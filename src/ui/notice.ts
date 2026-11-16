/**
 * The trunk's highlights as short phrases, for a place that can only hold
 * text: the line under the trunk in a README.
 */

import { activityNoun } from "../core/activity";
import { highlightsOf } from "../core/highlights";
import type { TreeModel } from "../core/types";
import { peakOf } from "./reading";

export function noticeLines(tree: TreeModel): string[] {
  const found = highlightsOf(tree);
  const lines: string[] = [];
  if (found.peak) {
    const count = Math.round(found.peak.activityCount);
    lines.push(
      `Thickest ring: ${found.peak.label} (${count.toLocaleString("en")} ${activityNoun(tree.metric, count)})`,
    );
  }
  if (found.busiestYear) {
    lines.push(`Busiest year: ${found.busiestYear.year}`);
  }
  if (found.quiet) {
    const { from, to } = found.quiet;
    lines.push(`Longest quiet stretch: ${from.label} to ${to.label}`);
  }
  const lean = peakOf(tree);
  if (lean !== "") {
    lines.push(`Leans toward ${lean}`);
  }
  if (found.trend !== null) {
    const change = Math.round((found.trend - 1) * 100);
    if (Math.abs(change) >= 5) {
      lines.push(`Last 12 months: ${change > 0 ? "+" : "−"}${Math.abs(change)}% on the 12 before`);
    }
  }
  return lines;
}
