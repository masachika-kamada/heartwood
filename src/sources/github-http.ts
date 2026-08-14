/**
 * Every call to api.github.com goes through here, so rate limiting is handled
 * in one place instead of three.
 *
 * Two changes of approach are worth stating, because both were wrong before:
 *
 * 1. Wait *before* being refused, not after. GitHub reports how many requests
 *    are left in every response. Ignoring that means each window ends by
 *    throwing one request at the wall to discover the wall is there — and on
 *    the search endpoint, where the budget is ten a minute, wasting one in ten
 *    is not a rounding error.
 *
 * 2. Waiting is not a one-off. A long history crosses several windows, so a
 *    single retry meant the second window refused and the whole read died
 *    after a minute of work. Waiting is allowed as often as GitHub asks for
 *    it; what is capped is how long any one wait may be, which is the thing
 *    that actually protects the visitor from an unbounded stall.
 */

import type { LoadProgress } from "../core/types";
import { githubHeaders, hasToken } from "./github-auth";

const GITHUB_API_ORIGIN = "https://api.github.com";
/** A window is a minute for search, an hour for the rest. Never stall an hour. */
const MAX_WAIT_MS = 75_000;
/** Enough to cross several windows; low enough that a broken loop still ends. */
const MAX_WAITS = 12;
/** Clock skew between GitHub and the visitor's machine is real. Pad for it. */
const RESET_SLACK_MS = 1_500;

export interface GitHubRequest {
  readonly url: URL;
  readonly signal: AbortSignal;
  readonly onProgress: LoadProgress;
  /** Commits gathered so far, purely so the progress line keeps its count. */
  readonly progressCount: number;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** A quick preview returns partial data instead of waiting for another window. */
  readonly rateLimitMode?: "wait" | "fail";
}

export class GitHubRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

/** What GitHub last said about the budget for one endpoint family. */
interface Budget {
  remaining: number;
  resetMs: number;
}

/**
 * Search and the rest of the API have separate budgets, and spending one does
 * not touch the other, so they are tracked apart.
 */
const budgets = new Map<string, Budget>();
let budgetResetController = new AbortController();

function bucketOf(url: URL): string {
  if (url.pathname.startsWith("/search/")) {
    return "search";
  }
  return url.pathname === "/graphql" ? "graphql" : "core";
}

export function resetBudgets(): void {
  budgets.clear();
  budgetResetController.abort();
  budgetResetController = new AbortController();
}

/**
 * Fetches with the token if there is one, waiting out the rate limit rather
 * than failing at it. Returns the response only once it is `ok`.
 */
export async function githubFetch(request: GitHubRequest): Promise<Response> {
  if (request.url.origin !== GITHUB_API_ORIGIN) {
    throw new Error("Refusing to send GitHub credentials outside api.github.com.");
  }

  const bucket = bucketOf(request.url);
  let waits = 0;

  for (;;) {
    const waited = await waitForBudget(bucket, request, waits);
    if (waited) {
      waits += 1;
    }

    const response = await fetch(request.url, {
      method: request.method,
      body: request.body,
      signal: request.signal,
      headers: { ...githubHeaders(), ...request.headers },
    });

    recordBudget(bucket, response);

    if (response.ok) {
      return response;
    }

    const throttled = isThrottled(response);
    if (throttled && request.rateLimitMode === "fail") {
      throw new GitHubRateLimitError(describeFailure(response, request.url));
    }
    if (!throttled || waits >= MAX_WAITS) {
      throw new Error(describeFailure(response, request.url));
    }

    const waitMs = waitUntilReset(response);
    if (waitMs === null || waitMs > MAX_WAIT_MS) {
      throw new Error(describeFailure(response, request.url));
    }

    const completed = await announceAndWait(waitMs, request);
    if (completed) {
      waits += 1;
    }
  }
}

/**
 * The budget is spent — wait for the window to turn over before asking, so the
 * refusal never happens. Returns whether it actually waited.
 */
