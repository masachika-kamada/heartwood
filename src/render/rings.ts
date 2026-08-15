/**
 * Draws a tree model as a cross-cut trunk on a 2D canvas.
 *
 * Everything is drawn in "world units" and scaled to fit at the end, so the
 * same code produces both the on-screen view and a large PNG export.
 */

import type { Ring, TreeModel } from "../core/types";
import { activityNoun, groupNoun } from "../core/activity";

export interface RenderOptions {
  /** Device pixel ratio, or a higher factor when exporting. */
  readonly pixelRatio?: number;
  /** Draws the title, dates and legend. Off for a bare picture. */
  readonly showCaption?: boolean;
  /** 0..1 reveal used by the growth animation. 1 draws everything. */
  readonly reveal?: number;
  /** Defaults to whatever the visitor's system asks for. */
  readonly theme?: "dark" | "light";
}

/** The trunk's outermost band. Exported so hit-testing can match the layout. */
export const BARK_THICKNESS = 9;

/** Room reserved under the drawing for the title block. */
export const CAPTION_SPACE = 96;
/**
 * Contributors shift the hue, but only within the range wood can actually be.
 * A full colour wheel would tell you who worked when at the cost of the thing
 * no longer looking like timber, which is the whole argument of the picture.
 */
const AUTHOR_HUES = [30, 22, 38, 26, 34, 19, 41, 24];

interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

interface Palette {
  readonly background: string;
  readonly bark: string;
  readonly outline: string;
  readonly shadow: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly dormantEdge: string;
  readonly dormantLightness: number;
  readonly scarInk: string;
  /** Wood laid down in easy conditions: pale and wide. */
  readonly earlyWood: Hsl;
  /** Wood laid down late in the season: dense and dark. */
  readonly lateWood: Hsl;
}

const DARK: Palette = {
  background: "#1a1512",
  bark: "#2f2318",
  outline: "rgba(16, 12, 8, 0.7)",
  shadow: "rgba(0, 0, 0, 0.55)",
  ink: "#f2e7d5",
  inkMuted: "rgba(242, 231, 213, 0.62)",
  dormantEdge: "rgba(14, 11, 8, 0.75)",
  dormantLightness: 26,
  scarInk: "rgba(26, 16, 10, ",
  earlyWood: { h: 33, s: 24, l: 62 },
  lateWood: { h: 26, s: 30, l: 29 },
};

