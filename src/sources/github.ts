/**
 * Reads one repository's history from the GitHub API.
 *
 * Walking a repository commit by commit costs a request per hundred commits,
 * which on an anonymous budget of sixty an hour means a large project can only
 * ever be shown its last few months. GitHub has already counted the whole
 * history, though: its contributor statistics give commits and changed lines
 * per author for every week since the first commit, in one response, and its
 * punch card gives the hours those commits were made at. So the whole trunk is
 * asked for first, and the commit list is what remains for a repository too
 * young to have weeks, or one GitHub has not finished counting.
 */

import type {
  ActivityHistory,
  ActivityRecord,
  HistoryRhythm,
  LoadProgress,
} from "../core/types";
import { isNightAt, localClock } from "../core/activity";
import { delay, githubFetch } from "./github-http";

const PER_PAGE = 100;
/** Keep remote reads bounded even when a token raises GitHub's request budget. */
const MAX_PAGES = 10;
/** Pages are independent once the last page number is known. */
const PAGE_CONCURRENCY = 4;
/**
 * GitHub answers 202 while it counts a repository nobody has asked about
 * lately. Small repositories are ready within a second or two; these waits add
 * up to about seven, after which the commit list is the better use of time.
 */
const STATS_RETRY_DELAYS_MS = [900, 1400, 2000, 2700];
/** Weekly statistics need this many weeks before they make a trunk worth drawing. */
const MIN_WEEKS_FOR_STATS = 15;
/** GitHub reports only its top hundred contributors. */
const MAX_REPORTED_CONTRIBUTORS = 100;
const DAY_MS = 86_400_000;

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
  const base = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const name = `${target.owner}/${target.repo}`;
  const context: RequestContext = { base, onProgress, signal };

  onProgress("Reading the repository", 0, null);

  // All three leave at once. The first page is the one that must succeed: it
  // is what says "no such repository" or "that repository is empty".
  const statsRequest = optional(loadWeeklyStats(context), signal);
  const rhythmRequest = optional(loadPunchCard(context), signal);
  // If the first page fails, nobody will be left to hear these two fail too.
  statsRequest.catch(() => undefined);
  rhythmRequest.catch(() => undefined);
  const firstPage = await loadCommitPage(context, 1, 0);

  const stats = await statsRequest;
  const rhythm = await rhythmRequest;

  if (stats && stats.spanWeeks >= MIN_WEEKS_FOR_STATS) {
    return {
      name,
      activities: stats.activities,
      metric: stats.linesKnown ? "lines" : "commits",
      groupKind: "authors",
      truncated: stats.contributors >= MAX_REPORTED_CONTRIBUTORS,
      sourceKind: "github",
      granularity: "week",
      rhythm,
    };
  }

  const activities = [...firstPage.activities];
  const lastPage = Math.min(firstPage.lastPage, MAX_PAGES);
  const remaining = Array.from({ length: lastPage - 1 }, (_, index) => index + 2);
  let fetched = activities.length;
  await inParallel(remaining, PAGE_CONCURRENCY, async (page) => {
    const result = await loadCommitPage(context, page, fetched);
    activities.push(...result.activities);
    fetched = activities.length;
    onProgress("Fetching commits", fetched, null);
  });

  if (activities.length === 0) {
    throw new Error("That repository has no commits to draw.");
  }
  activities.sort((a, b) => a.timestampMs - b.timestampMs);

  return {
    name,
    activities,
    metric: "commits",
    groupKind: "authors",
    truncated: firstPage.lastPage > MAX_PAGES,
    sourceKind: "github",
    granularity: "instant",
    rhythm,
  };
}

interface RequestContext {
  readonly base: string;
  readonly onProgress: LoadProgress;
  readonly signal: AbortSignal;
}

/**
 * Statistics make the picture better but are not what was asked for, so their
 * failure is not the load's failure. Only the visitor giving up gets through.
 */
async function optional<T>(request: Promise<T | null>, signal: AbortSignal): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return null;
  }
}

async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/* ------------------------------------------------------------------ *
 * The whole history, already counted
 * ------------------------------------------------------------------ */

interface WeeklyStats {
  readonly activities: ActivityRecord[];
  readonly contributors: number;
  readonly linesKnown: boolean;
  readonly spanWeeks: number;
}

async function loadWeeklyStats(context: RequestContext): Promise<WeeklyStats | null> {
  const url = new URL(`${context.base}/stats/contributors`);

  for (let attempt = 0; ; attempt += 1) {
    const response = await githubFetch({
      url,
      signal: context.signal,
      onProgress: context.onProgress,
      progressCount: 0,
      rateLimitMode: "fail",
    });
    if (response.status === 200) {
      return readWeeklyStats((await response.json()) as unknown);
    }
    // 202: still counting. 204: nothing to count.
    const wait = STATS_RETRY_DELAYS_MS[attempt];
    if (response.status !== 202 || wait === undefined) {
      return null;
    }
    context.onProgress("GitHub is counting this repository's history", 0, null);
    await delay(wait, context.signal);
  }
}

