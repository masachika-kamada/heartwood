/**
 * Hover inspection. Pointing at a ring should answer "what was happening
 * then?" without a click, and without covering the drawing.
 */

import type { Ring, TreeModel } from "../core/types";
import { activityNoun, groupNoun } from "../core/activity";
import { BARK_THICKNESS, CAPTION_SPACE } from "../render/rings";

export interface Inspector {
  attach(tree: TreeModel): void;
}

export function createInspector(panel: HTMLElement, canvas: HTMLCanvasElement): Inspector {
  let tree: TreeModel | null = null;

  const hide = (): void => {
    panel.hidden = true;
  };

  canvas.addEventListener("pointermove", (event) => {
    if (!tree || tree.rings.length === 0) {
      return;
    }

    const ring = ringAtPoint(tree, canvas, event);
    if (!ring) {
      hide();
      return;
    }

    panel.hidden = false;
    panel.innerHTML = describe(ring, tree);
  });

  canvas.addEventListener("pointerleave", hide);

  return {
    attach(next) {
      tree = next;
      hide();
    },
  };
}

/**
 * Reverses the layout in `renderTree`: same fit maths, so a pointer position
 * maps back to a ring index. The wobble is ignored here — it is small enough
 * that including it would cost accuracy at the edges for no felt benefit.
 */
function ringAtPoint(
  tree: TreeModel,
  canvas: HTMLCanvasElement,
  event: PointerEvent,
): Ring | null {
  const bounds = canvas.getBoundingClientRect();
  const cssWidth = bounds.width;
  const cssHeight = bounds.height;

  const outerRadius = tree.rings[tree.rings.length - 1]!.outerRadius + BARK_THICKNESS;
  const available = Math.min(cssWidth, cssHeight - CAPTION_SPACE) / 2 - 16;
  const scale = Math.max(0.05, available / outerRadius);

  const centreX = cssWidth / 2;
  const centreY = (cssHeight - CAPTION_SPACE) / 2 + 16;

  const dx = event.clientX - bounds.left - centreX;
  const dy = event.clientY - bounds.top - centreY;
  const distance = Math.hypot(dx, dy) / scale;

  if (distance > outerRadius) {
    return null;
  }

  return tree.rings.find((ring) => distance <= ring.outerRadius) ?? null;
}

function describe(ring: Ring, tree: TreeModel): string {
  if (ring.dormant) {
    return `
      <h3 class="inspector__title">${escapeHtml(ring.label)}</h3>
      <p class="inspector__scar">No ${activityNoun(tree.metric)}.</p>
    `;
  }

  const rows: Array<[string, string]> = [
    [
      capitalise(activityNoun(tree.metric)),
      ring.activityCount.toLocaleString("en"),
    ],
  ];
  if (tree.metric === "lines") {
    rows.push(["Lines changed", ring.volume.toLocaleString("en")]);
  }
  if (ring.nightRatio !== null) {
    rows.push(["Night work", `${Math.round(ring.nightRatio * 100)}%`]);
  }
  if (tree.groupKind !== "none") {
    rows.push([
      capitalise(groupNoun(tree.groupKind)),
      ring.groupCount.toLocaleString("en"),
    ]);
  }

  const stats = rows
    .map(
      ([term, value]) =>
        `<div class="inspector__row"><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join("");

  const scar = ring.scars[0]
    ? `<p class="inspector__scar">${escapeHtml(ring.scars[0].summary)}</p>`
    : "";

  return `
    <h3 class="inspector__title">${escapeHtml(ring.label)}</h3>
    <dl class="inspector__stats">${stats}</dl>
    ${scar}
  `;
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
