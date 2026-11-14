/**
 * Draws one person's GitHub activity.
 *
 * With a token, the trunk comes from GitHub's own contribution calendar: one
 * number per day, complete for every year, and never cut short however busy
 * the person was. Which repository each day's commits went to is asked for
 * alongside it and is allowed to be partial, because it only decides colour.
 * The first request finds out which years exist; the rest leave together.
 *
 * Without a token, commit search is the only official source a browser can
 * read, and it allows ten requests a minute. Eight are spent: the oldest
 * hundred commits, the newest hundred, and six windows across the time in
 * between. Every search also reports how many commits its window really
 * holds, so the stretch a window's hundred did not reach is not drawn as a
 * silence — its known count is spread evenly over it and marked as estimated.
 */

import type { ActivityHistory, ActivityRecord, LoadProgress } from "../core/types";
import { isNightAt, localClock } from "../core/activity";
import { hasExplicitOffset, parseIsoOffsetMinutes } from "./github";
import { hasToken } from "./github-auth";
import { GitHubRateLimitError, githubFetch } from "./github-http";

const PER_PAGE = 100;
/** Windows between the oldest and newest samples; with those two, eight searches. */
const MIDDLE_WINDOWS = 6;
const GRAPHQL_YEARS_PER_REQUEST = 3;
const GRAPHQL_CONCURRENCY = 4;
const GRAPHQL_URL = new URL("https://api.github.com/graphql");
const DAY_MS = 86_400_000;

