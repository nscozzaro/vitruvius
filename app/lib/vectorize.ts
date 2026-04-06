/**
 * PDF → PNG → Skeletonize → Chain-follow → DXF pipeline.
 *
 * Uses Zhang-Suen thinning to reduce all strokes to 1px centerlines,
 * then follows connected pixel chains to produce clean polylines.
 * Douglas-Peucker simplification reduces point count.
 */

import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";

export interface TracedChain {
  points: Array<{ x: number; y: number }>;
}

/**
 * Render a PDF to PNG. Uses mupdf (WASM, works everywhere including Vercel).
 */
export async function renderPdfToPng(
  pdfBuf: Buffer,
): Promise<{ base64: string; width: number; height: number } | null> {
  try {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(pdfBuf, "application/pdf");
    const page = doc.loadPage(0);

    // Render at 300 DPI — balances detail vs processing time on serverless
    const scale = 300 / 72;
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
    console.error("[renderPdfToPng] mupdf error:", err);
    return null;
  }
}

/**
 * Vectorize a PNG using skeletonization + chain following.
 * Produces clean single-line polylines (not outline traces).
 */
export async function vectorize(pngBase64: string): Promise<TracedChain[]> {
  const sharp = (await import("sharp")).default;
  const pngBuf = Buffer.from(pngBase64, "base64");

  // Convert to greyscale binary
  const { data, info } = await sharp(pngBuf)
    .greyscale()
    .threshold(128)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;

  // Binary: 1 = foreground (ink), 0 = background
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) {
    bin[i] = data[i] === 0 ? 1 : 0;
  }

  // Zhang-Suen thinning → 1px skeleton
  skeletonize(bin, w, h);

  // Chain following → polylines
  const chains = followChains(bin, w, h);

  // Douglas-Peucker simplification
  return chains
    .map((chain) => ({
      points: simplify(chain, 0.8).map(([x, y]) => ({ x, y: h - y })),
    }))
    .filter((c) => c.points.length >= 2);
}

// ── Zhang-Suen thinning ──────────────────────────────────────────────

function skeletonize(bin: Uint8Array, w: number, h: number): void {
  const get = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h ? bin[y * w + x] : 0;

  let changed = true;
  let iter = 0;

  while (changed && iter < 100) {
    changed = false;
    iter++;

    // Sub-iteration 1
    const rem1: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!bin[y * w + x]) continue;
        const p2 = get(x, y - 1), p3 = get(x + 1, y - 1), p4 = get(x + 1, y);
        const p5 = get(x + 1, y + 1), p6 = get(x, y + 1), p7 = get(x - 1, y + 1);
        const p8 = get(x - 1, y), p9 = get(x - 1, y - 1);
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        let A = 0;
        if (!p2 && p3) A++; if (!p3 && p4) A++; if (!p4 && p5) A++;
        if (!p5 && p6) A++; if (!p6 && p7) A++; if (!p7 && p8) A++;
        if (!p8 && p9) A++; if (!p9 && p2) A++;
        if (A !== 1) continue;
        if (p2 * p4 * p6 !== 0) continue;
        if (p4 * p6 * p8 !== 0) continue;
        rem1.push(y * w + x);
      }
    }
    for (const idx of rem1) { bin[idx] = 0; changed = true; }

    // Sub-iteration 2
    const rem2: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!bin[y * w + x]) continue;
        const p2 = get(x, y - 1), p3 = get(x + 1, y - 1), p4 = get(x + 1, y);
        const p5 = get(x + 1, y + 1), p6 = get(x, y + 1), p7 = get(x - 1, y + 1);
        const p8 = get(x - 1, y), p9 = get(x - 1, y - 1);
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        let A = 0;
        if (!p2 && p3) A++; if (!p3 && p4) A++; if (!p4 && p5) A++;
        if (!p5 && p6) A++; if (!p6 && p7) A++; if (!p7 && p8) A++;
        if (!p8 && p9) A++; if (!p9 && p2) A++;
        if (A !== 1) continue;
        if (p2 * p4 * p8 !== 0) continue;
        if (p2 * p6 * p8 !== 0) continue;
        rem2.push(y * w + x);
      }
    }
    for (const idx of rem2) { bin[idx] = 0; changed = true; }
  }
}

// ── Chain following ──────────────────────────────────────────────────

function followChains(bin: Uint8Array, w: number, h: number): number[][][] {
  const visited = new Uint8Array(w * h);
  const chains: number[][][] = [];

  function unvisitedNeighbors(x: number, y: number): number[][] {
    const n: number[][] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && bin[ny * w + nx] && !visited[ny * w + nx]) {
          n.push([nx, ny]);
        }
      }
    }
    return n;
  }

  function neighborCount(x: number, y: number): number {
    let c = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && bin[ny * w + nx]) c++;
      }
    }
    return c;
  }

  // Start from endpoints (1 neighbor)
  const endpoints: number[][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x] && neighborCount(x, y) === 1) {
        endpoints.push([x, y]);
      }
    }
  }

  for (const [sx, sy] of endpoints) {
    if (visited[sy * w + sx]) continue;
    const chain: number[][] = [[sx, sy]];
    visited[sy * w + sx] = 1;
    let cx = sx, cy = sy;
    while (true) {
      const next = unvisitedNeighbors(cx, cy);
      if (next.length === 0) break;
      const [nx, ny] = next[0];
      chain.push([nx, ny]);
      visited[ny * w + nx] = 1;
      cx = nx; cy = ny;
    }
    if (chain.length >= 3) chains.push(chain);
  }

  // Remaining loops
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x] || visited[y * w + x]) continue;
      const chain: number[][] = [[x, y]];
      visited[y * w + x] = 1;
      let cx = x, cy = y;
      while (true) {
        const next = unvisitedNeighbors(cx, cy);
        if (next.length === 0) break;
        const [nx, ny] = next[0];
        chain.push([nx, ny]);
        visited[ny * w + nx] = 1;
        cx = nx; cy = ny;
      }
      if (chain.length >= 3) chains.push(chain);
    }
  }

  return chains;
}

// ── Douglas-Peucker simplification ───────────────────────────────────

function simplify(points: number[][], epsilon: number): number[][] {
  if (points.length <= 2) return points;

  const [sx, sy] = points[0];
  const [ex, ey] = points[points.length - 1];
  const dx = ex - sx, dy = ey - sy;
  const len = Math.sqrt(dx * dx + dy * dy);

  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const dist = len === 0
      ? Math.sqrt((points[i][0] - sx) ** 2 + (points[i][1] - sy) ** 2)
      : Math.abs(dy * points[i][0] - dx * points[i][1] + ex * sy - ey * sx) / len;
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left = simplify(points.slice(0, maxIdx + 1), epsilon);
    const right = simplify(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}
