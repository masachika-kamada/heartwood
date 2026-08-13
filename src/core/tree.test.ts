import { describe, expect, it } from "vitest";
import { buildTree, churnOf, clamp, isNightCommit, percentile } from "./tree";
import type { CommitRecord, RepoHistory } from "./types";

function commit(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    sha: "a".repeat(40),
    timestampMs: Date.UTC(2024, 0, 15, 12, 0),
    tzOffsetMinutes: 0,
    authorName: "Wren",
    authorEmail: "wren@example.com",
    summary: "Work",
    parents: [],
    insertions: 10,
    deletions: 5,
    ...overrides,
  };
}

function history(commits: CommitRecord[]): RepoHistory {
  return { name: "test", commits, truncated: false, sourceKind: "demo" };
}

describe("churnOf", () => {
  it("adds insertions and deletions", () => {
    expect(churnOf(commit({ insertions: 30, deletions: 12 }))).toBe(42);
  });

  it("gives commits a default weight when the source cannot diff", () => {
    expect(churnOf(commit({ insertions: null, deletions: null }))).toBeGreaterThan(0);
  });
});

describe("isNightCommit", () => {
  it("uses the author's own timezone, not the viewer's", () => {
    // 15:00 UTC is midnight in UTC+9.
    const late = commit({
      timestampMs: Date.UTC(2024, 0, 15, 15, 0),
      tzOffsetMinutes: 540,
    });
    expect(isNightCommit(late)).toBe(true);

    // The same instant is 10:00 in UTC-5: not night at all.
    const daytime = commit({
      timestampMs: Date.UTC(2024, 0, 15, 15, 0),
      tzOffsetMinutes: -300,
    });
    expect(isNightCommit(daytime)).toBe(false);
  });

  it("treats 22:00 and 04:59 as night but not 21:59 or 05:00", () => {
    const at = (hour: number): CommitRecord =>
      commit({ timestampMs: Date.UTC(2024, 0, 15, hour, 0), tzOffsetMinutes: 0 });
    expect(isNightCommit(at(22))).toBe(true);
    expect(isNightCommit(at(4))).toBe(true);
    expect(isNightCommit(at(21))).toBe(false);
    expect(isNightCommit(at(5))).toBe(false);
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
    expect(tree.totalCommits).toBe(0);
  });

  it("creates one ring per month spanned, including silent months", () => {
    const tree = buildTree(
      history([
        commit({ timestampMs: new Date(2024, 0, 10).getTime() }),
        commit({ timestampMs: new Date(2024, 3, 10).getTime() }),
      ]),
    );

    // January through April inclusive.
    expect(tree.rings).toHaveLength(4);
    expect(tree.rings[1]!.dormant).toBe(true);
    expect(tree.rings[2]!.dormant).toBe(true);
    expect(tree.rings[0]!.dormant).toBe(false);
    expect(tree.rings[3]!.dormant).toBe(false);
  });

  it("grows radius monotonically outward", () => {
    const tree = buildTree(
      history(
        Array.from({ length: 40 }, (_, index) =>
          commit({
            timestampMs: new Date(2024, index % 12, 5).getTime(),
            insertions: index * 30,
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

  it("gives a busier month a thicker ring than a quiet one", () => {
    const busy = Array.from({ length: 30 }, () =>
      commit({ timestampMs: new Date(2024, 0, 5).getTime(), insertions: 400, deletions: 200 }),
    );
    const quiet = [
      commit({ timestampMs: new Date(2024, 1, 5).getTime(), insertions: 2, deletions: 0 }),
    ];

    const tree = buildTree(history([...busy, ...quiet]));
    expect(tree.rings[0]!.thickness).toBeGreaterThan(tree.rings[1]!.thickness);
  });

  it("switches to yearly rings for very long histories", () => {
    const commits = Array.from({ length: 60 }, (_, index) =>
      commit({ timestampMs: new Date(2000 + index / 4, (index * 3) % 12, 5).getTime() }),
    );
    const tree = buildTree(history(commits));
    expect(tree.rings.length).toBeLessThan(40);
    expect(tree.rings[0]!.label).toMatch(/^\d{4}$/);
  });

  it("ranks authors by commit count", () => {
    const tree = buildTree(
      history([
        commit({ authorEmail: "a@x", authorName: "A" }),
        commit({ authorEmail: "b@x", authorName: "B" }),
        commit({ authorEmail: "b@x", authorName: "B" }),
      ]),
    );
    expect(tree.authors[0]!.email).toBe("b@x");
    expect(tree.authors[0]!.commits).toBe(2);
  });

  it("is deterministic: the same history draws the same scars", () => {
    const commits = [
      ...Array.from({ length: 20 }, () =>
        commit({ timestampMs: new Date(2024, 0, 5).getTime(), insertions: 10, deletions: 5 }),
      ),
      commit({
        timestampMs: new Date(2024, 0, 20).getTime(),
        insertions: 9000,
        deletions: 3000,
        summary: "The big one",
      }),
    ];

    const first = buildTree(history(commits));
    const second = buildTree(history(commits));
    expect(first.rings[0]!.scars).toEqual(second.rings[0]!.scars);
    expect(first.rings[0]!.scars.length).toBeGreaterThan(0);
    expect(first.rings[0]!.scars[0]!.summary).toBe("The big one");
  });

  it("keeps scars rare, however busy the history is", () => {
    // Twelve months, each with its own large rewrite. Marking every one of
    // them would speckle the drawing and say nothing.
    const commits = Array.from({ length: 12 }, (_, month) => [
      ...Array.from({ length: 30 }, () =>
        commit({
          timestampMs: new Date(2024, month, 5).getTime(),
          insertions: 8,
          deletions: 4,
        }),
      ),
      commit({
        timestampMs: new Date(2024, month, 18).getTime(),
        insertions: 5_000 + month,
        deletions: 2_000,
        summary: `Rewrite ${month}`,
      }),
    ]).flat();

    const tree = buildTree(history(commits));
    const total = tree.rings.reduce((sum, ring) => sum + ring.scars.length, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(7);
  });

  it("marks no scars when every commit is the same size", () => {
    const commits = Array.from({ length: 50 }, () =>
      commit({ timestampMs: new Date(2024, 0, 5).getTime(), insertions: 40, deletions: 10 }),
    );
    const tree = buildTree(history(commits));
    expect(tree.rings.every((ring) => ring.scars.length === 0)).toBe(true);
  });

  it("reports how much of a period one person carried", () => {
    const solo = buildTree(
      history(
        Array.from({ length: 10 }, () =>
          commit({ timestampMs: new Date(2024, 0, 5).getTime(), authorEmail: "one@x" }),
        ),
      ),
    );
    expect(solo.rings[0]!.dominantShare).toBe(1);

    const crowd = buildTree(
      history(
        Array.from({ length: 10 }, (_, index) =>
          commit({
            timestampMs: new Date(2024, 0, 5).getTime(),
            authorEmail: `person${index}@x`,
          }),
        ),
      ),
    );
    expect(crowd.rings[0]!.dominantShare).toBeCloseTo(0.1, 5);
    expect(crowd.rings[0]!.authorCount).toBe(10);
  });

  it("marks night-heavy months with a high night ratio", () => {
    const tree = buildTree(
      history([
        commit({ timestampMs: Date.UTC(2024, 0, 5, 2, 0), tzOffsetMinutes: 0 }),
        commit({ timestampMs: Date.UTC(2024, 0, 6, 3, 0), tzOffsetMinutes: 0 }),
        commit({ timestampMs: Date.UTC(2024, 0, 7, 14, 0), tzOffsetMinutes: 0 }),
      ]),
    );
    expect(tree.rings[0]!.nightRatio).toBeCloseTo(2 / 3, 5);
  });
});

describe("clamp", () => {
  it("bounds on both sides", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
