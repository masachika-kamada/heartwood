/**
 * Saves the current tree as a PNG at a size worth keeping, rather than
 * whatever the window happened to be.
 */

import type { TreeModel } from "../core/types";
import { renderTree, type RenderOptions } from "./rings";

const EXPORT_WIDTH = 1600;
const EXPORT_HEIGHT = 1800;

export async function exportTreePng(
  tree: TreeModel,
  options: Pick<RenderOptions, "theme" | "groupLabel"> = {},
): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_WIDTH;
  canvas.height = EXPORT_HEIGHT;
  // renderTree measures with clientWidth, which is 0 for a detached canvas, so
  // the intrinsic size is what it falls back to. Keep pixelRatio at 1 here.
  renderTree(canvas, tree, { ...options, pixelRatio: 1, showCaption: true, reveal: 1 });

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });

  if (!blob) {
    throw new Error("The browser refused to produce an image.");
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(tree.name)}-heartwood.png`;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the download a moment to start before the blob disappears.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "repository"
  );
}
