/**
 * "How to read it", written for the tree that is actually on screen.
 *
 * A fixed legend would have to describe marks this particular history does not
 * have — night shading for a source that only knows dates, scars for one that
 * never measured a change. Each line here exists only when the drawing shows
 * the thing it explains.
 */

import type { RingPeriod, TreeModel } from "../core/types";
import { activityNoun } from "../core/activity";

export interface ReadingItem {
  /** Picks the small swatch drawn beside the line. */
  readonly kind: "width" | "lean" | "shade" | "sapwood" | "seam" | "scar" | "timber" | "marks";
  readonly title: string;
  readonly text: string;
}

const PERIOD_NOUN: Readonly<Record<RingPeriod, string>> = {
  day: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

const WEEKDAY_NAMES = [
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
  "Sundays",
];

export function readingFor(tree: TreeModel): ReadingItem[] {
  if (tree.rings.length === 0) {
    return [];
  }
  const noun = activityNoun(tree.metric);
  const period = PERIOD_NOUN[tree.period];
  const items: ReadingItem[] = [];

  items.push({
    kind: "width",
    title: `One ring, one ${period}`,
    text:
      tree.metric === "lines"
        ? `A wide ring is a ${period} when a lot of code changed. The ring length is chosen from the age of the history, so a young trunk is drawn closer up, not thinner.`
        : `A wide ring is a ${period} with many ${noun}. The ring length is chosen from the age of the history, so a young trunk is drawn closer up, not thinner.`,
  });

  const peak = peakOf(tree);
  if (tree.dial === "hours") {
    items.push({
      kind: "lean",
      title: "The lean is the hours",
      text: `The trunk is wrapped around a 24-hour dial, noon at the top and midnight at the bottom, and every ring grows thickest toward the hours its work was done in. This one leans toward ${peak}.`,
    });
  } else if (tree.dial === "weekdays") {
    items.push({
      kind: "lean",
      title: "The lean is the week",
      text: `The trunk is wrapped around the week, Wednesday at the top and the weekend at the bottom, and every ring grows thickest toward the days its work was done on. This one leans toward ${peak}.`,
    });
  }

  if (tree.shadeKind === "night") {
    items.push({
      kind: "shade",
      title: "Dark wood is night work",
      text: "The dense, dark part of a ring is the share done between 22:00 and 05:00, in the author's own timezone.",
    });
  } else if (tree.shadeKind === "weekend") {
    items.push({
      kind: "shade",
      title: "Dark wood is weekend work",
      text: "The dense, dark part of a ring is the share done on a Saturday or Sunday.",
    });
  }

  const living = tree.rings.some((ring) => ring.sapwood > 0);
  const settled = tree.rings.some((ring) => ring.sapwood < 1);
  items.push({
    kind: "sapwood",
    title: living ? "Sapwood and heartwood" : "All heartwood",
    text: !living
      ? "There is no pale outer band, because nothing has grown here in the last twelve months."
      : settled
        ? "The pale outer band is the last twelve months: sapwood, still growing. Everything inside it has settled into heartwood."
        : "The whole trunk is pale because all of it is less than a year old: sapwood, still growing.",
  });

  if (tree.rings.some((ring) => ring.dormant)) {
    items.push({
      kind: "seam",
      title: "A tight seam is a silence",
      text: `Where rings crowd into a thin dark line, there were no ${noun} at all.`,
    });
  }

  if (tree.rings.some((ring) => ring.scars.length > 0)) {
    items.push({
      kind: "scar",
      title: "A crack is one outsized change",
      text: "A split across the rings is a single change far larger than everything around it, still open in the wood laid down afterwards.",
    });
  }

  if (tree.groupKind !== "none" && tree.groups.length > 1) {
    items.push({
      kind: "timber",
      title: "The timber changes hands",
      text:
        tree.groupKind === "repositories"
          ? "The colour of the wood follows whichever repository took most of that ring."
          : "The colour of the wood follows whoever committed most in that ring.",
    });
  }

  if (tree.rings.some((ring) => ring.mark !== null)) {
    items.push({
      kind: "marks",
      title: "Pencil marks count the time",
      text:
        tree.period === "day"
          ? "The ruled line runs from the first day to the last, with a tick where each month begins."
          : "The ruled line runs from the first ring to the last, with a tick where each year begins.",
    });
  }

  return items;
}

/** Where on the dial the most work happened, in words. */
export function peakOf(tree: TreeModel): string {
  const weights = tree.dialWeights;
  if (tree.dial === "none" || weights.length === 0) {
    return "";
  }
  if (tree.dial === "weekdays") {
    const day = weights.indexOf(Math.max(...weights));
    return WEEKDAY_NAMES[day] ?? "";
  }
  // Three-hour windows: a single busy hour next to two empty ones is a spike,
  // not the time of day somebody works.
  let best = 0;
  let bestSum = -1;
  for (let hour = 0; hour < weights.length; hour += 1) {
    const sum =
      weights[(hour + weights.length - 1) % weights.length]! +
      weights[hour]! +
      weights[(hour + 1) % weights.length]!;
    if (sum > bestSum) {
      bestSum = sum;
      best = hour;
    }
  }
  return `${String(best).padStart(2, "0")}:00–${String((best + 1) % 24).padStart(2, "0")}:00`;
}
