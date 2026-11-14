/**
 * The trunk as a core sample: the pencil-thin cylinder a forester bores out
 * of a living tree to count its rings without felling it. Pith at the left,
 * bark at the right, every ring a band across it.
 *
 * It exists because of what a README can and cannot do. A README runs no
 * script and applies no stylesheet, so a round drawing in it cannot answer a
 * pointer. But it does keep the `title` on an image, and a browser shows a
 * title when the pointer rests there. A ring in a core is a rectangle, and a
 * rectangle can be its own image: so the core is cut into one small image
 * per ring, each titled with what that ring would say on the page, and laid
 * side by side with nothing between them. Resting on a band reads it.
 */

import type { Ring, TreeModel } from "../core/types";
import { activityNoun } from "../core/activity";
import { hashString, mulberry32 } from "../core/prng";
import { woodColours } from "./rings";

export interface CoreOptions {
  /** Total length in CSS pixels, bark included. */
  readonly width?: number;
  /** Thickness in CSS pixels. */
  readonly height?: number;
  /** Image pixels per CSS pixel. */
  readonly pixelRatio?: number;
}

export interface CoreSlice {
  /** -1 for the bark at the end, otherwise the ring's index. */
  readonly ringIndex: number;
  /** Width in CSS pixels; the image is this times the pixel ratio. */
  readonly width: number;
  /** What resting on the band says. */
  readonly title: string;
  readonly dataUrl: string;
}

export interface Core {
  readonly height: number;
  readonly slices: CoreSlice[];
}

/** A band thinner than this cannot be pointed at. */
const MIN_BAND = 2;

export function renderCore(tree: TreeModel, options: CoreOptions = {}): Core {
  const height = Math.round(options.height ?? 54);
  const pixelRatio = options.pixelRatio ?? 2;
  if (tree.rings.length === 0) {
    return { height, slices: [] };
  }

  const total = Math.round(options.width ?? 840);
  const bark = Math.max(6, Math.round(height * 0.16));
  const widths = bandWidths(tree.rings, total - bark);
  const length = widths.reduce((sum, width) => sum + width, 0) + bark;

  const canvas = document.createElement("canvas");
  canvas.width = length * pixelRatio;
  canvas.height = height * pixelRatio;
  const context = canvas.getContext("2d");
  if (!context) {
    return { height, slices: [] };
  }
  context.scale(pixelRatio, pixelRatio);

  // The cylinder's outline: rounded where the borer broke it off.
  const radius = height * 0.28;
  context.beginPath();
  context.roundRect(0, 0, length, height, radius);
  context.clip();

  const colourAt = woodColours(tree);
  const step = 1 / pixelRatio;
  let x = 0;
  for (const [index, width] of widths.entries()) {
    for (let column = 0; column < width; column += step) {
      context.fillStyle = colourAt(index, (column + step / 2) / width);
      context.fillRect(x + column, 0, step + 0.01, height);
    }
    x += width;
  }
  context.fillStyle = "hsl(24 26% 15%)";
  context.fillRect(x, 0, bark, height);
  context.fillStyle = "hsl(21 40% 31%)";
  context.fillRect(x, 0, Math.max(1, bark * 0.22), height);

  // Ring boundaries, heavier where a year turns over.
  x = 0;
  for (const [index, width] of widths.entries()) {
    x += width;
    const closesYear = tree.rings[index + 1]?.mark != null && tree.period !== "day";
    context.fillStyle = closesYear ? "rgba(38, 20, 8, 0.8)" : "rgba(52, 28, 12, 0.3)";
    context.fillRect(x - (closesYear ? 1 : 0.5), 0, closesYear ? 1 : 0.5, height);
  }

  drawGrain(context, tree, length - bark, length, height);

  // Round, not flat: light along the middle, falling away to both edges.
  const roundness = context.createLinearGradient(0, 0, 0, height);
  roundness.addColorStop(0, "rgba(20, 10, 4, 0.42)");
  roundness.addColorStop(0.3, "rgba(255, 244, 222, 0.14)");
  roundness.addColorStop(0.55, "rgba(255, 244, 222, 0)");
  roundness.addColorStop(1, "rgba(20, 10, 4, 0.5)");
  context.fillStyle = roundness;
  context.fillRect(0, 0, length, height);

  const noun = activityNoun(tree.metric);
  const slices: CoreSlice[] = [];
  x = 0;
  const cut = (width: number, ringIndex: number, title: string): void => {
    const piece = document.createElement("canvas");
    piece.width = width * pixelRatio;
    piece.height = height * pixelRatio;
    piece
      .getContext("2d")
      ?.drawImage(
        canvas,
        x * pixelRatio,
        0,
        piece.width,
        piece.height,
        0,
        0,
        piece.width,
        piece.height,
      );
    slices.push({ ringIndex, width, title, dataUrl: piece.toDataURL("image/webp", 0.9) });
    x += width;
  };
  for (const [index, width] of widths.entries()) {
    cut(width, index, describeRing(tree.rings[index]!, tree, noun));
  }
  cut(bark, -1, `Bark · ${tree.name}`);

  return { height, slices };
}

