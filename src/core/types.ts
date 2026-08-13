/**
 * Shared contracts for Heartwood.
 *
 * Every data source (local `.git` directory, GitHub API, demo fixture) produces
 * a `RepoHistory`. Every renderer consumes one. Nothing else crosses the line,
 * so sources and renderers can evolve independently.
 */

/** A single commit, reduced to what the drawing actually needs. */
export interface CommitRecord {
  readonly sha: string;
  /** Author time in epoch milliseconds. */
  readonly timestampMs: number;
  /** Minutes offset from UTC, as recorded by the author's machine. */
  readonly tzOffsetMinutes: number;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly summary: string;
  readonly parents: readonly string[];
  /**
   * Size of the change. Null when the source cannot afford to diff
   * (the GitHub list endpoint, for example, omits per-commit stats).
   */
  readonly insertions: number | null;
  readonly deletions: number | null;
}

export interface RepoHistory {
  /** Display name, e.g. "heartwood" or "octocat/hello-world". */
  readonly name: string;
  /** Ordered oldest first. */
  readonly commits: readonly CommitRecord[];
  /** True when the source deliberately stopped early. */
  readonly truncated: boolean;
  readonly sourceKind: HistorySourceKind;
}

export type HistorySourceKind = "local" | "github" | "demo";

/** Progress callback shared by every loader. */
export type LoadProgress = (phase: string, done: number, total: number | null) => void;

export interface HistorySource {
  readonly kind: HistorySourceKind;
  load(onProgress: LoadProgress, signal: AbortSignal): Promise<RepoHistory>;
}

/* ------------------------------------------------------------------ *
 * Derived model: the tree
 * ------------------------------------------------------------------ */

/** One growth ring. By default a ring is a calendar month of activity. */
export interface Ring {
  readonly index: number;
  /** Inclusive start of the period, epoch ms. */
  readonly startMs: number;
  /** Exclusive end of the period, epoch ms. */
  readonly endMs: number;
  readonly label: string;
  readonly commitCount: number;
  /** Total churn (insertions + deletions) across the period. */
  readonly churn: number;
  /** Ring thickness in world units, derived from churn and commit count. */
  readonly thickness: number;
  /** Outer radius after layout, in world units. */
  readonly outerRadius: number;
  /** 0..1, share of commits made between 22:00 and 05:00 local author time. */
  readonly nightRatio: number;
  /** Distinct author emails active during the period. */
  readonly authorCount: number;
  /** Dominant author email, or null when the period is empty. */
  readonly dominantAuthor: string | null;
  /**
   * 0..1 share of the period's commits made by the dominant author. A month
   * carried by one person tints strongly; a month spread across forty people
   * barely tints at all, because "who owned it" is not a meaningful question.
   */
  readonly dominantShare: number;
  /** True when no commits landed: drawn as a narrow, pale, pinched ring. */
  readonly dormant: boolean;
  /** Commits whose churn is a strong outlier: drawn as scars. */
  readonly scars: readonly RingScar[];
}

export interface RingScar {
  /** Angle in radians where the scar sits. */
  readonly angle: number;
  /** 0..1 severity, relative to the largest change in the whole history. */
  readonly severity: number;
  readonly sha: string;
  readonly summary: string;
}

export interface TreeModel {
  readonly name: string;
  readonly rings: readonly Ring[];
  readonly firstCommitMs: number;
  readonly lastCommitMs: number;
  readonly totalCommits: number;
  readonly totalChurn: number;
  /** Author emails ordered by commit count, most active first. */
  readonly authors: readonly AuthorTally[];
  readonly truncated: boolean;
  readonly sourceKind: HistorySourceKind;
}

export interface AuthorTally {
  readonly email: string;
  readonly name: string;
  readonly commits: number;
}

export type RingPeriod = "month" | "year";

export interface TreeBuildOptions {
  readonly period?: RingPeriod;
  /** Deterministic seed so the same repository always draws the same tree. */
  readonly seed?: string;
}
