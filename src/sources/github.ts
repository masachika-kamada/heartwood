/**
 * Reads history from the public GitHub API.
 *
 * This exists so the page is not a dead end for someone who just wants to look
 * at something. It is unauthenticated, so it is rate limited (60 requests per
 * hour per IP) and capped well below what a local read can do.
 */

import type { CommitRecord, LoadProgress, RepoHistory } from "../core/types";

const PER_PAGE = 100;
const MAX_PAGES = 10;

export interface GitHubTarget {
  readonly owner: string;
  readonly repo: string;
}

export function parseRepoInput(input: string): GitHubTarget | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const withoutOrigin = trimmed
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

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
): Promise<RepoHistory> {
  const commits: CommitRecord[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    onProgress("Fetching commits", commits.length, null);

    const url = new URL(
      `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits`,
    );
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!response.ok) {
      throw new Error(describeFailure(response.status, target));
    }

    const batch = (await response.json()) as unknown;
    if (!Array.isArray(batch)) {
      throw new Error("GitHub returned something unexpected.");
    }

    for (const entry of batch) {
      const record = toCommitRecord(entry);
      if (record) {
        commits.push(record);
      }
    }

    if (batch.length < PER_PAGE) {
      break;
    }
    if (page === MAX_PAGES) {
      truncated = true;
    }
  }

  if (commits.length === 0) {
    throw new Error("That repository has no commits to draw.");
  }

  commits.sort((a, b) => a.timestampMs - b.timestampMs);

  return {
    name: `${target.owner}/${target.repo}`,
    commits,
    truncated,
    sourceKind: "github",
  };
}

function describeFailure(status: number, target: GitHubTarget): string {
  if (status === 404) {
    return `Could not find ${target.owner}/${target.repo}. Private repositories need the local folder option.`;
  }
  if (status === 403 || status === 429) {
    return "GitHub is rate limiting anonymous requests right now. Try the local folder option, or wait an hour.";
  }
  if (status === 409) {
    return "That repository is empty.";
  }
  return `GitHub replied with ${status}.`;
}

/**
 * The list endpoint gives no per-commit stats. Fetching them would cost one
 * request per commit, which the anonymous rate limit cannot pay for, so churn
 * stays null and the tree falls back to weighing commits equally.
 */
function toCommitRecord(entry: unknown): CommitRecord | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const sha = typeof record.sha === "string" ? record.sha : null;
  const commit = record.commit as Record<string, unknown> | undefined;
  const author = commit?.author as Record<string, unknown> | undefined;
  const dateText = typeof author?.date === "string" ? author.date : null;

  if (!sha || !dateText) {
    return null;
  }

  const timestampMs = Date.parse(dateText);
  if (Number.isNaN(timestampMs)) {
    return null;
  }

  const message = typeof commit?.message === "string" ? commit.message : "";
  const parents = Array.isArray(record.parents)
    ? record.parents
        .map((parent) =>
          typeof parent === "object" && parent !== null
            ? (parent as Record<string, unknown>).sha
            : null,
        )
        .filter((value): value is string => typeof value === "string")
    : [];

  return {
    sha,
    timestampMs,
    tzOffsetMinutes: parseIsoOffsetMinutes(dateText),
    authorName: typeof author?.name === "string" ? author.name : "unknown",
    authorEmail: typeof author?.email === "string" ? author.email : "unknown",
    summary: message.split("\n", 1)[0]!.trim(),
    parents,
    insertions: null,
    deletions: null,
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
