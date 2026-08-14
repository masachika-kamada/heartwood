/**
 * A synthetic history so the page has something alive on it before the visitor
 * hands over anything of their own.
 *
 * It is not random noise: it tells a small story on purpose — an enthusiastic
 * first year, a second contributor arriving, a long quiet stretch, a big
 * rewrite, then a steady maintained tail.
 */

import type { ActivityHistory, ActivityRecord } from "../core/types";
import { isNightAt } from "../core/activity";
import { hashString, mulberry32 } from "../core/prng";

interface Chapter {
  readonly months: number;
  readonly commitsPerMonth: number;
  readonly churnScale: number;
  readonly nightBias: number;
  readonly authors: readonly number[];
  readonly rewriteInFinalMonth?: boolean;
}

const CAST = [
  { email: "wren@example.com", tzOffsetMinutes: 540 },
  { email: "ansel@example.com", tzOffsetMinutes: -300 },
  { email: "margot@example.com", tzOffsetMinutes: 60 },
];

const CHAPTERS: readonly Chapter[] = [
  { months: 8, commitsPerMonth: 34, churnScale: 1.5, nightBias: 0.62, authors: [0] },
  { months: 6, commitsPerMonth: 22, churnScale: 0.8, nightBias: 0.34, authors: [0, 1] },
  { months: 5, commitsPerMonth: 1, churnScale: 0.2, nightBias: 0.1, authors: [0] },
  {
    months: 4,
    commitsPerMonth: 40,
    churnScale: 2.4,
    nightBias: 0.55,
    authors: [0, 1, 2],
    rewriteInFinalMonth: true,
  },
  { months: 9, commitsPerMonth: 12, churnScale: 0.6, nightBias: 0.2, authors: [1, 2] },
];

const SUMMARIES = [
  "Fix the thing that only breaks on Sundays",
  "Extract the loader so it stops knowing about the view",
  "Make the empty state say something kinder",
  "Cache the parsed objects",
  "Rename everything, sorry",
  "Handle the timezone properly this time",
  "Add the test I should have written first",
  "Tidy up",
];

export function createDemoHistory(): ActivityHistory {
  const random = mulberry32(hashString("heartwood-demo-v1"));
  const activities: ActivityRecord[] = [];

  const start = new Date();
  start.setFullYear(start.getFullYear() - 3, start.getMonth(), 1);
  start.setHours(0, 0, 0, 0);

  let monthCursor = 0;

  for (const chapter of CHAPTERS) {
    for (let month = 0; month < chapter.months; month += 1) {
      const isRewriteMonth =
        chapter.rewriteInFinalMonth === true && month === chapter.months - 1;
      const count = Math.max(
        0,
        Math.round(chapter.commitsPerMonth * (0.6 + random() * 0.8)),
      );

      for (let index = 0; index < count; index += 1) {
        const author = CAST[chapter.authors[Math.floor(random() * chapter.authors.length)]!]!;
        const date = new Date(start);
        date.setMonth(start.getMonth() + monthCursor + month);
        date.setDate(1 + Math.floor(random() * 27));

        const atNight = random() < chapter.nightBias;
        date.setHours(atNight ? (random() < 0.5 ? 23 : 2) : 10 + Math.floor(random() * 8));
        date.setMinutes(Math.floor(random() * 60));

        const magnitude = Math.round(
          (6 + random() * 90) * chapter.churnScale * (random() < 0.1 ? 4 : 1),
        );

        const deletions = Math.round(magnitude * random() * 0.8);
        const summary = SUMMARIES[Math.floor(random() * SUMMARIES.length)]!;
        const id = fakeSha(random);
        activities.push({
          timestampMs: date.getTime(),
          count: 1,
          magnitude: magnitude + deletions,
          nightCount: isNightAt(date.getTime(), author.tzOffsetMinutes) ? 1 : 0,
          groupKey: author.email,
          detail: { id, summary },
        });
      }

      if (isRewriteMonth) {
        const date = new Date(start);
        date.setMonth(start.getMonth() + monthCursor + month);
        date.setDate(18);
        date.setHours(3, 14);
        const id = fakeSha(random);
        activities.push({
          timestampMs: date.getTime(),
          count: 1,
          magnitude: 9_400 + 7_800,
          nightCount: 1,
          groupKey: CAST[0]!.email,
          detail: { id, summary: "Replace the rendering layer entirely" },
        });
      }
    }
    monthCursor += chapter.months;
  }

  activities.sort((a, b) => a.timestampMs - b.timestampMs);

  return {
    name: "a made-up project",
    activities,
    metric: "lines",
    groupKind: "authors",
    truncated: false,
    sourceKind: "demo",
  };
}

function fakeSha(random: () => number): string {
  let sha = "";
  while (sha.length < 40) {
    sha += Math.floor(random() * 16).toString(16);
  }
  return sha;
}
