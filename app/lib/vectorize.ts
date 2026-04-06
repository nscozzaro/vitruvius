/**
 * PDF → PNG → Potrace → DXF pipeline.
 *
 * Renders PDF at 300 DPI via mupdf, then vectorizes with potrace.
 * Potrace traces outlines of ink regions, preserving filled shapes
 * (monuments, thick lines) that skeletonization would destroy.
 */

import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";

export interface TracedPath {
  /** SVG path d attribute for this subpath */
  d: string;
  /** Extracted coordinate points */
  points: Array<{ x: number; y: number }>;
}

export interface VectorizeResult {
  paths: TracedPath[];
  width: number;
  height: number;
}

/**
 * Render a specific page of a PDF to PNG via mupdf WASM.
 * Returns base64 PNG + dimensions.
 */
export async function renderPdfToPng(
  pdfBuf: Buffer,
  pageIndex = 0,
  dpi = 300,
): Promise<{ base64: string; width: number; height: number } | null> {
  try {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(pdfBuf, "application/pdf");
    const page = doc.loadPage(pageIndex);

    const scale = dpi / 72;
    const pixmap = page.toPixmap(
      [scale, 0, 0, scale, 0, 0],
      mupdf.ColorSpace.DeviceGray,
    );

    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const pngBuf = pixmap.asPNG();

    return {
      base64: Buffer.from(pngBuf).toString("base64"),
      width,
      height,
    };
  } catch (err) {
    console.error("[renderPdfToPng] error:", err);
    return null;
  }
}

/**
 * Vectorize a PNG using potrace.
 * Returns SVG subpaths with coordinate points + image dimensions.
 */
export async function vectorize(
  pngBase64: string,
  imageWidth: number,
  imageHeight: number,
): Promise<VectorizeResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const potrace = require("potrace");
  const pngBuf = Buffer.from(pngBase64, "base64");

  const id = Math.random().toString(36).slice(2);
  const pngPath = join(tmpdir(), `trace-${id}.png`);
  await writeFile(pngPath, pngBuf);

  try {
    const svg: string = await new Promise((resolve, reject) => {
      potrace.trace(
        pngPath,
        { threshold: 128, turdSize: 5, optCurve: true },
        (err: Error | null, result: string) =>
          err ? reject(err) : resolve(result),
      );
    });

    const paths = parseSvgPaths(svg, imageHeight);
    return { paths, width: imageWidth, height: imageHeight };
  } finally {
    await unlink(pngPath).catch(() => {});
  }
}

/**
 * Parse potrace SVG output into individual subpaths with points.
 * Extracts coordinate pairs from M/L/C commands.
 * Y-flips coordinates so origin is bottom-left (DXF convention).
 */
function parseSvgPaths(svg: string, imageHeight: number): TracedPath[] {
  const dMatch = svg.match(/d="([^"]+)"/);
  if (!dMatch) return [];

  const subpaths = dMatch[1].split(/(?=M\s)/).filter((s) => s.trim());
  const paths: TracedPath[] = [];

  for (const sp of subpaths) {
    const points = extractPoints(sp, imageHeight);
    if (points.length >= 2) {
      paths.push({ d: sp, points });
    }
  }

  return paths;
}

/**
 * Extract coordinate points from an SVG path data string.
 * Handles M (moveto), L (lineto), and C (cubic bezier) commands.
 * Flips Y axis for DXF coordinate system.
 */
function extractPoints(
  d: string,
  imageHeight: number,
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const regex = /([\d.]+)\s*,\s*([\d.]+)/g;
  let m;
  while ((m = regex.exec(d)) !== null) {
    points.push({
      x: parseFloat(m[1]),
      y: imageHeight - parseFloat(m[2]),
    });
  }
  return points;
}