/**
 * Whole-pixel widths that add up to `available`, proportional to how thick
 * each ring grew, except that no band is too thin to point at.
 */
export function bandWidths(rings: readonly Ring[], available: number): number[] {
  const floor = rings.length * MIN_BAND;
  if (available <= floor) {
    return rings.map(() => MIN_BAND);
  }
  const grown = rings.reduce((sum, ring) => sum + ring.thickness, 0);
  const exact = rings.map((ring) => MIN_BAND + (ring.thickness / grown) * (available - floor));
  const widths = exact.map(Math.floor);
  // Hand the pixels lost to rounding to the bands that lost the most.
  const order = exact
    .map((value, index) => ({ index, lost: value - Math.floor(value) }))
    .sort((a, b) => b.lost - a.lost);
  let spare = available - widths.reduce((sum, width) => sum + width, 0);
  for (const { index } of order) {
    if (spare <= 0) {
      break;
    }
    widths[index]! += 1;
    spare -= 1;
  }
  return widths;
}

/** One line, because a browser's tooltip is one line. Counts only, no names. */
export function describeRing(ring: Ring, tree: TreeModel, noun = activityNoun(tree.metric)): string {
  if (ring.dormant) {
    return `${ring.label} · no ${noun}`;
  }
  const count = Math.round(ring.activityCount);
  const parts = [
    ring.label,
    `${count.toLocaleString("en")} ${activityNoun(tree.metric, count)}`,
  ];
  if (tree.metric === "lines") {
    parts.push(`${ring.volume.toLocaleString("en")} lines changed`);
  }
  if (ring.nightRatio !== null) {
    parts.push(`${Math.round(ring.nightRatio * 100)}% at night`);
  } else if (tree.shadeKind === "weekend" && ring.weekendRatio !== null) {
    parts.push(`${Math.round(ring.weekendRatio * 100)}% at weekends`);
  }
  return parts.join(" · ");
}

/** Long fibres running the length of the core, and a scatter of pores. */
function drawGrain(
  context: CanvasRenderingContext2D,
  tree: TreeModel,
  wood: number,
  length: number,
  height: number,
): void {
  const random = mulberry32(hashString(`core:${tree.name}`));
  for (let fibre = 0; fibre < height * 1.6; fibre += 1) {
    const y = random() * height;
    const from = random() * wood;
    const run = (0.15 + random() * 0.6) * wood;
    context.fillStyle =
      random() < 0.6
        ? `rgba(255, 240, 210, ${(0.03 + random() * 0.06).toFixed(3)})`
        : `rgba(48, 24, 8, ${(0.03 + random() * 0.06).toFixed(3)})`;
    context.fillRect(from, y, Math.min(run, wood - from), 0.5 + random() * 0.6);
  }
  for (let pore = 0; pore < length * height * 0.02; pore += 1) {
    context.fillStyle = `rgba(46, 24, 10, ${(0.08 + random() * 0.14).toFixed(3)})`;
    context.fillRect(random() * wood, random() * height, 0.6, 0.6);
  }
}
