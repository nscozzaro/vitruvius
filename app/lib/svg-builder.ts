/**
 * SVG Builder — incremental SVG fragment generation.
 *
 * Each survey element becomes an SVG fragment (path, circle, text)
 * assigned to a color-coded layer. The client assembles these fragments
 * into a full SVG overlay on top of the original raster image.
 */

import type { SurveyElement, MonumentMeta } from "./reconstruction-agent";

// ─── Layer Colors ────────────────────────────────────────────

export const LAYER_COLORS = {
  lot_boundary: "#0066FF",   // Blue
  monument: "#FF0000",       // Red
  easement: "#FFD700",       // Gold
  road_centerline: "#00CC00", // Green
  label: "#00FFFF",          // Cyan
} as const;

export type LayerType = keyof typeof LAYER_COLORS;

// ─── Monument SVG Shapes ─────────────────────────────────────

const MONUMENT_RADIUS = 6;

function monumentSvg(
  cx: number,
  cy: number,
  shape: string,
  color: string,
): string {
  const r = MONUMENT_RADIUS;
  switch (shape) {
    case "solid_circle":
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="none" />`;
    case "open_circle":
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="1.5" />`;
    case "circled_cross":
      return [
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="1.5" />`,
        `<line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke="${color}" stroke-width="1" />`,
        `<line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}" stroke="${color}" stroke-width="1" />`,
      ].join("");
    case "half_filled": {
      // Left half filled, right half empty
      return [
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="1.5" />`,
        `<path d="M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r} Z" fill="${color}" />`,
      ].join("");
    }
    default:
      // Fallback: small filled circle
      return `<circle cx="${cx}" cy="${cy}" r="${r * 0.6}" fill="${color}" stroke="${color}" stroke-width="1" />`;
  }
}

// ─── SVG Fragment Builders ───────────────────────────────────

/**
 * Build an SVG fragment for a single survey element.
 * Returns an SVG string to be inserted into the appropriate layer <g>.
 */
export function buildSvgFragment(element: SurveyElement): string {
  const color = LAYER_COLORS[element.elementType] ?? LAYER_COLORS.lot_boundary;
  const id = element.id;

  if (element.elementType === "monument" && element.monument) {
    const { px, py } = element.pixelPoints[0] ?? { px: 0, py: 0 };
    return `<g data-element-id="${id}" data-overlap="${element.overlapScore.toFixed(2)}">`
      + monumentSvg(px, py, element.monument.shape, color)
      + `</g>`;
  }

  // Line or curve — render as polyline/path
  const points = element.pixelPoints;
  if (points.length < 2) return "";

  const strokeWidth = element.svgStrokeWidth ?? 2;
  const dashArray = element.elementType === "easement" ? ' stroke-dasharray="8,4"' : "";

  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.px.toFixed(1)} ${p.py.toFixed(1)}`)
    .join(" ");

  return `<path data-element-id="${id}" data-overlap="${element.overlapScore.toFixed(2)}" `
    + `d="${d}" stroke="${color}" stroke-width="${strokeWidth}" fill="none"${dashArray} `
    + `stroke-linecap="round" stroke-linejoin="round" />`;
}

/**
 * Build a quality halo around an element (green = good, red = poor).
 * The halo is a thicker, semi-transparent version of the element path.
 */
export function buildQualityHalo(element: SurveyElement): string {
  const points = element.pixelPoints;
  if (points.length < 1) return "";

  const score = element.overlapScore;
  // Continuous color: green (score=1) → yellow (0.5) → red (0)
  const r = Math.round(255 * Math.max(0, 1 - score * 2));
  const g = Math.round(255 * Math.min(1, score * 2));
  const color = `rgb(${r},${g},0)`;

  if (element.elementType === "monument") {
    const { px, py } = points[0];
    return `<circle cx="${px}" cy="${py}" r="12" fill="none" `
      + `stroke="${color}" stroke-width="3" opacity="0.3" />`;
  }

  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.px.toFixed(1)} ${p.py.toFixed(1)}`)
    .join(" ");

  return `<path d="${d}" stroke="${color}" stroke-width="8" fill="none" `
    + `opacity="0.3" stroke-linecap="round" />`;
}

/**
 * Build a label for an element (bearing/distance text near the line midpoint).
 */
export function buildLabel(element: SurveyElement): string {
  if (!element.bearing && !element.distance) return "";

  const points = element.pixelPoints;
  if (points.length < 2) return "";

  // Place label at midpoint
  const mid = Math.floor(points.length / 2);
  const { px, py } = points[mid];

  const parts: string[] = [];
  if (element.bearing) parts.push(element.bearing);
  if (element.distance) parts.push(`${element.distance.toFixed(2)}'`);
  const text = parts.join(" ");

  return `<text x="${px.toFixed(1)}" y="${(py - 8).toFixed(1)}" `
    + `fill="${LAYER_COLORS.label}" font-size="9" font-family="monospace" `
    + `text-anchor="middle" data-element-id="${element.id}-label">${escapeXml(text)}</text>`;
}

/**
 * Build the full initial SVG shell (empty layers).
 */
export function buildSvgShell(width: number, height: number): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `  <g id="layer-quality" data-layer="quality"></g>`,
    `  <g id="layer-road_centerline" data-layer="road_centerline"></g>`,
    `  <g id="layer-easement" data-layer="easement"></g>`,
    `  <g id="layer-lot_boundary" data-layer="lot_boundary"></g>`,
    `  <g id="layer-monument" data-layer="monument"></g>`,
    `  <g id="layer-label" data-layer="label"></g>`,
    `</svg>`,
  ].join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
