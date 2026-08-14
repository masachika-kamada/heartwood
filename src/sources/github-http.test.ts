import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delay, GitHubRateLimitError, githubFetch, resetBudgets } from "./github-http";

const SEARCH = () => new URL("https://api.github.com/search/commits?q=author:someone");
const CORE = () => new URL("https://api.github.com/repos/o/r/commits");

function reply(
  status: number,
  headers: Record<string, string> = {},
  body: unknown = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Seconds-since-epoch, as GitHub reports its reset times. */
function resetIn(seconds: number): string {
  return String(Math.floor((Date.now() + seconds * 1000) / 1000));
}

function context(onProgress = vi.fn()) {
  return {
    signal: new AbortController().signal,
    onProgress,
    progressCount: 0,
  };
}

describe("githubFetch", () => {
  beforeEach(() => {
    resetBudgets();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for the window to turn over before spending a request it does not have", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(30) }),
      )
      .mockResolvedValueOnce(
        reply(200, { "x-ratelimit-remaining": "9", "x-ratelimit-reset": resetIn(90) }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const onProgress = vi.fn();
    await githubFetch({ url: SEARCH(), ...context(onProgress) });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The budget is known to be spent, so the second call must not be made
    // yet — the old code threw it at the wall to discover the wall.
    const pending = githubFetch({ url: SEARCH(), ...context(onProgress) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31_000);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls.some(([phase]) => String(phase).startsWith("Waiting"))).toBe(
      true,
    );
  });

  it("wakes a current wait when the auth state changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(30) }),
      )
      .mockResolvedValueOnce(reply(200, { "x-ratelimit-remaining": "9" }));
    vi.stubGlobal("fetch", fetchMock);

    await githubFetch({ url: SEARCH(), ...context() });
    const pending = githubFetch({ url: SEARCH(), ...context() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetBudgets();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets a quick preview stop instead of waiting for another window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reply(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(30) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await githubFetch({ url: SEARCH(), ...context() });
    await expect(
      githubFetch({
        url: SEARCH(),
        ...context(),
        rateLimitMode: "fail",
      }),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting across several windows instead of dying on the second refusal", async () => {
    const throttled = () =>
      reply(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(10) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(reply(200, { "x-ratelimit-remaining": "9" }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = githubFetch({ url: SEARCH(), ...context() });
    await vi.advanceTimersByTimeAsync(60_000);

    const response = await pending;
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not wait out a 403 that is not a rate limit", async () => {
    // A token missing a scope is forbidden forever; waiting a minute to be
    // told so again helps nobody.
    vi.stubGlobal("localStorage", {
      getItem: () => "ghp_" + "a".repeat(36),
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const fetchMock = vi.fn().mockResolvedValue(reply(403, { "x-ratelimit-remaining": "27" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubFetch({ url: SEARCH(), ...context() })).rejects.toThrow(/permission/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-aborted wait immediately", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(delay(30_000, controller.signal)).rejects.toThrow(/abort/i);
  });

  it("never sends GitHub credentials to another origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      githubFetch({
        url: new URL("https://example.com/commits"),
        ...context(),
      }),
    ).rejects.toThrow(/outside api\.github\.com/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up rather than stalling for an hour", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        reply(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(3600) }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubFetch({ url: CORE(), ...context() })).rejects.toThrow(/rate limiting/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the search and core budgets apart", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(30) }),
      )
      .mockResolvedValueOnce(reply(200, { "x-ratelimit-remaining": "59" }));
    vi.stubGlobal("fetch", fetchMock);

    await githubFetch({ url: SEARCH(), ...context() });
    // Spending the search budget says nothing about the ordinary one.
    await githubFetch({ url: CORE(), ...context() });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("says what to do about the limit, and mentions the token when there is none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        reply(429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(7200) }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubFetch({ url: SEARCH(), ...context() })).rejects.toThrow(/token/i);
  });

  it("names an expired token rather than blaming the limit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(401)));
    await expect(githubFetch({ url: SEARCH(), ...context() })).rejects.toThrow(/token/i);
  });

  it("stops waiting when the visitor gives up", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          reply(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(30) }),
        ),
    );

    const pending = githubFetch({
      url: SEARCH(),
      signal: controller.signal,
      onProgress: vi.fn(),
      progressCount: 0,
    });
    const settled = expect(pending).rejects.toThrow(/abort/i);

    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await settled;
  });
});
