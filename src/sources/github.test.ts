import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasExplicitOffset,
  loadGitHubHistory,
  parseGitHubInput,
  parseIsoOffsetMinutes,
  parseLastPage,
  parseRepoInput,
  readPunchCard,
  readWeeklyStats,
} from "./github";
import { resetBudgets } from "./github-http";

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

describe("hasExplicitOffset", () => {
  it("tells an author's offset from a date GitHub normalised to UTC", () => {
    expect(hasExplicitOffset("2024-01-15T12:00:00+09:00")).toBe(true);
    expect(hasExplicitOffset("2024-01-15T12:00:00-05:30")).toBe(true);
    expect(hasExplicitOffset("2024-01-15T12:00:00Z")).toBe(false);
  });
});

describe("parseLastPage", () => {
  it("reads the last page out of a Link header", () => {
    const link =
      '<https://api.github.com/repositories/1/commits?per_page=100&page=2>; rel="next", ' +
      '<https://api.github.com/repositories/1/commits?per_page=100&page=37>; rel="last"';
    expect(parseLastPage(link)).toBe(37);
  });

  it("is one page when there is no header, or no last link", () => {
    expect(parseLastPage(null)).toBe(1);
    expect(parseLastPage('<https://api.github.com/x?page=1>; rel="prev"')).toBe(1);
  });
});

const WEEK_SECONDS = 7 * 86_400;
const FIRST_WEEK = Date.UTC(2021, 0, 3) / 1000;

function weeks(count: number, each: (index: number) => { a: number; d: number; c: number }) {
  return Array.from({ length: count }, (_, index) => ({
    w: FIRST_WEEK + index * WEEK_SECONDS,
    ...each(index),
  }));
}

describe("readWeeklyStats", () => {
  it("turns each author's active weeks into one record, with lines when known", () => {
    const stats = readWeeklyStats([
      {
        author: { login: "wren" },
        weeks: weeks(20, (index) => ({ a: index === 3 ? 900 : 10, d: 5, c: index % 2 })),
      },
      { author: null, weeks: weeks(20, (index) => ({ a: 1, d: 0, c: index === 0 ? 4 : 0 })) },
    ])!;

    expect(stats.contributors).toBe(2);
    expect(stats.linesKnown).toBe(true);
    expect(stats.spanWeeks).toBe(20);
    // Ten odd weeks for wren, one for the author with no account.
    expect(stats.activities).toHaveLength(11);
    expect(stats.activities[0]).toMatchObject({ count: 4, groupKey: "unlinked author 2" });
    const big = stats.activities.find((activity) => activity.magnitude === 905)!;
    expect(big.detail!.summary).toMatch(/^wren changed 905 lines in the week of /);
    // No hours and no night in a weekly total.
    expect(stats.activities.every((activity) => activity.nightCount === null)).toBe(true);
  });

  it("places a week at its middle, not at the Sunday it starts on", () => {
    const stats = readWeeklyStats([
      { author: { login: "wren" }, weeks: weeks(1, () => ({ a: 0, d: 0, c: 1 })) },
    ])!;
    expect(new Date(stats.activities[0]!.timestampMs).getUTCDay()).toBe(3);
  });

  it("treats all-zero line counts as unknown, as GitHub sends for huge repositories", () => {
    const stats = readWeeklyStats([
      { author: { login: "wren" }, weeks: weeks(30, () => ({ a: 0, d: 0, c: 2 })) },
    ])!;
    expect(stats.linesKnown).toBe(false);
    expect(stats.activities.every((activity) => activity.magnitude === null)).toBe(true);
    expect(stats.activities.every((activity) => activity.detail === null)).toBe(true);
  });

  it("has nothing to say about an empty or unfinished answer", () => {
    expect(readWeeklyStats({})).toBeNull();
    expect(readWeeklyStats([])).toBeNull();
    expect(
      readWeeklyStats([{ author: { login: "wren" }, weeks: weeks(5, () => ({ a: 0, d: 0, c: 0 })) }]),
    ).toBeNull();
  });
});

describe("readPunchCard", () => {
  it("sums every weekday into twenty-four hours", () => {
    const rhythm = readPunchCard([
      [0, 9, 2],
      [3, 9, 5],
      [6, 23, 1],
    ])!;
    expect(rhythm.dial).toBe("hours");
    expect(rhythm.weights).toHaveLength(24);
    expect(rhythm.weights[9]).toBe(7);
    expect(rhythm.weights[23]).toBe(1);
  });

  it("is absent when the card is empty or malformed", () => {
    expect(readPunchCard([[0, 9, 0]])).toBeNull();
    expect(readPunchCard({})).toBeNull();
    expect(readPunchCard([[0, 99, 4], "nonsense"])).toBeNull();
  });
});

