import { describe, expect, it } from "vitest";
import { parseGitHubInput, parseIsoOffsetMinutes, parseRepoInput } from "./github";

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

describe("parseGitHubInput", () => {
  it("reads a repository when there is a slash", () => {
    expect(parseGitHubInput("octocat/hello-world")).toEqual({
      kind: "repo",
      target: { owner: "octocat", repo: "hello-world" },
    });
    expect(parseGitHubInput("https://github.com/octocat/hello-world")).toEqual({
      kind: "repo",
      target: { owner: "octocat", repo: "hello-world" },
    });
  });

  it("reads a person when there is not", () => {
    expect(parseGitHubInput("octocat")).toEqual({ kind: "user", login: "octocat" });
    expect(parseGitHubInput("@octocat")).toEqual({ kind: "user", login: "octocat" });
    expect(parseGitHubInput("https://github.com/octocat")).toEqual({
      kind: "user",
      login: "octocat",
    });
  });

  it("accepts logins with inner hyphens", () => {
    expect(parseGitHubInput("masachika-kamada")).toEqual({
      kind: "user",
      login: "masachika-kamada",
    });
  });

  it("rejects shapes GitHub could never accept", () => {
    expect(parseGitHubInput("")).toBeNull();
    expect(parseGitHubInput("   ")).toBeNull();
    expect(parseGitHubInput("-leading")).toBeNull();
    expect(parseGitHubInput("trailing-")).toBeNull();
    expect(parseGitHubInput("double--hyphen")).toBeNull();
    expect(parseGitHubInput("a".repeat(40))).toBeNull();
    expect(parseGitHubInput("too/many/parts")).toBeNull();
    expect(parseGitHubInput("has space")).toBeNull();
  });

  it("accepts a login of exactly the maximum length", () => {
    expect(parseGitHubInput("a".repeat(39))).toEqual({
      kind: "user",
      login: "a".repeat(39),
    });
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
