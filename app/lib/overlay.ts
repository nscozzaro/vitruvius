/**
 * Overlay Renderer.
 *
 * Renders extracted features as color-coded overlays on the original
 * tract map image for the agent's validation feedback loop.
 *
 * Uses sharp to composite colored annotations onto the base image.
 */

import sharp from "sharp";
import type { Point } from "./cogo";

interface OverlayCircle {
  x: number;
  y: number;
  radius: number;
  color: string; // hex
  label?: string;
}

interface OverlayPolyline {
  points: Point[];
  color: string;
  strokeWidth: number;
  dashed?: boolean;
}

interface OverlayText {
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
}

export interface OverlaySpec {
  circles: OverlayCircle[];
  polylines: OverlayPolyline[];
  texts: OverlayText[];
}

/**
 * Render an SVG overlay of extracted features,
 * then composite it onto the original image.
 */
export async function renderOverlay(
  baseImageBase64: string,
  imageWidth: number,
  imageHeight: number,
  spec: OverlaySpec,
): Promise<string> {
  // Build SVG overlay
  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}">`,
  ];

  // Circles (monuments)
  for (const c of spec.circles) {
    svgParts.push(
      `<circle cx="${c.x}" cy="${c.y}" r="${c.radius}" fill="none" stroke="${c.color}" stroke-width="2"/>`,
    );
    if (c.label) {
      svgParts.push(
        `<text x="${c.x + c.radius + 4}" y="${c.y + 4}" fill="${c.color}" font-size="14" font-family="monospace">${escapeXml(c.label)}</text>`,
      );
    }
  }

  // Polylines (lot lines, easements, centerlines)
  for (const p of spec.polylines) {
    if (p.points.length < 2) continue;
    const d = p.points
      .map((pt, i) => `${i === 0 ? "M" : "L"} ${pt.x} ${pt.y}`)
      .join(" ");
    const dashAttr = p.dashed ? ' stroke-dasharray="10,6"' : "";
    svgParts.push(
      `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="${p.strokeWidth}"${dashAttr}/>`,
    );
  }

  // Text labels
  for (const t of spec.texts) {
    svgParts.push(
      `<text x="${t.x}" y="${t.y}" fill="${t.color}" font-size="${t.fontSize}" font-family="monospace">${escapeXml(t.text)}</text>`,
    );
  }

  svgParts.push("</svg>");
  const svgBuf = Buffer.from(svgParts.join("\n"));

  // Composite onto base image
  const baseBuf = Buffer.from(baseImageBase64, "base64");
  const result = await sharp(baseBuf)
    .composite([{ input: svgBuf, blend: "over" }])
    .jpeg({ quality: 90 })
    .toBuffer();

  return result.toString("base64");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Color constants for different feature types (matching AIA layer colors).
 */
export const LAYER_COLORS = {
  "C-PROP": "#FFFFFF", // White — lot lines
  "C-PROP-ESMT": "#FFFF00", // Yellow — easements
  "C-PROP-MONU": "#FF0000", // Red — monuments
  "C-PROP-BRNG": "#00FF00", // Green — bearings
  "C-ROAD-CNTR": "#FF00FF", // Magenta — centerlines
  "C-ANNO-TEXT": "#00FFFF", // Cyan — text
  "C-ANNO-DIMS": "#00FF00", // Green — dimensions
  "C-ANNO-TTLB": "#808080", // Gray — title block
} as const;
