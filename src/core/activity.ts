import type { ActivityGroupKind, ActivityMetric } from "./types";

export function isNightAt(timestampMs: number, tzOffsetMinutes: number): boolean {
  const localMs = timestampMs + tzOffsetMinutes * 60_000;
  const hour = new Date(localMs).getUTCHours();
  return hour >= 22 || hour < 5;
}

/** What the author's own clock and calendar said at that instant. */
export function localClock(
  timestampMs: number,
  tzOffsetMinutes: number,
): { hour: number; weekday: number } {
  const local = new Date(timestampMs + tzOffsetMinutes * 60_000);
  return {
    hour: local.getUTCHours() + local.getUTCMinutes() / 60,
    // Monday first, so that the weekend is the last two days rather than both ends.
    weekday: (local.getUTCDay() + 6) % 7,
  };
}

export function activityNoun(metric: ActivityMetric, count = 2): string {
  const singular = metric === "contributions" ? "contribution" : "commit";
  return count === 1 ? singular : `${singular}s`;
}

export function groupNoun(kind: ActivityGroupKind, count = 2): string {
  if (kind === "repositories") {
    return count === 1 ? "repository" : "repositories";
  }
  if (kind === "authors") {
    return count === 1 ? "hand" : "hands";
  }
  return "";
}