describe("loadGitHubHistory", () => {
  const target = { owner: "octocat", repo: "hello-world" };

  function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    // 204 may not carry a body at all.
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  }

  function commits(count: number, page = 1): unknown[] {
    return Array.from({ length: count }, (_, index) => ({
      commit: {
        author: {
          name: "Wren",
          email: "wren@example.com",
          date: new Date(Date.UTC(2024, 0, 1 + page, index % 24)).toISOString(),
        },
      },
    }));
  }

  interface Routes {
    readonly contributors: () => Response;
    readonly punchCard?: () => Response;
    readonly commits: (page: number) => Response;
  }

  function route(routes: Routes) {
    return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stats/contributors")) {
        return routes.contributors();
      }
      if (url.pathname.endsWith("/stats/punch_card")) {
        return routes.punchCard?.() ?? json([]);
      }
      return routes.commits(Number(url.searchParams.get("page")));
    });
  }

  function load() {
    return loadGitHubHistory(target, vi.fn(), new AbortController().signal);
  }

  const longStats = [
    { author: { login: "wren" }, weeks: weeks(60, (index) => ({ a: 20 + index, d: 3, c: 2 })) },
  ];

  beforeEach(() => {
    resetBudgets();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("draws the whole history from three requests when GitHub has it counted", async () => {
    const fetchMock = route({
      contributors: () => json(longStats),
      punchCard: () => json([[2, 22, 9]]),
      // A repository far larger than the commit list would ever be walked.
      commits: () => json(commits(100), 200, { link: '<x?page=500>; rel="last"' }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const history = await load();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(history.name).toBe("octocat/hello-world");
    expect(history.granularity).toBe("week");
    expect(history.metric).toBe("lines");
    expect(history.activities).toHaveLength(60);
    expect(history.truncated).toBe(false);
    expect(history.rhythm?.weights[22]).toBe(9);
  });

  it("waits while GitHub is still counting, then uses the answer", async () => {
    let asked = 0;
    const fetchMock = route({
      contributors: () => {
        asked += 1;
        return asked < 3 ? json({}, 202) : json(longStats);
      },
      commits: () => json(commits(100), 200, { link: '<x?page=500>; rel="last"' }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const loading = load();
    await vi.advanceTimersByTimeAsync(10_000);
    const history = await loading;

    expect(asked).toBe(3);
    expect(history.granularity).toBe("week");
  });

  it("walks the commit list, pages in parallel, when the count never arrives", async () => {
    let inFlight = 0;
    let widest = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stats/contributors")) {
        return json({}, 202);
      }
      if (url.pathname.endsWith("/stats/punch_card")) {
        return json([]);
      }
      const page = Number(url.searchParams.get("page"));
      inFlight += 1;
      widest = Math.max(widest, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return json(commits(100, page), 200, { link: '<x?page=25>; rel="last"' });
    });
    vi.stubGlobal("fetch", fetchMock);

    const loading = load();
    await vi.advanceTimersByTimeAsync(20_000);
    const history = await loading;

    expect(history.granularity).toBe("instant");
    expect(history.metric).toBe("commits");
    // Ten pages of a hundred, and the history says there was more.
    expect(history.activities).toHaveLength(1000);
    expect(history.truncated).toBe(true);
    expect(widest).toBe(4);
    const pages = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith("/commits"))
      .map((url) => Number(url.searchParams.get("page")))
      .sort((a, b) => a - b);
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("prefers the commit list for a repository too young to have weeks", async () => {
    const fetchMock = route({
      contributors: () =>
        json([{ author: { login: "wren" }, weeks: weeks(3, () => ({ a: 5, d: 1, c: 4 })) }]),
      punchCard: () => json([[1, 21, 12]]),
      commits: () => json(commits(12)),
    });
    vi.stubGlobal("fetch", fetchMock);

    const history = await load();

    expect(history.granularity).toBe("instant");
    expect(history.activities).toHaveLength(12);
    expect(history.truncated).toBe(false);
    // The punch card still supplies the hours the commit list cannot.
    expect(history.rhythm?.weights[21]).toBe(12);
  });

  it("does not call a UTC hour the author's hour", async () => {
    vi.stubGlobal(
      "fetch",
      route({ contributors: () => json(null, 204), commits: () => json(commits(5)) }),
    );

    const history = await load();
    expect(history.activities.every((activity) => activity.nightCount === null)).toBe(true);
    expect(history.activities.every((activity) => activity.localHour === null)).toBe(true);
    expect(history.activities.every((activity) => typeof activity.weekday === "number")).toBe(true);
  });

  it("says the top hundred contributors are not everyone", async () => {
    const hundred = Array.from({ length: 100 }, (_, index) => ({
      author: { login: `hand-${index}` },
      weeks: weeks(40, () => ({ a: 0, d: 0, c: 1 })),
    }));
    vi.stubGlobal(
      "fetch",
      route({ contributors: () => json(hundred), commits: () => json(commits(100)) }),
    );

    const history = await load();
    expect(history.truncated).toBe(true);
    expect(history.metric).toBe("commits");
  });

  it("reports a missing repository as missing, whatever the statistics said", async () => {
    vi.stubGlobal(
      "fetch",
      route({ contributors: () => json({}, 404), commits: () => json({}, 404) }),
    );
    await expect(load()).rejects.toThrow(/no such public account or repository/);
  });
});
