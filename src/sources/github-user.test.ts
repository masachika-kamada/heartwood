import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGitHubUserHistory } from "./github-user";
import { resetBudgets } from "./github-http";

function searchItem(index: number): unknown {
  return {
    sha: `sha-${index}`,
    commit: {
      author: { date: "2024-01-15T12:00:00+09:00" },
    },
    repository: { full_name: `owner/repository-${index % 3}` },
  };
}

function reply(body: unknown, remaining = "9"): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "x-ratelimit-remaining": remaining,
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
    },
  });
}

describe("loadGitHubUserHistory", () => {
  beforeEach(() => {
    resetBudgets();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a bounded anonymous preview instead of waiting for another window", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => searchItem(index));
    const fetchMock = vi.fn().mockResolvedValue(
      reply(
        {
          total_count: 900,
          incomplete_results: false,
          items: firstPage,
        },
        "0",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const history = await loadGitHubUserHistory(
      "someone",
      vi.fn(),
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(history.activities).toHaveLength(100);
    expect(history.metric).toBe("commits");
    expect(history.groupKind).toBe("repositories");
    expect(history.truncated).toBe(true);
  });

  it("uses compact yearly GraphQL commit contributions when a token exists", async () => {
    const token = "ghp_" + "a".repeat(36);
    vi.stubGlobal("localStorage", {
      getItem: () => token,
      setItem: () => undefined,
      removeItem: () => undefined,
    });

    const year = new Date().getUTCFullYear();
    const responses = [
      reply({ data: { user: { createdAt: `${year}-01-01T00:00:00Z` } } }, "4999"),
      reply(
        {
          data: {
            user: {
              [`y${year}`]: {
                totalCommitContributions: 3,
                commitContributionsByRepository: [
                  {
                    repository: { nameWithOwner: "owner/repository" },
                    contributions: {
                      nodes: [
                        {
                          occurredAt: `${year}-02-03T00:00:00Z`,
                          commitCount: 3,
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                ],
              },
            },
          },
        },
        "4998",
      ),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        responses.shift()!,
    );
    vi.stubGlobal("fetch", fetchMock);

    const history = await loadGitHubUserHistory(
      "someone",
      vi.fn(),
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1]?.method).toBe("POST");
    const requestBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as {
      query: string;
    };
    expect(requestBody.query).toContain("commitCount");
    expect(requestBody.query).not.toMatch(/\b(message|parents|oid)\b/);
    expect(history.activities).toEqual([
      expect.objectContaining({
        count: 3,
        nightCount: null,
        groupKey: "owner/repository",
      }),
    ]);
    expect(history.truncated).toBe(false);
  });

  it("marks GraphQL history partial when GitHub omits contribution nodes", async () => {
    const token = "ghp_" + "a".repeat(36);
    vi.stubGlobal("localStorage", {
      getItem: () => token,
      setItem: () => undefined,
      removeItem: () => undefined,
    });

    const year = new Date().getUTCFullYear();
    const responses = [
      reply({ data: { user: { createdAt: `${year}-01-01T00:00:00Z` } } }, "4999"),
      reply({
        data: {
          user: {
            [`y${year}`]: {
              totalCommitContributions: 5,
              commitContributionsByRepository: [
                {
                  repository: { nameWithOwner: "owner/repository" },
                  contributions: {
                    nodes: [
                      {
                        occurredAt: `${year}-02-03T00:00:00Z`,
                        commitCount: 3,
                      },
                    ],
                    pageInfo: { hasNextPage: true },
                  },
                },
              ],
            },
          },
        },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => responses.shift()!));

    const history = await loadGitHubUserHistory(
      "someone",
      vi.fn(),
      new AbortController().signal,
    );

    expect(history.truncated).toBe(true);
    expect(history.activities[0]!.count).toBe(3);
  });
});
