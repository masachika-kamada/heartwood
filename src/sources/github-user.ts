/**
 * Reads one person's commits across all their public repositories.
 *
 * This is what a contribution graph shows, except it does not reset every
 * January. GitHub's commit search refuses to page past 1000 results for any
 * one query, so a long career is fetched a year at a time and stitched back
 * together.
 *
 * Anonymous search is limited to ten requests a minute, which a busy account
 * will exhaust. Rather than failing, this waits for the window to reset and
 * says so, because the alternative is asking someone to paste a token.
 */

import type { CommitRecord, LoadProgress, RepoHistory } from "../core/types";
import { parseIsoOffsetMinutes } from "./github";

const PER_PAGE = 100;
/** GitHub refuses to page past this many results for any one query. */
const SEARCH_RESULT_CAP = 1000;
const MAX_PAGES = SEARCH_RESULT_CAP / PER_PAGE;
/** A rate limit window is a minute; never wait much longer than one. */
const MAX_WAIT_MS = 75_000;

interface SearchPage {
  readonly totalCount: number;
  readonly commits: CommitRecord[];
  readonly remaining: number | null;
  readonly resetEpochMs: number | null;
}

export async function loadGitHubUserHistory(
  login: string,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<RepoHistory> {
  const bySha = new Map<string, CommitRecord>();
  let truncated = false;

  onProgress("Looking for commits", 0, null);

  // Ascending, so this single request answers both "how many?" and "since
  // when?" — which saves a profile lookup out of a very small budget.
  const probe = await searchCommits(`author:${login}`, 1, 1, onProgress, signal, 0);

  if (probe.totalCount === 0) {
    throw new Error(
      `No public commits found for ${login}. Private and internal work only shows up through the local folder option.`,
    );
  }

  if (probe.totalCount <= SEARCH_RESULT_CAP) {
    truncated = await collect(`author:${login}`, bySha, onProgress, signal);
  } else {
    const firstYear = probe.commits[0]
      ? new Date(probe.commits[0].timestampMs).getFullYear()
      : new Date().getFullYear() - 10;
    const thisYear = new Date().getFullYear();

    for (let year = firstYear; year <= thisYear; year += 1) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const stoppedEarly = await collect(
        `author:${login} author-date:${year}-01-01..${year}-12-31`,
        bySha,
        onProgress,
        signal,
        year,
      );
      truncated = truncated || stoppedEarly;
    }
  }

  const commits = [...bySha.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  if (commits.length === 0) {
    throw new Error(`No commits could be read for ${login}.`);
  }

  return { name: login, commits, truncated, sourceKind: "github" };
}

/** Returns true when it gave up before reading everything. */
async function collect(
  query: string,
  bySha: Map<string, CommitRecord>,
  onProgress: LoadProgress,
  signal: AbortSignal,
  year?: number,
): Promise<boolean> {
  const label = year === undefined ? "Fetching commits" : `Fetching ${year}`;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    onProgress(label, bySha.size, null);

    const result = await searchCommits(query, PER_PAGE, page, onProgress, signal, bySha.size);
    for (const commit of result.commits) {
      if (!bySha.has(commit.sha)) {
        bySha.set(commit.sha, commit);
      }
    }

    const seen = page * PER_PAGE;
    if (result.commits.length < PER_PAGE || seen >= result.totalCount) {
      return false;
    }
    if (seen >= SEARCH_RESULT_CAP) {
      return true;
    }
  }

  return true;
}

async function searchCommits(
  query: string,
  perPage: number,
  page: number,
  onProgress: LoadProgress,
  signal: AbortSignal,
  progressCount: number,
): Promise<SearchPage> {
  const url = new URL("https://api.github.com/search/commits");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "author-date");
  url.searchParams.set("order", "asc");

  // One retry only: a second refusal after a full window means something other
  // than ordinary throttling is going on.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });

    if (response.ok) {
      return await readPage(response);
    }

    const throttled = response.status === 403 || response.status === 429;
    if (throttled && attempt === 0) {
      const waitMs = waitUntilReset(response);
      if (waitMs !== null && waitMs <= MAX_WAIT_MS) {
        const seconds = Math.max(1, Math.ceil(waitMs / 1000));
        onProgress(`Waiting ${seconds}s for GitHub's rate limit`, progressCount, null);
        await delay(waitMs, signal);
        continue;
      }
    }

    throw new Error(describeFailure(response.status));
  }

  throw new Error(
    "GitHub kept refusing anonymous searches. Try again in a minute, or use the local folder option.",
  );
}

function describeFailure(status: number): string {
  if (status === 403 || status === 429) {
    return "GitHub is rate limiting anonymous searches. Wait a minute and try again, or use the local folder option.";
  }
  if (status === 422) {
    return "GitHub could not make sense of that name.";
  }
  if (status === 404) {
    return "GitHub has no such account.";
  }
  return `GitHub replied with ${status}.`;
}

/** Milliseconds until the limit resets, with a little slack. */
function waitUntilReset(response: Response): number | null {
  const retryAfter = readNumberHeader(response, "retry-after");
  if (retryAfter !== null) {
    return retryAfter * 1000 + 1000;
  }
  const reset = readNumberHeader(response, "x-ratelimit-reset");
  if (reset === null) {
    return null;
  }
  return Math.max(0, reset * 1000 - Date.now()) + 1000;
}

async function readPage(response: Response): Promise<SearchPage> {
  const body = (await response.json()) as unknown;
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const items = Array.isArray(record.items) ? record.items : [];

  return {
    totalCount: typeof record.total_count === "number" ? record.total_count : 0,
    commits: items
      .map((item) => toCommitRecord(item))
      .filter((commit): commit is CommitRecord => commit !== null),
    remaining: readNumberHeader(response, "x-ratelimit-remaining"),
    resetEpochMs: (readNumberHeader(response, "x-ratelimit-reset") ?? 0) * 1000 || null,
  };
}

function toCommitRecord(entry: unknown): CommitRecord | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const item = entry as Record<string, unknown>;
  const sha = typeof item.sha === "string" ? item.sha : null;
  const commit = item.commit as Record<string, unknown> | undefined;
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
  const repository = item.repository as Record<string, unknown> | undefined;
  const repoName = typeof repository?.full_name === "string" ? repository.full_name : null;
  const summary = message.split("\n", 1)[0]!.trim();

  return {
    sha,
    timestampMs,
    tzOffsetMinutes: parseIsoOffsetMinutes(dateText),
    authorName: repoName ?? "unknown",
    // Across one person's own history "who" is constant, so the colour is
    // spent on where the work went instead.
    authorEmail: repoName ?? "unknown",
    summary: repoName ? `${repoName}: ${summary}` : summary,
    parents: [],
    insertions: null,
    deletions: null,
  };
}

function readNumberHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
