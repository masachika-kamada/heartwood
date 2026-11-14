/**
 * Draws a tree model as a cross-cut trunk on a 2D canvas.
 *
 * The trunk itself — rings, grain, cracks, bark — is painted once into an
 * offscreen bitmap, because it is the expensive part and never changes for a
 * given tree and size. Each frame then only decides how much of that bitmap
 * to uncover, which is what lets the trunk grow smoothly instead of popping in
 * one ring at a time.
 *
 * Everything inside the trunk is drawn in "world units" with the pith at the
 * origin; `layoutTree` is the single place that turns those into pixels, and
 * the hover inspector uses the same function to turn pixels back into rings.
 */

import type { Ring, RingPeriod, TreeModel } from "../core/types";
import { activityNoun, groupNoun } from "../core/activity";
import { hashString, mulberry32 } from "../core/prng";
import { dialFraction } from "../core/tree";

export interface RenderOptions {
  /** Device pixel ratio, or a higher factor when exporting. */
  readonly pixelRatio?: number;
  /** Draws the title, dates and summary under the trunk. */
  readonly showCaption?: boolean;
  /** Draws the dial around the bark and the year marks across the wood. */
  readonly annotate?: boolean;
  /** 0..1 reveal used by the growth animation. 1 draws everything. */
  readonly reveal?: number;
  /** Defaults to whatever the visitor's system asks for. */
  readonly theme?: "dark" | "light";
}

export interface TreeLayout {
  readonly width: number;
  readonly height: number;
  /** Pixels per world unit. */
  readonly scale: number;
  /** Where the pith sits, in CSS pixels. Not the centre of the picture. */
  readonly originX: number;
  readonly originY: number;
  /** World units of bark outside the last ring. */
  readonly bark: number;
  /** Type and line weights grow with the picture, for the large export. */
  readonly captionScale: number;
  readonly captionSpace: number;
}

export interface TreePainter {
  readonly layout: TreeLayout;
  paint(reveal?: number): void;
}

/** Room reserved under the drawing for the title block, before scaling. */
const CAPTION_SPACE = 96;
/** The bark's rough outer edge can stand this much proud of its nominal line. */
const BARK_ROUGHNESS = 0.22;
/** The last stretch of the reveal is the bark closing around the wood. */
const WOOD_REVEAL = 0.93;

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/** Wood laid down early in a period: open, pale. */
const SAP_EARLY: Hsl = { h: 40, s: 44, l: 79 };
const HEART_EARLY: Hsl = { h: 33, s: 45, l: 63 };
/** Wood laid down late: dense, dark. */
const SAP_LATE: Hsl = { h: 30, s: 38, l: 42 };
const HEART_LATE: Hsl = { h: 24, s: 44, l: 27 };

/**
 * Groups shift the colour, but only as far as one timber differs from
 * another: oak, cherry, maple, walnut, ash, mahogany. A full colour wheel
 * would say who worked when at the cost of the thing no longer being wood,
 * which is the whole argument of the picture.
 */
const TIMBERS: readonly Hsl[] = [
  { h: 0, s: 0, l: 0 },
  { h: -11, s: 3, l: -6 },
  { h: 8, s: -5, l: 6 },
  { h: -6, s: -14, l: -15 },
  { h: 5, s: -20, l: 3 },
  { h: -15, s: -2, l: -11 },
  { h: 11, s: -9, l: -1 },
  { h: -8, s: -6, l: 9 },
];

interface Palette {
  readonly background: string;
  /** The lamp's pool of light, and the same colour at zero alpha to fade to. */
  readonly glow: string;
  readonly glowEdge: string;
  readonly shadow: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly inkFaint: string;
}

const DARK: Palette = {
  background: "#14110e",
  glow: "rgba(214, 168, 112, 0.075)",
  glowEdge: "rgba(214, 168, 112, 0)",
  shadow: "rgba(0, 0, 0, 0.6)",
  ink: "#f2e7d5",
  inkMuted: "rgba(242, 231, 213, 0.62)",
  inkFaint: "rgba(242, 231, 213, 0.34)",
};

const LIGHT: Palette = {
  background: "#efe6d4",
  glow: "rgba(255, 252, 244, 0.6)",
  glowEdge: "rgba(255, 252, 244, 0)",
  shadow: "rgba(74, 52, 30, 0.3)",
  ink: "#2c2118",
  inkMuted: "rgba(44, 33, 24, 0.64)",
  inkFaint: "rgba(44, 33, 24, 0.36)",
};

function resolvePalette(theme: RenderOptions["theme"]): Palette {
  if (theme === "light") {
    return LIGHT;
  }
  if (theme === "dark") {
    return DARK;
  }
  const prefersLight =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  return prefersLight ? LIGHT : DARK;
}

