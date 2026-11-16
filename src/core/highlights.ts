/**
 * What stands out in a trunk, so that a reader does not have to find it.
 *
 * Rings are good at texture and poor at comparison: nobody can tell by eye
 * that one ring is the thickest of eighty. These are the handful of facts a
 * person would point at with a pin if the slice hung in a museum.
 */

import type { Ring, TreeModel } from "./types";

export interface Highlights {
  /** The ring that grew the most. */
  readonly peak: Ring | null;
  /** The longest run of rings with nothing in them, if there is a real one. */
  readonly quiet: { readonly from: Ring; readonly to: Ring; readonly rings: number } | null;
  /** The calendar year that grew the most, when the trunk spans several. */
  readonly busiestYear: { readonly year: number; readonly count: number } | null;
  /**
   * The last twelve months against the twelve before: 1.4 is 40% more.
   * Null when the trunk is too young to have both.
   */
  readonly trend: number | null;
}

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
/** A gap shorter than this is just a pause. */
const MIN_QUIET_RINGS = 2;

export function highlightsOf(tree: TreeModel): Highlights {
  const rings = tree.rings;
  if (rings.length === 0) {
    return { peak: null, quiet: null, busiestYear: null, trend: null };
  }

  let peak: Ring | null = null;
  for (const ring of rings) {
    if (!ring.dormant && (!peak || ring.activityCount > peak.activityCount)) {
      peak = ring;
    }
  }

  let quiet: Highlights["quiet"] = null;
  let runStart = -1;
  for (let index = 0; index <= rings.length; index += 1) {
    const dormant = rings[index]?.dormant ?? false;
    if (dormant && runStart === -1) {
      runStart = index;
    } else if (!dormant && runStart !== -1) {
      const length = index - runStart;
      // A run that reaches the bark is not over yet; it is not a "stretch".
      if (index < rings.length && length >= MIN_QUIET_RINGS && length > (quiet?.rings ?? 0)) {
        quiet = { from: rings[runStart]!, to: rings[index - 1]!, rings: length };
      }
      runStart = -1;
    }
  }

  const byYear = new Map<number, number>();
  for (const ring of rings) {
    const year = new Date(ring.startMs).getUTCFullYear();
    byYear.set(year, (byYear.get(year) ?? 0) + ring.activityCount);
  }
  let busiestYear: Highlights["busiestYear"] = null;
  if (byYear.size >= 3 && tree.period !== "year") {
    for (const [year, count] of byYear) {
      if (!busiestYear || count > busiestYear.count) {
        busiestYear = { year, count };
      }
    }
  }

  let trend: number | null = null;
  const end = rings[rings.length - 1]!.endMs;
  if (end - rings[0]!.startMs >= 2 * YEAR_MS) {
    let recent = 0;
    let before = 0;
    for (const ring of rings) {
      const middle = (ring.startMs + ring.endMs) / 2;
      if (middle >= end - YEAR_MS) {
        recent += ring.activityCount;
      } else if (middle >= end - 2 * YEAR_MS) {
        before += ring.activityCount;
      }
    }
    if (before > 0) {
      trend = recent / before;
    }
  }

  return { peak, quiet, busiestYear, trend };
}