export async function loadGitHubUserHistory(
  login: string,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<ActivityHistory> {
  return hasToken()
    ? await loadContributionHistory(login, onProgress, signal)
    : await loadAnonymousSample(login, onProgress, signal);
}

/* ------------------------------------------------------------------ *
 * Without a token: eight searches
 * ------------------------------------------------------------------ */

interface SearchPage {
  readonly totalCount: number;
  readonly items: readonly SampledCommit[];
  readonly incomplete: boolean;
}

interface SampledCommit {
  readonly id: string;
  readonly activity: ActivityRecord;
}

interface SearchWindow {
  /** Inclusive calendar days, UTC; null leaves that end open. */
  readonly fromDay: number | null;
  readonly toDay: number | null;
  readonly order: "asc" | "desc";
}

async function loadAnonymousSample(
  login: string,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<ActivityHistory> {
  const total = 2 + MIDDLE_WINDOWS;
  let done = 0;
  onProgress("Sampling public commits", done, total);

  const search = async (window: SearchWindow): Promise<SearchPage> => {
    const page = await searchCommits(login, window, onProgress, signal);
    done += 1;
    onProgress("Sampling public commits", done, total);
    return page;
  };

  // Both ends first: together they say how long the history is and how much
  // of it there is, which is what the windows in between are cut from.
  const [newest, oldest] = await Promise.all([
    search({ fromDay: null, toDay: null, order: "desc" }),
    search({ fromDay: null, toDay: null, order: "asc" }),
  ]);

  const byId = new Map<string, ActivityRecord>();
  const keep = (items: readonly SampledCommit[]): void => {
    for (const item of items) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item.activity);
      }
    }
  };
  keep(newest.items);
  keep(oldest.items);

  const totalCount = Math.max(newest.totalCount, oldest.totalCount);
  let incomplete = newest.incomplete || oldest.incomplete;
  let stoppedAtLimit = false as boolean;
  const estimates: ActivityRecord[] = [];

  if (byId.size === 0) {
    if (incomplete) {
      throw new Error("GitHub's search timed out before it could find anything.");
    }
    throw new Error(
      `No public commits found for ${login}. Add a token to include activity GitHub can show you.`,
    );
  }

  if (totalCount > byId.size) {
    // The gap the two ends did not reach, in whole days, exclusive of the days
    // they touched so that no commit is counted by two searches.
    const gapStart = dayOf(Math.max(...oldest.items.map((item) => item.activity.timestampMs))) + 1;
    const gapEnd = dayOf(Math.min(...newest.items.map((item) => item.activity.timestampMs))) - 1;
    const windows = splitDays(gapStart, gapEnd, MIDDLE_WINDOWS);

    const failed: SearchWindow[] = [];
    const results = await Promise.all(
      windows.map(async (window) => {
        try {
          return { window, page: await search(window) };
        } catch (error) {
          if (!(error instanceof GitHubRateLimitError)) {
            throw error;
          }
          failed.push(window);
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) {
        continue;
      }
      const { window, page } = result;
      keep(page.items);
      incomplete = incomplete || page.incomplete;
      estimates.push(...spreadUnsampled(window, page));
    }

    // A window the budget ran out on is still not a silence: the commits
    // nothing has accounted for yet can only be in there.
    if (failed.length > 0) {
      stoppedAtLimit = true;
      const accounted = byId.size + estimates.reduce((sum, record) => sum + record.count, 0);
      const failedDays = failed.reduce(
        (sum, window) => sum + (window.toDay! - window.fromDay! + 1),
        0,
      );
      for (const window of failed) {
        const days = window.toDay! - window.fromDay! + 1;
        estimates.push(
          ...spreadEvenly(
            window.fromDay! * DAY_MS,
            (window.toDay! + 1) * DAY_MS,
            ((totalCount - accounted) * days) / failedDays,
          ),
        );
      }
    }
  }

  const sampled = [...byId.values()];
  const activities = [...sampled, ...estimates].sort((a, b) => a.timestampMs - b.timestampMs);
  const represented = activities.reduce((sum, activity) => sum + activity.count, 0);

  return {
    name: login,
    activities,
    metric: "commits",
    groupKind: "repositories",
    truncated: incomplete || stoppedAtLimit || represented < totalCount * 0.98,
    sourceKind: "github",
    granularity: "instant",
    estimated: estimates.length > 0,
  };
}

/**
 * A window's search returned its newest hundred commits and the true number
 * it holds. The older part of the window, which the hundred did not reach,
 * therefore holds a known number of commits at unknown moments. One record a
 * week, each carrying an equal share, says exactly that much and no more: no
 * repository, no hour, no weekday.
 */
export function spreadUnsampled(window: SearchWindow, page: SearchPage): ActivityRecord[] {
  if (window.fromDay === null || page.items.length === 0) {
    return [];
  }
  return spreadEvenly(
    window.fromDay * DAY_MS,
    Math.min(...page.items.map((item) => item.activity.timestampMs)),
    page.totalCount - page.items.length,
  );
}

function spreadEvenly(startMs: number, endMs: number, count: number): ActivityRecord[] {
  if (count <= 0 || endMs <= startMs) {
    return [];
  }
  const slices = Math.max(1, Math.round((endMs - startMs) / (7 * DAY_MS)));
  return Array.from({ length: slices }, (_, slice) => ({
    timestampMs: startMs + ((slice + 0.5) / slices) * (endMs - startMs),
    count: count / slices,
    magnitude: null,
    nightCount: null,
    groupKey: null,
    detail: null,
    localHour: null,
    weekday: null,
  }));
}

function splitDays(fromDay: number, toDay: number, count: number): SearchWindow[] {
  if (toDay < fromDay) {
    return [];
  }
  const days = toDay - fromDay + 1;
  const windows = Math.min(count, days);
  return Array.from({ length: windows }, (_, index) => ({
    fromDay: fromDay + Math.floor((days * index) / windows),
    toDay: fromDay + Math.floor((days * (index + 1)) / windows) - 1,
    order: "desc" as const,
  }));
}

function dayOf(timestampMs: number): number {
  return Math.floor(timestampMs / DAY_MS);
}

function formatDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

async function searchCommits(
  login: string,
  window: SearchWindow,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<SearchPage> {
  const url = new URL("https://api.github.com/search/commits");
  const range =
    window.fromDay !== null && window.toDay !== null
      ? ` author-date:${formatDay(window.fromDay)}..${formatDay(window.toDay)}`
      : "";
  url.searchParams.set("q", `author:${login}${range}`);
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("sort", "author-date");
  url.searchParams.set("order", window.order);

  const response = await githubFetch({
    url,
    signal,
    onProgress,
    progressCount: 0,
    rateLimitMode: "fail",
  });
  return await readSearchPage(response);
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
      .map((item) => toSampledCommit(item))
      .filter((item): item is SampledCommit => item !== null),
    incomplete: record.incomplete_results === true,
  };
}

function toSampledCommit(entry: unknown): SampledCommit | null {
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
  // Search keeps the author's own offset, so the hour is the author's hour.
  const offset = hasExplicitOffset(dateText) ? parseIsoOffsetMinutes(dateText) : null;
  const clock = localClock(timestampMs, offset ?? 0);

  return {
    // The same commit can be found in a repository and in its forks.
    id: sha,
    activity: {
      timestampMs,
      count: 1,
      magnitude: null,
      nightCount: offset === null ? null : isNightAt(timestampMs, offset) ? 1 : 0,
      groupKey: repoName,
      detail: null,
      localHour: offset === null ? null : clock.hour,
      weekday: clock.weekday,
    },
  };
}

/* ------------------------------------------------------------------ *
 * With a token: the contribution calendar
 * ------------------------------------------------------------------ */

interface DayTally {
  total: number;
  readonly repositories: Map<string, number>;
}

async function loadContributionHistory(
  login: string,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<ActivityHistory> {
  onProgress("Finding the years with contributions", 0, null);
  const currentYear = new Date().getUTCFullYear();

  // The newest year rides along with the question of which years exist, so
  // an account with one year of history is finished after a single request.
  const opening = await graphqlRequest(
    contributionQuery([currentYear], true),
    { login },
    onProgress,
    signal,
  );
  const openingUser = asRecord(opening.user);
  if (!openingUser) {
    throw new Error(`GitHub has no account named ${login}.`);
  }
  const listed = asRecord(openingUser.contributionsCollection)?.contributionYears;
  const years = (Array.isArray(listed) ? listed : [])
    .filter((year): year is number => typeof year === "number" && year <= currentYear)
    .sort((a, b) => a - b);

  const days = new Map<string, DayTally>();
  let missingYears = 0;
  const absorb = (user: Record<string, unknown>, batch: readonly number[]): void => {
    for (const year of batch) {
      const collection = asRecord(user[`y${year}`]);
      if (!collection) {
        missingYears += 1;
        continue;
      }
      readCalendar(collection, days);
      readRepositories(collection, days);
    }
  };
  absorb(openingUser, [currentYear]);

  const earlier = years.filter((year) => year !== currentYear);
  const batches: number[][] = [];
  for (let offset = 0; offset < earlier.length; offset += GRAPHQL_YEARS_PER_REQUEST) {
    batches.push(earlier.slice(offset, offset + GRAPHQL_YEARS_PER_REQUEST));
  }

  let finished = 1;
  const totalYears = earlier.length + 1;
  onProgress("Reading contribution years", finished, totalYears);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batch = batches[next]!;
      next += 1;
      const data = await graphqlRequest(
        contributionQuery(batch, false),
        { login },
        onProgress,
        signal,
      );
      const user = asRecord(data.user);
      if (!user) {
        throw new Error(`GitHub has no account named ${login}.`);
      }
      absorb(user, batch);
      finished += batch.length;
      onProgress("Reading contribution years", finished, totalYears);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(GRAPHQL_CONCURRENCY, batches.length) }, worker),
  );

  const activities = toActivities(days);
  if (activities.length === 0) {
    throw new Error(`No contributions found for ${login} that this token can see.`);
  }

  return {
    name: login,
    activities,
    metric: "contributions",
    groupKind: "repositories",
    truncated: missingYears > 0,
    sourceKind: "github",
    granularity: "day",
  };
}

