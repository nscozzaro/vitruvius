/**
 * PDF → PNG → Mask → Vectorize pipeline.
 *
 * Renders a PDF page to PNG, optionally masks out regions,
 * then vectorizes with potrace to produce SVG path data.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink } from "fs/promises";
import type { MaskRegion } from "@/app/lib/map-analyzer";

const execFileAsync = promisify(execFile);

const PDFTOPPM_CANDIDATES = [
  "/opt/homebrew/bin/pdftoppm",
  "/usr/local/bin/pdftoppm",
  "pdftoppm",
];

export interface TracedPath {
  /** SVG path data (d attribute) */
  d: string;
  /** Parsed points for spatial matching */
  points: Array<{ x: number; y: number }>;
  /** Bounding box */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Centroid */
  centroid: { x: number; y: number };
}

/**
 * Render a PDF buffer to a PNG, capped at maxSize on the longest side.
 * Returns the PNG as a base64 string.
 */
export async function renderPdfToPng(
  pdfBuf: Buffer,
  maxSize = 2048,
): Promise<{ base64: string; width: number; height: number } | null> {
  const id = Math.random().toString(36).slice(2);
  const pdfPath = join(tmpdir(), `dxf-render-${id}.pdf`);
  const pngPrefix = join(tmpdir(), `dxf-render-${id}`);

  try {
    await writeFile(pdfPath, pdfBuf);

    let rendered = false;
    for (const bin of PDFTOPPM_CANDIDATES) {
      try {
        await execFileAsync(bin, [
          "-png", "-f", "1", "-l", "1",
          "-scale-to", String(maxSize),
          pdfPath, pngPrefix,
        ]);
        rendered = true;
        break;
      } catch { /* try next */ }
    }
    if (!rendered) return null;

    for (const suffix of ["-1.png", "-01.png", "-001.png"]) {
      try {
        const png = await readFile(pngPrefix + suffix);
        // Get dimensions from PNG header
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        return {
          base64: png.toString("base64"),
          width,
          height,
        };
      } catch { /* try next suffix */ }
    }
    return null;
  } finally {
    await unlink(pdfPath).catch(() => {});
  }
}

/**
 * Apply mask regions to a PNG image — paint specified areas white.
 * Operates on raw PNG buffer, returns masked PNG as base64.
 */
export async function applyMask(
  pngBase64: string,
  width: number,
  height: number,
  regions: MaskRegion[],
): Promise<string> {
  if (regions.length === 0) return pngBase64;

  // Use sharp if available, otherwise use canvas
  // For now, use a simple approach: decode PNG, paint rectangles, re-encode
  // We'll use the `sharp` package if installed, otherwise fall back to raw manipulation

  try {
    const sharp = (await import("sharp")).default;
    const inputBuf = Buffer.from(pngBase64, "base64");

    // Create white rectangles for each mask region
    const composites = regions.map((r) => {
      const x = Math.round((r.x_pct / 100) * width);
      const y = Math.round((r.y_pct / 100) * height);
      const w = Math.round((r.w_pct / 100) * width);
      const h = Math.round((r.h_pct / 100) * height);

      // Create a white rectangle SVG
      const svg = `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="white"/></svg>`;

      return {
        input: Buffer.from(svg),
        top: Math.max(0, y),
        left: Math.max(0, x),
      };
    });

    const result = await sharp(inputBuf)
      .composite(composites)
      .png()
      .toBuffer();

    return result.toString("base64");
  } catch {
    // Fallback: return unmasked image (sharp not available)
    console.warn("[vectorize] sharp not available, skipping mask");
    return pngBase64;
  }
}

/**
 * Vectorize a PNG image using potrace.
 * Returns an array of traced paths.
 */
export async function vectorize(pngBase64: string): Promise<TracedPath[]> {
  const potrace = await import("potrace");
  const pngBuf = Buffer.from(pngBase64, "base64");

  // Write to temp file (potrace npm needs file path)
  const id = Math.random().toString(36).slice(2);
  const pngPath = join(tmpdir(), `dxf-trace-${id}.png`);
  await writeFile(pngPath, pngBuf);

  try {
    const svg = await new Promise<string>((resolve, reject) => {
      potrace.trace(pngPath, {
        threshold: 128,
        turdSize: 2,
        optCurve: true,
      }, (err: Error | null, svg: string) => {
        if (err) reject(err);
        else resolve(svg);
      });
    });

    return parseSvgPaths(svg);
  } finally {
    await unlink(pngPath).catch(() => {});
  }
}

/**
 * Parse SVG output from potrace into individual path objects.
 * Potrace produces a single compound path with subpaths (separated by M commands).
 */
function parseSvgPaths(svg: string): TracedPath[] {
  const dMatch = svg.match(/d="([^"]+)"/);
  if (!dMatch) return [];

  const d = dMatch[1];
  // Split into subpaths by M command
  const subpaths = d.split(/(?=M\s)/).filter((s) => s.trim());

  const paths: TracedPath[] = [];

  for (const sp of subpaths) {
    const points = extractPoints(sp);
    if (points.length < 2) continue;

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    paths.push({
      d: sp,
      points,
      bbox: { minX, minY, maxX, maxY },
      centroid: {
        x: points.reduce((s, p) => s + p.x, 0) / points.length,
        y: points.reduce((s, p) => s + p.y, 0) / points.length,
      },
    });
  }

  return paths;
}

/**
 * Extract coordinate points from an SVG path data string.
 */
function extractPoints(d: string): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const regex = /([\d.]+)\s*,\s*([\d.]+)/g;
  let m;
  while ((m = regex.exec(d)) !== null) {
    points.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
  }
  return points;
}
