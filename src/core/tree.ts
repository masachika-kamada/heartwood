/**
 * Turns activity records into the geometry of a tree trunk cross-section.
 *
 * The mapping, in one place so it can be argued with:
 *   - one calendar period (month, or year for long histories) = one ring
 *   - ring thickness  <- the history's declared metric, damped by a log curve
 *   - ring darkness   <- share made at night, when the source knows it
 *   - ring hue        <- the group that dominated that period
 *   - pinched ring    <- a period with no activity at all
 *   - a scar          <- one measured change far larger than its neighbours
 */

import type {
  ActivityHistory,
  ActivityRecord,
  GroupTally,
  Ring,
  RingScar,
  TreeBuildOptions,
  TreeModel,
} from "./types";
import { hashString, mulberry32 } from "./prng";

const MIN_THICKNESS = 1.6;
const MAX_THICKNESS = 14;
const DORMANT_THICKNESS = 0.9;
const PITH_RADIUS = 6;

/** Above this many periods we switch from monthly to yearly rings. */
const MONTHLY_RING_LIMIT = 132;

export function buildTree(history: ActivityHistory, options: TreeBuildOptions = {}): TreeModel {
  const activities = [...history.activities].sort((a, b) => a.timestampMs - b.timestampMs);
  const seed = options.seed ?? history.name;
  if (activities.length === 0) {
    return {
      name: history.name,
      rings: [],
      firstActivityMs: 0,
      lastActivityMs: 0,
      totalActivities: 0,
      metric: history.metric,
      groupKind: history.groupKind,
      groups: [],
      hasNightData: false,
      hasOutlierData: false,
      truncated: history.truncated,
      sourceKind: history.sourceKind,
    };
  }

  const firstActivityMs = activities[0]!.timestampMs;
  const lastActivityMs = activities[activities.length - 1]!.timestampMs;
  const period = options.period ?? choosePeriod(firstActivityMs, lastActivityMs);
  const buckets = bucketByPeriod(
    activities,
    firstActivityMs,
    lastActivityMs,
    period,
    history.metric,
  );

  const volumes = buckets.map((bucket) => bucket.volume);
  const referenceVolume = percentile(volumes.filter((value) => value > 0), 0.9) || 1;
  const scarsByBucket = chooseScars(buckets, activities, seed, history.metric);

  const rings: Ring[] = [];
  let radius = PITH_RADIUS;

  for (const [index, bucket] of buckets.entries()) {
    const dormant = bucket.activityCount === 0;
    const thickness = dormant
      ? DORMANT_THICKNESS
      : clamp(
          MIN_THICKNESS +
            (MAX_THICKNESS - MIN_THICKNESS) *
              Math.log1p(bucket.volume / referenceVolume) /
              Math.log1p(3),
          MIN_THICKNESS,
          MAX_THICKNESS,
        );

    radius += thickness;

    const dominant = dominantOf(bucket.groups);

    rings.push({
      index,
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      label: formatPeriod(bucket.startMs, period),
      activityCount: bucket.activityCount,
      volume: bucket.volume,
      thickness,
      outerRadius: radius,
      nightRatio:
        bucket.timedActivityCount === 0 ? null : bucket.nightCount / bucket.timedActivityCount,
      groupCount: bucket.groups.size,
      dominantGroup: dominant.key,
      dominantShare:
        bucket.activityCount === 0 ? 0 : dominant.count / bucket.activityCount,
      dormant,
      scars: scarsByBucket.get(index) ?? [],
    });
  }

  return {
    name: history.name,
    rings,
    firstActivityMs,
    lastActivityMs,
    totalActivities: activities.reduce((sum, activity) => sum + activity.count, 0),
    metric: history.metric,
    groupKind: history.groupKind,
    groups: tallyGroups(activities),
    hasNightData: activities.some((activity) => activity.nightCount !== null),
    hasOutlierData:
      history.metric === "lines" &&
      activities.some((activity) => activity.magnitude !== null && activity.detail !== null),
    truncated: history.truncated,
    sourceKind: history.sourceKind,
  };
}

/* ------------------------------------------------------------------ *
 * Bucketing
 * ------------------------------------------------------------------ */

interface Bucket {
  readonly startMs: number;
  readonly endMs: number;
  readonly activities: ActivityRecord[];
  activityCount: number;
  volume: number;
  nightCount: number;
  timedActivityCount: number;
  readonly groups: Map<string, number>;
}

export function choosePeriod(firstMs: number, lastMs: number): "month" | "year" {
  const months = monthsBetween(new Date(firstMs), new Date(lastMs));
  return months > MONTHLY_RING_LIMIT ? "year" : "month";
}

