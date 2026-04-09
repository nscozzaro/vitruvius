/**
 * Overlap Measurement — empirical quality scoring for SVG-on-raster alignment.
 *
 * After the agent draws a line, we sample points along it and check whether
 * the corresponding pixels in the original grayscale raster are dark (ink).
 * This gives an objective overlap score that LLMs (which are bad at visual
 * assessment) and users can both rely on.
 *
 * No hardcoded accept/reject thresholds — the score is informational input.
 */

import sharp from "sharp";

export interface OverlapResult {
  /** Fraction of sampled points that overlap dark ink (0–1) */
  score: number;
  /** Per-point details for debugging / visualization */
  samples: SamplePoint[];
  /** Measured stroke width in pixels (median of perpendicular scans) */
  measuredStrokeWidth: number;
}

export interface SamplePoint {
  /** Pixel coordinates of the sample */
  px: number;
  py: number;
  /** Average darkness of the neighborhood (0=white, 255=black) */
  darkness: number;
  /** Whether this point overlaps ink */
  overlaps: boolean;
}

const DARK_THRESHOLD = 128; // pixel values below this are "dark ink"
const NEIGHBORHOOD_RADIUS = 2; // 5×5 patch

/**
 * Measure how well a drawn line overlaps the original raster image.
 *
 * @param imagePngBase64 - Grayscale PNG of the original map page
 * @param imageWidth - Full image width in pixels
 * @param imageHeight - Full image height in pixels
 * @param linePixels - Pixel coordinates along the drawn line
 * @param numSamples - Number of evenly-spaced points to check (default 30)
 */
export async function measureOverlap(
  imagePngBase64: string,
  imageWidth: number,
  imageHeight: number,
  linePixels: Array<{ px: number; py: number }>,
  numSamples = 30,
): Promise<OverlapResult> {
  if (linePixels.length < 2) {
    return { score: 0, samples: [], measuredStrokeWidth: 0 };
  }

  // Compute the bounding box of the line with padding
  const pad = 20;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of linePixels) {
    minX = Math.min(minX, p.px);
    minY = Math.min(minY, p.py);
    maxX = Math.max(maxX, p.px);
    maxY = Math.max(maxY, p.py);
  }
  const cropX = Math.max(0, Math.floor(minX - pad));
  const cropY = Math.max(0, Math.floor(minY - pad));
  const cropW = Math.min(imageWidth - cropX, Math.ceil(maxX - minX + 2 * pad));
  const cropH = Math.min(imageHeight - cropY, Math.ceil(maxY - minY + 2 * pad));

  if (cropW <= 0 || cropH <= 0) {
    return { score: 0, samples: [], measuredStrokeWidth: 0 };
  }

  // Extract the crop as raw grayscale pixels
  const buf = Buffer.from(imagePngBase64, "base64");
  const { data: rawPixels, info } = await sharp(buf)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;

  // Helper: get darkness at a pixel (relative to crop)
  function getDarkness(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= w || y >= info.height) return 255; // white = off-image
    return 255 - rawPixels[y * w + x]; // invert so 255 = darkest
  }

  // Sample evenly along the line
  const samplePoints = sampleAlongLine(linePixels, numSamples);
  const samples: SamplePoint[] = [];

  for (const { px, py } of samplePoints) {
    // Convert to crop-local coordinates
    const lx = Math.round(px - cropX);
    const ly = Math.round(py - cropY);

    // Check neighborhood
    let darkCount = 0;
    let totalCount = 0;
    let darkSum = 0;
    for (let dy = -NEIGHBORHOOD_RADIUS; dy <= NEIGHBORHOOD_RADIUS; dy++) {
      for (let dx = -NEIGHBORHOOD_RADIUS; dx <= NEIGHBORHOOD_RADIUS; dx++) {
        const d = getDarkness(lx + dx, ly + dy);
        darkSum += d;
        totalCount++;
        if (d > DARK_THRESHOLD) darkCount++;
      }
    }

    const avgDarkness = totalCount > 0 ? darkSum / totalCount : 0;
    const overlaps = darkCount / totalCount >= 0.4;

    samples.push({ px, py, darkness: avgDarkness, overlaps });
  }

  const overlapCount = samples.filter((s) => s.overlaps).length;
  const score = samples.length > 0 ? overlapCount / samples.length : 0;

  // Measure stroke width via perpendicular scans
  const strokeWidth = measureStrokeWidth(
    linePixels, samplePoints, rawPixels, w, info.height, cropX, cropY,
  );

  return { score, samples, measuredStrokeWidth: strokeWidth };
}

/**
 * Measure overlap for a monument (point element).
 * Checks a circular region around the monument center.
 */
