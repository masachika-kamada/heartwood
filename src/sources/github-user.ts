/**
 * Draws one person's GitHub activity without treating a transport-level list
 * of commits as the product.
 *
 * With a token, GitHub's GraphQL contribution data already groups commits by
 * date and repository, so several years fit in one request and no commit
 * message, parent list, or SHA crosses into the drawing model.
 *
 * Without a token, commit search is still the only official browser-readable
 * source. Five searches are spread across the account's lifetime so a prolific
 * person's newest few days do not collapse an entire career into one ring.
 */

import type { ActivityHistory, ActivityRecord, LoadProgress } from "../core/types";
import { isNightAt } from "../core/activity";
import { parseIsoOffsetMinutes } from "./github";
import { hasToken } from "./github-auth";
import { GitHubRateLimitError, githubFetch } from "./github-http";

const PER_PAGE = 100;
const PREVIEW_PAGES = 5;
const GRAPHQL_YEARS_PER_REQUEST = 4;
const GRAPHQL_URL = new URL("https://api.github.com/graphql");

interface SearchPage {
  readonly totalCount: number;
  readonly items: readonly PreviewItem[];
  readonly incomplete: boolean;
}

interface PreviewItem {
  readonly id: string;
  readonly activity: ActivityRecord;
}

export async function loadGitHubUserHistory(
  login: string,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<ActivityHistory> {
  return hasToken()
    ? await loadContributionHistory(login, onProgress, signal)
    : await loadAnonymousPreview(login, onProgress, signal);
}

async function loadAnonymousPreview(
  login: string,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<ActivityHistory> {
  onProgress("Finding the account's timeline", 0, PREVIEW_PAGES);
  const createdAt = await loadPublicProfileCreatedAt(login, onProgress, signal);
  const windows = timelineWindows(createdAt, Date.now(), PREVIEW_PAGES);
  const byId = new Map<string, ActivityRecord>();
  let totalCount = 0;
  let incomplete = false;
  let stoppedAtLimit = false;

  for (const [index, window] of windows.entries()) {
    onProgress(
      "Sampling the account's timeline",
      index,
      windows.length,
    );

    let result: SearchPage;
    try {
      result = await searchCommits(
        login,
        window.startMs,
        window.endMs,
        onProgress,
        signal,
        byId.size,
      );
    } catch (error) {
      if (!(error instanceof GitHubRateLimitError) || byId.size === 0) {
        throw error;
      }
      stoppedAtLimit = true;
      break;
    }

    totalCount += result.totalCount;
    incomplete = incomplete || result.incomplete;
    for (const item of result.items) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item.activity);
      }
    }
    onProgress("Sampling the account's timeline", index + 1, windows.length);
  }

  const activities = [...byId.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  if (activities.length === 0) {
    if (incomplete) {
      throw new Error("GitHub's search timed out before it could produce a preview.");
    }
    throw new Error(
      `No public commits found for ${login}. Add a token to include activity GitHub can show you.`,
    );
  }

  return {
    name: login,
    activities,
    metric: "commits",
    groupKind: "repositories",
    truncated: incomplete || stoppedAtLimit || activities.length < totalCount,
    sourceKind: "github",
  };
}

async function searchCommits(
  login: string,
  startMs: number,
  endMs: number,
  onProgress: LoadProgress,
  signal: AbortSignal,
  progressCount: number,
): Promise<SearchPage> {
  const url = new URL("https://api.github.com/search/commits");
  const range = `${formatSearchDate(startMs)}..${formatSearchDate(endMs)}`;
  url.searchParams.set("q", `author:${login} author-date:${range}`);
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("sort", "author-date");
  url.searchParams.set("order", "desc");

  const response = await githubFetch({
    url,
    signal,
    onProgress,
    progressCount,
    rateLimitMode: "fail",
  });
  return await readSearchPage(response);
}

