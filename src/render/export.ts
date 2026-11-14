/**
 * Saves the current tree as a PNG at a size worth keeping, rather than
 * whatever the window happened to be.
 */

import type { TreeModel } from "../core/types";
import { layoutTree, renderTree, type RenderOptions, type TreeLayout } from "./rings";

const EXPORT_WIDTH = 1600;
const EXPORT_HEIGHT = 1800;

/**
 * How the picture for a README is drawn. A click on that picture comes back
 * as a position in it, so the page has to be able to lay it out again exactly.
 */
export const README_IMAGE = { width: 1000, textScale: 1.5 } as const;

/** The layout of the README picture, as drawn at `README_IMAGE.width`. */
export function readmeImageLayout(tree: TreeModel): TreeLayout {
  const width = README_IMAGE.width;
  return layoutTree(tree, width, Math.round((width * EXPORT_HEIGHT) / EXPORT_WIDTH), {
    showCaption: true,
    annotate: true,
    textScale: README_IMAGE.textScale,
  });
}

export interface ExportOptions
  extends Pick<RenderOptions, "theme" | "transparent" | "textScale"> {
  /** Pixels across; the height follows. Defaults to a size worth printing. */
  readonly width?: number;
}

function drawForExport(tree: TreeModel, options: ExportOptions): HTMLCanvasElement {
  const width = Math.round(options.width ?? EXPORT_WIDTH);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((width * EXPORT_HEIGHT) / EXPORT_WIDTH);
  // renderTree measures with clientWidth, which is 0 for a detached canvas, so
  // the intrinsic size is what it falls back to. Keep pixelRatio at 1 here.
  renderTree(canvas, tree, {
    theme: options.theme,
    transparent: options.transparent,
    textScale: options.textScale,
    pixelRatio: 1,
    showCaption: true,
    annotate: true,
    reveal: 1,
  });
  return canvas;
}

/**
 * The same picture as a data URL, for a script that wants the bytes. WebP,
 * because the grain that makes the wood look like wood is exactly what PNG
 * compresses worst: the same image is a twentieth of the size.
 */
export function treeImageDataUrl(tree: TreeModel, options: ExportOptions = {}): string {
  return drawForExport(tree, options).toDataURL("image/webp", 0.86);
}

export async function exportTreePng(tree: TreeModel, options: ExportOptions = {}): Promise<void> {
  const canvas = drawForExport(tree, options);

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
