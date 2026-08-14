/**
 * Reads history from the public GitHub API.
 *
 * This exists so the page is not a dead end for someone who just wants to look
 * at something. Requests may use the optional token, but remote repository
 * reads still stop after 1000 commits to keep browser and API work bounded.
 * The local-folder source is the complete path for longer histories.
 */

import type { ActivityHistory, ActivityRecord, LoadProgress } from "../core/types";
import { isNightAt } from "../core/activity";
import { githubFetch } from "./github-http";

const PER_PAGE = 100;
/** Keep remote reads bounded even when a token raises GitHub's request budget. */
const MAX_PAGES = 10;

export interface GitHubTarget {
  readonly owner: string;
  readonly repo: string;
}

export type GitHubInput =
  | { readonly kind: "repo"; readonly target: GitHubTarget }
  | { readonly kind: "user"; readonly login: string };

/**
 * Accepts a repository (`owner/repo`, or a URL) or a person (`@name`, `name`,
 * or their profile URL). One field, because asking someone to pick a mode
 * before they have typed anything is a question they cannot answer yet.
 */
export function parseGitHubInput(input: string): GitHubInput | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const repo = parseRepoInput(trimmed);
  if (repo) {
    return { kind: "repo", target: repo };
  }

  const bare = stripGitHubOrigin(trimmed).replace(/^@/, "");
  // GitHub logins: letters, digits and single hyphens, up to 39 characters.
  if (/^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/.test(bare)) {
    return { kind: "user", login: bare };
  }

  return null;
}

function stripGitHubOrigin(input: string): string {
  return input
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

export function parseRepoInput(input: string): GitHubTarget | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const withoutOrigin = stripGitHubOrigin(trimmed);

  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(withoutOrigin);
  if (!match) {
    return null;
  }
  return { owner: match[1]!, repo: match[2]! };
}

export async function loadGitHubHistory(
  target: GitHubTarget,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<ActivityHistory> {
  const activities: ActivityRecord[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    onProgress("Fetching commits", activities.length, null);

    const url = new URL(
      `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits`,
    );
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));

    const response = await githubFetch({
      url,
      signal,
      onProgress,
      progressCount: activities.length,
    });

    const batch = (await response.json()) as unknown;
    if (!Array.isArray(batch)) {
      throw new Error("GitHub returned something unexpected.");
    }

    for (const entry of batch) {
      const activity = toActivity(entry);
      if (activity) {
        activities.push(activity);
      }
    }

    if (batch.length < PER_PAGE) {
      break;
    }
    if (page === MAX_PAGES) {
      truncated = true;
    }
  }

  if (activities.length === 0) {
    throw new Error("That repository has no commits to draw.");
  }

  activities.sort((a, b) => a.timestampMs - b.timestampMs);

  return {
    name: `${target.owner}/${target.repo}`,
    activities,
    metric: "commits",
    groupKind: "authors",
    truncated,
    sourceKind: "github",
  };
}

/**
 * The list endpoint already returns more than the drawing needs. Keep only
 * when the commit happened and who authored it.
 */
function toActivity(entry: unknown): ActivityRecord | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const commit = record.commit as Record<string, unknown> | undefined;
  const author = commit?.author as Record<string, unknown> | undefined;
  const dateText = typeof author?.date === "string" ? author.date : null;

  if (!dateText) {
    return null;
  }

  const timestampMs = Date.parse(dateText);
  if (Number.isNaN(timestampMs)) {
    return null;
  }

  const authorName = typeof author?.name === "string" ? author.name : "unknown";
  const authorEmail = typeof author?.email === "string" ? author.email : authorName;
  const tzOffsetMinutes = parseIsoOffsetMinutes(dateText);

  return {
    timestampMs,
    count: 1,
    magnitude: null,
    nightCount: isNightAt(timestampMs, tzOffsetMinutes) ? 1 : 0,
    groupKey: authorEmail,
    detail: null,
  };
}

/** GitHub returns the author's own offset, which is what night work needs. */
export function parseIsoOffsetMinutes(iso: string): number {
  const match = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}
