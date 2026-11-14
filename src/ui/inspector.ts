/**
 * Hover inspection. Pointing at a ring should answer "what was happening
 * then?" without a click: the ring lights up where it lies, and a small label
 * follows the pointer rather than sitting on top of the wood.
 */

import type { Ring, TreeModel } from "../core/types";
import { activityNoun, groupNoun } from "../core/activity";
import { contourRadiusAtAngle, traceLoop, type TreeLayout } from "../render/rings";

export interface Inspector {
  attach(tree: TreeModel, layout: TreeLayout): void;
}

export function createInspector(
  panel: HTMLElement,
  canvas: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
): Inspector {
  let tree: TreeModel | null = null;
  let layout: TreeLayout | null = null;
  let shown: Ring | null = null;

  const hide = (): void => {
    panel.hidden = true;
    if (shown) {
      shown = null;
      highlight(overlay, null, null, null);
    }
  };

  const inspect = (event: PointerEvent): void => {
    if (!tree || !layout || tree.rings.length === 0) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const ring = ringAtPoint(tree, layout, x, y);
    if (!ring) {
      hide();
      return;
    }

    if (ring !== shown) {
      shown = ring;
      panel.innerHTML = describe(ring, tree);
      highlight(overlay, tree, layout, ring);
    }
    panel.hidden = false;

    // Beside the pointer, on whichever side has room.
    const gap = 18;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = x + gap + width > bounds.width ? x - gap - width : x + gap;
    const top = Math.min(Math.max(8, y - height / 2), bounds.height - height - 8);
    panel.style.left = `${Math.max(8, left)}px`;
    panel.style.top = `${top}px`;
  };

  canvas.addEventListener("pointermove", inspect);
  canvas.addEventListener("pointerdown", inspect);
  canvas.addEventListener("pointerleave", hide);

  return {
    attach(nextTree, nextLayout) {
      tree = nextTree;
      layout = nextLayout;
      hide();
      highlight(overlay, null, null, null);
    },
  };
}

/** Reverses `layoutTree`: a pointer position back to the ring under it. */
export function ringAtPoint(
  tree: TreeModel,
  layout: TreeLayout,
  x: number,
  y: number,
): Ring | null {
  const dx = (x - layout.originX) / layout.scale;
  const dy = (y - layout.originY) / layout.scale;
  const distance = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  const outer = tree.rings[tree.rings.length - 1]!.contour;
  if (distance > contourRadiusAtAngle(outer, angle)) {
    return null;
  }
  return (
    tree.rings.find((ring) => distance <= contourRadiusAtAngle(ring.contour, angle)) ?? null
  );
}

function highlight(
  overlay: HTMLCanvasElement,
  tree: TreeModel | null,
  layout: TreeLayout | null,
  ring: Ring | null,
): void {
  const context = overlay.getContext("2d");
  if (!context) {
    return;
  }
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = overlay.clientWidth;
  const height = overlay.clientHeight;
  if (overlay.width !== Math.round(width * pixelRatio)) {
    overlay.width = Math.round(width * pixelRatio);
    overlay.height = Math.round(height * pixelRatio);
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, overlay.width, overlay.height);
  if (!tree || !layout || !ring) {
    return;
  }

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.translate(layout.originX, layout.originY);
  context.scale(layout.scale, layout.scale);

  const inner = tree.rings[ring.index - 1]?.contour ?? null;
  context.beginPath();
  traceLoop(context, ring.contour);
  if (inner) {
    traceLoop(context, inner);
  }
  context.fillStyle = "rgba(255, 244, 220, 0.3)";
  context.fill("evenodd");

  context.lineWidth = 1.4 / layout.scale;
  context.strokeStyle = "rgba(255, 250, 240, 0.95)";
  context.beginPath();
  traceLoop(context, ring.contour);
  context.stroke();
  if (inner) {
    context.beginPath();
    traceLoop(context, inner);
    context.stroke();
  }
}

function describe(ring: Ring, tree: TreeModel): string {
  if (ring.dormant) {
    return `
      <h3 class="inspector__title">${escapeHtml(ring.label)}</h3>
      <p class="inspector__note">No ${activityNoun(tree.metric)}.</p>
    `;
  }

  const rows: Array<[string, string]> = [
    [
      capitalise(activityNoun(tree.metric)),
      `${tree.estimated && !Number.isInteger(ring.activityCount) ? "≈ " : ""}${Math.round(ring.activityCount).toLocaleString("en")}`,
    ],
  ];
  if (tree.metric === "lines") {
    rows.push(["Lines changed", ring.volume.toLocaleString("en")]);
  }
  if (ring.nightRatio !== null) {
    rows.push(["At night", `${Math.round(ring.nightRatio * 100)}%`]);
  } else if (tree.shadeKind === "weekend" && ring.weekendRatio !== null) {
    rows.push(["At weekends", `${Math.round(ring.weekendRatio * 100)}%`]);
  }
  if (tree.groupKind !== "none" && ring.groupCount > 0) {
    rows.push([
      capitalise(groupNoun(tree.groupKind, ring.groupCount)),
      ring.groupCount.toLocaleString("en"),
    ]);
  }

  const stats = rows
    .map(
      ([term, value]) =>
        `<div class="inspector__row"><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join("");

  const mostly =
    ring.dominantGroup && ring.groupCount > 1
      ? `<p class="inspector__note">Mostly ${escapeHtml(shortGroup(ring.dominantGroup))}</p>`
      : ring.dominantGroup && tree.groupKind === "repositories"
        ? `<p class="inspector__note">${escapeHtml(shortGroup(ring.dominantGroup))}</p>`
        : "";
  const scar = ring.scars[0]
    ? `<p class="inspector__note inspector__note--scar">${escapeHtml(ring.scars[0].summary)}</p>`
    : "";

  return `
    <h3 class="inspector__title">${escapeHtml(ring.label)}</h3>
    <dl class="inspector__stats">${stats}</dl>
    ${mostly}
    ${scar}
  `;
}

/** An email is a long way to say who; the part before the @ is enough. */
function shortGroup(key: string): string {
  const at = key.indexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

function capitalise(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