async function loadPublicProfileCreatedAt(
  login: string,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<number> {
  const url = new URL(`https://api.github.com/users/${encodeURIComponent(login)}`);
  const response = await githubFetch({
    url,
    signal,
    onProgress,
    progressCount: 0,
    rateLimitMode: "fail",
  });
  const body = asRecord((await response.json()) as unknown);
  const createdAt =
    typeof body?.created_at === "string" ? Date.parse(body.created_at) : Number.NaN;
  if (!Number.isFinite(createdAt)) {
    throw new Error("GitHub returned an invalid account creation date.");
  }
  return createdAt;
}

interface TimelineWindow {
  readonly startMs: number;
  readonly endMs: number;
}

function timelineWindows(
  createdAt: number,
  now: number,
  count: number,
): TimelineWindow[] {
  const span = Math.max(count, now - createdAt);
  return Array.from({ length: count }, (_, index) => ({
    startMs: createdAt + (span * index) / count,
    endMs: index === count - 1 ? now : createdAt + (span * (index + 1)) / count,
  }));
}

function formatSearchDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

async function readSearchPage(response: Response): Promise<SearchPage> {
  const body = (await response.json()) as unknown;
  const record = asRecord(body);
  if (!record || typeof record.total_count !== "number" || !Array.isArray(record.items)) {
    throw new Error("GitHub returned an unexpected commit search response.");
  }

  return {
    totalCount: record.total_count,
    items: record.items
      .map((item) => toPreviewItem(item))
      .filter((item): item is PreviewItem => item !== null),
    incomplete: record.incomplete_results === true,
  };
}

function toPreviewItem(entry: unknown): PreviewItem | null {
  const item = asRecord(entry);
  const commit = asRecord(item?.commit);
  const author = asRecord(commit?.author);
  const repository = asRecord(item?.repository);
  const sha = typeof item?.sha === "string" ? item.sha : null;
  const dateText = typeof author?.date === "string" ? author.date : null;
  const repoName = typeof repository?.full_name === "string" ? repository.full_name : null;
  if (!sha || !dateText) {
    return null;
  }

  const timestampMs = Date.parse(dateText);
  if (Number.isNaN(timestampMs)) {
    return null;
  }
  const tzOffsetMinutes = parseIsoOffsetMinutes(dateText);

  return {
    id: `${repoName ?? "unknown"}:${sha}`,
    activity: {
      timestampMs,
      count: 1,
      magnitude: null,
      nightCount: isNightAt(timestampMs, tzOffsetMinutes) ? 1 : 0,
      groupKey: repoName,
      detail: null,
    },
  };
}

async function loadContributionHistory(
  login: string,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<ActivityHistory> {
  onProgress("Finding the account's first year", 0, null);
  const profile = await graphqlRequest(PROFILE_QUERY, { login }, onProgress, signal, 0);
  const user = asRecord(profile.user);
  const createdAt = typeof user?.createdAt === "string" ? user.createdAt : null;
  if (!user || !createdAt) {
    throw new Error(`GitHub has no account named ${login}.`);
  }

  const createdYear = new Date(createdAt).getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isFinite(createdYear) || createdYear > currentYear) {
    throw new Error("GitHub returned an invalid account creation date.");
  }

  const years = Array.from(
    { length: currentYear - createdYear + 1 },
    (_, index) => createdYear + index,
  );
  const activities: ActivityRecord[] = [];
  let reportedTotal = 0;
  let observedTotal = 0;
  let truncated = false;

  for (let offset = 0; offset < years.length; offset += GRAPHQL_YEARS_PER_REQUEST) {
    const batch = years.slice(offset, offset + GRAPHQL_YEARS_PER_REQUEST);
    onProgress("Reading contribution years", offset, years.length);
    const data = await graphqlRequest(
      contributionQuery(batch),
      { login },
      onProgress,
      signal,
      observedTotal,
    );
    const batchUser = asRecord(data.user);
    if (!batchUser) {
      throw new Error(`GitHub has no account named ${login}.`);
    }

    for (const year of batch) {
      const collection = asRecord(batchUser[`y${year}`]);
      if (!collection) {
        truncated = true;
        continue;
      }

      const total =
        typeof collection.totalCommitContributions === "number"
          ? collection.totalCommitContributions
          : 0;
      reportedTotal += total;

      const repositories = Array.isArray(collection.commitContributionsByRepository)
        ? collection.commitContributionsByRepository
        : [];
      let observedYear = 0;

      for (const value of repositories) {
        const repositoryGroup = asRecord(value);
        const repository = asRecord(repositoryGroup?.repository);
        const repoName =
          typeof repository?.nameWithOwner === "string" ? repository.nameWithOwner : null;
        const contributions = asRecord(repositoryGroup?.contributions);
        const nodes = Array.isArray(contributions?.nodes) ? contributions.nodes : [];
        const pageInfo = asRecord(contributions?.pageInfo);
        if (pageInfo?.hasNextPage === true) {
          truncated = true;
        }

        for (const nodeValue of nodes) {
          const node = asRecord(nodeValue);
          const occurredAt =
            typeof node?.occurredAt === "string" ? Date.parse(node.occurredAt) : Number.NaN;
          const commitCount =
            typeof node?.commitCount === "number" ? Math.max(0, node.commitCount) : 0;
          if (!Number.isFinite(occurredAt) || commitCount === 0) {
            continue;
          }

          observedYear += commitCount;
          activities.push({
            timestampMs: occurredAt,
            count: commitCount,
            magnitude: null,
            nightCount: null,
            groupKey: repoName,
            detail: null,
          });
        }
      }

      observedTotal += observedYear;
      if (observedYear < total) {
        truncated = true;
      }
    }
  }

  onProgress("Reading contribution years", years.length, years.length);
  if (activities.length === 0) {
    if (reportedTotal > 0) {
      throw new Error("GitHub reported commits but did not expose their dates and repositories.");
    }
    throw new Error(`No commits found for ${login} that this token can see.`);
  }

  activities.sort((a, b) => a.timestampMs - b.timestampMs);
  return {
    name: login,
    activities,
    metric: "commits",
    groupKind: "repositories",
    truncated: truncated || observedTotal < reportedTotal,
    sourceKind: "github",
  };
}

const PROFILE_QUERY = `
  query HeartwoodProfile($login: String!) {
    user(login: $login) {
      createdAt
    }
  }
`;

function contributionQuery(years: readonly number[]): string {
  const selections = years
    .map((year) => {
      const from = new Date(Date.UTC(year, 0, 1)).toISOString();
      const yearEnd = new Date(Date.UTC(year + 1, 0, 1) - 1);
      const to = new Date(Math.min(yearEnd.getTime(), Date.now())).toISOString();
      return `
        y${year}: contributionsCollection(from: "${from}", to: "${to}") {
          ...HeartwoodContributionYear
        }
      `;
    })
    .join("\n");

  return `
    query HeartwoodContributionYears($login: String!) {
      user(login: $login) {
        ${selections}
      }
    }

    fragment HeartwoodContributionYear on ContributionsCollection {
      totalCommitContributions
      commitContributionsByRepository(maxRepositories: 100) {
        repository {
          nameWithOwner
        }
        contributions(first: 100) {
          nodes {
            occurredAt
            commitCount
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    }
  `;
}

async function graphqlRequest(
  query: string,
  variables: Readonly<Record<string, unknown>>,
  onProgress: LoadProgress,
  signal: AbortSignal,
  progressCount: number,
): Promise<Record<string, unknown>> {
  const response = await githubFetch({
    url: GRAPHQL_URL,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal,
    onProgress,
    progressCount,
  });
  const payload = (await response.json()) as unknown;
  const record = asRecord(payload);
  if (!record) {
    throw new Error("GitHub returned an unexpected GraphQL response.");
  }

  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const first = asRecord(record.errors[0]);
    const message = typeof first?.message === "string" ? first.message : "GraphQL request failed.";
    throw new Error(`GitHub could not read contribution history: ${message}`);
  }

  const data = asRecord(record.data);
  if (!data) {
    throw new Error("GitHub returned no contribution data.");
  }
  return data;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
