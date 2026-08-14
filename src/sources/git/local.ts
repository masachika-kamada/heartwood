/**
 * Local `.git` history reader.
 *
 * Everything runs in the browser: the user grants access to a directory with
 * the File System Access API, we parse the object database in place, and no
 * byte of the repository leaves the machine.
 */

import type {
  ActivityHistory,
  ActivityRecord,
  CommitRecord,
  HistorySource,
  LoadProgress,
} from "../../core/types";
import { isNightAt } from "../../core/activity";
import { GitObjectStore } from "./objects";

const MAX_COMMITS = 20000;
const PROGRESS_EVERY = 200;

const decoder = new TextDecoder();

/* ------------------------------------------------------------------ *
 * Commit parsing (pure)
 * ------------------------------------------------------------------ */

interface Identity {
  readonly name: string;
  readonly email: string;
  readonly timestampMs: number;
  readonly tzOffsetMinutes: number;
}

const EMPTY_IDENTITY: Identity = {
  name: "",
  email: "",
  timestampMs: 0,
  tzOffsetMinutes: 0,
};

/**
 * Parse the value part of an `author` / `committer` line, e.g.
 * `Ada <ada@example.com> 1700000000 +0900`.
 *
 * Names can legitimately contain angle brackets, so the email is taken from the
 * *last* `<...>` pair. Anything unparseable degrades to empty/zero rather than
 * throwing: one weird commit must not sink the whole history.
 */
export function parseIdentity(line: string): Identity {
  const close = line.lastIndexOf(">");
  const open = close < 0 ? -1 : line.lastIndexOf("<", close);
  if (open < 0 || close < 0) return EMPTY_IDENTITY;

  const name = line.slice(0, open).trim();
  const email = line.slice(open + 1, close).trim();
  const rest = line.slice(close + 1).trim();
  if (rest.length === 0) return { name, email, timestampMs: 0, tzOffsetMinutes: 0 };

  const parts = rest.split(/\s+/);
  const seconds = Number.parseInt(parts[0] ?? "", 10);
  const tz = parts[1] ?? "";

  let tzOffsetMinutes = 0;
  const tzMatch = /^([+-])(\d{2})(\d{2})$/.exec(tz);
  if (tzMatch) {
    const sign = tzMatch[1] === "-" ? -1 : 1;
    tzOffsetMinutes = sign * (Number(tzMatch[2]) * 60 + Number(tzMatch[3]));
  }

  return {
    name,
    email,
    timestampMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
    tzOffsetMinutes,
  };
}

/** Parse a raw commit object payload (the bytes after the loose-object header). */
export function parseCommitObject(sha: string, payload: Uint8Array): CommitRecord {
  const text = decoder.decode(payload);

  // Headers end at the first blank line.
  let headerEnd = text.indexOf("\n\n");
  if (headerEnd < 0) {
    headerEnd = text.length;
  }

  const parents: string[] = [];
  let author: Identity | null = null;

  for (const line of text.slice(0, headerEnd).split("\n")) {
    // Continuation lines of multi-line headers (gpgsig) start with a space.
    if (line.startsWith(" ") || line.length === 0) continue;
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === "parent") {
      parents.push(value.trim().toLowerCase());
    } else if (key === "author" && author === null) {
      author = parseIdentity(value);
    }
  }

  const identity = author ?? EMPTY_IDENTITY;
  return {
    sha,
    timestampMs: identity.timestampMs,
    tzOffsetMinutes: identity.tzOffsetMinutes,
    authorName: identity.name,
    authorEmail: identity.email,
    parents,
  };
}

/** Parse a `packed-refs` file into a ref-name → sha map. */
export function parsePackedRefs(text: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // `#` is a header comment, `^` a peeled tag target we do not need.
    if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space < 0) continue;
    refs.set(line.slice(space + 1).trim(), line.slice(0, space).toLowerCase());
  }
  return refs;
}

/* ------------------------------------------------------------------ *
 * Directory helpers
 * ------------------------------------------------------------------ */