function bucketByPeriod(
  activities: readonly ActivityRecord[],
  firstMs: number,
  lastMs: number,
  period: "month" | "year",
  metric: ActivityHistory["metric"],
): Bucket[] {
  const buckets: Bucket[] = [];
  const keyed = new Map<string, Bucket>();

  let cursor = startOfPeriod(new Date(firstMs), period);
  const end = startOfPeriod(new Date(lastMs), period);

  // Empty periods must exist as rings; a gap in the work is part of the story.
  while (cursor.getTime() <= end.getTime()) {
    const next = advancePeriod(cursor, period);
    const bucket: Bucket = {
      startMs: cursor.getTime(),
      endMs: next.getTime(),
      activities: [],
      activityCount: 0,
      volume: 0,
      nightCount: 0,
      timedActivityCount: 0,
      groups: new Map(),
    };
    buckets.push(bucket);
    keyed.set(periodKey(cursor, period), bucket);
    cursor = next;
  }

  for (const activity of activities) {
    const key = periodKey(startOfPeriod(new Date(activity.timestampMs), period), period);
    const bucket = keyed.get(key);
    if (!bucket) {
      continue;
    }
    bucket.activities.push(activity);
    bucket.activityCount += activity.count;
    bucket.volume += volumeOf(activity, metric);
    if (activity.nightCount !== null) {
      bucket.nightCount += activity.nightCount;
      bucket.timedActivityCount += activity.count;
    }
    if (activity.groupKey) {
      bucket.groups.set(
        activity.groupKey,
        (bucket.groups.get(activity.groupKey) ?? 0) + activity.count,
      );
    }
  }

  return buckets;
}

function startOfPeriod(date: Date, period: "month" | "year"): Date {
  return period === "year"
    ? new Date(date.getFullYear(), 0, 1)
    : new Date(date.getFullYear(), date.getMonth(), 1);
}

function advancePeriod(date: Date, period: "month" | "year"): Date {
  return period === "year"
    ? new Date(date.getFullYear() + 1, 0, 1)
    : new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

function periodKey(date: Date, period: "month" | "year"): string {
  return period === "year"
    ? String(date.getFullYear())
    : `${date.getFullYear()}-${date.getMonth()}`;
}

function formatPeriod(ms: number, period: "month" | "year"): string {
  const date = new Date(ms);
  if (period === "year") {
    return String(date.getFullYear());
  }
  const month = date.toLocaleString("en", { month: "short" });
  return `${month} ${date.getFullYear()}`;
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/* ------------------------------------------------------------------ *
 * Measures
 * ------------------------------------------------------------------ */

/**
 * The declared width metric. Missing line counts stay missing; count-based
 * histories use their represented activity count directly.
 */
export function volumeOf(
  activity: ActivityRecord,
  metric: ActivityHistory["metric"],
): number {
  return metric === "lines" ? (activity.magnitude ?? 0) : activity.count;
}

/**
 * Scars are chosen across the whole history, not per period. Picking the
 * biggest few changes of every month meant a busy project ended up speckled
 * with a hundred marks, which says nothing — a scar has to be rare to mean
 * "this one was different".
 */
const MAX_SCARS = 7;

function chooseScars(
  buckets: readonly Bucket[],
  activities: readonly ActivityRecord[],
  seed: string,
  metric: ActivityHistory["metric"],
): Map<number, RingScar[]> {
  const byBucket = new Map<number, RingScar[]>();
  if (metric !== "lines" || activities.length === 0) {
    return byBucket;
  }

  const measurable = activities.filter(
    (activity) => activity.magnitude !== null && activity.detail !== null,
  );
  const median = percentile(measurable.map((activity) => activity.magnitude ?? 0), 0.5) || 1;
  const largest = measurable.reduce(
    (max, activity) => Math.max(max, activity.magnitude ?? 0),
    0,
  );
  if (largest <= 0) {
    return byBucket;
  }

  const bucketOf = new Map<ActivityRecord, number>();
  for (const [index, bucket] of buckets.entries()) {
    for (const activity of bucket.activities) {
      bucketOf.set(activity, index);
    }
  }

  const candidates = measurable
    .filter((activity) => (activity.magnitude ?? 0) > Math.max(median * 12, 400))
    .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0))
    .slice(0, MAX_SCARS);

  // Seeded by the event itself, so a scar sits in the same place every time
  // regardless of what else is in the history.
  for (const activity of candidates) {
    const index = bucketOf.get(activity);
    if (index === undefined || !activity.detail) {
      continue;
    }
    const random = mulberry32(hashString(seed + activity.detail.id));
    const scars = byBucket.get(index) ?? [];
    scars.push({
      angle: random() * Math.PI * 2,
      severity: clamp((activity.magnitude ?? 0) / largest, 0.2, 1),
      id: activity.detail.id,
      summary: activity.detail.summary,
    });
    byBucket.set(index, scars);
  }

  return byBucket;
}

function dominantOf(
  groups: ReadonlyMap<string, number>,
): { key: string | null; count: number } {
  let key: string | null = null;
  let count = 0;
  for (const [candidate, tally] of groups) {
    if (tally > count) {
      key = candidate;
      count = tally;
    }
  }
  return { key, count };
}

function tallyGroups(activities: readonly ActivityRecord[]): GroupTally[] {
  const byKey = new Map<string, number>();
  for (const activity of activities) {
    if (!activity.groupKey) {
      continue;
    }
    const existing = byKey.get(activity.groupKey);
    byKey.set(activity.groupKey, (existing ?? 0) + activity.count);
  }
  return [...byKey.entries()]
    .map(([key, activities]) => ({ key, activities }))
    .sort((a, b) => b.activities - a.activities);
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower]!;
  }
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
