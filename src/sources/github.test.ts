import { describe, expect, it } from "vitest";
import { parseIsoOffsetMinutes, parseRepoInput } from "./github";

describe("parseRepoInput", () => {
  it("accepts a bare owner/repo", () => {
    expect(parseRepoInput("octocat/hello-world")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("accepts a browser URL", () => {
    expect(parseRepoInput("https://github.com/octocat/Hello-World")).toEqual({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("accepts an ssh remote and strips the .git suffix", () => {
    expect(parseRepoInput("git@github.com:octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parseRepoInput("https://github.com/octocat/hello-world/")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("rejects nonsense", () => {
    expect(parseRepoInput("")).toBeNull();
    expect(parseRepoInput("just-a-name")).toBeNull();
    expect(parseRepoInput("too/many/parts")).toBeNull();
  });
});

describe("parseIsoOffsetMinutes", () => {
  it("reads a positive offset", () => {
    expect(parseIsoOffsetMinutes("2024-01-15T12:00:00+09:00")).toBe(540);
  });

  it("reads a negative offset", () => {
    expect(parseIsoOffsetMinutes("2024-01-15T12:00:00-05:30")).toBe(-330);
  });

  it("treats Z as zero", () => {
    expect(parseIsoOffsetMinutes("2024-01-15T12:00:00Z")).toBe(0);
  });
});
