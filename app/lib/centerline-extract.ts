/**
 * Centerline Extraction — extract ink line segments from a raster image.
 *
 * Binary threshold → Zhang-Suen thinning → connected component extraction →
 * Douglas-Peucker simplification → line segments with angle and length.
 *
 * Used for geometric matching: compare COGO-computed line segments against
 * extracted ink segments to find where on the image the lot boundary actually is.
 */

import sharp from "sharp";

export interface ExtractedSegment {
  /** Start point in crop-local pixel coords */
  startPx: { x: number; y: number };
  /** End point in crop-local pixel coords */
  endPx: { x: number; y: number };
  /** Angle in radians (atan2, measured from positive X axis) */
  angle: number;
  /** Length in pixels */
  length: number;
}

/**
 * Extract centerline segments from a PNG crop.
 * Returns line segments with angle and length in pixel space.
 */
export async function extractCenterlines(
  pngBase64: string,
  opts: { threshold?: number; minLength?: number } = {},
): Promise<ExtractedSegment[]> {
  const { threshold = 128, minLength = 30 } = opts;

  // Get raw grayscale pixels
  const { data, info } = await sharp(Buffer.from(pngBase64, "base64"))
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;

  // Threshold to binary (1 = ink, 0 = paper)
  const binary = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) {
    binary[i] = data[i] < threshold ? 1 : 0;
  }

  // Zhang-Suen thinning to get 1-pixel-wide skeleton
  zhangSuenThin(binary, w, h);

  // Extract connected chains of skeleton pixels
  const chains = extractChains(binary, w, h);

  // Simplify chains to line segments via Douglas-Peucker
  const segments: ExtractedSegment[] = [];
  for (const chain of chains) {
    const simplified = douglasPeucker(chain, 3.0); // 3px tolerance
    for (let i = 0; i < simplified.length - 1; i++) {
      const s = simplified[i];
      const e = simplified[i + 1];
      const dx = e.x - s.x;
      const dy = e.y - s.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < minLength) continue;
      segments.push({
        startPx: s,
        endPx: e,
        angle: Math.atan2(dy, dx),
        length: len,
      });
    }
  }

  return segments;
}

// ─── Zhang-Suen Thinning ──────────────────────────────────

/**
 * Zhang-Suen thinning algorithm (in-place).
 * Iteratively removes edge pixels that don't break connectivity,
 * producing a 1-pixel-wide skeleton.
 */
function zhangSuenThin(img: Uint8Array, w: number, h: number): void {
  let changed = true;
  const toRemove: number[] = [];

  while (changed) {
    changed = false;

    // Sub-iteration 1
    toRemove.length = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!img[y * w + x]) continue;
        const p = neighbors(img, x, y, w);
        const b = p.reduce((s, v) => s + v, 0);
        if (b < 2 || b > 6) continue;
        if (transitions(p) !== 1) continue;
        if (p[0] * p[2] * p[4] !== 0) continue; // P2 * P4 * P6
        if (p[2] * p[4] * p[6] !== 0) continue; // P4 * P6 * P8
        toRemove.push(y * w + x);
      }
    }
    for (const idx of toRemove) { img[idx] = 0; changed = true; }

    // Sub-iteration 2
    toRemove.length = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!img[y * w + x]) continue;
        const p = neighbors(img, x, y, w);
        const b = p.reduce((s, v) => s + v, 0);
        if (b < 2 || b > 6) continue;
        if (transitions(p) !== 1) continue;
        if (p[0] * p[2] * p[6] !== 0) continue; // P2 * P4 * P8
        if (p[0] * p[4] * p[6] !== 0) continue; // P2 * P6 * P8
        toRemove.push(y * w + x);
      }
    }
    for (const idx of toRemove) { img[idx] = 0; changed = true; }
  }
}

/** 8-neighbor values in clockwise order: P2,P3,P4,P5,P6,P7,P8,P9 */
function neighbors(img: Uint8Array, x: number, y: number, w: number): number[] {
  return [
    img[(y - 1) * w + x],     // P2 (top)
    img[(y - 1) * w + x + 1], // P3 (top-right)
    img[y * w + x + 1],       // P4 (right)
    img[(y + 1) * w + x + 1], // P5 (bottom-right)
    img[(y + 1) * w + x],     // P6 (bottom)
    img[(y + 1) * w + x - 1], // P7 (bottom-left)
    img[y * w + x - 1],       // P8 (left)
    img[(y - 1) * w + x - 1], // P9 (top-left)
  ];
}

/** Count 0→1 transitions in the clockwise neighbor sequence */
function transitions(p: number[]): number {
  let count = 0;
  for (let i = 0; i < 8; i++) {
    if (p[i] === 0 && p[(i + 1) % 8] === 1) count++;
  }
  return count;
}

// ─── Chain Extraction ─────────────────────────────────────

interface Pt { x: number; y: number }

/** Extract connected chains of skeleton pixels by tracing 8-connected paths */
function extractChains(img: Uint8Array, w: number, h: number): Pt[][] {
  const visited = new Uint8Array(w * h);
  const chains: Pt[][] = [];

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!img[y * w + x] || visited[y * w + x]) continue;

      // Trace chain from this seed
      const chain: Pt[] = [];
      let cx = x, cy = y;

      while (true) {
        chain.push({ x: cx, y: cy });
        visited[cy * w + cx] = 1;

        // Find unvisited 8-connected neighbor
        let found = false;
        for (const [dx, dy] of [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h &&
              img[ny * w + nx] && !visited[ny * w + nx]) {
            cx = nx;
            cy = ny;
            found = true;
            break;
          }
        }
        if (!found) break;
      }

      if (chain.length >= 10) chains.push(chain);
    }
  }

  return chains;
}

// ─── Douglas-Peucker Simplification ──────────────────────

function douglasPeucker(points: Pt[], epsilon: number): Pt[] {
  if (points.length <= 2) return points;

  const first = points[0];
  const last = points[points.length - 1];

  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist <= epsilon) {
    return [first, last];
  }

  const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
  const right = douglasPeucker(points.slice(maxIdx), epsilon);

  return [...left.slice(0, -1), ...right];
}

function pointLineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}