export async function measureMonumentOverlap(
  imagePngBase64: string,
  imageWidth: number,
  imageHeight: number,
  center: { px: number; py: number },
  radiusPx = 8,
): Promise<{ score: number; darkness: number }> {
  const cropX = Math.max(0, Math.floor(center.px - radiusPx - 5));
  const cropY = Math.max(0, Math.floor(center.py - radiusPx - 5));
  const size = (radiusPx + 5) * 2;
  const cropW = Math.min(imageWidth - cropX, size);
  const cropH = Math.min(imageHeight - cropY, size);

  if (cropW <= 0 || cropH <= 0) return { score: 0, darkness: 0 };

  const buf = Buffer.from(imagePngBase64, "base64");
  const { data: rawPixels, info } = await sharp(buf)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cx = Math.round(center.px - cropX);
  const cy = Math.round(center.py - cropY);
  let darkCount = 0;
  let totalCount = 0;
  let darkSum = 0;

  for (let dy = -radiusPx; dy <= radiusPx; dy++) {
    for (let dx = -radiusPx; dx <= radiusPx; dx++) {
      if (dx * dx + dy * dy > radiusPx * radiusPx) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= info.width || y >= info.height) continue;
      const darkness = 255 - rawPixels[y * info.width + x];
      darkSum += darkness;
      totalCount++;
      if (darkness > DARK_THRESHOLD) darkCount++;
    }
  }

  return {
    score: totalCount > 0 ? darkCount / totalCount : 0,
    darkness: totalCount > 0 ? darkSum / totalCount : 0,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Sample N evenly-spaced points along a polyline.
 */
function sampleAlongLine(
  points: Array<{ px: number; py: number }>,
  n: number,
): Array<{ px: number; py: number }> {
  // Compute total length
  let totalLength = 0;
  const segLengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].px - points[i - 1].px;
    const dy = points[i].py - points[i - 1].py;
    const len = Math.sqrt(dx * dx + dy * dy);
    segLengths.push(len);
    totalLength += len;
  }

  if (totalLength === 0) return [points[0]];

  const samples: Array<{ px: number; py: number }> = [];
  for (let i = 0; i < n; i++) {
    const targetDist = (i / (n - 1)) * totalLength;
    let accum = 0;
    for (let j = 0; j < segLengths.length; j++) {
      if (accum + segLengths[j] >= targetDist || j === segLengths.length - 1) {
        const t = segLengths[j] > 0 ? (targetDist - accum) / segLengths[j] : 0;
        samples.push({
          px: points[j].px + t * (points[j + 1].px - points[j].px),
          py: points[j].py + t * (points[j + 1].py - points[j].py),
        });
        break;
      }
      accum += segLengths[j];
    }
  }

  return samples;
}

/**
 * Measure stroke width by scanning perpendicular to the line at sample points.
 * Returns median measured width in pixels.
 */
function measureStrokeWidth(
  linePoints: Array<{ px: number; py: number }>,
  samplePoints: Array<{ px: number; py: number }>,
  rawPixels: Buffer,
  imgW: number,
  imgH: number,
  cropX: number,
  cropY: number,
): number {
  const widths: number[] = [];
  const scanRadius = 15; // scan 15 pixels each direction perpendicular

  // Pick ~10 evenly-spaced sample points
  const step = Math.max(1, Math.floor(samplePoints.length / 10));

  for (let i = 0; i < samplePoints.length; i += step) {
    const sp = samplePoints[i];
    // Compute line direction at this point
    const idx = findNearestSegment(linePoints, sp);
    const p0 = linePoints[idx];
    const p1 = linePoints[Math.min(idx + 1, linePoints.length - 1)];
    const dx = p1.px - p0.px;
    const dy = p1.py - p0.py;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.1) continue;

    // Perpendicular direction
    const nx = -dy / len;
    const ny = dx / len;

    // Scan perpendicular
    let darkStart = -1;
    let darkEnd = -1;
    for (let t = -scanRadius; t <= scanRadius; t++) {
      const x = Math.round(sp.px + nx * t - cropX);
      const y = Math.round(sp.py + ny * t - cropY);
      if (x < 0 || y < 0 || x >= imgW || y >= imgH) continue;
      const darkness = 255 - rawPixels[y * imgW + x];
      if (darkness > DARK_THRESHOLD) {
        if (darkStart === -1) darkStart = t;
        darkEnd = t;
      }
    }

    if (darkStart !== -1 && darkEnd !== -1) {
      widths.push(darkEnd - darkStart + 1);
    }
  }

  if (widths.length === 0) return 0;

  // Return median
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}

function findNearestSegment(
  points: Array<{ px: number; py: number }>,
  target: { px: number; py: number },
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const mx = (points[i].px + points[i + 1].px) / 2;
    const my = (points[i].py + points[i + 1].py) / 2;
    const d = (mx - target.px) ** 2 + (my - target.py) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