export function readWeeklyStats(body: unknown): WeeklyStats | null {
  if (!Array.isArray(body) || body.length === 0) {
    return null;
  }

  const rows: { who: string; weekMs: number; commits: number; lines: number }[] = [];
  let linesKnown = false;
  let firstWeek = Infinity;
  let lastWeek = -Infinity;

  for (const [index, entry] of body.entries()) {
    const contributor = asRecord(entry);
    const author = asRecord(contributor?.author);
    // Commits whose email matches no account still count; they just have no name.
    const who = typeof author?.login === "string" ? author.login : `unlinked author ${index + 1}`;
    const weeks = Array.isArray(contributor?.weeks) ? contributor.weeks : [];

    for (const value of weeks) {
      const week = asRecord(value);
      const startSeconds = typeof week?.w === "number" ? week.w : Number.NaN;
      const commits = typeof week?.c === "number" ? week.c : 0;
      if (!Number.isFinite(startSeconds) || commits <= 0) {
        continue;
      }
      const lines =
        (typeof week?.a === "number" ? week.a : 0) + (typeof week?.d === "number" ? week.d : 0);
      linesKnown = linesKnown || lines > 0;
      firstWeek = Math.min(firstWeek, startSeconds);
      lastWeek = Math.max(lastWeek, startSeconds);
      rows.push({ who, weekMs: startSeconds * 1000, commits, lines });
    }
  }

  if (rows.length === 0) {
    return null;
  }

  const activities = rows
    .map(
      (row): ActivityRecord => ({
        // GitHub's weeks begin on Sunday at midnight UTC. The middle of the
        // week is the fairest single instant to stand for all seven days.
        timestampMs: row.weekMs + 3.5 * DAY_MS,
        count: row.commits,
        // Past ten thousand commits GitHub stops counting lines and sends
        // zeros; those are "unknown", not "nothing changed".
        magnitude: linesKnown ? row.lines : null,
        nightCount: null,
        groupKey: row.who,
        detail:
          linesKnown && row.lines > 0
            ? {
                id: `${row.who}@${row.weekMs}`,
                summary: `${row.who} changed ${row.lines.toLocaleString("en")} lines in the week of ${formatWeek(row.weekMs)}`,
              }
            : null,
      }),
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);

  return {
    activities,
    contributors: body.length,
    linesKnown,
    spanWeeks: Math.round((lastWeek - firstWeek) / (7 * 86_400)) + 1,
  };
}

function formatWeek(weekMs: number): string {
  return new Date(weekMs).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The punch card counts commits by weekday and hour "based on the time zone
 * of individual commits" — the author's own clock, which the commit list does
 * not give. Summed over weekdays it is the rhythm the trunk leans by.
 */
async function loadPunchCard(context: RequestContext): Promise<HistoryRhythm | null> {
  const response = await githubFetch({
    url: new URL(`${context.base}/stats/punch_card`),
    signal: context.signal,
    onProgress: context.onProgress,
    progressCount: 0,
    rateLimitMode: "fail",
  });
  if (response.status !== 200) {
    return null;
  }
  return readPunchCard((await response.json()) as unknown);
}

export function readPunchCard(body: unknown): HistoryRhythm | null {
  if (!Array.isArray(body)) {
    return null;
  }
  const weights = Array<number>(24).fill(0);
  for (const cell of body) {
    if (!Array.isArray(cell)) {
      continue;
    }
    const hour = cell[1] as unknown;
    const commits = cell[2] as unknown;
    if (
      typeof hour === "number" &&
      Number.isInteger(hour) &&
      hour >= 0 &&
      hour < 24 &&
      typeof commits === "number" &&
      commits > 0
    ) {
      weights[hour] += commits;
    }
  }
  return weights.some((value) => value > 0) ? { dial: "hours", weights } : null;
}

/* ------------------------------------------------------------------ *
 * Commit by commit
 * ------------------------------------------------------------------ */

interface CommitPage {
  readonly activities: ActivityRecord[];
  /** From the Link header; 1 when everything fitted on this page. */
  readonly lastPage: number;
}

async function loadCommitPage(
  context: RequestContext,
  page: number,
  progressCount: number,
): Promise<CommitPage> {
  const url = new URL(`${context.base}/commits`);
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));

  const response = await githubFetch({
    url,
    signal: context.signal,
    onProgress: context.onProgress,
    progressCount,
  });

  const batch = (await response.json()) as unknown;
  if (!Array.isArray(batch)) {
    throw new Error("GitHub returned something unexpected.");
  }

  return {
    activities: batch
      .map((entry) => toActivity(entry))
      .filter((activity): activity is ActivityRecord => activity !== null),
    lastPage: Math.max(page, parseLastPage(response.headers.get("link"))),
  };
}

/** Reads `page=N` out of the `rel="last"` entry of a Link header. */
export function parseLastPage(link: string | null): number {
  if (!link) {
    return 1;
  }
  for (const part of link.split(",")) {
    if (!/rel="last"/.test(part)) {
      continue;
    }
    const match = /[?&]page=(\d+)/.exec(part);
    if (match) {
      return Number(match[1]);
    }
  }
  return 1;
}

/**
 * The list endpoint already returns more than the drawing needs. Keep only
 * when the commit happened and who authored it.
 */
function toActivity(entry: unknown): ActivityRecord | null {
  const record = asRecord(entry);
  const commit = asRecord(record?.commit);
  const author = asRecord(commit?.author);
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

  // This endpoint normalises every date to UTC, so the author's own hour is
  // gone. Claiming night work from a UTC hour would shade a Tokyo afternoon
  // dark; the weekday, at least, is only ever off by the edges of a day.
  const offset = hasExplicitOffset(dateText) ? parseIsoOffsetMinutes(dateText) : null;
  const clock = localClock(timestampMs, offset ?? 0);

  return {
    timestampMs,
    count: 1,
    magnitude: null,
    nightCount: offset === null ? null : isNightAt(timestampMs, offset) ? 1 : 0,
    groupKey: authorEmail,
    detail: null,
    localHour: offset === null ? null : clock.hour,
    weekday: clock.weekday,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** True for `+09:00` and `-05:30`, false for a bare `Z`. */
export function hasExplicitOffset(iso: string): boolean {
  return /[+-]\d{2}:\d{2}$/.test(iso);
}

/** The author's own offset, where GitHub kept it; zero for a date given in UTC. */
export function parseIsoOffsetMinutes(iso: string): number {
  const match = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}
