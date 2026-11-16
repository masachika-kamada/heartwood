/**
 * The trunk's highlights as short phrases, for a place that can only hold
 * text: the line under the trunk in a README. The thickest ring and the
 * longest quiet stretch are not repeated here; the picture pins those.
 */

import { highlightsOf } from "../core/highlights";
import type { TreeModel } from "../core/types";
import { peakOf } from "./reading";

export function noticeLines(tree: TreeModel): string[] {
  const found = highlightsOf(tree);
  const lines: string[] = [];
  if (found.busiestYear) {
    lines.push(`Busiest year: ${found.busiestYear.year}`);
  }
  const lean = peakOf(tree);
  if (lean !== "") {
    lines.push(`Leans toward ${lean}`);
  }
  if (found.trend !== null) {
    if (found.trend >= 2) {
      lines.push(`Last 12 months: ${found.trend.toFixed(1)}× the 12 before`);
    } else {
      const change = Math.round((found.trend - 1) * 100);
      if (Math.abs(change) >= 5) {
        lines.push(`Last 12 months: ${change > 0 ? "+" : "−"}${Math.abs(change)}% on the 12 before`);
      }
    }
  }
  return lines;
}
