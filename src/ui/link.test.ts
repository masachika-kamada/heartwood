import { describe, expect, it } from "vitest";
import { parseTreeLink } from "./link";

describe("parseTreeLink", () => {
  it("reads a bare name", () => {
    expect(parseTreeLink("#facebook/react")).toEqual({
      name: "facebook/react",
      ring: null,
      point: null,
    });
    expect(parseTreeLink("#/torvalds")?.name).toBe("torvalds");
  });

  it("reads a ring to point at", () => {
    expect(parseTreeLink("#someone?ring=12")).toEqual({ name: "someone", ring: 12, point: null });
  });

  it("reads where an ismap click landed, and how wide the picture was shown", () => {
    expect(parseTreeLink("#someone@600?213,188")).toEqual({
      name: "someone",
      ring: null,
      point: { x: 213, y: 188, shownWidth: 600 },
    });
  });

  it("ignores a click position that does not say how wide the picture was", () => {
    expect(parseTreeLink("#someone?213,188")).toEqual({ name: "someone", ring: null, point: null });
  });

  it("keeps the name when what follows it is nonsense", () => {
    expect(parseTreeLink("#owner/repo?whatever")).toEqual({
      name: "owner/repo",
      ring: null,
      point: null,
    });
  });

  it("has nothing to say about an empty or broken address", () => {
    expect(parseTreeLink("")).toBeNull();
    expect(parseTreeLink("#")).toBeNull();
    expect(parseTreeLink("#%E0%A4%A")).toBeNull();
    expect(parseTreeLink("#@600?1,2")).toBeNull();
  });
});
