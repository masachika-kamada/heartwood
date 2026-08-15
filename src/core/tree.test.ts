import { describe, expect, it } from "vitest";
import { buildTree, clamp, percentile, volumeOf } from "./tree";
import { isNightAt } from "./activity";
import type {
  ActivityGroupKind,
  ActivityHistory,
  ActivityMetric,
  ActivityRecord,
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
    );
    expect(tree.rings[0]!.thickness).toBeGreaterThan(tree.rings[1]!.thickness);
  });

  it("derives a repeatable contour directly from activity timing", () => {
    const input = history([
      activity({ timestampMs: new Date(2024, 0, 2).getTime(), magnitude: 80 }),
      activity({ timestampMs: new Date(2024, 0, 3).getTime(), magnitude: 20 }),
      activity({ timestampMs: new Date(2024, 0, 24).getTime(), magnitude: 10 }),
    ]);

    const first = buildTree(input);
    const second = buildTree(input);
    expect(first.rings[0]!.contour).toEqual(second.rings[0]!.contour);
    expect(new Set(first.rings[0]!.contour).size).toBeGreaterThan(1);
  });

  it("changes the contour when the activity timing changes", () => {
    const early = buildTree(
      history([activity({ timestampMs: new Date(2024, 0, 3).getTime() })]),
    );
    const late = buildTree(
      history([activity({ timestampMs: new Date(2024, 0, 24).getTime() })]),
    );

    expect(early.rings[0]!.contour).not.toEqual(late.rings[0]!.contour);
  });

  it("inherits each inner contour into the next ring", () => {
    const tree = buildTree(
      history([
        activity({ timestampMs: new Date(2024, 0, 3).getTime(), magnitude: 100 }),
        activity({ timestampMs: new Date(2024, 1, 20).getTime(), magnitude: 100 }),
      ]),
    );

    for (let sample = 0; sample < tree.rings[0]!.contour.length; sample += 1) {
      expect(tree.rings[1]!.contour[sample]).toBeGreaterThan(
        tree.rings[0]!.contour[sample]!,
      );
    }
  });

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

  it("switches to yearly rings for very long histories", () => {
    const activities = Array.from({ length: 60 }, (_, index) =>
      activity({ timestampMs: new Date(2000 + index / 4, (index * 3) % 12, 5).getTime() }),
    );
    const tree = buildTree(history(activities));
    expect(tree.rings.length).toBeLessThan(40);
    expect(tree.rings[0]!.label).toMatch(/^\d{4}$/);
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

    const first = buildTree(history(activities));
    const second = buildTree(history(activities));
    expect(first.rings[0]!.scars).toEqual(second.rings[0]!.scars);
    expect(first.rings[0]!.scars[0]!.summary).toBe("The big one");
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
