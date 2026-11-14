/**
 * The trunk as GeoJSON.
 *
 * A README cannot run a script, so nothing in it can answer a pointer — with
 * one exception: GitHub draws a `geojson` code block as a map of its own, and
 * its map lets a visitor zoom, pan, and click a shape to read its properties.
 * A ring is a shape. So each ring becomes a polygon carrying what the hover
 * label on the page would have said, and the trunk becomes a small island
 * that can be explored inside the README itself.
 *
 * It stands at 0°N 0°E, where no land is, so that nothing on the map competes
 * with it.
 */

import type { Ring, TreeModel } from "../core/types";
import { activityNoun } from "../core/activity";
import { ringColours } from "./rings";

/** Points per ring outline. A map this small does not need the canvas's 180. */
const OUTLINE_POINTS = 60;
/** Degrees from the pith to the outermost ring. */
const RADIUS_DEGREES = 0.5;
const BARK_COLOUR = "#2e2118";

type Position = [number, number];

interface Feature {
  readonly type: "Feature";
  readonly properties: Record<string, string | number>;
  readonly geometry: { readonly type: "Polygon"; readonly coordinates: Position[][] };
}

export interface TreeGeoJson {
  readonly type: "FeatureCollection";
  readonly features: Feature[];
}

export function treeGeoJson(tree: TreeModel): TreeGeoJson {
  const last = tree.rings[tree.rings.length - 1];
  if (!last) {
    return { type: "FeatureCollection", features: [] };
  }
  const scale = RADIUS_DEGREES / last.outerRadius;
  const colours = ringColours(tree);
  const noun = activityNoun(tree.metric);

  /** A closed outline. North is the top of the dial; `clockwise` sets the winding. */
  const outline = (contour: readonly number[], clockwise: boolean, grow = 1): Position[] => {
    const points: Position[] = [];
    for (let point = 0; point < OUTLINE_POINTS; point += 1) {
      const turn = point / OUTLINE_POINTS;
      const radius = contour[Math.round(turn * contour.length) % contour.length]! * scale * grow;
      const angle = turn * Math.PI * 2;
      points.push([round(Math.sin(angle) * radius), round(Math.cos(angle) * radius)]);
    }
    if (!clockwise) {
      points.reverse();
    }
    points.push(points[0]!);
    return points;
  };

  const features: Feature[] = [
    {
      type: "Feature",
      properties: { title: tree.name, ...style(BARK_COLOUR) },
      // Exteriors run counter-clockwise and holes clockwise, as the format asks.
      geometry: {
        type: "Polygon",
        coordinates: [outline(last.contour, false, 1.06), outline(last.contour, true)],
      },
    },
  ];

  for (const ring of tree.rings) {
    const inner = tree.rings[ring.index - 1]?.contour;
    features.push({
      type: "Feature",
      properties: { ...describe(ring, tree, noun), ...style(colours[ring.index]!) },
      geometry: {
        type: "Polygon",
        coordinates: inner
          ? [outline(ring.contour, false), outline(inner, true)]
          : [outline(ring.contour, false)],
      },
    });
  }

  return { type: "FeatureCollection", features };
}

/**
 * What a click on the ring shows. Counts only: a README is public, and the
 * names of the repositories or people behind a ring may not be.
 */
function describe(ring: Ring, tree: TreeModel, noun: string): Record<string, string | number> {
  const properties: Record<string, string | number> = { title: ring.label };
  if (ring.dormant) {
    properties[noun] = 0;
    return properties;
  }
  properties[noun] = Math.round(ring.activityCount);
  if (tree.metric === "lines") {
    properties["lines changed"] = ring.volume;
  }
  if (ring.nightRatio !== null) {
    properties["at night"] = `${Math.round(ring.nightRatio * 100)}%`;
  } else if (tree.shadeKind === "weekend" && ring.weekendRatio !== null) {
    properties["at weekends"] = `${Math.round(ring.weekendRatio * 100)}%`;
  }
  return properties;
}

/** simplestyle-spec, which GitHub's map reads for colours. */
function style(fill: string): Record<string, string | number> {
  return {
    fill,
    "fill-opacity": 1,
    stroke: "#3a2414",
    "stroke-width": 0.5,
    "stroke-opacity": 0.6,
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
