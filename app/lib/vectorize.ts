/**
 * PDF → PNG → Mask → Vectorize pipeline.
 *
 * Renders PDF to PNG using pdftoppm (local) or returns null on serverless.
 * The API route handles the null case gracefully.
 */

import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink } from "fs/promises";
import type { MaskRegion } from "@/app/lib/map-analyzer";

export interface TracedPath {
  d: string;
  points: Array<{ x: number; y: number }>;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  centroid: { x: number; y: number };
}

/**
 * Render a PDF to PNG. Uses pdftoppm if available, otherwise returns null.
 */
export async function renderPdfToPng(
  pdfBuf: Buffer,
  maxSize = 2048,
): Promise<{ base64: string; width: number; height: number } | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const id = Math.random().toString(36).slice(2);
  const pdfPath = join(tmpdir(), `render-${id}.pdf`);
  const pngPrefix = join(tmpdir(), `render-${id}`);

  try {
    await writeFile(pdfPath, pdfBuf);

    const bins = ["/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm", "/usr/bin/pdftoppm", "pdftoppm"];
    let rendered = false;
    for (const bin of bins) {
      try {
        await execFileAsync(bin, ["-png", "-f", "1", "-l", "1", "-scale-to", String(maxSize), pdfPath, pngPrefix]);
        rendered = true;
        break;
      } catch { /* try next */ }
    }
    if (!rendered) return null;

    for (const suffix of ["-1.png", "-01.png", "-001.png"]) {
      try {
        const png = await readFile(pngPrefix + suffix);
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        await unlink(pngPrefix + suffix).catch(() => {});
        return { base64: png.toString("base64"), width, height };
      } catch { /* try next suffix */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    await unlink(pdfPath).catch(() => {});
  }
}

/**
 * Apply mask regions to a PNG — paint areas white.
 */
export async function applyMask(
  pngBase64: string,
  width: number,
  height: number,
  regions: MaskRegion[],
): Promise<string> {
  if (regions.length === 0) return pngBase64;

  try {
    const sharp = (await import("sharp")).default;
    const inputBuf = Buffer.from(pngBase64, "base64");

    const composites = regions
      .map((r) => {
        const x = Math.max(0, Math.round((r.x_pct / 100) * width));
        const y = Math.max(0, Math.round((r.y_pct / 100) * height));
        const w = Math.min(width - x, Math.max(1, Math.round((r.w_pct / 100) * width)));
        const h = Math.min(height - y, Math.max(1, Math.round((r.h_pct / 100) * height)));
        const svg = `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="white"/></svg>`;
        return { input: Buffer.from(svg), top: y, left: x };
      });

    const result = await sharp(inputBuf).composite(composites).png().toBuffer();
    return result.toString("base64");
  } catch {
    return pngBase64;
  }
}

/**
 * Vectorize a PNG image using potrace.
 */
export async function vectorize(pngBase64: string): Promise<TracedPath[]> {
  const pngBuf = Buffer.from(pngBase64, "base64");

  const id = Math.random().toString(36).slice(2);
  const pngPath = join(tmpdir(), `trace-${id}.png`);
  await writeFile(pngPath, pngBuf);

  try {
    // potrace module has compatibility issues with Turbopack's require/import
    // Use dynamic require with explicit default handling
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const potraceModule = require("potrace");
    const traceFn = potraceModule.trace || potraceModule.default?.trace;
    if (!traceFn) {
      console.error("[vectorize] potrace.trace not found. Keys:", Object.keys(potraceModule));
      return [];
    }

    const svg: string = await new Promise((resolve, reject) => {
      traceFn(pngPath, { threshold: 128, turdSize: 2, optCurve: true },
        (err: Error | null, result: string) => err ? reject(err) : resolve(result));
    });
    return parseSvgPaths(svg);
  } catch (err) {
    console.error("[vectorize] potrace error:", err);
    return [];
  } finally {
    await unlink(pngPath).catch(() => {});
  }
}

function parseSvgPaths(svg: string): TracedPath[] {
  const dMatch = svg.match(/d="([^"]+)"/);
  if (!dMatch) return [];

  return dMatch[1].split(/(?=M\s)/).filter(s => s.trim()).map(sp => {
    const points: { x: number; y: number }[] = [];
    const re = /([\d.]+)\s*,\s*([\d.]+)/g;
    let m;
    while ((m = re.exec(sp)) !== null) points.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
    if (points.length < 2) return null;

    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    return {
      d: sp, points,
      bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
      centroid: { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length },
    };
  }).filter(Boolean) as TracedPath[];
}
