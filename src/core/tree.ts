/**
 * Turns activity records into the geometry of a tree trunk cross-section.
 *
 * The mapping, in one place so it can be argued with:
 *   - one period (day, week, month, quarter or year, chosen so that a young
 *     history and an old one both make a readable trunk) = one ring
 *   - ring thickness  <- the history's declared metric, damped by a log curve
 *   - where it is thick <- the hours (or weekdays) the work was done in. The
 *     dial is fixed, so a habit kept for years adds up to a trunk that leans
 *   - dense dark wood <- share made at night, or at weekends when only dates
 *     are known
 *   - ring hue        <- the group that dominated that period
 *   - pale outer band <- the last twelve months: sapwood, still alive
 *   - pinched ring    <- a period with no activity at all
 *   - a scar          <- one measured change far larger than its neighbours
 */

import type {
  ActivityGranularity,
  ActivityHistory,
  ActivityRecord,
  DialKind,
  GroupTally,
  Ring,
  RingPeriod,
  RingScar,
  ShadeKind,
  TreeBuildOptions,
  TreeModel,
} from "./types";
import { hashString, mulberry32 } from "./prng";

const MIN_THICKNESS = 1.6;
const MAX_THICKNESS = 14;
const DORMANT_THICKNESS = 0.8;
const MAX_SILENT_SHARE = 0.2;
const PITH_RADIUS = 5;
export const CONTOUR_SAMPLES = 180;

/**
 * How far the rhythm may pull one ring out of round. A ring is at most this
 * much thicker on its busy side and thinner on its quiet one, which over a
 * whole trunk moves the pith visibly off-centre without ever making a blob.
 */
const LEAN_STRENGTH = 0.2;
/** Rings with fewer activities than this mostly follow the whole-history rhythm. */
const RHYTHM_PRIOR = 10;
/** How quickly a change of habit shows; the rest is carried over from the ring inside. */
const RHYTHM_FOLLOW = 0.45;
/** Width of the brush that spreads one dial bin around the trunk. */
const RHYTHM_SHARPNESS = 4;
/**
 * Grain, not data: a few low waves, seeded by the name, so that two trunks
 * with the same rhythm are still two different pieces of wood. Small enough
 * that the lean above is always the larger effect.
 */
const GRAIN_WOBBLE = 0.032;
/**
 * And a smaller, different wave in every ring, so that neighbours are not
 * exact copies of each other pushed outward. Rings in real wood drift.
 */
const RING_DRIFT = 0.045;

/** Below this share of rings with any activity, the period is too fine. */
const SPARSE_SHARE = 0.25;
const MIN_RINGS_WHEN_COARSENED = 12;
const COARSER: Readonly<Partial<Record<RingPeriod, RingPeriod>>> = {
  day: "week",
  week: "month",
  month: "quarter",
  quarter: "year",
};

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const SAPWOOD_FADE_MS = 90 * DAY_MS;

/**
 * A sampled history knows the hour of only some of its activities. A fifth of
 * them is still plenty to read a daily rhythm from; rings with none of their
 * own simply follow the whole history's.
 */
const RHYTHM_COVERAGE = 0.2;

const HOURS = 24;
const WEEKDAYS = 7;