async function waitForBudget(
  bucket: string,
  request: GitHubRequest,
  waits: number,
): Promise<boolean> {
  const budget = budgets.get(bucket);
  if (!budget || budget.remaining > 0 || waits >= MAX_WAITS) {
    return false;
  }

  const waitMs = budget.resetMs - Date.now() + RESET_SLACK_MS;
  if (waitMs <= 0) {
    // The window already turned over; let the next response correct the count.
    budget.remaining = 1;
    return false;
  }
  if (request.rateLimitMode === "fail") {
    throw new GitHubRateLimitError(describeKnownLimit(bucket));
  }
  if (waitMs > MAX_WAIT_MS) {
    return false;
  }

  function describeKnownLimit(bucket: string): string {
    if (bucket === "search") {
      return hasToken()
        ? "GitHub's search budget is spent. Try again in a minute."
        : "GitHub's anonymous search budget is spent. Add a token for the full history, or try again in a minute.";
    }
    return hasToken()
      ? "This token has spent its GitHub API budget."
      : "GitHub's anonymous API budget is spent. Add a token or try again later.";
  }

  return await announceAndWait(waitMs, request);
}

/**
 * Returns false when an auth change reset the budgets and woke this request
 * early, so it can retry immediately with the new headers.
 */
async function announceAndWait(waitMs: number, request: GitHubRequest): Promise<boolean> {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  const suffix = hasToken() ? "" : " (a token lifts this)";
  request.onProgress(
    `Waiting ${seconds}s for GitHub's rate limit${suffix}`,
    request.progressCount,
    null,
  );
  return await interruptibleDelay(waitMs, request.signal, budgetResetController.signal);
}

function recordBudget(bucket: string, response: Response): void {
  const remaining = readNumberHeader(response, "x-ratelimit-remaining");
  const reset = readNumberHeader(response, "x-ratelimit-reset");
  if (remaining === null || reset === null) {
    return;
  }
  budgets.set(bucket, { remaining, resetMs: reset * 1000 });
}

function isThrottled(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  // 403 is also plain "forbidden", e.g. a token without the right scope. Only
  // an exhausted budget or an explicit Retry-After is worth waiting out.
  if (response.status !== 403) {
    return false;
  }
  if (response.headers.get("retry-after") !== null) {
    return true;
  }
  return readNumberHeader(response, "x-ratelimit-remaining") === 0;
}

/** Milliseconds until the limit resets, with a little slack. */
export function waitUntilReset(response: Response): number | null {
  const retryAfter = readNumberHeader(response, "retry-after");
  if (retryAfter !== null) {
    return retryAfter * 1000 + RESET_SLACK_MS;
  }
  const reset = readNumberHeader(response, "x-ratelimit-reset");
  if (reset === null) {
    return null;
  }
  return Math.max(0, reset * 1000 - Date.now()) + RESET_SLACK_MS;
}

function describeFailure(response: Response, url: URL): string {
  const search = bucketOf(url) === "search";

  if (response.status === 401) {
    return "GitHub rejected that token. It may have expired, or been revoked — remove it and try again.";
  }
  if (response.status === 409) {
    return "That repository is empty.";
  }
  if (response.status === 403 && !isThrottled(response)) {
    return hasToken()
      ? "GitHub refused this token for that request. Check that it can access the repository and has the required permissions."
      : "GitHub refused this request. Add a token with access to the resource, or use the local folder option.";
  }
  if (response.status === 403 || response.status === 429) {
    if (hasToken()) {
      return search
        ? "GitHub is still rate limiting this token. Wait a minute and try again."
        : "This token has spent its hourly budget. Wait, or use the local folder option.";
    }
    return search
      ? "GitHub is rate limiting anonymous searches, and the wait is longer than a minute. Add a token below to raise the limit, or use the local folder option."
      : "GitHub is rate limiting anonymous requests — sixty an hour, shared by everyone on your address. Add a token below, or use the local folder option.";
  }
  if (response.status === 422) {
    return "GitHub could not make sense of that name.";
  }
  if (response.status === 404) {
    return hasToken()
      ? "GitHub has nothing there that this token can see."
      : "GitHub has no such public account or repository. Private work needs a token, or the local folder option.";
  }
  if (response.status >= 500) {
    return `GitHub is having trouble (${response.status}). Try again shortly.`;
  }
  return `GitHub replied with ${response.status}.`;
}

function readNumberHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return interruptibleDelay(ms, signal).then(() => undefined);
}

/**
 * Resolves true when the timer elapsed, false when a budget reset woke it, and
 * rejects only when the caller cancelled the load.
 */
function interruptibleDelay(
  ms: number,
  signal: AbortSignal,
  wakeSignal?: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  if (wakeSignal?.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      wakeSignal?.removeEventListener("abort", onWake);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const onWake = (): void => {
      cleanup();
      resolve(false);
    };

    timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    wakeSignal?.addEventListener("abort", onWake, { once: true });
  });
}
