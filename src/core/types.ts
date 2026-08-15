/**
 * Shared contracts for Heartwood.
 *
 * Every data source produces an `ActivityHistory`. A record may represent one
 * commit or an already-aggregated set of commits; renderers do not need the
 * transport-level SHA, message, parents, or API response shape.
 */

/** A parsed git commit used internally by the local object walker. */
export interface CommitRecord {
  readonly sha: string;
  readonly timestampMs: number;
  readonly tzOffsetMinutes: number;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly parents: readonly string[];
}

export type ActivityMetric = "lines" | "commits" | "contributions";
export type ActivityGroupKind = "authors" | "repositories" | "none";

export interface ActivityDetail {
  readonly id: string;
  readonly summary: string;
}

/**
 * The smallest useful drawing input. `count` can be greater than one when an
 * API already grouped several commits on the same date and repository.
 */
export interface ActivityRecord {
  readonly timestampMs: number;
  readonly count: number;
  /** Total changed lines represented by this record, when the source knows it. */
  readonly magnitude: number | null;
  /** Number of represented activities made at night, or null when unavailable. */
  readonly nightCount: number | null;
  readonly groupKey: string | null;
  /** Present only when one concrete event can become a visible scar. */
  readonly detail: ActivityDetail | null;
}

export interface ActivityHistory {
  readonly name: string;
  readonly activities: readonly ActivityRecord[];
  /** What controls ring width. */
  readonly metric: ActivityMetric;
  /** What controls hue. */
  readonly groupKind: ActivityGroupKind;
  readonly truncated: boolean;
  readonly sourceKind: HistorySourceKind;
}

export type HistorySourceKind = "local" | "github" | "demo";

/** Progress callback shared by every loader. */
export type LoadProgress = (phase: string, done: number, total: number | null) => void;

export interface HistorySource {
  readonly kind: HistorySourceKind;
  load(onProgress: LoadProgress, signal: AbortSignal): Promise<ActivityHistory>;
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
  readonly activityCount: number;
  /** Lines, commits, or contributions, according to the tree metric. */
  readonly volume: number;
  readonly thickness: number;
  /** Largest outer radius after data-driven contour layout, in world units. */
  readonly outerRadius: number;
  /**
   * Absolute radii sampled clockwise around the ring, starting at 12 o'clock.
   * Activity timing shapes local growth; every outer ring inherits the wood
   * already laid down inside it.
   */
  readonly contour: readonly number[];
  /** 0..1 share made at night, or null when the source has no time-of-day data. */
  readonly nightRatio: number | null;
  readonly groupCount: number;
  readonly dominantGroup: string | null;
  /**
   * 0..1 share of the period's activity made by the dominant group. A month
   * carried by one group tints strongly; a month spread across forty groups
   * barely tints at all, because "who owned it" is not a meaningful question.
   */
  readonly dominantShare: number;
  /** True when no activity landed: drawn as a narrow, pale, pinched ring. */
  readonly dormant: boolean;
  /** Concrete changes whose magnitude is a strong outlier: drawn as scars. */
  readonly scars: readonly RingScar[];
}

export interface RingScar {
  /** Angle in radians where the scar sits. */
  readonly angle: number;
  /** 0..1 severity, relative to the largest change in the whole history. */
  readonly severity: number;
  readonly id: string;
  readonly summary: string;
}

export interface TreeModel {
  readonly name: string;
  readonly rings: readonly Ring[];
  readonly firstActivityMs: number;
  readonly lastActivityMs: number;
  readonly totalActivities: number;
  readonly metric: ActivityMetric;
  readonly groupKind: ActivityGroupKind;
  readonly groups: readonly GroupTally[];
  readonly hasNightData: boolean;
  readonly hasOutlierData: boolean;
  readonly truncated: boolean;
  readonly sourceKind: HistorySourceKind;
}

export interface GroupTally {
  readonly key: string;
  readonly activities: number;
}

export type RingPeriod = "month" | "year";

export interface TreeBuildOptions {
  readonly period?: RingPeriod;
}
