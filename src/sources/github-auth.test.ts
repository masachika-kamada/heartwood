import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPlausibleToken, maskToken } from "./github-auth";

describe("isPlausibleToken", () => {
  it("accepts the shapes GitHub actually issues", () => {
    expect(isPlausibleToken("ghp_" + "a".repeat(36))).toBe(true);
    expect(isPlausibleToken("github_pat_" + "b".repeat(60))).toBe(true);
    // Classic 40-character hex, still valid and still in the wild.
    expect(isPlausibleToken("0".repeat(40))).toBe(true);
  });

  it("tolerates surrounding whitespace from a sloppy paste", () => {
    expect(isPlausibleToken("  ghp_" + "a".repeat(36) + "  ")).toBe(true);
  });

  it("rejects what cannot be a token", () => {
    expect(isPlausibleToken("")).toBe(false);
    expect(isPlausibleToken("   ")).toBe(false);
    expect(isPlausibleToken("too-short")).toBe(false);
    expect(isPlausibleToken("has a space in the middle of it")).toBe(false);
  });

  it("does not guess at future prefixes", () => {
    // A picky check that rejects a valid future token is the worse failure.
    expect(isPlausibleToken("gsomethingnew_" + "c".repeat(30))).toBe(true);
  });
});

describe("maskToken", () => {
  it("shows enough to recognise, not enough to use", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const masked = maskToken(token);
    expect(masked).toBe("ghp_…6789");
    expect(masked).not.toContain("abcdefgh");
  });

  it("reveals nothing from something too short to split", () => {
    expect(maskToken("short")).toBe("•••••");
  });
});

describe("storage failures", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("degrades to no token when localStorage throws", async () => {
    // Safari in private mode, or a browser with site data switched off.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });

    const auth = await import("./github-auth");
    expect(auth.readToken()).toBeNull();
    expect(auth.hasToken()).toBe(false);
    // Reported as unavailable, not invalid: the token was fine, the browser
    // was not, and those send you to fix different things.
    expect(auth.saveToken("ghp_" + "a".repeat(36))).toBe("unavailable");
    expect(auth.clearToken()).toBe("unavailable");
    expect(auth.githubHeaders()).toEqual({ Accept: "application/vnd.github+json" });

    vi.unstubAllGlobals();
  });

  it("signs requests once a token is stored", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });

    const auth = await import("./github-auth");
    const token = "ghp_" + "a".repeat(36);

    expect(auth.githubHeaders().Authorization).toBeUndefined();
    expect(auth.saveToken(token)).toBe("saved");
    expect(auth.githubHeaders().Authorization).toBe(`Bearer ${token}`);
    expect(auth.githubHeaders().Accept).toBe("application/vnd.github+json");

    expect(auth.clearToken()).toBe("cleared");
    expect(auth.githubHeaders().Authorization).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("refuses to store something that cannot be a token", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });

    const auth = await import("./github-auth");
    expect(auth.saveToken("nope")).toBe("invalid");
    expect(store.size).toBe(0);

    vi.unstubAllGlobals();
  });

  it("reports when a saved token cannot be removed", async () => {
    const token = "ghp_" + "a".repeat(36);
    vi.stubGlobal("localStorage", {
      getItem: () => token,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("denied");
      },
    });

    const auth = await import("./github-auth");
    expect(auth.clearToken()).toBe("unavailable");
    expect(auth.githubHeaders().Authorization).toBeDefined();

    vi.unstubAllGlobals();
  });
});
