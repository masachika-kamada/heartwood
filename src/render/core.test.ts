import { describe, expect, it } from "vitest";
import { buildTree } from "../core/tree";
import { createDemoHistory } from "../sources/demo";
import { bandWidths, describeRing } from "./core";

const tree = buildTree(createDemoHistory());

describe("bandWidths", () => {
  it("fills the length exactly, in whole pixels", () => {
    const widths = bandWidths(tree.rings, 560);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(560);
    expect(widths.every(Number.isInteger)).toBe(true);
  });

  it("leaves no band too thin to point at", () => {
    expect(Math.min(...bandWidths(tree.rings, 560))).toBeGreaterThanOrEqual(2);
    expect(bandWidths(tree.rings, 10).every((width) => width === 2)).toBe(true);
  });

  it("gives a thicker ring a wider band", () => {
    const widths = bandWidths(tree.rings, 2000);
    const thickest = tree.rings.reduce((a, b) => (b.thickness > a.thickness ? b : a));
    const thinnest = tree.rings.reduce((a, b) => (b.thickness < a.thickness ? b : a));
    expect(widths[thickest.index]!).toBeGreaterThan(widths[thinnest.index]!);
  });
});

describe("describeRing", () => {
  it("says when and how much on one line", () => {
    const ring = tree.rings.find((candidate) => !candidate.dormant)!;
    const line = describeRing(ring, tree);
    expect(line.startsWith(ring.label)).toBe(true);
    expect(line).toMatch(/ · [\d,]+ \w+/);
    expect(line).not.toContain("\n");
  });
});
