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
  /**
   * Hour of the day in the author's own timezone, 0 <= hour < 24. Only sources
   * that keep the author's UTC offset can say this.
   */
  readonly localHour?: number | null;
  /** Day of the week, 0 = Monday … 6 = Sunday, when the source knows the date. */
  readonly weekday?: number | null;
}

/** The finest step of time a source can honestly place an activity in. */
export type ActivityGranularity = "instant" | "day" | "week";

/** Which daily or weekly cycle is wrapped around the trunk. */
export type DialKind = "hours" | "weekdays" | "none";

/**
 * A rhythm measured over the whole history rather than per record, e.g.
 * GitHub's punch card. `weights` has 24 entries for hours, 7 for weekdays.
 */
export interface HistoryRhythm {
  readonly dial: "hours" | "weekdays";
  readonly weights: readonly number[];
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
  /** Rings are never finer than this. Defaults to "instant". */
  readonly granularity?: ActivityGranularity;
  /** Used for the trunk's lean when individual records carry no timing. */
  readonly rhythm?: HistoryRhythm | null;
  /** True when some counts are estimates spread over a stretch of time. */
  readonly estimated?: boolean;
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

/** One growth ring: a day, week, month, quarter or year of activity. */
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
   * Absolute radii from the pith, sampled clockwise starting at 12 o'clock.
   * A ring is thicker toward the part of the dial where its work happened, so
   * every ring sits on the wood already laid down inside it.
   */
  readonly contour: readonly number[];
  /** 0..1 share made at night, or null when the source has no time-of-day data. */
  readonly nightRatio: number | null;
  /** 0..1 share made on Saturday or Sunday, or null when dates are too coarse. */
  readonly weekendRatio: number | null;
  /**
   * 0..1 share of dense, dark wood in this ring: night work when hours are
   * known, weekend work when only dates are, null when neither is.
   */
  readonly shade: number | null;
  /** 0..1: how much of this ring is living sapwood, i.e. the last year. */
  readonly sapwood: number;
  /** Set on the first ring of a calendar year (or month, for daily rings). */
  readonly mark: string | null;
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
  readonly period: RingPeriod;
  /** The cycle wrapped around the trunk, which decides where it grows thick. */
  readonly dial: DialKind;
  /** Share of all activity in each dial bin; empty when there is no dial. */
  readonly dialWeights: readonly number[];
  /** What dark wood stands for in this tree. */
  readonly shadeKind: ShadeKind;
  readonly estimated: boolean;
}

export type ShadeKind = "night" | "weekend" | "none";

export interface GroupTally {
  readonly key: string;
  readonly activities: number;
}

export type RingPeriod = "day" | "week" | "month" | "quarter" | "year";

export interface TreeBuildOptions {
  readonly period?: RingPeriod;
  /** "Now", for deciding which rings are still sapwood. Defaults to the clock. */
  readonly nowMs?: number;
}