const LIGHT: Palette = {
  background: "#efe6d4",
  bark: "#4a382a",
  outline: "rgba(52, 38, 26, 0.5)",
  shadow: "rgba(74, 56, 40, 0.32)",
  ink: "#2c2118",
  inkMuted: "rgba(44, 33, 24, 0.62)",
  dormantEdge: "rgba(74, 56, 40, 0.45)",
  dormantLightness: 84,
  scarInk: "rgba(58, 38, 24, ",
  earlyWood: { h: 33, s: 26, l: 68 },
  lateWood: { h: 26, s: 32, l: 33 },
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

export function renderTree(
  canvas: HTMLCanvasElement,
  tree: TreeModel,
  options: RenderOptions = {},
): void {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const palette = resolvePalette(options.theme);
  const pixelRatio = options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = canvas.clientWidth || canvas.width;
  const cssHeight = canvas.clientHeight || canvas.height;
  canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
  canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  context.fillStyle = palette.background;
  context.fillRect(0, 0, cssWidth, cssHeight);

  if (tree.rings.length === 0) {
    drawEmptyState(context, cssWidth, cssHeight, palette, tree);
    return;
  }

  const reveal = clamp01(options.reveal ?? 1);
  const showCaption = options.showCaption ?? true;
  // A 1600px export should not carry 13px type. Scale the title block with the
  // picture, but never below the on-screen size the inspector hit-tests against.
  const captionScale = Math.max(1, cssWidth / 720);
  const captionSpace = showCaption ? CAPTION_SPACE * captionScale : 24;
  const outerRadius = tree.rings[tree.rings.length - 1]!.outerRadius + BARK_THICKNESS;
  const available = Math.min(cssWidth, cssHeight - captionSpace) / 2 - 16;
  const scale = Math.max(0.05, available / outerRadius);

  const centreX = cssWidth / 2;
  const centreY = showCaption ? (cssHeight - captionSpace) / 2 + 16 : cssHeight / 2;

  const groupHue = assignGroupHues(tree);
  context.save();
  context.translate(centreX, centreY);
  context.scale(scale, scale);

  const outerContour = tree.rings[tree.rings.length - 1]!.contour;
  drawTrunkShadow(context, outerContour, palette);

  const visibleRings = Math.ceil(tree.rings.length * reveal);
  for (let index = 0; index < visibleRings; index += 1) {
    const ring = tree.rings[index]!;
    const inner = index === 0 ? null : tree.rings[index - 1]!.contour;
    drawRing(context, ring, inner, groupHue, palette);
  }

  // Scars reach outward past their own ring, so they go on last or the wood
  // laid down afterwards would paint over the wound.
  for (let index = 0; index < visibleRings; index += 1) {
    const ring = tree.rings[index]!;
    const inner = index === 0 ? null : tree.rings[index - 1]!.contour;
    for (const scar of ring.scars) {
      drawScar(context, scar.angle, inner, ring.contour, scar.severity, palette);
    }
  }

  if (reveal >= 1) {
    drawBark(context, outerContour, palette);
  }

  context.restore();

  if (showCaption) {
    drawCaption(
      context,
      tree,
      cssWidth,
      cssHeight,
      captionSpace,
      palette,
      captionScale,
    );
  }
}

/** Kept in one place: the inspector reverses this layout to find a ring. */

/* ------------------------------------------------------------------ *
 * Rings
 * ------------------------------------------------------------------ */

/**
 * Traces one closed loop. It deliberately does NOT call `beginPath`, because an
 * annulus is a single path made of two loops filled with the even-odd rule —
 * starting a new path between them would throw the first loop away.
 */
function ringLoop(
  context: CanvasRenderingContext2D,
  contour: readonly number[] | null,
): void {
  const steps = contour?.length ?? 180;
  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2 - Math.PI / 2;
    const r = contour ? contour[step % contour.length]! : 0;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (step === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.closePath();
}

function drawRing(
  context: CanvasRenderingContext2D,
  ring: Ring,
  innerContour: readonly number[] | null,
  groupHue: ReadonlyMap<string, number>,
  palette: Palette,
): void {
  const hue = ring.dominantGroup
    ? blendHue(
        palette.earlyWood.h,
        groupHue.get(ring.dominantGroup) ?? palette.earlyWood.h,
        ring.dominantShare,
      )
    : palette.earlyWood.h;

  // Late wood: the dark band laid down at the end of a growing season. Here it
  // stands for night work when the source has time-of-day data.
  const nightPull = ring.nightRatio ?? 0;
  const lightness = ring.dormant
    ? palette.dormantLightness
    : lerp(palette.earlyWood.l, palette.lateWood.l, 0.2 + nightPull * 0.8);
  const saturation = ring.dormant
    ? 10
    : lerp(palette.earlyWood.s, palette.lateWood.s, 0.4);

  context.beginPath();
  ringLoop(context, ring.contour);
  ringLoop(context, innerContour);
  context.fillStyle = `hsl(${hue} ${saturation}% ${lightness}%)`;
  context.fill("evenodd");

  // A thin dark line at the outer edge of each ring: the season boundary.
  context.beginPath();
  ringLoop(context, ring.contour);
  context.lineWidth = ring.dormant ? 0.6 : 0.8;
  context.strokeStyle = ring.dormant
    ? palette.dormantEdge
    : `hsl(${hue} ${saturation + 8}% ${Math.max(12, lightness - 24)}%)`;
  context.stroke();
}

/**
 * A scar: a radial split where one commit rewrote far more than everything
 * around it. It reaches outward past its own ring, because a wound in a trunk
 * stays visible in the wood laid down after it.
 */
function drawScar(
  context: CanvasRenderingContext2D,
  angle: number,
  innerContour: readonly number[] | null,
  outerContour: readonly number[],
  severity: number,
  palette: Palette,
): void {
  // Narrow: a crack, not a slice of pie. Severity lengthens it more than it
  // widens it, so a huge commit reads as a deep split rather than a blob.
  const halfWidth = 0.004 + severity * 0.012;
  const innerRadius = contourRadiusAtAngle(innerContour, angle);
  const outerRadius = contourRadiusAtAngle(outerContour, angle);
  const reach = innerRadius + (outerRadius - innerRadius) * (1 + severity * 1.6);
  const steps = 10;

  context.beginPath();
  for (let step = 0; step <= steps; step += 1) {
    const a = angle - halfWidth + (step / steps) * halfWidth * 2;
    const r = reach;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (step === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  // Taper to a point at the inner edge: the split closes as it goes inward.
  const tip = Math.max(0, innerRadius - outerRadius * 0.02);
  context.lineTo(Math.cos(angle) * tip, Math.sin(angle) * tip);
  context.closePath();

  context.fillStyle = `${palette.scarInk}${(0.45 + severity * 0.4).toFixed(3)})`;
  context.fill();
}

function drawBark(
  context: CanvasRenderingContext2D,
  outerContour: readonly number[],
  palette: Palette,
): void {
  const barkContour = outerContour.map((radius) => radius + BARK_THICKNESS);
  context.beginPath();
  ringLoop(context, barkContour);
  ringLoop(context, outerContour);
  context.fillStyle = palette.bark;
  context.fill("evenodd");

  context.beginPath();
  ringLoop(context, barkContour);
  context.lineWidth = 1.2;
  context.strokeStyle = palette.outline;
  context.stroke();
}

function drawTrunkShadow(
  context: CanvasRenderingContext2D,
  outerContour: readonly number[],
  palette: Palette,
): void {
  const outerRadius = Math.max(...outerContour) + BARK_THICKNESS;
  const barkContour = outerContour.map((radius) => radius + BARK_THICKNESS);
  context.save();
  context.shadowColor = palette.shadow;
  context.shadowBlur = outerRadius * 0.14;
  context.shadowOffsetY = outerRadius * 0.035;
  context.beginPath();
  ringLoop(context, barkContour);
  context.fillStyle = palette.bark;
  context.fill();
  context.restore();
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
  return lerp(contour[lower]!, contour[upper]!, fraction);
}

/* ------------------------------------------------------------------ *
 * Caption
 * ------------------------------------------------------------------ */

function drawCaption(
  context: CanvasRenderingContext2D,
  tree: TreeModel,
  width: number,
  height: number,
  captionSpace: number,
  palette: Palette,
  scale: number,
): void {
  const baseline = height - captionSpace + 34 * scale;

  context.textAlign = "center";
  context.fillStyle = palette.ink;
  context.font = `600 ${22 * scale}px ui-serif, Georgia, 'Times New Roman', serif`;
  context.fillText(tree.name, width / 2, baseline);

  const years = `${formatDate(tree.firstActivityMs)} — ${formatDate(tree.lastActivityMs)}`;
  context.fillStyle = palette.inkMuted;
  context.font = `${13 * scale}px ui-sans-serif, system-ui, sans-serif`;
  context.fillText(years, width / 2, baseline + 22 * scale);

  const rings = tree.rings.length;
  const parts = [
    `${formatCount(tree.totalActivities)} ${activityNoun(tree.metric, tree.totalActivities)}`,
    `${rings} rings`,
  ];
  if (tree.groupKind !== "none") {
    parts.push(
      `${formatCount(tree.groups.length)} ${groupNoun(tree.groupKind, tree.groups.length)}`,
    );
  }
  const summary = parts.join(" · ");
  context.fillText(summary, width / 2, baseline + 42 * scale);
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
  context.fillText(
    `No ${activityNoun(tree.metric)} to grow from.`,
    width / 2,
    height / 2,
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function assignGroupHues(tree: TreeModel): Map<string, number> {
  const hues = new Map<string, number>();
  for (const [index, group] of tree.groups.entries()) {
    hues.set(group.key, AUTHOR_HUES[index % AUTHOR_HUES.length]!);
  }
  return hues;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatCount(value: number): string {
  return value.toLocaleString("en");
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * clamp01(amount);
}

/** Author hues all live in the warm band, so a plain lerp is safe here. */
function blendHue(base: number, target: number, amount: number): number {
  return base + (target - base) * clamp01(amount);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
