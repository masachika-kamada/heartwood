/**
 * Turns a flat commit history into the geometry of a tree trunk cross-section.
 *
 * The mapping, in one place so it can be argued with:
 *   - one calendar period (month, or year for long histories) = one ring
 *   - ring thickness  <- how much code changed (churn), damped by a log curve
 *   - ring darkness   <- share of commits made at night
 *   - ring hue        <- the author who dominated that period
 *   - pinched ring    <- a period with no commits at all
 *   - a scar          <- a single commit far larger than its neighbours
 */

import type {
  AuthorTally,
  CommitRecord,
  RepoHistory,
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

export function buildTree(history: RepoHistory, options: TreeBuildOptions = {}): TreeModel {
  const commits = [...history.commits].sort((a, b) => a.timestampMs - b.timestampMs);
  const seed = options.seed ?? history.name;
  if (commits.length === 0) {
    return {
      name: history.name,
      rings: [],
      firstCommitMs: 0,
      lastCommitMs: 0,
      totalCommits: 0,
      totalChurn: 0,
      authors: [],
      truncated: history.truncated,
      sourceKind: history.sourceKind,
    };
  }

  const firstCommitMs = commits[0]!.timestampMs;
  const lastCommitMs = commits[commits.length - 1]!.timestampMs;
  const period = options.period ?? choosePeriod(firstCommitMs, lastCommitMs);
  const buckets = bucketByPeriod(commits, firstCommitMs, lastCommitMs, period);

  const churns = buckets.map((bucket) => bucket.churn);
  const referenceChurn = percentile(churns.filter((value) => value > 0), 0.9) || 1;
  const scarsByBucket = chooseScars(buckets, commits, seed);

  const rings: Ring[] = [];
  let radius = PITH_RADIUS;

  for (const [index, bucket] of buckets.entries()) {
    const dormant = bucket.commits.length === 0;
    const thickness = dormant
      ? DORMANT_THICKNESS
      : clamp(
          MIN_THICKNESS +
            (MAX_THICKNESS - MIN_THICKNESS) *
              Math.log1p(bucket.churn / referenceChurn) /
              Math.log1p(3),
          MIN_THICKNESS,
          MAX_THICKNESS,
        );

    radius += thickness;

    const dominant = dominantOf(bucket.authors);

    rings.push({
      index,
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      label: formatPeriod(bucket.startMs, period),
      commitCount: bucket.commits.length,
      churn: bucket.churn,
      thickness,
      outerRadius: radius,
      nightRatio: bucket.commits.length === 0 ? 0 : bucket.nightCount / bucket.commits.length,
      authorCount: bucket.authors.size,
      dominantAuthor: dominant.email,
      dominantShare:
        bucket.commits.length === 0 ? 0 : dominant.count / bucket.commits.length,
      dormant,
      scars: scarsByBucket.get(index) ?? [],
    });
  }

  return {
    name: history.name,
    rings,
    firstCommitMs,
    lastCommitMs,
    totalCommits: commits.length,
    totalChurn: commits.reduce((sum, commit) => sum + churnOf(commit), 0),
    authors: tallyAuthors(commits),
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
  readonly commits: CommitRecord[];
  churn: number;
  nightCount: number;
  readonly authors: Map<string, number>;
}

export function choosePeriod(firstMs: number, lastMs: number): "month" | "year" {
  const months = monthsBetween(new Date(firstMs), new Date(lastMs));
  return months > MONTHLY_RING_LIMIT ? "year" : "month";
}

function bucketByPeriod(
  commits: readonly CommitRecord[],
  firstMs: number,
  lastMs: number,
  period: "month" | "year",
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
      commits: [],
      churn: 0,
      nightCount: 0,
      authors: new Map(),
    };
    buckets.push(bucket);
    keyed.set(periodKey(cursor, period), bucket);
    cursor = next;
  }

  for (const commit of commits) {
    const key = periodKey(startOfPeriod(new Date(commit.timestampMs), period), period);
    const bucket = keyed.get(key);
    if (!bucket) {
      continue;
    }
    bucket.commits.push(commit);
    bucket.churn += churnOf(commit);
    if (isNightCommit(commit)) {
      bucket.nightCount += 1;
    }
    const email = commit.authorEmail || commit.authorName || "unknown";
    bucket.authors.set(email, (bucket.authors.get(email) ?? 0) + 1);
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
 * Churn for a commit. Sources that cannot diff report null, in which case a
 * commit still has to weigh something — otherwise a whole history of nulls
 * would draw a tree with no rings at all.
 */
export function churnOf(commit: CommitRecord): number {
  if (commit.insertions === null && commit.deletions === null) {
    return 12;
  }
  return (commit.insertions ?? 0) + (commit.deletions ?? 0);
}

/** Night is 22:00–05:00 in the author's own recorded timezone, not the viewer's. */
export function isNightCommit(commit: CommitRecord): boolean {
  const localMs = commit.timestampMs + commit.tzOffsetMinutes * 60_000;
  const hour = new Date(localMs).getUTCHours();
  return hour >= 22 || hour < 5;
}

/**
 * Scars are chosen across the whole history, not per period. Picking the
 * biggest few commits of every month meant a busy project ended up speckled
 * with a hundred marks, which says nothing — a scar has to be rare to mean
 * "this one was different".
 */
const MAX_SCARS = 7;

function chooseScars(
  buckets: readonly Bucket[],
  commits: readonly CommitRecord[],
  seed: string,
): Map<number, RingScar[]> {
  const byBucket = new Map<number, RingScar[]>();
  if (commits.length === 0) {
    return byBucket;
  }

  const median = percentile(commits.map(churnOf), 0.5) || 1;
  const largest = commits.reduce((max, commit) => Math.max(max, churnOf(commit)), 0);
  if (largest <= 0) {
    return byBucket;
  }

  const bucketOf = new Map<string, number>();
  for (const [index, bucket] of buckets.entries()) {
    for (const commit of bucket.commits) {
      bucketOf.set(commit.sha, index);
    }
  }

  const candidates = commits
    .filter((commit) => churnOf(commit) > Math.max(median * 12, 400))
    .sort((a, b) => churnOf(b) - churnOf(a))
    .slice(0, MAX_SCARS);

  // Seeded by the commit itself, so a scar sits in the same place every time
  // regardless of what else is in the history.
  for (const commit of candidates) {
    const index = bucketOf.get(commit.sha);
    if (index === undefined) {
      continue;
    }
    const random = mulberry32(hashString(seed + commit.sha));
    const scars = byBucket.get(index) ?? [];
    scars.push({
      angle: random() * Math.PI * 2,
      severity: clamp(churnOf(commit) / largest, 0.2, 1),
      sha: commit.sha,
      summary: commit.summary,
    });
    byBucket.set(index, scars);
  }

  return byBucket;
}

function dominantOf(
  authors: ReadonlyMap<string, number>,
): { email: string | null; count: number } {
  let email: string | null = null;
  let count = 0;
  for (const [candidate, tally] of authors) {
    if (tally > count) {
      email = candidate;
      count = tally;
    }
  }
  return { email, count };
}

function tallyAuthors(commits: readonly CommitRecord[]): AuthorTally[] {
  const byEmail = new Map<string, { name: string; commits: number }>();
  for (const commit of commits) {
    const email = commit.authorEmail || commit.authorName || "unknown";
    const existing = byEmail.get(email);
    if (existing) {
      existing.commits += 1;
    } else {
      byEmail.set(email, { name: commit.authorName || email, commits: 1 });
    }
  }
  return [...byEmail.entries()]
    .map(([email, value]) => ({ email, name: value.name, commits: value.commits }))
    .sort((a, b) => b.commits - a.commits);
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
