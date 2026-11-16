import { describe, expect, it } from "vitest";
import { parseTreeLink } from "./link";

describe("parseTreeLink", () => {
  it("reads a bare name", () => {
    expect(parseTreeLink("#facebook/react")).toEqual({ name: "facebook/react", ring: null });
    expect(parseTreeLink("#/torvalds")?.name).toBe("torvalds");
  });

  it("reads a ring to point at", () => {
    expect(parseTreeLink("#someone?ring=12")).toEqual({ name: "someone", ring: 12 });
  });

  it("keeps the name when what follows it is nonsense", () => {
    expect(parseTreeLink("#owner/repo?whatever")).toEqual({ name: "owner/repo", ring: null });
  });

  it("has nothing to say about an empty or broken address", () => {
    expect(parseTreeLink("")).toBeNull();
    expect(parseTreeLink("#")).toBeNull();
    expect(parseTreeLink("#%E0%A4%A")).toBeNull();
  });
});
