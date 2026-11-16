import { describe, expect, it } from "vitest";
import { highlightsOf } from "./highlights";
import type { Ring, TreeModel } from "./types";

const MONTH = 30.4375 * 24 * 60 * 60 * 1000;
const START = Date.UTC(2020, 0, 1);

function treeOf(counts: number[]): TreeModel {
  const rings = counts.map(
    (count, index) =>
      ({
        index,
        startMs: START + index * MONTH,
        endMs: START + (index + 1) * MONTH,
        label: `m${index}`,
        activityCount: count,
        dormant: count === 0,
      }) as Ring,
  );
  return { rings, period: "month" } as unknown as TreeModel;
}

describe("highlightsOf", () => {
  it("finds the ring that grew the most", () => {
    expect(highlightsOf(treeOf([3, 9, 4])).peak?.index).toBe(1);
  });

  it("finds the longest quiet stretch, but not one still running at the bark", () => {
    const found = highlightsOf(treeOf([5, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0]));
    expect(found.quiet?.from.index).toBe(4);
    expect(found.quiet?.to.index).toBe(6);
  });

  it("does not call a single empty ring a stretch", () => {
    expect(highlightsOf(treeOf([5, 0, 2])).quiet).toBeNull();
  });

  it("names the busiest year once there are several to compare", () => {
    const counts = [...Array(12).fill(1), ...Array(12).fill(5), ...Array(12).fill(2)];
    expect(highlightsOf(treeOf(counts)).busiestYear?.year).toBe(2021);
    expect(highlightsOf(treeOf([1, 2, 3])).busiestYear).toBeNull();
  });

  it("compares the last twelve months with the twelve before", () => {
    const counts = [...Array(12).fill(1), ...Array(12).fill(2), ...Array(12).fill(3)];
    expect(highlightsOf(treeOf(counts)).trend).toBeCloseTo(1.5, 1);
    expect(highlightsOf(treeOf(Array(12).fill(1))).trend).toBeNull();
  });

  it("has nothing to say about an empty trunk", () => {
    expect(highlightsOf(treeOf([]))).toEqual({
      peak: null,
      quiet: null,
      busiestYear: null,
      trend: null,
    });
  });
});