async function readTextFile(dir: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const segments = path.split("/");
  const fileName = segments.pop();
  if (fileName === undefined) return null;
  try {
    let cursor = dir;
    for (const segment of segments) cursor = await cursor.getDirectoryHandle(segment);
    const file = await (await cursor.getFileHandle(fileName)).getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function hasEntry(
  dir: FileSystemDirectoryHandle,
  name: string,
  kind: "file" | "directory",
): Promise<boolean> {
  try {
    if (kind === "directory") await dir.getDirectoryHandle(name);
    else await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** True when this handle looks like a `.git` directory. */
async function looksLikeGitDir(dir: FileSystemDirectoryHandle): Promise<boolean> {
  if (!(await hasEntry(dir, "HEAD", "file"))) return false;
  return (await hasEntry(dir, "objects", "directory")) || (await hasEntry(dir, "refs", "directory"));
}

async function resolveGitDir(dir: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
  if (await looksLikeGitDir(dir)) return dir;

  try {
    const inner = await dir.getDirectoryHandle(".git");
    if (await looksLikeGitDir(inner)) return inner;
  } catch {
    // Fall through: maybe `.git` is a file, maybe it is absent entirely.
  }

  if (await hasEntry(dir, ".git", "file")) {
    throw new Error("Worktrees and submodules are not supported yet.");
  }

  throw new Error("That folder is not a git repository.");
}

/* ------------------------------------------------------------------ *
 * Refs
 * ------------------------------------------------------------------ */

async function resolveHead(gitDir: FileSystemDirectoryHandle): Promise<string> {
  const head = await readTextFile(gitDir, "HEAD");
  if (head === null) throw new Error("That folder is not a git repository.");

  const trimmed = head.trim();
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();

  const match = /^ref:\s*(.+)$/.exec(trimmed);
  if (!match) throw new Error("Could not understand this repository's HEAD.");
  const refName = match[1]!.trim();

  const direct = await readTextFile(gitDir, refName);
  if (direct !== null) {
    const sha = direct.trim().toLowerCase();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }

  const packed = await readTextFile(gitDir, "packed-refs");
  if (packed !== null) {
    const sha = parsePackedRefs(packed).get(refName);
    if (sha) return sha;
  }

  throw new Error("This repository has no commits yet.");
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

export async function loadLocalHistory(
  dir: FileSystemDirectoryHandle,
  onProgress: LoadProgress,
  signal: AbortSignal,
): Promise<ActivityHistory> {
  throwIfAborted(signal);
  onProgress("Opening repository", 0, null);

  const gitDir = await resolveGitDir(dir);
  const headSha = await resolveHead(gitDir);

  throwIfAborted(signal);
  onProgress("Reading packfiles", 0, null);
  const store = await GitObjectStore.open(gitDir);

  const commits: CommitRecord[] = [];
  const visited = new Set<string>([headSha]);
  const queue: string[] = [headSha];
  let head = 0;
  let truncated = false;

  onProgress("Reading commits", 0, null);
  while (head < queue.length) {
    if (commits.length >= MAX_COMMITS) {
      truncated = true;
      break;
    }
    throwIfAborted(signal);

    const sha = queue[head++]!;
    const object = await store.read(sha);
    if (!object || object.type !== "commit") continue;

    const record = parseCommitObject(sha, object.data);
    commits.push(record);

    for (const parent of record.parents) {
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }

    if (commits.length % PROGRESS_EVERY === 0) {
      onProgress("Reading commits", visited.size, null);
      // Yield so the UI can paint during long walks.
      await Promise.resolve();
    }
  }

  onProgress("Reading commits", visited.size, null);
  commits.sort((a, b) => a.timestampMs - b.timestampMs || a.sha.localeCompare(b.sha));

  return {
    name: dir.name === ".git" || dir.name.length === 0 ? "repository" : dir.name,
    activities: commits.map(toActivity),
    metric: "commits",
    groupKind: "authors",
    truncated,
    sourceKind: "local",
  };
}

function toActivity(commit: CommitRecord): ActivityRecord {
  const groupKey = commit.authorEmail || commit.authorName || "unknown";
  return {
    timestampMs: commit.timestampMs,
    count: 1,
    magnitude: null,
    nightCount: isNightAt(commit.timestampMs, commit.tzOffsetMinutes) ? 1 : 0,
    groupKey,
    detail: null,
  };
}

/** Wrap a picked directory as a `HistorySource`. */
export function localHistorySource(dir: FileSystemDirectoryHandle): HistorySource {
  return {
    kind: "local",
    load: (onProgress, signal) => loadLocalHistory(dir, onProgress, signal),
  };
}
