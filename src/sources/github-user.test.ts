import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGitHubUserHistory } from "./github-user";
import { resetBudgets } from "./github-http";

const DAY = 86_400_000;

function commit(sha: string, date: string, repository = "owner/repository"): unknown {
  return {
    sha,
    commit: { author: { date } },
    repository: { full_name: repository },
  };
}

/** `count` commits, one a day, ending on (and including) the given day. */
function run(prefix: string, lastDay: string, count: number): unknown[] {
  const last = Date.parse(`${lastDay}T12:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    commit(
      `${prefix}-${index}`,
      `${new Date(last - index * DAY).toISOString().slice(0, 10)}T21:00:00+09:00`,
    ),
  );
}

function reply(body: unknown, remaining = "9", status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "x-ratelimit-remaining": remaining,
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
    },
  });
}

function searchReply(totalCount: number, items: unknown[], remaining = "9"): Response {
  return reply({ total_count: totalCount, incomplete_results: false, items }, remaining);
}

function queryOf(input: RequestInfo | URL): { q: string; order: string } {
  const url = new URL(String(input));
  return {
    q: url.searchParams.get("q") ?? "",
    order: url.searchParams.get("order") ?? "",
  };
}

function load(): ReturnType<typeof loadGitHubUserHistory> {
  return loadGitHubUserHistory("someone", vi.fn(), new AbortController().signal);
}

describe("a person without a token", () => {
  beforeEach(() => {
    resetBudgets();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is finished after two searches when everything fits in them", async () => {
    const items = run("c", "2024-03-01", 40);
    const fetchMock = vi.fn(async () => searchReply(40, items));
    vi.stubGlobal("fetch", fetchMock);

    const history = await load();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(history.activities).toHaveLength(40);
    expect(history.truncated).toBe(false);
    expect(history.estimated).toBe(false);
    expect(history.metric).toBe("commits");
    expect(history.groupKind).toBe("repositories");
  });

  it("keeps the author's own hour, which search results still carry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => searchReply(1, [commit("only", "2024-03-02T23:30:00+09:00")])),
    );

    const [activity] = (await load()).activities;
    expect(activity!.localHour).toBeCloseTo(23.5);
    expect(activity!.nightCount).toBe(1);
    // 2 March 2024 was a Saturday.
    expect(activity!.weekday).toBe(5);
  });

  it("samples both ends, then six windows across the time in between", async () => {
    const newest = run("new", "2024-06-30", 100);
    const oldest = run("old", "2015-04-10", 100).reverse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { q, order } = queryOf(input);
      if (!q.includes("author-date:")) {
        return searchReply(5000, order === "asc" ? oldest : newest);
      }
      return searchReply(0, []);
    });
    vi.stubGlobal("fetch", fetchMock);

    await load();

    expect(fetchMock).toHaveBeenCalledTimes(8);
    const ranges = fetchMock.mock.calls
      .map(([input]) => /author-date:(\S+)\.\.(\S+)/.exec(queryOf(input).q))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1]!, match[2]!] as const)
      .sort();
    expect(ranges).toHaveLength(6);
    // The windows start the day after the oldest sample and end the day
    // before the newest one, and never share a day with each other.
    expect(ranges[0]![0]).toBe("2015-04-11");
    expect(ranges[5]![1]).toBe("2024-03-22");
    for (let index = 1; index < ranges.length; index += 1) {
      expect(Date.parse(ranges[index]![0]) - Date.parse(ranges[index - 1]![1])).toBe(DAY);
    }
  });

  it("spreads a window's unreached commits over it instead of drawing a silence", async () => {
    const newest = run("new", "2024-06-30", 100);
    const oldest = run("old", "2015-04-10", 100).reverse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { q, order } = queryOf(input);
      const range = /author-date:(\S+)\.\.(\S+)/.exec(q);
      if (!range) {
        return searchReply(1400, order === "asc" ? oldest : newest);
      }
      // Each window really holds 200 commits and returns its newest 100.
      return searchReply(200, run(`w-${range[1]}`, range[2]!, 100));
    });
    vi.stubGlobal("fetch", fetchMock);

    const history = await load();
    const represented = history.activities.reduce((sum, activity) => sum + activity.count, 0);
    const estimates = history.activities.filter((activity) => activity.groupKey === null);

    expect(history.estimated).toBe(true);
    expect(represented).toBeCloseTo(1400, 5);
    expect(estimates.reduce((sum, activity) => sum + activity.count, 0)).toBeCloseTo(600, 5);
    // An estimate claims a count and a stretch of time, and nothing else.
    expect(estimates.every((activity) => activity.nightCount === null)).toBe(true);
    expect(estimates.every((activity) => activity.localHour === null)).toBe(true);
    expect(history.truncated).toBe(false);

    // No gap longer than a couple of weeks is left empty anywhere in between.
    const times = history.activities.map((activity) => activity.timestampMs);
    const widest = Math.max(...times.slice(1).map((time, index) => time - times[index]!));
    expect(widest).toBeLessThan(15 * DAY);
  });

  it("still fills the middle when the search budget runs out on it", async () => {
    const newest = run("new", "2024-06-30", 100);
    const oldest = run("old", "2015-04-10", 100).reverse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { order } = queryOf(input);
      // The second reply says the budget is now spent.
      return searchReply(900, order === "asc" ? oldest : newest, order === "asc" ? "0" : "1");
    });
    vi.stubGlobal("fetch", fetchMock);

    const history = await load();
    const represented = history.activities.reduce((sum, activity) => sum + activity.count, 0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(history.truncated).toBe(true);
    expect(history.estimated).toBe(true);
    expect(represented).toBeCloseTo(900, 5);
  });

  it("says so when there is nothing public to draw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => searchReply(0, [])));
    await expect(load()).rejects.toThrow(/No public commits found for someone/);
  });
});

describe("a person with a token", () => {
  const year = new Date().getUTCFullYear();

  function calendar(days: Record<string, number>): unknown {
    return {
      weeks: [
        {
          contributionDays: Object.entries(days).map(([date, contributionCount]) => ({
            date,
            contributionCount,
          })),
        },
      ],
    };
  }

  function repositories(entries: Record<string, [string, number][]>): unknown {
    return Object.entries(entries).map(([nameWithOwner, nodes]) => ({
      repository: { nameWithOwner },
      contributions: {
        nodes: nodes.map(([occurredAt, commitCount]) => ({ occurredAt, commitCount })),
      },
    }));
  }

  function yearsIn(init?: RequestInit): number[] {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    return [...query.matchAll(/\by(\d{4}):/g)].map((match) => Number(match[1]));
  }

  beforeEach(() => {
    resetBudgets();
    const token = "ghp_" + "a".repeat(36);
    vi.stubGlobal("localStorage", {
      getItem: () => token,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes each day's size from the calendar and its colour from the repositories", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      reply({
        data: {
          user: {
            contributionsCollection: { contributionYears: [year] },
            [`y${year}`]: {
              contributionCalendar: calendar({ [`${year}-02-03`]: 5, [`${year}-02-04`]: 2 }),
              commitContributionsByRepository: repositories({
                "owner/repository": [[`${year}-02-03T00:00:00Z`, 3]],
              }),
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const history = await load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
    const { query } = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { query: string };
    expect(query).toContain("contributionCalendar");
    expect(query).not.toMatch(/\b(message|parents|oid)\b/);

    expect(history.metric).toBe("contributions");
    expect(history.granularity).toBe("day");
    expect(history.truncated).toBe(false);
    // 3 February: three commits to one repository, and two contributions the
    // repositories do not account for. 4 February: two, unattributed.
    expect(
      history.activities.map((activity) => [activity.count, activity.groupKey]),
    ).toEqual([
      [3, "owner/repository"],
      [2, null],
      [2, null],
    ]);
    expect(history.activities.every((activity) => activity.nightCount === null)).toBe(true);
    // 3 February of any year is a known weekday; just check it is carried.
    expect(history.activities[0]!.weekday).toBe(
      (new Date(year, 1, 3).getDay() + 6) % 7,
    );
  });

  it("reads a midnight west or east of UTC as the calendar day it meant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply({
          data: {
            user: {
              contributionsCollection: { contributionYears: [year] },
              [`y${year}`]: {
                contributionCalendar: calendar({ [`${year}-02-03`]: 4 }),
                commitContributionsByRepository: repositories({
                  // Tokyo's midnight on the 3rd is 15:00 UTC on the 2nd…
                  "owner/east": [[`${year}-02-02T15:00:00Z`, 1]],
                  // …and Los Angeles's is 08:00 UTC on the 3rd.
                  "owner/west": [[`${year}-02-03T08:00:00Z`, 3]],
                }),
              },
            },
          },
        }),
      ),
    );

    const history = await load();
    expect(history.activities).toHaveLength(2);
    expect(new Set(history.activities.map((activity) => activity.timestampMs)).size).toBe(1);
  });

  it("never lets repository detail outgrow what the calendar counted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply({
          data: {
            user: {
              contributionsCollection: { contributionYears: [year] },
              [`y${year}`]: {
                contributionCalendar: calendar({ [`${year}-02-03`]: 4 }),
                commitContributionsByRepository: repositories({
                  "owner/a": [[`${year}-02-03T00:00:00Z`, 6]],
                  "owner/b": [[`${year}-02-03T00:00:00Z`, 2]],
                }),
              },
            },
          },
        }),
      ),
    );

    const history = await load();
    expect(history.activities.reduce((sum, activity) => sum + activity.count, 0)).toBeCloseTo(4);
  });

  it("asks for the earlier years together rather than one after another", async () => {
    const years = Array.from({ length: 8 }, (_, index) => year - 7 + index);
    let inFlight = 0;
    let widest = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const asked = yearsIn(init);
      inFlight += 1;
      widest = Math.max(widest, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const user: Record<string, unknown> = {
        contributionsCollection: { contributionYears: years },
      };
      for (const asking of asked) {
        user[`y${asking}`] = {
          contributionCalendar: calendar({ [`${asking}-03-01`]: 1 }),
          commitContributionsByRepository: [],
        };
      }
      return reply({ data: { user } }, "4000");
    });
    vi.stubGlobal("fetch", fetchMock);

    const history = await load();

    // One opening request, then seven earlier years in batches of three.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(widest).toBe(3);
    expect(history.activities).toHaveLength(8);
    const asked = fetchMock.mock.calls.flatMap(([, init]) => yearsIn(init)).sort();
    expect(asked).toEqual(years);
  });

  it("marks the history partial when GitHub leaves a year out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const asked = yearsIn(init);
        const user: Record<string, unknown> = {
          contributionsCollection: { contributionYears: [year - 1, year] },
        };
        if (asked.includes(year)) {
          user[`y${year}`] = {
            contributionCalendar: calendar({ [`${year}-01-05`]: 1 }),
            commitContributionsByRepository: [],
          };
        }
        return reply({ data: { user } });
      }),
    );

    expect((await load()).truncated).toBe(true);
  });

  it("names the account when GitHub has no such person", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ data: { user: null } })));
    await expect(load()).rejects.toThrow(/no account named someone/);
  });
});
