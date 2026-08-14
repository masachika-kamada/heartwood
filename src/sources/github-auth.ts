/**
 * An optional GitHub token, kept in this browser and nowhere else.
 *
 * Heartwood's whole argument is that it has no server and wants no account, so
 * a token cannot be required. But anonymous search is ten requests a minute,
 * and a career's worth of commits does not fit in ten requests — so someone
 * watching a progress bar crawl for seventy seconds deserves the option.
 *
 * A token multiplies the search budget by three (10/min -> 30/min) and the
 * ordinary budget by eighty (60/hour -> 5000/hour), and lets a person draw the
 * repositories they can see rather than only the ones the world can.
 *
 * It is stored in localStorage. That is honest rather than clever: there is no
 * server to hold it instead, and a token that has to be re-pasted every visit
 * is a token nobody uses.
 */

const STORAGE_KEY = "heartwood.github-token";

/**
 * Deliberately loose. GitHub has changed its token formats more than once, and
 * a picky check that rejects a valid future token is worse than a permissive
 * one that lets GitHub itself say no.
 */
export function isPlausibleToken(candidate: string): boolean {
  const trimmed = candidate.trim();
  return trimmed.length >= 20 && !/\s/.test(trimmed);
}

/** Enough to recognise your own token without printing it back at you. */
export function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 8) {
    return "•".repeat(trimmed.length);
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/**
 * Storage can throw outright: Safari in private mode, a browser with site data
 * disabled, an embedded webview. None of that should take the page down, so
 * every path here degrades to "no token" instead.
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readToken(): string | null {
  try {
    const value = storage()?.getItem(STORAGE_KEY) ?? null;
    return value && isPlausibleToken(value) ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Why a save did not take. "Invalid" and "unavailable" are different problems
 * with different answers — telling someone their token is malformed when the
 * browser simply refused to store it sends them to fix the wrong thing.
 */
export type SaveOutcome = "saved" | "invalid" | "unavailable";

export function saveToken(token: string): SaveOutcome {
  if (!isPlausibleToken(token)) {
    return "invalid";
  }
  const store = storage();
  if (!store) {
    return "unavailable";
  }
  try {
    const trimmed = token.trim();
    store.setItem(STORAGE_KEY, trimmed);
    return store.getItem(STORAGE_KEY) === trimmed ? "saved" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export type ClearOutcome = "cleared" | "unavailable";

export function clearToken(): ClearOutcome {
  const store = storage();
  if (!store) {
    return "unavailable";
  }
  try {
    store.removeItem(STORAGE_KEY);
    return store.getItem(STORAGE_KEY) === null ? "cleared" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function hasToken(): boolean {
  return readToken() !== null;
}

/** Headers for any api.github.com call, with the token when there is one. */
export function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = readToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}
