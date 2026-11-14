import { describe, expect, it } from "vitest";
import {
  buildTree,
  choosePeriod,
  clamp,
  CONTOUR_SAMPLES,
  dialFraction,
  percentile,
  volumeOf,
} from "./tree";
import { isNightAt } from "./activity";
import type {
  ActivityGroupKind,
  ActivityHistory,
  ActivityMetric,
  ActivityRecord,
  TreeModel,
} from "./types";

function activity(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    timestampMs: Date.UTC(2024, 0, 15, 12, 0),
    count: 1,
    magnitude: 15,
    nightCount: 0,
    groupKey: "wren@example.com",
    detail: { id: "a".repeat(40), summary: "Work" },
    ...overrides,
  };
}

function history(
  activities: ActivityRecord[],
  metric: ActivityMetric = "lines",
  groupKind: ActivityGroupKind = "authors",
): ActivityHistory {
  return {
    name: "test",
    activities,
    metric,
    groupKind,
    truncated: false,
    sourceKind: "demo",
  };
}

describe("volumeOf", () => {
  it("uses changed lines for a line-based history", () => {
    expect(volumeOf(activity({ magnitude: 42 }), "lines")).toBe(42);
  });

  it("uses represented activity count for a commit history", () => {
    expect(volumeOf(activity({ count: 7, magnitude: null }), "commits")).toBe(7);
  });
});

describe("isNightAt", () => {
  it("uses the author's timezone, not the viewer's", () => {
    const instant = Date.UTC(2024, 0, 15, 15, 0);
    expect(isNightAt(instant, 540)).toBe(true);
    expect(isNightAt(instant, -300)).toBe(false);
  });

  it("treats 22:00 and 04:59 as night but not 21:59 or 05:00", () => {
    const at = (hour: number): boolean => isNightAt(Date.UTC(2024, 0, 15, hour, 0), 0);
    expect(at(22)).toBe(true);
    expect(at(4)).toBe(true);
    expect(at(21)).toBe(false);
    expect(at(5)).toBe(false);
  });
});