export function buildTree(history: ActivityHistory, options: TreeBuildOptions = {}): TreeModel {
  const activities = [...history.activities].sort((a, b) => a.timestampMs - b.timestampMs);
  const granularity = history.granularity ?? "instant";
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
      period: options.period ?? "month",
      dial: "none",
      dialWeights: [],
      shadeKind: "none",
      estimated: history.estimated === true,
    };
  }

  const firstActivityMs = activities[0]!.timestampMs;
  const lastActivityMs = activities[activities.length - 1]!.timestampMs;
  let period =
    options.period ?? choosePeriod(firstActivityMs, lastActivityMs, granularity);
  let buckets = bucketByPeriod(
    activities,
    firstActivityMs,
    lastActivityMs,
    period,
    history.metric,
  );

  // The age of a history says how many rings fit; it does not say they are
  // used. Three busy days and three months of nothing would be ninety empty
  // rings around a dot, so a mostly silent trunk is redrawn one step coarser
  // for as long as that still leaves enough rings to read.
  while (options.period === undefined) {
    const active = buckets.filter((bucket) => bucket.activityCount > 0).length;
    const coarser = COARSER[period];
    if (active / buckets.length >= SPARSE_SHARE || !coarser) {
      break;
    }
    const fewer = bucketByPeriod(
      activities,
      firstActivityMs,
      lastActivityMs,
      coarser,
      history.metric,
    );
    if (fewer.length < MIN_RINGS_WHEN_COARSENED) {
      break;
    }
    period = coarser;
    buckets = fewer;
  }

  const volumes = buckets.map((bucket) => bucket.volume);
  const referenceVolume = percentile(volumes.filter((value) => value > 0), 0.9) || 1;
  const rhythm = measureRhythm(history, activities, buckets);
  const scarsByBucket = chooseScars(buckets, activities, history.metric, rhythm.dial);
  const wobble = grainWobble(history.name);
  const hasNightData = activities.some((activity) => activity.nightCount !== null);
  const shadeKind: ShadeKind = hasNightData
    ? "night"
    : rhythm.weekdayCoverage >= RHYTHM_COVERAGE && granularity !== "week"
      ? "weekend"
      : "none";
  const nowMs = options.nowMs ?? Date.now();
  // A dozen commits are not yet a habit, and three rings cannot average out
  // their own irregularities the way a hundred do. Both effects are eased in,
  // so a very young trunk is plain rather than lumpy.
  const leanStrength = LEAN_STRENGTH * (rhythm.observed / (rhythm.observed + 24));
  const driftStrength = RING_DRIFT * clamp(Math.sqrt(buckets.length / 50), 0.2, 1);

  // Silence is drawn as a seam, never as the bulk of the trunk: however many
  // empty periods there are, together they get at most a fifth of the wood.
  const thicknessOf = (bucket: Bucket): number =>
    clamp(
      MIN_THICKNESS +
        ((MAX_THICKNESS - MIN_THICKNESS) * Math.log1p(bucket.volume / referenceVolume)) /
          Math.log1p(3),
      MIN_THICKNESS,
      MAX_THICKNESS,
    );
  const active = buckets.filter((bucket) => bucket.activityCount > 0);
  const grown = active.reduce((sum, bucket) => sum + thicknessOf(bucket), 0);
  const silent = buckets.length - active.length;
  const dormantThickness =
    silent === 0
      ? DORMANT_THICKNESS
      : Math.min(DORMANT_THICKNESS, (grown * MAX_SILENT_SHARE) / (1 - MAX_SILENT_SHARE) / silent);

  const rings: Ring[] = [];
  let contour = wobble.start.map((value) => PITH_RADIUS * (1 + GRAIN_WOBBLE * value));
  let carried = rhythm.overall;

  for (const [index, bucket] of buckets.entries()) {
    const dormant = bucket.activityCount === 0;
    const thickness = dormant ? dormantThickness : thicknessOf(bucket);

    // A quiet ring has too few events to have a rhythm of its own, so it is
    // pulled toward the whole history; and no ring forgets the one inside it.
    if (rhythm.dial !== "none" && !dormant) {
      const own = blendWithPrior(rhythm.perBucket[index]!, rhythm.overall);
      carried = carried.map(
        (value, bin) => value + (own[bin]! - value) * RHYTHM_FOLLOW,
      );
    }

    const progress = buckets.length === 1 ? 0 : index / (buckets.length - 1);
    const growth = growthProfile(
      rhythm.dial === "none" || dormant ? null : carried,
      rhythm.kernel,
      wobble,
      progress,
      leanStrength,
      driftStrength,
    );
    contour = contour.map((radius, sample) => radius + thickness * growth[sample]!);

    const dominant = dominantOf(bucket.groups);
    const nightRatio =
      bucket.timedActivityCount === 0 ? null : bucket.nightCount / bucket.timedActivityCount;
    const weekendRatio =
      bucket.datedActivityCount === 0 || granularity === "week"
        ? null
        : bucket.weekendCount / bucket.datedActivityCount;

    rings.push({
      index,
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      label: formatPeriod(bucket.startMs, period),
      activityCount: bucket.activityCount,
      volume: bucket.volume,
      thickness,
      outerRadius: Math.max(...contour),
      contour,
      nightRatio,
      weekendRatio,
      shade:
        shadeKind === "night" ? nightRatio : shadeKind === "weekend" ? weekendRatio : null,
      sapwood: clamp((bucket.endMs - (nowMs - YEAR_MS)) / SAPWOOD_FADE_MS, 0, 1),
      mark: index === 0 ? null : markFor(buckets[index - 1]!, bucket, period),
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
    hasNightData,
    hasOutlierData:
      history.metric === "lines" &&
      activities.some((activity) => activity.magnitude !== null && activity.detail !== null),
    truncated: history.truncated,
    sourceKind: history.sourceKind,
    period,
    dial: rhythm.dial,
    dialWeights: rhythm.dial === "none" ? [] : rhythm.overall,
    shadeKind,
    estimated: history.estimated === true,
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
  weekendCount: number;
  datedActivityCount: number;
  readonly groups: Map<string, number>;
}

/**
 * Picks the ring period from the length of the history, so that the trunk has
 * somewhere between a dozen and about a hundred and forty rings whether it is
 * a month old or thirty years old. A young history is not drawn thinner than
 * an old one; it is drawn closer up.
 */
export function choosePeriod(
  firstMs: number,
  lastMs: number,
  granularity: ActivityGranularity = "instant",
): RingPeriod {
  const days = (lastMs - firstMs) / DAY_MS;
  if (granularity !== "week" && days <= 100) {
    return "day";
  }
  if (days <= 800) {
    return "week";
  }
  const months = monthsBetween(new Date(firstMs), new Date(lastMs));
  if (months <= 132) {
    return "month";
  }
  return months <= 420 ? "quarter" : "year";
}

function bucketByPeriod(
  activities: readonly ActivityRecord[],
  firstMs: number,
  lastMs: number,
  period: RingPeriod,
  metric: ActivityHistory["metric"],
): Bucket[] {
  const buckets: Bucket[] = [];
  const keyed = new Map<number, Bucket>();

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
      weekendCount: 0,
      datedActivityCount: 0,
      groups: new Map(),
    };
    buckets.push(bucket);
    keyed.set(bucket.startMs, bucket);
    cursor = next;
  }

  for (const activity of activities) {
    const bucket = keyed.get(startOfPeriod(new Date(activity.timestampMs), period).getTime());
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
    if (activity.weekday !== null && activity.weekday !== undefined) {
      bucket.datedActivityCount += activity.count;
      if (activity.weekday >= 5) {
        bucket.weekendCount += activity.count;
      }
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

function startOfPeriod(date: Date, period: RingPeriod): Date {
  const year = date.getFullYear();
  const month = date.getMonth();
  switch (period) {
    case "day":
      return new Date(year, month, date.getDate());
    case "week":
      // Weeks start on Monday, so a weekend is never split across two rings.
      return new Date(year, month, date.getDate() - ((date.getDay() + 6) % 7));
    case "month":
      return new Date(year, month, 1);
    case "quarter":
      return new Date(year, month - (month % 3), 1);
    case "year":
      return new Date(year, 0, 1);
  }
}

function advancePeriod(date: Date, period: RingPeriod): Date {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  switch (period) {
    case "day":
      return new Date(year, month, day + 1);
    case "week":
      return new Date(year, month, day + 7);
    case "month":
      return new Date(year, month + 1, 1);
    case "quarter":
      return new Date(year, month + 3, 1);
    case "year":
      return new Date(year + 1, 0, 1);
  }
}

function formatPeriod(ms: number, period: RingPeriod): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = date.toLocaleString("en", { month: "short" });
  switch (period) {
    case "day":
      return `${date.getDate()} ${month} ${year}`;
    case "week":
      return `Week of ${date.getDate()} ${month} ${year}`;
    case "month":
      return `${month} ${year}`;
    case "quarter":
      return `Q${Math.floor(date.getMonth() / 3) + 1} ${year}`;
    case "year":
      return String(year);
  }
}

/**
 * The label for the boundary a ring begins at, where that boundary is worth a
 * tick on the ruler: a new year, or a new month when rings are days.
 */
function markFor(previous: Bucket, bucket: Bucket, period: RingPeriod): string | null {
  // The last instant of a period says which year it reaches into, which is
  // what puts the mark on the week that contains the first of January.
  const before = new Date(previous.endMs - 1);
  const now = new Date(bucket.endMs - 1);
  if (period === "day") {
    return before.getMonth() === now.getMonth()
      ? null
      : now.toLocaleString("en", { month: "short" });
  }
  if (period === "year") {
    return now.getFullYear() % 5 === 0 ? String(now.getFullYear()) : null;
  }
  return before.getFullYear() === now.getFullYear() ? null : String(now.getFullYear());
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

/* ------------------------------------------------------------------ *
 * Rhythm: which way the trunk leans
 * ------------------------------------------------------------------ */

/**
 * Where a moment on the dial sits around the trunk, as a fraction of a turn
 * clockwise from the top. Both dials put the middle of ordinary working time
 * at the top and time off at the bottom: noon up and midnight down, Wednesday
 * up and the weekend down. A trunk that is heavy underneath was built after
 * hours, whichever dial drew it.
 */
export function dialFraction(dial: DialKind, position: number): number {
  if (dial === "hours") {
    return wrapUnit((position - 12) / HOURS);
  }
  if (dial === "weekdays") {
    return wrapUnit((position - 2) / WEEKDAYS);
  }
  return 0;
}

interface Rhythm {
  readonly dial: DialKind;
  /** Share of activity per dial bin over the whole history. Sums to 1. */
  readonly overall: readonly number[];
  /** Raw activity counts per dial bin, one row per bucket. */
  readonly perBucket: readonly (readonly number[])[];
  /** How much each dial bin feeds each contour sample. */
  readonly kernel: readonly (readonly number[])[];
  /** Share of activity whose weekday is known, for deciding on weekend shade. */
  readonly weekdayCoverage: number;
  /** How many activities the rhythm was measured from. */
  readonly observed: number;
}

function measureRhythm(
  history: ActivityHistory,
  activities: readonly ActivityRecord[],
  buckets: readonly Bucket[],
): Rhythm {
  let total = 0;
  let withHour = 0;
  let withWeekday = 0;
  for (const activity of activities) {
    total += activity.count;
    if (typeof activity.localHour === "number") {
      withHour += activity.count;
    }
    if (typeof activity.weekday === "number") {
      withWeekday += activity.count;
    }
  }
  const weekdayCoverage = total === 0 ? 0 : withWeekday / total;
  const none: Rhythm = {
    dial: "none",
    overall: [],
    perBucket: [],
    kernel: [],
    weekdayCoverage,
    observed: 0,
  };
  if (total === 0) {
    return none;
  }

  // Hours beat weekdays, and a reading taken from each record beats one taken
  // over the whole history, because only the former can change ring by ring.
  const measuredDial: DialKind =
    withHour / total >= RHYTHM_COVERAGE
      ? "hours"
      : history.rhythm?.dial === "hours"
        ? "none"
        : weekdayCoverage >= RHYTHM_COVERAGE && history.granularity !== "week"
          ? "weekdays"
          : "none";

  if (measuredDial === "none") {
    const given = history.rhythm;
    const sum = given?.weights.reduce((acc, value) => acc + Math.max(0, value), 0) ?? 0;
    if (!given || sum <= 0 || given.weights.length !== binsOf(given.dial)) {
      return none;
    }
    const overall = given.weights.map((value) => Math.max(0, value) / sum);
    return {
      dial: given.dial,
      overall,
      // Nothing is known per ring, so every ring grows to the same rhythm.
      perBucket: buckets.map(() => Array<number>(overall.length).fill(0)),
      kernel: dialKernel(given.dial),
      weekdayCoverage,
      observed: sum,
    };
  }

  const bins = binsOf(measuredDial);
  const totals = Array<number>(bins).fill(0);
  const perBucket = buckets.map((bucket) => {
    const counts = Array<number>(bins).fill(0);
    for (const activity of bucket.activities) {
      const position = measuredDial === "hours" ? activity.localHour : activity.weekday;
      if (typeof position !== "number" || !Number.isFinite(position)) {
        continue;
      }
      const bin = clamp(Math.floor(position), 0, bins - 1);
      counts[bin] += activity.count;
      totals[bin] += activity.count;
    }
    return counts;
  });
  const sum = totals.reduce((acc, value) => acc + value, 0) || 1;

  return {
    dial: measuredDial,
    overall: totals.map((value) => value / sum),
    perBucket,
    kernel: dialKernel(measuredDial),
    weekdayCoverage,
    observed: sum,
  };
}

function binsOf(dial: DialKind): number {
  return dial === "hours" ? HOURS : dial === "weekdays" ? WEEKDAYS : 0;
}

/** One ring's own distribution, steadied by the whole history's. */
function blendWithPrior(counts: readonly number[], overall: readonly number[]): number[] {
  const observed = counts.reduce((sum, value) => sum + value, 0);
  return counts.map(
    (value, bin) => (value + RHYTHM_PRIOR * overall[bin]!) / (observed + RHYTHM_PRIOR),
  );
}

/**
 * A wide, smooth brush for each dial bin. Wide on purpose: the eye reads a
 * trunk with one or two soft lobes as wood, and one with twenty-four small
 * bumps as a chart that has been bent into a circle.
 */
function dialKernel(dial: DialKind): number[][] {
  const bins = binsOf(dial);
  return Array.from({ length: CONTOUR_SAMPLES }, (_, sample) => {
    const sampleFraction = sample / CONTOUR_SAMPLES;
    return Array.from({ length: bins }, (_unused, bin) => {
      // Hours are spans, so their weight sits mid-span; a weekday is a point.
      const centre = dialFraction(dial, dial === "hours" ? bin + 0.5 : bin);
      const angle = (sampleFraction - centre) * Math.PI * 2;
      return Math.pow((1 + Math.cos(angle)) / 2, RHYTHM_SHARPNESS);
    });
  });
}

interface Wobble {
  readonly start: readonly number[];
  readonly end: readonly number[];
  /** Draws the next ring's own small wave: two [frequency, phase] pairs. */
  readonly drift: () => readonly (readonly [number, number])[];
}

/** Two slow wave patterns; the trunk drifts from one to the other as it ages. */
function grainWobble(name: string): Wobble {
  const random = mulberry32(hashString(`grain:${name}`));
  const pattern = (): number[] => {
    const waves = [2, 3, 4, 5, 6].map((frequency) => ({
      frequency,
      amplitude: (0.5 + random()) / frequency,
      phase: random() * Math.PI * 2,
    }));
    const values = Array.from({ length: CONTOUR_SAMPLES }, (_, sample) => {
      const angle = (sample / CONTOUR_SAMPLES) * Math.PI * 2;
      return waves.reduce(
        (sum, wave) => sum + wave.amplitude * Math.cos(angle * wave.frequency + wave.phase),
        0,
      );
    });
    const extent = Math.max(...values.map(Math.abs)) || 1;
    return values.map((value) => value / extent);
  };
  const start = pattern();
  const end = pattern();
  return {
    start,
    end,
    drift: () => [
      [3 + Math.floor(random() * 3), random() * Math.PI * 2],
      [6 + Math.floor(random() * 4), random() * Math.PI * 2],
    ],
  };
}

/**
 * How one ring's thickness is shared out around the trunk. The mean is always
 * exactly 1, so shape never changes how much wood a period is given.
 */
function growthProfile(
  distribution: readonly number[] | null,
  kernel: readonly (readonly number[])[],
  wobble: Wobble,
  progress: number,
  leanStrength: number,
  driftStrength: number,
): number[] {
  const lean = Array<number>(CONTOUR_SAMPLES).fill(0);

  if (distribution) {
    let mean = 0;
    for (let sample = 0; sample < CONTOUR_SAMPLES; sample += 1) {
      const row = kernel[sample]!;
      let value = 0;
      for (let bin = 0; bin < distribution.length; bin += 1) {
        value += distribution[bin]! * row[bin]!;
      }
      lean[sample] = value;
      mean += value;
    }
    mean /= CONTOUR_SAMPLES;
    for (let sample = 0; sample < CONTOUR_SAMPLES; sample += 1) {
      // tanh keeps a history that only ever happens at 3am from growing a horn.
      lean[sample] = mean === 0 ? 0 : Math.tanh(1.1 * (lean[sample]! / mean - 1));
    }
  }

  const drift = wobble.drift();
  const growth = lean.map((value, sample) => {
    const angle = (sample / CONTOUR_SAMPLES) * Math.PI * 2;
    const grain = wobble.start[sample]! * (1 - progress) + wobble.end[sample]! * progress;
    const own = drift.reduce(
      (sum, [frequency, phase]) => sum + Math.cos(angle * frequency + phase) / 2,
      0,
    );
    return (1 + leanStrength * value) * (1 + GRAIN_WOBBLE * grain + driftStrength * own);
  });
  const mean = growth.reduce((sum, value) => sum + value, 0) / growth.length;
  return growth.map((value) => value / mean);
}

function wrapUnit(value: number): number {
  return ((value % 1) + 1) % 1;
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
  metric: ActivityHistory["metric"],
  dial: DialKind,
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

  // Far beyond the ordinary, and also within sight of the largest: a trunk
  // with one great split should not be scratched all over by lesser ones.
  const candidates = measurable
    .filter(
      (activity) =>
        (activity.magnitude ?? 0) > Math.max(median * 12, 400) &&
        (activity.magnitude ?? 0) >= largest * 0.12,
    )
    .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0))
    .slice(0, MAX_SCARS);

  for (const activity of candidates) {
    const index = bucketOf.get(activity);
    if (index === undefined || !activity.detail) {
      continue;
    }
    const bucket = buckets[index]!;
    const periodFraction =
      (activity.timestampMs - bucket.startMs) / (bucket.endMs - bucket.startMs);
    // A scar sits where its moment falls on the dial, so that it lines up with
    // the lean around it; without a dial it falls back to when in the period.
    const turn =
      dial === "hours" && typeof activity.localHour === "number"
        ? dialFraction(dial, activity.localHour)
        : dial === "weekdays" && typeof activity.weekday === "number"
          ? dialFraction(dial, activity.weekday + (periodFraction - 0.5) * 0.6)
          : periodFraction;
    const scars = byBucket.get(index) ?? [];
    scars.push({
      angle: turn * Math.PI * 2 - Math.PI / 2,
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