function hsl(colour: Hsl, alpha = 1): string {
  const h = colour.h.toFixed(1);
  const s = clamp(colour.s, 0, 100).toFixed(1);
  const l = clamp(colour.l, 0, 100).toFixed(1);
  return alpha >= 1 ? `hsl(${h} ${s}% ${l}%)` : `hsl(${h} ${s}% ${l}% / ${alpha.toFixed(3)})`;
}

function mixHsl(from: Hsl, to: Hsl, amount: number): Hsl {
  const t = clamp(amount, 0, 1);
  return {
    h: from.h + (to.h - from.h) * t,
    s: from.s + (to.s - from.s) * t,
    l: from.l + (to.l - from.l) * t,
  };
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

function barkOf(tree: TreeModel): number {
  const outer = tree.rings[tree.rings.length - 1]?.outerRadius ?? 0;
  return Math.max(2.5, outer * 0.055);
}

/**
 * Fits the trunk into the canvas. The trunk is centred on its own outline,
 * not on the pith: a lopsided tree should sit squarely in the frame with its
 * heart visibly off to one side, which is how a real one looks on the bench.
 */
export function layoutTree(
  tree: TreeModel,
  width: number,
  height: number,
  options: Pick<RenderOptions, "showCaption" | "annotate"> = {},
): TreeLayout {
  const showCaption = options.showCaption ?? true;
  const annotate = options.annotate ?? true;
  // A 1600px export should not carry 13px type.
  const captionScale = Math.max(1, width / 720);
  const captionSpace = showCaption ? CAPTION_SPACE * captionScale : 0;
  const bark = barkOf(tree);
  const margin = (annotate && tree.dial !== "none" ? 46 : 22) * captionScale;

  const outer = tree.rings[tree.rings.length - 1]?.contour ?? [];
  let minX = -1;
  let maxX = 1;
  let minY = -1;
  let maxY = 1;
  for (const [sample, radius] of outer.entries()) {
    const angle = (sample / outer.length) * Math.PI * 2;
    const reach = radius + bark * (1 + BARK_ROUGHNESS);
    const x = Math.sin(angle) * reach;
    const y = -Math.cos(angle) * reach;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const availableWidth = Math.max(1, width - margin * 2);
  const availableHeight = Math.max(1, height - captionSpace - margin * 2);
  const scale = Math.max(
    0.02,
    Math.min(availableWidth / (maxX - minX), availableHeight / (maxY - minY)),
  );

  return {
    width,
    height,
    scale,
    originX: width / 2 - ((minX + maxX) / 2) * scale,
    originY: margin + availableHeight / 2 - ((minY + maxY) / 2) * scale,
    bark,
    captionScale,
    captionSpace,
  };
}

/* ------------------------------------------------------------------ *
 * Painter
 * ------------------------------------------------------------------ */

export function createTreePainter(
  canvas: HTMLCanvasElement,
  tree: TreeModel,
  options: RenderOptions = {},
): TreePainter {
  const palette = resolvePalette(options.theme);
  const pixelRatio = options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const showCaption = options.showCaption ?? true;
  const annotate = options.annotate ?? true;
  const layout = layoutTree(tree, width, height, { showCaption, annotate });

  canvas.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = Math.max(1, Math.round(height * pixelRatio));
  const context = canvas.getContext("2d");

  const outerContour = tree.rings[tree.rings.length - 1]?.contour ?? [];
  const barkEdge = barkEdgeOf(tree, layout.bark);
  const trunk = tree.rings.length === 0 ? null : paintTrunk(tree, layout, pixelRatio, barkEdge);

  const toWorld = (target: CanvasRenderingContext2D): void => {
    target.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    target.translate(layout.originX, layout.originY);
    target.scale(layout.scale, layout.scale);
  };

  return {
    layout,
    paint(revealInput = 1) {
      if (!context) {
        return;
      }
      const reveal = clamp(revealInput, 0, 1);

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.globalAlpha = 1;
      context.fillStyle = palette.background;
      context.fillRect(0, 0, width, height);

      if (!trunk) {
        drawEmptyState(context, width, height, palette, tree);
        return;
      }

      drawGlow(context, layout, tree, palette);

      const edge = revealEdge(tree, outerContour, barkEdge, reveal);

      toWorld(context);
      context.save();
      context.shadowColor = palette.shadow;
      context.shadowBlur = Math.max(...edge) * layout.scale * pixelRatio * 0.09;
      context.shadowOffsetY = Math.max(...edge) * layout.scale * pixelRatio * 0.035;
      context.beginPath();
      traceLoop(context, edge);
      context.fillStyle = "#20170f";
      context.fill();
      context.restore();

      context.save();
      if (reveal < 1) {
        context.beginPath();
        traceLoop(context, edge);
        context.clip();
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(trunk, 0, 0);
      context.restore();

      if (reveal < 1) {
        // The growing edge, so the unfinished trunk does not end in a raw cut.
        toWorld(context);
        context.beginPath();
        traceLoop(context, edge);
        context.lineWidth = 1.4 / layout.scale;
        context.strokeStyle = "rgba(28, 18, 10, 0.75)";
        context.stroke();
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const settled = clamp((reveal - WOOD_REVEAL) / (1 - WOOD_REVEAL), 0, 1);
      if (annotate && settled > 0) {
        context.globalAlpha = settled;
        drawDial(context, tree, layout, barkEdge, palette);
        drawRuler(context, tree, layout);
        context.globalAlpha = 1;
      }
      if (showCaption) {
        drawCaption(context, tree, layout, palette);
      }
    },
  };
}

/** One-shot drawing, for when nothing is going to animate. */
export function renderTree(
  canvas: HTMLCanvasElement,
  tree: TreeModel,
  options: RenderOptions = {},
): TreeLayout {
  const painter = createTreePainter(canvas, tree, options);
  painter.paint(options.reveal ?? 1);
  return painter.layout;
}

/**
 * The outline the trunk has reached at a given point in the reveal: somewhere
 * between two rings while the wood grows, then swelling out to the bark.
 */
function revealEdge(
  tree: TreeModel,
  outerContour: readonly number[],
  barkEdge: readonly number[],
  reveal: number,
): number[] {
  if (reveal >= 1) {
    return resample(barkEdge, outerContour.length);
  }
  const wood = clamp(reveal / WOOD_REVEAL, 0, 1);
  if (wood >= 1) {
    const closing = (reveal - WOOD_REVEAL) / (1 - WOOD_REVEAL);
    const full = resample(barkEdge, outerContour.length);
    return outerContour.map((radius, sample) => radius + (full[sample]! - radius) * closing);
  }
  const position = wood * tree.rings.length;
  const index = Math.min(tree.rings.length - 1, Math.floor(position));
  const fraction = position - index;
  const inner = index === 0 ? null : tree.rings[index - 1]!.contour;
  const outer = tree.rings[index]!.contour;
  return outer.map((radius, sample) => {
    const from = inner ? inner[sample]! : 0;
    return from + (radius - from) * fraction;
  });
}

function resample(contour: readonly number[], length: number): number[] {
  const step = contour.length / length;
  return Array.from({ length }, (_, sample) => contour[Math.round(sample * step) % contour.length]!);
}

/* ------------------------------------------------------------------ *
 * The trunk bitmap
 * ------------------------------------------------------------------ */

function paintTrunk(
  tree: TreeModel,
  layout: TreeLayout,
  pixelRatio: number,
  barkEdge: readonly number[],
): HTMLCanvasElement {
  const bitmap = document.createElement("canvas");
  bitmap.width = Math.max(1, Math.round(layout.width * pixelRatio));
  bitmap.height = Math.max(1, Math.round(layout.height * pixelRatio));
  const context = bitmap.getContext("2d");
  if (!context) {
    return bitmap;
  }

  const devicePerWorld = layout.scale * pixelRatio;
  /** A length in CSS pixels, expressed in world units. */
  const px = (value: number): number => (value * layout.captionScale) / layout.scale;
  const outer = tree.rings[tree.rings.length - 1]!.contour;
  const random = mulberry32(hashString(`wood:${tree.name}`));

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.translate(layout.originX, layout.originY);
  context.scale(layout.scale, layout.scale);
  context.lineJoin = "round";

  drawBark(context, outer, barkEdge, layout.bark, px, random);

  context.save();
  context.beginPath();
  traceLoop(context, outer);
  context.clip();

  drawWood(context, tree, devicePerWorld);
  drawRingLines(context, tree, px, devicePerWorld);
  drawRays(context, outer, px, random);
  drawPores(context, pixelRatio, random);
  drawSawMarks(context, outer, px, random);
  for (const [index, ring] of tree.rings.entries()) {
    const inner = index === 0 ? null : tree.rings[index - 1]!.contour;
    for (const scar of ring.scars) {
      drawScar(context, scar.angle, inner, ring.contour, outer, scar.severity, scar.id, px);
    }
  }
  drawPith(context, px);
  drawLight(context, outer, px);
  context.restore();

  // The cambium: the one line where wood stops and bark begins.
  context.beginPath();
  traceLoop(context, outer);
  context.lineWidth = px(1);
  context.strokeStyle = "rgba(24, 14, 8, 0.7)";
  context.stroke();

  return bitmap;
}

interface RingTone {
  readonly early: Hsl;
  readonly late: Hsl;
  /** Share of the ring's width that is dense late wood. */
  readonly lateShare: number;
}

function toneOf(ring: Ring, timber: Hsl): RingTone {
  const heart = 1 - ring.sapwood;
  const tint = ring.dominantGroup ? clamp(ring.dominantShare * 1.15, 0, 1) : 0;
  const shift = (colour: Hsl): Hsl => ({
    h: colour.h + timber.h * tint,
    s: colour.s + timber.s * tint,
    l: colour.l + timber.l * tint,
  });

  const early = shift(mixHsl(SAP_EARLY, HEART_EARLY, heart));
  const late = shift(mixHsl(SAP_LATE, HEART_LATE, heart));

  if (ring.dormant) {
    // Nothing grew, so there is no pale early wood at all: only the tight
    // seam a tree leaves in a hard year.
    const seam = { h: late.h, s: late.s * 0.7, l: late.l + 5 };
    return { early: seam, late: seam, lateShare: 1 };
  }

  const shade = ring.shade;
  return {
    early: { ...early, l: early.l - (shade ?? 0) * 6 },
    late,
    lateShare: shade === null ? 0.24 : 0.12 + shade * 0.66,
  };
}

/** 0 at the pale inner edge of a ring, 1 at its dark outer edge. */
function densityAt(position: number, lateShare: number): number {
  const start = 1 - lateShare * 1.5;
  const t = clamp((position - start) / (1 - start), 0, 1);
  return t * t * (3 - 2 * t);
}

function drawWood(
  context: CanvasRenderingContext2D,
  tree: TreeModel,
  devicePerWorld: number,
): void {
  const timbers = assignTimbers(tree);
  // Bands are painted from the bark inward, each reaching a little further in
  // than it should. The next band covers the excess, so no hairline of
  // background ever shows between two of them.
  const overlap = 0.8 / devicePerWorld;

  for (let index = tree.rings.length - 1; index >= 0; index -= 1) {
    const ring = tree.rings[index]!;
    const inner = index === 0 ? null : tree.rings[index - 1]!.contour;
    const tone = toneOf(ring, timbers.get(ring.dominantGroup ?? "") ?? TIMBERS[0]!);
    const bands = ring.dormant
      ? 1
      : clamp(Math.round((ring.thickness * devicePerWorld) / 1.3), 1, 12);

    for (let band = bands - 1; band >= 0; band -= 1) {
      const outerAt = (band + 1) / bands;
      const innerAt = band / bands;
      const density = densityAt((band + 0.5) / bands, tone.lateShare);

      context.beginPath();
      traceBlend(context, inner, ring.contour, outerAt, 0);
      if (!(index === 0 && band === 0)) {
        traceBlend(context, inner, ring.contour, innerAt, -overlap);
      }
      context.fillStyle = hsl(mixHsl(tone.early, tone.late, density));
      context.fill("evenodd");
    }
  }
}

/** The boundary of every ring, heavier where a calendar year turns over. */
function drawRingLines(
  context: CanvasRenderingContext2D,
  tree: TreeModel,
  px: (value: number) => number,
  devicePerWorld: number,
): void {
  for (const [index, ring] of tree.rings.entries()) {
    const closesYear = tree.rings[index + 1]?.mark != null && tree.period !== "day";
    // Very thin rings would otherwise be nothing but their own outlines.
    const presence = clamp((ring.thickness * devicePerWorld) / 3.2, 0.25, 1);
    context.beginPath();
    traceLoop(context, ring.contour);
    context.lineWidth = px(closesYear ? 1.15 : 0.55);
    context.strokeStyle = closesYear
      ? "rgba(38, 20, 8, 0.72)"
      : `rgba(52, 28, 12, ${(0.42 * presence).toFixed(3)})`;
    context.stroke();
  }
}

/** Medullary rays: the fine spokes that make a cut face read as wood. */
function drawRays(
  context: CanvasRenderingContext2D,
  outer: readonly number[],
  px: (value: number) => number,
  random: () => number,
): void {
  context.save();
  context.lineCap = "round";
  for (let ray = 0; ray < 300; ray += 1) {
    const angle = random() * Math.PI * 2 - Math.PI / 2;
    const reach = contourRadiusAtAngle(outer, angle);
    const from = reach * (0.03 + 0.55 * random() * random());
    const to = reach * (0.72 + 0.28 * random());
    const light = random() < 0.72;
    context.beginPath();
    context.moveTo(Math.cos(angle) * from, Math.sin(angle) * from);
    context.lineTo(Math.cos(angle) * to, Math.sin(angle) * to);
    context.lineWidth = px(0.5 + random() * 0.9);
    context.strokeStyle = light
      ? `rgba(255, 238, 205, ${(0.035 + random() * 0.06).toFixed(3)})`
      : `rgba(48, 24, 8, ${(0.03 + random() * 0.05).toFixed(3)})`;
    context.stroke();
  }
  context.restore();
}

/** Pores and flecks, as a repeating tile in device pixels. */
function drawPores(
  context: CanvasRenderingContext2D,
  pixelRatio: number,
  random: () => number,
): void {
  const size = 192;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const tileContext = tile.getContext("2d");
  if (!tileContext) {
    return;
  }
  const image = tileContext.createImageData(size, size);
  for (let pixel = 0; pixel < size * size; pixel += 1) {
    const roll = random();
    const offset = pixel * 4;
    if (roll < 0.07) {
      image.data[offset] = 46;
      image.data[offset + 1] = 24;
      image.data[offset + 2] = 10;
      image.data[offset + 3] = 16 + random() * 38;
    } else if (roll < 0.11) {
      image.data[offset] = 255;
      image.data[offset + 1] = 240;
      image.data[offset + 2] = 214;
      image.data[offset + 3] = 16 + random() * 30;
    }
  }
  tileContext.putImageData(image, 0, 0);
  const pattern = context.createPattern(tile, "repeat");
  if (!pattern) {
    return;
  }
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  // Pores are a property of the wood, not of the screen: keep them the same
  // apparent size whether this is a phone or a large export.
  context.scale(Math.max(1, pixelRatio * 0.75), Math.max(1, pixelRatio * 0.75));
  context.fillStyle = pattern;
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  context.restore();
}

/** The faint parallel tracks a saw leaves across the face. */
function drawSawMarks(
  context: CanvasRenderingContext2D,
  outer: readonly number[],
  px: (value: number) => number,
  random: () => number,
): void {
  const reach = Math.max(...outer);
  const tilt = -0.32;
  context.save();
  context.rotate(tilt);
  let y = -reach;
  while (y < reach) {
    y += px(3 + random() * 9);
    context.beginPath();
    context.moveTo(-reach, y);
    context.lineTo(reach, y + px((random() - 0.5) * 3));
    context.lineWidth = px(0.6 + random() * 0.8);
    context.strokeStyle =
      random() < 0.5
        ? `rgba(40, 20, 8, ${(0.018 + random() * 0.03).toFixed(3)})`
        : `rgba(255, 244, 222, ${(0.015 + random() * 0.03).toFixed(3)})`;
    context.stroke();
  }
  context.restore();
}

function drawPith(context: CanvasRenderingContext2D, px: (value: number) => number): void {
  context.beginPath();
  context.arc(0, 0, px(2.1), 0, Math.PI * 2);
  context.fillStyle = "rgba(44, 24, 10, 0.85)";
  context.fill();
  context.beginPath();
  context.arc(0, 0, px(4.2), 0, Math.PI * 2);
  context.lineWidth = px(0.7);
  context.strokeStyle = "rgba(44, 24, 10, 0.35)";
  context.stroke();
}

/** A lamp up and to the left, and the face darkening as it nears the bark. */
function drawLight(
  context: CanvasRenderingContext2D,
  outer: readonly number[],
  px: (value: number) => number,
): void {
  const reach = Math.max(...outer);
  const lamp = context.createLinearGradient(-reach * 0.75, -reach * 0.85, reach * 0.75, reach * 0.85);
  lamp.addColorStop(0, "rgba(255, 246, 226, 0.17)");
  lamp.addColorStop(0.5, "rgba(255, 246, 226, 0)");
  lamp.addColorStop(1, "rgba(18, 8, 2, 0.2)");
  context.fillStyle = lamp;
  context.fillRect(-reach * 1.5, -reach * 1.5, reach * 3, reach * 3);

  for (const [width, alpha] of [
    [26, 0.05],
    [14, 0.07],
    [6, 0.1],
  ] as const) {
    context.beginPath();
    traceLoop(context, outer);
    context.lineWidth = px(width);
    context.strokeStyle = `rgba(30, 14, 4, ${alpha})`;
    context.stroke();
  }
}

/**
 * A scar: a radial check where one change rewrote far more than everything
 * around it. It runs outward past its own ring, because a wound in a trunk
 * stays open in the wood laid down after it.
 */
function drawScar(
  context: CanvasRenderingContext2D,
  angle: number,
  innerContour: readonly number[] | null,
  ringContour: readonly number[],
  outerContour: readonly number[],
  severity: number,
  id: string,
  px: (value: number) => number,
): void {
  const random = mulberry32(hashString(`scar:${id}`));
  const innerRadius = contourRadiusAtAngle(innerContour, angle);
  const ringRadius = contourRadiusAtAngle(ringContour, angle);
  const limit = contourRadiusAtAngle(outerContour, angle);
  const from = Math.max(0, innerRadius - (ringRadius - innerRadius) * 0.4);
  const to = Math.min(
    limit,
    ringRadius + (ringRadius - innerRadius) * (0.6 + severity * 2.2) + limit * 0.05 * severity,
  );
  // Sized against the trunk, so a small drawing gets a hairline, not a gash.
  const halfWidth = limit * (0.0035 + severity * 0.0065);
  const steps = 14;

  // The crack wanders a little; a ruled line would look drawn, not split.
  const wander = Array.from({ length: steps + 1 }, () => (random() - 0.5) * 2);
  const centre = (step: number): { x: number; y: number; nx: number; ny: number; w: number } => {
    const along = step / steps;
    const radius = from + (to - from) * along;
    const drift = (wander[step]! * halfWidth * 0.4) / Math.max(radius, 1);
    const a = angle + drift;
    return {
      x: Math.cos(a) * radius,
      y: Math.sin(a) * radius,
      nx: -Math.sin(a),
      ny: Math.cos(a),
      // Widest about a third of the way out, closing to a point at both ends.
      w: halfWidth * Math.pow(Math.sin(Math.PI * Math.pow(along, 0.7)), 0.8),
    };
  };

  context.beginPath();
  for (let step = 0; step <= steps; step += 1) {
    const point = centre(step);
    const x = point.x + point.nx * point.w;
    const y = point.y + point.ny * point.w;
    if (step === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  for (let step = steps; step >= 0; step -= 1) {
    const point = centre(step);
    context.lineTo(point.x - point.nx * point.w, point.y - point.ny * point.w);
  }
  context.closePath();
  context.fillStyle = `rgba(20, 10, 4, ${(0.72 + severity * 0.2).toFixed(3)})`;
  context.fill();

  // One lit lip, so the split has depth instead of sitting on the surface.
  context.beginPath();
  for (let step = 0; step <= steps; step += 1) {
    const point = centre(step);
    const x = point.x - point.nx * (point.w + px(0.5));
    const y = point.y - point.ny * (point.w + px(0.5));
    if (step === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.lineWidth = px(0.8);
  context.strokeStyle = "rgba(255, 236, 200, 0.28)";
  context.stroke();
}

/* ------------------------------------------------------------------ *
 * Bark
 * ------------------------------------------------------------------ */

const BARK_SAMPLES = 720;

/** The rough outer edge of the bark, at a finer angular step than the rings. */
function barkEdgeOf(tree: TreeModel, bark: number): number[] {
  const outer = tree.rings[tree.rings.length - 1]?.contour;
  if (!outer) {
    return [];
  }
  const random = mulberry32(hashString(`bark:${tree.name}`));
  const waves = Array.from({ length: 9 }, () => ({
    frequency: 7 + Math.floor(random() * 46),
    amplitude: 0.35 + random() * 0.65,
    phase: random() * Math.PI * 2,
  }));
  const weight = waves.reduce((sum, wave) => sum + wave.amplitude, 0);

  return Array.from({ length: BARK_SAMPLES }, (_, sample) => {
    const turn = sample / BARK_SAMPLES;
    const angle = turn * Math.PI * 2;
    const base = contourRadiusAtAngle(outer, angle - Math.PI / 2);
    const rough = waves.reduce(
      (sum, wave) => sum + wave.amplitude * Math.sin(angle * wave.frequency + wave.phase),
      0,
    );
    return base + bark * (1 + (BARK_ROUGHNESS * rough) / weight);
  });
}

function drawBark(
  context: CanvasRenderingContext2D,
  outer: readonly number[],
  barkEdge: readonly number[],
  bark: number,
  px: (value: number) => number,
  random: () => number,
): void {
  context.beginPath();
  traceLoop(context, barkEdge);
  context.fillStyle = "hsl(24 26% 15%)";
  context.fill();

  context.save();
  context.beginPath();
  traceLoop(context, barkEdge);
  context.clip();

  // Furrows and ridges, running in from the outside.
  context.lineCap = "round";
  for (let mark = 0; mark < 190; mark += 1) {
    const angle = random() * Math.PI * 2 - Math.PI / 2;
    const base = contourRadiusAtAngle(outer, angle);
    const depth = 0.3 + random() * 0.75;
    const ridge = random() < 0.42;
    const start = base + bark * (ridge ? 0.3 + random() * 0.3 : 1.3);
    const end = base + bark * (ridge ? 0.75 + random() * 0.4 : 1.25 - depth);
    const lean = (random() - 0.5) * 0.02;
    context.beginPath();
    context.moveTo(Math.cos(angle) * start, Math.sin(angle) * start);
    context.lineTo(Math.cos(angle + lean) * end, Math.sin(angle + lean) * end);
    context.lineWidth = px(ridge ? 1 + random() * 1.6 : 0.8 + random() * 2);
    context.strokeStyle = ridge
      ? `hsl(26 24% ${(22 + random() * 9).toFixed(1)}% / 0.65)`
      : `hsl(20 30% ${(5 + random() * 5).toFixed(1)}% / 0.8)`;
    context.stroke();
  }
  context.restore();

  // Inner bark: the thin, paler, still-living layer against the wood.
  context.beginPath();
  traceLoop(context, outer.map((radius) => radius + bark * 0.24));
  traceLoop(context, outer);
  context.fillStyle = "hsl(21 40% 31%)";
  context.fill("evenodd");

  context.beginPath();
  traceLoop(context, barkEdge);
  context.lineWidth = px(1);
  context.strokeStyle = "rgba(8, 5, 3, 0.75)";
  context.stroke();
}

/* ------------------------------------------------------------------ *
 * Around the trunk: glow, dial, ruler, caption
 * ------------------------------------------------------------------ */

function drawGlow(
  context: CanvasRenderingContext2D,
  layout: TreeLayout,
  tree: TreeModel,
  palette: Palette,
): void {
  const reach = (tree.rings[tree.rings.length - 1]!.outerRadius + layout.bark) * layout.scale;
  const centreY = (layout.height - layout.captionSpace) / 2;
  const glow = context.createRadialGradient(
    layout.width / 2,
    centreY,
    reach * 0.5,
    layout.width / 2,
    centreY,
    reach * 1.55,
  );
  glow.addColorStop(0, palette.glow);
  // Fading to transparent black would drag a grey haze through the middle.
  glow.addColorStop(1, palette.glowEdge);
  context.fillStyle = glow;
  context.fillRect(0, 0, layout.width, layout.height);
}

const DIAL_LABELS: Readonly<Record<"hours" | "weekdays", readonly [number, string][]>> = {
  hours: [
    [12, "noon"],
    [18, "18"],
    [0, "midnight"],
    [6, "06"],
  ],
  weekdays: [
    [0, "Mon"],
    [1, "Tue"],
    [2, "Wed"],
    [3, "Thu"],
    [4, "Fri"],
    [5, "Sat"],
    [6, "Sun"],
  ],
};

/**
 * The dial the trunk is wrapped around. Each bar is how much of the whole
 * history happened in that hour (or on that weekday), standing just outside
 * the bark on the side of the trunk that hour pulled outward.
 */
function drawDial(
  context: CanvasRenderingContext2D,
  tree: TreeModel,
  layout: TreeLayout,
  barkEdge: readonly number[],
  palette: Palette,
): void {
  if (tree.dial === "none" || tree.dialWeights.length === 0) {
    return;
  }
  const unit = layout.captionScale;
  const largest = Math.max(...tree.dialWeights) || 1;
  const edgeAt = (turn: number): number =>
    barkEdge[Math.round(turn * barkEdge.length) % barkEdge.length]! * layout.scale;
  const point = (turn: number, distance: number): [number, number] => {
    const angle = turn * Math.PI * 2;
    return [
      layout.originX + Math.sin(angle) * distance,
      layout.originY - Math.cos(angle) * distance,
    ];
  };

  context.lineCap = "round";
  for (const [bin, weight] of tree.dialWeights.entries()) {
    const turn = dialFraction(tree.dial, tree.dial === "hours" ? bin + 0.5 : bin);
    const base = edgeAt(turn) + 7 * unit;
    const length = (1.5 + 13 * (weight / largest)) * unit;
    const [x1, y1] = point(turn, base);
    const [x2, y2] = point(turn, base + length);
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.lineWidth = (tree.dial === "hours" ? 2 : 3.5) * unit;
    context.strokeStyle = weight / largest > 0.12 ? palette.inkMuted : palette.inkFaint;
    context.stroke();
  }

  context.fillStyle = palette.inkMuted;
  context.font = `${10.5 * unit}px ui-sans-serif, system-ui, sans-serif`;
  context.textBaseline = "middle";
  for (const [position, label] of DIAL_LABELS[tree.dial]) {
    const turn = dialFraction(tree.dial, position);
    const [x, y] = point(turn, edgeAt(turn) + 31 * unit);
    const sideways = Math.sin(turn * Math.PI * 2);
    context.textAlign = sideways > 0.3 ? "left" : sideways < -0.3 ? "right" : "center";
    context.fillText(label, x - sideways * 5 * unit, y);
  }
  context.textBaseline = "alphabetic";
}

/**
 * Year marks across the wood, the way a specimen is pencilled when its rings
 * are counted: a line from the pith to the bark, a tick where each year
 * begins, and a label wherever there is room for one.
 */
function drawRuler(context: CanvasRenderingContext2D, tree: TreeModel, layout: TreeLayout): void {
  const marks = tree.rings.filter((ring) => ring.mark !== null);
  if (marks.length === 0) {
    return;
  }
  const unit = layout.captionScale;
  const pencil = "rgba(34, 22, 14, 0.62)";
  // Sample 45 is three o'clock: the ruler lies flat, so its labels read level.
  const radiusOf = (ring: Ring): number =>
    (tree.rings[ring.index - 1]?.contour[45] ?? 0) * layout.scale;
  const end = tree.rings[tree.rings.length - 1]!.contour[45]! * layout.scale;

  context.beginPath();
  context.moveTo(layout.originX, layout.originY);
  context.lineTo(layout.originX + end, layout.originY);
  context.lineWidth = 0.9 * unit;
  context.strokeStyle = pencil;
  context.stroke();

  context.font = `${9.5 * unit}px ui-sans-serif, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "top";
  let lastLabelX = -Infinity;
  for (const ring of marks) {
    const x = layout.originX + radiusOf(ring);
    context.beginPath();
    context.moveTo(x, layout.originY - 4 * unit);
    context.lineTo(x, layout.originY + 4 * unit);
    context.lineWidth = 1.1 * unit;
    context.strokeStyle = pencil;
    context.stroke();

    const label = ring.mark ?? "";
    const labelWidth = context.measureText(label).width;
    if (x - labelWidth / 2 > lastLabelX + 5 * unit && x + labelWidth / 2 < layout.originX + end) {
      // A pale halo first: the label has to survive crossing dark late wood.
      context.lineJoin = "round";
      context.lineWidth = 2.4 * unit;
      context.strokeStyle = "rgba(244, 226, 196, 0.42)";
      context.strokeText(label, x, layout.originY + 6.5 * unit);
      context.fillStyle = "rgba(30, 18, 10, 0.86)";
      context.fillText(label, x, layout.originY + 6.5 * unit);
      lastLabelX = x + labelWidth / 2;
    }
  }
  context.textBaseline = "alphabetic";
}

const PERIOD_ADJECTIVE: Readonly<Record<RingPeriod, string>> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  quarter: "quarterly",
  year: "yearly",
};

function drawCaption(
  context: CanvasRenderingContext2D,
  tree: TreeModel,
  layout: TreeLayout,
  palette: Palette,
): void {
  const unit = layout.captionScale;
  const baseline = layout.height - layout.captionSpace + 30 * unit;
  const centre = layout.width / 2;

  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillStyle = palette.ink;
  context.font = `500 ${22 * unit}px ui-serif, Georgia, 'Times New Roman', serif`;
  context.fillText(tree.name, centre, baseline, layout.width - 40 * unit);

  context.fillStyle = palette.inkMuted;
  context.font = `${12.5 * unit}px ui-sans-serif, system-ui, sans-serif`;
  context.fillText(
    `${formatDate(tree.firstActivityMs)} — ${formatDate(tree.lastActivityMs)}`,
    centre,
    baseline + 22 * unit,
  );

  const approximately = tree.estimated ? "about " : "";
  const parts = [
    `${approximately}${formatCount(tree.totalActivities)} ${activityNoun(tree.metric, tree.totalActivities)}`,
    `${tree.rings.length} ${PERIOD_ADJECTIVE[tree.period]} ${tree.rings.length === 1 ? "ring" : "rings"}`,
  ];
  if (tree.groupKind !== "none" && tree.groups.length > 0) {
    parts.push(
      `${formatCount(tree.groups.length)} ${groupNoun(tree.groupKind, tree.groups.length)}`,
    );
  }
  context.fillText(parts.join("  ·  "), centre, baseline + 41 * unit);
}

function drawEmptyState(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: Palette,
  tree: TreeModel,
): void {
  context.textAlign = "center";
  context.fillStyle = palette.inkMuted;
  context.font = "14px ui-sans-serif, system-ui, sans-serif";
  context.fillText(`No ${activityNoun(tree.metric)} to grow from.`, width / 2, height / 2);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Traces one closed loop. It deliberately does NOT call `beginPath`, because a
 * band is a single path made of two loops filled with the even-odd rule —
 * starting a new path between them would throw the first loop away.
 */
export function traceLoop(
  context: CanvasRenderingContext2D,
  contour: readonly number[],
): void {
  const steps = contour.length;
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2 - Math.PI / 2;
    const radius = contour[step]!;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (step === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.closePath();
}

/** A loop part-way between two contours; `inner` null means the pith itself. */
function traceBlend(
  context: CanvasRenderingContext2D,
  inner: readonly number[] | null,
  outer: readonly number[],
  position: number,
  offset: number,
): void {
  const steps = outer.length;
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2 - Math.PI / 2;
    const from = inner ? inner[step]! : 0;
    const radius = Math.max(0, from + (outer[step]! - from) * position + offset);
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (step === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.closePath();
}

/** Interpolates the sampled contour at a canvas angle (-PI/2 is 12 o'clock). */
export function contourRadiusAtAngle(
  contour: readonly number[] | null,
  angle: number,
): number {
  if (!contour || contour.length === 0) {
    return 0;
  }
  const turn = Math.PI * 2;
  const clockwise = ((angle + Math.PI / 2) % turn + turn) % turn;
  const position = (clockwise / turn) * contour.length;
  const lower = Math.floor(position) % contour.length;
  const upper = (lower + 1) % contour.length;
  const fraction = position - Math.floor(position);
  return contour[lower]! + (contour[upper]! - contour[lower]!) * fraction;
}

function assignTimbers(tree: TreeModel): Map<string, Hsl> {
  const timbers = new Map<string, Hsl>();
  for (const [index, group] of tree.groups.entries()) {
    timbers.set(group.key, TIMBERS[index % TIMBERS.length]!);
  }
  return timbers;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