function readCalendar(collection: Record<string, unknown>, days: Map<string, DayTally>): void {
  const calendar = asRecord(collection.contributionCalendar);
  const weeks = Array.isArray(calendar?.weeks) ? calendar.weeks : [];
  for (const week of weeks) {
    const contributionDays = asRecord(week)?.contributionDays;
    for (const value of Array.isArray(contributionDays) ? contributionDays : []) {
      const day = asRecord(value);
      const date = typeof day?.date === "string" ? day.date : null;
      const count = typeof day?.contributionCount === "number" ? day.contributionCount : 0;
      if (!date || count <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        continue;
      }
      const tally = days.get(date) ?? { total: 0, repositories: new Map() };
      // Years are asked for separately and never overlap, but a week can
      // straddle New Year and be reported by both; the larger reading wins.
      tally.total = Math.max(tally.total, count);
      days.set(date, tally);
    }
  }
}

function readRepositories(
  collection: Record<string, unknown>,
  days: Map<string, DayTally>,
): void {
  const repositories = Array.isArray(collection.commitContributionsByRepository)
    ? collection.commitContributionsByRepository
    : [];
  for (const value of repositories) {
    const group = asRecord(value);
    const name = asRecord(group?.repository)?.nameWithOwner;
    const nodes = asRecord(group?.contributions)?.nodes;
    if (typeof name !== "string" || !Array.isArray(nodes)) {
      continue;
    }
    for (const nodeValue of nodes) {
      const node = asRecord(nodeValue);
      const occurredAt =
        typeof node?.occurredAt === "string" ? Date.parse(node.occurredAt) : Number.NaN;
      const commits = typeof node?.commitCount === "number" ? node.commitCount : 0;
      if (!Number.isFinite(occurredAt) || commits <= 0) {
        continue;
      }
      // GitHub stamps a day's commits with that day's midnight in the
      // account's own timezone, given in UTC. The nearest UTC midnight is
      // therefore the calendar date it meant, whichever side of UTC that is.
      const date = new Date(Math.round(occurredAt / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
      const tally = days.get(date) ?? { total: 0, repositories: new Map() };
      tally.repositories.set(name, (tally.repositories.get(name) ?? 0) + commits);
      days.set(date, tally);
    }
  }
}

/**
 * One record per repository per day, plus one for whatever the calendar
 * counted that no repository accounts for: pull requests, reviews, issues,
 * private work. Each day's records always add up to the calendar's number.
 */
function toActivities(days: ReadonlyMap<string, DayTally>): ActivityRecord[] {
  const activities: ActivityRecord[] = [];
  for (const [date, tally] of days) {
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    // Noon, local: safely inside the right calendar day in any timezone.
    const timestampMs = new Date(year, month - 1, day, 12).getTime();
    const weekday = (new Date(year, month - 1, day).getDay() + 6) % 7;
    const attributed = [...tally.repositories.values()].reduce((sum, value) => sum + value, 0);
    const total = tally.total > 0 ? tally.total : attributed;
    const scale = attributed > total ? total / attributed : 1;

    const record = (count: number, groupKey: string | null): ActivityRecord => ({
      timestampMs,
      count,
      magnitude: null,
      nightCount: null,
      groupKey,
      detail: null,
      localHour: null,
      weekday,
    });

    for (const [name, commits] of tally.repositories) {
      activities.push(record(commits * scale, name));
    }
    if (total - attributed > 0) {
      activities.push(record(total - attributed, null));
    }
  }
  return activities.sort((a, b) => a.timestampMs - b.timestampMs);
}

function contributionQuery(years: readonly number[], listYears: boolean): string {
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
        ${listYears ? "contributionsCollection { contributionYears }" : ""}
        ${selections}
      }
    }

    fragment HeartwoodContributionYear on ContributionsCollection {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
      commitContributionsByRepository(maxRepositories: 50) {
        repository {
          nameWithOwner
        }
        contributions(first: 100) {
          nodes {
            occurredAt
            commitCount
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
): Promise<Record<string, unknown>> {
  const response = await githubFetch({
    url: GRAPHQL_URL,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal,
    onProgress,
    progressCount: 0,
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
