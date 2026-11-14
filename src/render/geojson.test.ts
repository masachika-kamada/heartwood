import { describe, expect, it, vi } from "vitest";
import { buildTree } from "../core/tree";
import type { ActivityRecord } from "../core/types";
import { treeGeoJson } from "./geojson";

function record(month: number, overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    timestampMs: new Date(2019, month, 10).getTime(),
    count: 4,
    magnitude: null,
    nightCount: 1,
    groupKey: "secret/repository",
    detail: null,
    localHour: 23,
    weekday: 2,
    ...overrides,
  };
}

function tree() {
  // Month 3 is left out, so one ring is a silence.
  const activities = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((month) => record(month));
  return buildTree(
    {
      name: "someone",
      activities,
      metric: "commits",
      groupKind: "repositories",
      truncated: false,
      sourceKind: "github",
    },
    { period: "month" },
  );
}

/** Twice the signed area: positive when the outline runs counter-clockwise. */
function signedArea(points: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    sum += points[index]![0] * points[index + 1]![1] - points[index + 1]![0] * points[index]![1];
  }
  return sum;
}

describe("treeGeoJson", () => {
  // The renderer module reads the theme from `window` only when drawing.
  vi.stubGlobal("window", {});

  it("makes one polygon per ring, plus the bark", () => {
    const model = tree();
    const map = treeGeoJson(model);
    expect(map.type).toBe("FeatureCollection");
    expect(map.features).toHaveLength(model.rings.length + 1);
  });

  it("says on each ring what the hover label would have said", () => {
    const map = treeGeoJson(tree());
    expect(map.features[1]!.properties).toMatchObject({
      title: "Jan 2019",
      commits: 4,
      "at night": "25%",
    });
    expect(map.features[4]!.properties).toMatchObject({ title: "Apr 2019", commits: 0 });
  });

  it("never names the repositories behind a ring", () => {
    expect(JSON.stringify(treeGeoJson(tree()))).not.toContain("secret");
  });

  it("closes every outline, with exteriors counter-clockwise and holes clockwise", () => {
    for (const feature of treeGeoJson(tree()).features) {
      const [exterior, hole] = feature.geometry.coordinates;
      expect(exterior![0]).toEqual(exterior![exterior!.length - 1]);
      expect(signedArea(exterior!)).toBeGreaterThan(0);
      if (hole) {
        expect(signedArea(hole)).toBeLessThan(0);
      }
    }
  });

  it("gives every ring a fill colour the map can read", () => {
    for (const feature of treeGeoJson(tree()).features) {
      expect(feature.properties.fill).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("is empty for an empty history", () => {
    const empty = buildTree({
      name: "nobody",
      activities: [],
      metric: "commits",
      groupKind: "none",
      truncated: false,
      sourceKind: "github",
    });
    expect(treeGeoJson(empty).features).toHaveLength(0);
  });
});
