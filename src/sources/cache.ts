/**
 * Remembers recently drawn GitHub histories in this browser.
 *
 * GitHub's anonymous budget is sixty requests an hour, and a tree that has
 * been drawn once should not spend any of it to be drawn again — on a reload,
 * a second look, or a link opened in another tab. A cached history is a few
 * numbers per activity, never a response body, and it expires on its own so
 * yesterday's trunk is not passed off as today's.
 */

import type { ActivityHistory, ActivityRecord } from "../core/types";

const PREFIX = "heartwood.history.v1.";
const INDEX_KEY = `${PREFIX}index`;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 8;
/** localStorage is small and shared; one huge history must not evict the rest. */
const MAX_ENTRY_CHARS = 1_200_000;

export interface CachedHistory {
  readonly history: ActivityHistory;
  readonly savedAtMs: number;
}

type PackedRecord = [
  timestampMs: number,
  count: number,
  magnitude: number | null,
  nightCount: number | null,
  group: number,
  localHour: number | null,
  weekday: number | null,
  detailId?: string,
  detailSummary?: string,
];

interface PackedHistory {
  readonly savedAtMs: number;
  readonly meta: Omit<ActivityHistory, "activities">;
  readonly groups: readonly string[];
  readonly records: readonly PackedRecord[];
}

interface IndexEntry {
  readonly key: string;
  readonly savedAtMs: number;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readIndex(store: Storage): IndexEntry[] {
  try {
    const parsed = JSON.parse(store.getItem(INDEX_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is IndexEntry =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as IndexEntry).key === "string" &&
            typeof (entry as IndexEntry).savedAtMs === "number",
        )
      : [];
  } catch {
    return [];
  }
}

export function readCachedHistory(key: string, nowMs = Date.now()): CachedHistory | null {
  const store = storage();
  if (!store) {
    return null;
  }
  try {
    const raw = store.getItem(PREFIX + key);
    if (!raw) {
      return null;
    }
    const packed = JSON.parse(raw) as PackedHistory;
    if (
      typeof packed?.savedAtMs !== "number" ||
      nowMs - packed.savedAtMs > MAX_AGE_MS ||
      !Array.isArray(packed.records) ||
      !Array.isArray(packed.groups)
    ) {
      store.removeItem(PREFIX + key);
      return null;
    }
    return { history: unpack(packed), savedAtMs: packed.savedAtMs };
  } catch {
    return null;
  }
}

export function writeCachedHistory(
  key: string,
  history: ActivityHistory,
  nowMs = Date.now(),
): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    const raw = JSON.stringify(pack(history, nowMs));
    if (raw.length > MAX_ENTRY_CHARS) {
      return;
    }
    const index = readIndex(store).filter((entry) => entry.key !== key);
    index.push({ key, savedAtMs: nowMs });
    while (index.length > MAX_ENTRIES) {
      const oldest = index.shift();
      if (oldest) {
        store.removeItem(PREFIX + oldest.key);
      }
    }
    store.setItem(PREFIX + key, raw);
    store.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // A full or forbidden store only costs a repeat request later.
  }
}

/** Forgets everything, e.g. when a token that could see private work is removed. */
export function clearCachedHistories(): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    for (const entry of readIndex(store)) {
      store.removeItem(PREFIX + entry.key);
    }
    store.removeItem(INDEX_KEY);
  } catch {
    // Nothing useful to do about a store that refuses to forget.
  }
}

function pack(history: ActivityHistory, savedAtMs: number): PackedHistory {
  const { activities, ...meta } = history;
  const groups: string[] = [];
  const groupIndex = new Map<string, number>();
  const records = activities.map((activity): PackedRecord => {
    let group = -1;
    if (activity.groupKey !== null) {
      group = groupIndex.get(activity.groupKey) ?? -1;
      if (group === -1) {
        group = groups.push(activity.groupKey) - 1;
        groupIndex.set(activity.groupKey, group);
      }
    }
    const record: PackedRecord = [
      activity.timestampMs,
      activity.count,
      activity.magnitude,
      activity.nightCount,
      group,
      activity.localHour ?? null,
      activity.weekday ?? null,
    ];
    if (activity.detail) {
      record.push(activity.detail.id, activity.detail.summary);
    }
    return record;
  });
  return { savedAtMs, meta, groups, records };
}

function unpack(packed: PackedHistory): ActivityHistory {
  const activities = packed.records.map(
    (record): ActivityRecord => ({
      timestampMs: record[0],
      count: record[1],
      magnitude: record[2],
      nightCount: record[3],
      groupKey: record[4] >= 0 ? (packed.groups[record[4]] ?? null) : null,
      localHour: record[5],
      weekday: record[6],
      detail:
        typeof record[7] === "string" && typeof record[8] === "string"
          ? { id: record[7], summary: record[8] }
          : null,
    }),
  );
  return { ...packed.meta, activities };
}