describe("percentile", () => {
  it("interpolates between neighbours", () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
  });

  it("survives an empty list", () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("buildTree", () => {
  it("returns an empty model for an empty history", () => {
    const tree = buildTree(history([]));
    expect(tree.rings).toHaveLength(0);
    expect(tree.totalActivities).toBe(0);
  });

  it("creates one ring per month spanned, including silent months", () => {
    const tree = buildTree(
      history([
        activity({ timestampMs: new Date(2024, 0, 10).getTime() }),
        activity({ timestampMs: new Date(2024, 3, 10).getTime() }),
      ]),
      { period: "month" },
    );

    expect(tree.rings).toHaveLength(4);
    expect(tree.rings[1]!.dormant).toBe(true);
    expect(tree.rings[2]!.dormant).toBe(true);
  });

  it("grows radius monotonically outward", () => {
    const tree = buildTree(
      history(
        Array.from({ length: 40 }, (_, index) =>
          activity({
            timestampMs: new Date(2024, index % 12, 5).getTime(),
            magnitude: index * 30,
          }),
        ),
      ),
    );

    for (let index = 1; index < tree.rings.length; index += 1) {
      expect(tree.rings[index]!.outerRadius).toBeGreaterThan(
        tree.rings[index - 1]!.outerRadius,
      );
    }
  });

  it("gives a busier period a thicker ring for the declared metric", () => {
    const tree = buildTree(
      history([
        activity({ timestampMs: new Date(2024, 0, 5).getTime(), magnitude: 600 }),
        activity({ timestampMs: new Date(2024, 1, 5).getTime(), magnitude: 2 }),
      ]),
      { period: "month" },
    );
    expect(tree.rings[0]!.thickness).toBeGreaterThan(tree.rings[1]!.thickness);
  });

  it("never lets one ring cross the one inside it", () => {
    const tree = buildTree(history(habit(60, () => 23)));

    for (let index = 1; index < tree.rings.length; index += 1) {
      for (let sample = 0; sample < CONTOUR_SAMPLES; sample += 1) {
        expect(tree.rings[index]!.contour[sample]).toBeGreaterThan(
          tree.rings[index - 1]!.contour[sample]!,
        );
      }
    }
  });

  it("draws the same history the same way twice", () => {
    const input = history(habit(30, (month) => (month % 2 === 0 ? 10 : 22)));
    const first = buildTree(input, { nowMs: 0 });
    const second = buildTree(input, { nowMs: 0 });
    expect(first.rings.map((ring) => ring.contour)).toEqual(
      second.rings.map((ring) => ring.contour),
    );
  });
});

/** Ten commits a month for `months` months, at whatever hour `hourOf` says. */
function habit(months: number, hourOf: (month: number) => number): ActivityRecord[] {
  return Array.from({ length: months }, (_, month) =>
    Array.from({ length: 10 }, (_unused, day) =>
      activity({
        timestampMs: new Date(2018, month, 2 + day).getTime(),
        localHour: hourOf(month),
        weekday: day % 7,
        detail: null,
      }),
    ),
  ).flat();
}

/** How much further the trunk reaches toward one dial position than its opposite. */
function leanToward(tree: TreeModel, turn: number): number {
  const contour = tree.rings[tree.rings.length - 1]!.contour;
  const toward = contour[Math.round(turn * CONTOUR_SAMPLES) % CONTOUR_SAMPLES]!;
  const away = contour[Math.round((turn + 0.5) * CONTOUR_SAMPLES) % CONTOUR_SAMPLES]!;
  return toward / away;
}

describe("the lean", () => {
  it("puts noon at the top of the hour dial and the weekend at the bottom of the week", () => {
    expect(dialFraction("hours", 12)).toBeCloseTo(0);
    expect(dialFraction("hours", 18)).toBeCloseTo(0.25);
    expect(dialFraction("hours", 0)).toBeCloseTo(0.5);
    expect(dialFraction("weekdays", 2)).toBeCloseTo(0);
    expect((dialFraction("weekdays", 5) + dialFraction("weekdays", 6)) / 2).toBeCloseTo(0.5);
  });

  it("grows the trunk toward the hours the work was done in", () => {
    const nightOwl = buildTree(history(habit(48, () => 0)));
    const dayJob = buildTree(history(habit(48, () => 12)));

    expect(nightOwl.dial).toBe("hours");
    expect(leanToward(nightOwl, 0.5)).toBeGreaterThan(1.15);
    expect(leanToward(dayJob, 0)).toBeGreaterThan(1.15);
    expect(leanToward(dayJob, 0.5)).toBeLessThan(1);
  });

  it("leaves a trunk whose hours are spread evenly close to round", () => {
    const tree = buildTree(history(habit(48, (month) => (month * 5) % 24)));
    const contour = tree.rings[tree.rings.length - 1]!.contour;
    expect(Math.max(...contour) / Math.min(...contour)).toBeLessThan(1.15);
  });

  it("stays a trunk, not a horn, even when every commit is at the same hour", () => {
    const tree = buildTree(history(habit(120, () => 3)));
    const contour = tree.rings[tree.rings.length - 1]!.contour;
    expect(Math.max(...contour) / Math.min(...contour)).toBeLessThan(1.7);
  });

  it("moves with a change of habit instead of averaging it away", () => {
    const tree = buildTree(history(habit(60, (month) => (month < 30 ? 0 : 12))));
    const thicknessAt = (ringIndex: number, turn: number): number => {
      const sample = Math.round(turn * CONTOUR_SAMPLES) % CONTOUR_SAMPLES;
      return (
        tree.rings[ringIndex]!.contour[sample]! - tree.rings[ringIndex - 1]!.contour[sample]!
      );
    };

    // Early rings are thick at midnight (bottom), late ones at noon (top).
    expect(thicknessAt(20, 0.5)).toBeGreaterThan(thicknessAt(20, 0));
    expect(thicknessAt(58, 0)).toBeGreaterThan(thicknessAt(58, 0.5));
  });

  it("falls back to the week when only dates are known", () => {
    const weekender = Array.from({ length: 200 }, (_, index) =>
      activity({
        timestampMs: new Date(2021, 0, 2 + index * 7).getTime(),
        weekday: index % 2 === 0 ? 5 : 6,
        nightCount: null,
        detail: null,
      }),
    );
    const tree = buildTree({ ...history(weekender, "commits"), granularity: "day" });

    expect(tree.dial).toBe("weekdays");
    expect(leanToward(tree, 0.5)).toBeGreaterThan(1.15);
    expect(tree.shadeKind).toBe("weekend");
    expect(tree.rings.find((ring) => !ring.dormant)!.shade).toBe(1);
  });

  it("uses a whole-history rhythm when records carry no timing at all", () => {
    const weekly = Array.from({ length: 150 }, (_, week) =>
      activity({
        timestampMs: new Date(2020, 0, 6 + week * 7).getTime(),
        nightCount: null,
        detail: null,
      }),
    );
    const weights = Array.from({ length: 24 }, (_, hour) => (hour >= 21 ? 50 : 0));
    const tree = buildTree({
      ...history(weekly, "commits"),
      granularity: "week",
      rhythm: { dial: "hours", weights },
    });

    expect(tree.dial).toBe("hours");
    expect(tree.dialWeights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(leanToward(tree, dialFraction("hours", 22.5))).toBeGreaterThan(1.15);
    expect(tree.shadeKind).toBe("none");
  });

  it("barely leans at all on a handful of commits", () => {
    const few = buildTree(history(habit(1, () => 0).slice(0, 6)), { period: "day" });
    const many = buildTree(history(habit(40, () => 0)));
    expect(leanToward(few, 0.5)).toBeLessThan(1.08);
    expect(leanToward(many, 0.5)).toBeGreaterThan(leanToward(few, 0.5));
  });

  it("has no dial, and stays near round, when nothing is known about timing", () => {
    const tree = buildTree(
      history(
        Array.from({ length: 150 }, (_, week) =>
          activity({ timestampMs: new Date(2020, 0, 6 + week * 7).getTime(), detail: null }),
        ),
        "commits",
      ),
    );
    const contour = tree.rings[tree.rings.length - 1]!.contour;

    expect(tree.dial).toBe("none");
    expect(Math.max(...contour) / Math.min(...contour)).toBeLessThan(1.15);
    expect(new Set(contour).size).toBeGreaterThan(1);
  });
});

describe("ring period", () => {
  const DAY = 86_400_000;
  const from = new Date(2020, 0, 1).getTime();

  it("draws a young history close up and an old one from further back", () => {
    expect(choosePeriod(from, from + 20 * DAY)).toBe("day");
    expect(choosePeriod(from, from + 400 * DAY)).toBe("week");
    expect(choosePeriod(from, from + 5 * 365 * DAY)).toBe("month");
    expect(choosePeriod(from, from + 20 * 365 * DAY)).toBe("quarter");
    expect(choosePeriod(from, from + 40 * 365 * DAY)).toBe("year");
  });

  it("never draws rings finer than the source can place an activity", () => {
    expect(choosePeriod(from, from + 20 * DAY, "week")).toBe("week");
    expect(choosePeriod(from, from + 20 * DAY, "day")).toBe("day");
  });

  it("keeps the number of rings readable at every age", () => {
    for (const days of [30, 100, 101, 800, 801, 4000, 4100, 12_000, 13_000, 20_000]) {
      const tree = buildTree(
        history([
          activity({ timestampMs: from }),
          activity({ timestampMs: from + days * DAY }),
        ]),
      );
      expect(tree.rings.length).toBeGreaterThanOrEqual(13);
      expect(tree.rings.length).toBeLessThanOrEqual(141);
    }
  });

  it("starts weekly rings on a Monday", () => {
    const tree = buildTree(
      history([
        activity({ timestampMs: new Date(2024, 0, 3).getTime() }),
        activity({ timestampMs: new Date(2024, 11, 3).getTime() }),
      ]),
    );
    expect(tree.period).toBe("week");
    expect(new Date(tree.rings[0]!.startMs).getDay()).toBe(1);
    expect(tree.rings[0]!.label).toBe("Week of 1 Jan 2024");
  });

  it("marks the ring in which each new year begins", () => {
    const tree = buildTree(
      history([
        activity({ timestampMs: new Date(2022, 5, 10).getTime() }),
        activity({ timestampMs: new Date(2025, 2, 10).getTime() }),
      ]),
    );
    expect(tree.period).toBe("month");
    expect(tree.rings.filter((ring) => ring.mark).map((ring) => ring.mark)).toEqual([
      "2023",
      "2024",
      "2025",
    ]);
    expect(tree.rings.find((ring) => ring.mark === "2023")!.label).toBe("Jan 2023");
  });
});

describe("sapwood", () => {
  it("is the last twelve months before now, and nothing older", () => {
    const tree = buildTree(
      history([
        activity({ timestampMs: new Date(2020, 0, 10).getTime() }),
        activity({ timestampMs: new Date(2024, 5, 10).getTime() }),
      ]),
      { nowMs: new Date(2024, 6, 1).getTime() },
    );
    expect(tree.rings[0]!.sapwood).toBe(0);
    expect(tree.rings[tree.rings.length - 1]!.sapwood).toBe(1);
    const living = tree.rings.filter((ring) => ring.sapwood > 0).length;
    expect(living).toBeGreaterThanOrEqual(12);
    expect(living).toBeLessThanOrEqual(15);
  });

  it("is absent from a history nobody has touched for years", () => {
    const tree = buildTree(
      history([
        activity({ timestampMs: new Date(2015, 0, 10).getTime() }),
        activity({ timestampMs: new Date(2018, 5, 10).getTime() }),
      ]),
      { nowMs: new Date(2024, 6, 1).getTime() },
    );
    expect(tree.rings.every((ring) => ring.sapwood === 0)).toBe(true);
  });
});

describe("buildTree: measures", () => {
  it("accepts an already-aggregated contribution record", () => {
    const tree = buildTree(
      history(
        [
          activity({
            count: 37,
            magnitude: null,
            nightCount: null,
            detail: null,
          }),
        ],
        "commits",
      ),
    );

    expect(tree.totalActivities).toBe(37);
    expect(tree.rings[0]!.activityCount).toBe(37);
    expect(tree.rings[0]!.volume).toBe(37);
  });

  it("ranks groups by represented activity count", () => {
    const tree = buildTree(
      history([
        activity({ groupKey: "a" }),
        activity({ groupKey: "b", count: 4 }),
      ]),
    );
    expect(tree.groups[0]!.key).toBe("b");
    expect(tree.groups[0]!.activities).toBe(4);
  });

  it("is deterministic: the same history draws the same scars", () => {
    const activities = [
      ...Array.from({ length: 20 }, (_, index) =>
        activity({
          timestampMs: new Date(2024, 0, 5).getTime(),
          magnitude: 15,
          detail: { id: `ordinary-${index}`, summary: "Routine" },
        }),
      ),
      activity({
        timestampMs: new Date(2024, 0, 20).getTime(),
        magnitude: 12_000,
        detail: { id: "rewrite", summary: "The big one" },
      }),
    ];

    const first = buildTree(history(activities), { period: "month" });
    const second = buildTree(history(activities), { period: "month" });
    expect(first.rings[0]!.scars).toEqual(second.rings[0]!.scars);
    expect(first.rings[0]!.scars[0]!.summary).toBe("The big one");
  });

  it("places a scar at the hour it happened, on the hour dial", () => {
    const activities = [
      ...habit(12, () => 14).map((record, index) => ({
        ...record,
        detail: { id: `ordinary-${index}`, summary: "Routine" },
      })),
      activity({
        timestampMs: new Date(2018, 5, 20).getTime(),
        magnitude: 12_000,
        localHour: 0,
        weekday: 2,
        detail: { id: "rewrite", summary: "The big one" },
      }),
    ];
    const tree = buildTree(history(activities));
    const scar = tree.rings.flatMap((ring) => ring.scars)[0]!;
    // Midnight is at the bottom, which is +PI/2 in canvas angles.
    expect(scar.angle).toBeCloseTo(Math.PI / 2, 5);
  });

  it("does not scratch the trunk with changes dwarfed by the largest", () => {
    const activities = [
      ...Array.from({ length: 40 }, (_, index) =>
        activity({
          timestampMs: new Date(2024, 0, 5).getTime(),
          magnitude: 12,
          detail: { id: `ordinary-${index}`, summary: "Routine" },
        }),
      ),
      activity({ magnitude: 900, detail: { id: "medium", summary: "Medium" } }),
      activity({ magnitude: 40_000, detail: { id: "huge", summary: "Huge" } }),
    ];
    const tree = buildTree(history(activities));
    expect(tree.rings.flatMap((ring) => ring.scars).map((scar) => scar.id)).toEqual(["huge"]);
  });

  it("keeps scars rare", () => {
    const activities = Array.from({ length: 12 }, (_, month) => [
      ...Array.from({ length: 30 }, (_, index) =>
        activity({
          timestampMs: new Date(2024, month, 5).getTime(),
          magnitude: 12,
          detail: { id: `${month}-${index}`, summary: "Routine" },
        }),
      ),
      activity({
        timestampMs: new Date(2024, month, 18).getTime(),
        magnitude: 7_000 + month,
        detail: { id: `rewrite-${month}`, summary: `Rewrite ${month}` },
      }),
    ]).flat();

    const tree = buildTree(history(activities));
    const total = tree.rings.reduce((sum, ring) => sum + ring.scars.length, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(7);
  });

  it("marks no scars for count-only histories", () => {
    const tree = buildTree(
      history(
        [activity({ count: 500, magnitude: null, detail: null })],
        "commits",
      ),
    );
    expect(tree.rings[0]!.scars).toHaveLength(0);
    expect(tree.hasOutlierData).toBe(false);
  });

  it("reports how much of a period one group carried", () => {
    const tree = buildTree(
      history([
        activity({ groupKey: "one", count: 9 }),
        activity({ groupKey: "two", count: 1 }),
      ]),
    );
    expect(tree.rings[0]!.dominantShare).toBeCloseTo(0.9, 5);
    expect(tree.rings[0]!.groupCount).toBe(2);
  });

  it("uses night counts only when the source provides them", () => {
    const known = buildTree(
      history([
        activity({ count: 2, nightCount: 2 }),
        activity({ count: 1, nightCount: 0 }),
      ]),
    );
    expect(known.rings[0]!.nightRatio).toBeCloseTo(2 / 3, 5);

    const unknown = buildTree(
      history([activity({ count: 3, nightCount: null })], "commits"),
    );
    expect(unknown.rings[0]!.nightRatio).toBeNull();
    expect(unknown.hasNightData).toBe(false);
  });
});

describe("clamp", () => {
  it("bounds on both sides", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
