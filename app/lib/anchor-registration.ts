/**
 * Anchor Registration — find the precise pixel position of the lot boundary
 * by matching COGO geometry against extracted ink centerlines.
 *
 * Strategy:
 * 1. Coarse VLM localization → crop bounding box for the target lot
 * 2. Potrace/thinning → extract centerline segments from the crop
 * 3. VLM batch extraction → read all bearings/distances from the crop
 * 4. Geometric matching → find which extracted segment matches each COGO leg
 * 5. Least-squares → compute the anchor from matched segment endpoints
 *
 * This NEVER asks the VLM for pixel coordinates. It uses the VLM only
 * for reading text (bearings/distances) and uses computation for spatial matching.
 */

import { parseBearing, traversePoint, type Point } from "./cogo";
import { registerCoordSystem, surveyToPixel, type CoordSystem } from "./coord-system";
import { extractCenterlines, type ExtractedSegment } from "./centerline-extract";
import { nimVision, parseJsonResponse } from "./nim-client";
import { cropTile, overviewTile, type CropRegion } from "./tile-cropper";
import type { PageInfo } from "./reconstruction-agent";

export interface RegistrationResult {
  coordSystem: CoordSystem;
  anchorPixel: { px: number; py: number };
  /** Confidence score (0-1) based on how many COGO legs matched extracted segments */
  matchConfidence: number;
  /** The matched segment pairs for debugging */
  matches: Array<{
    cogoAngle: number;
    cogoLength: number;
    extractedAngle: number;
    extractedLength: number;
    startPx: { x: number; y: number };
  }>;
  /** The crop region used (in full-image coordinates) */
  cropRegion: CropRegion;
}

/**
 * Register the coordinate system by matching COGO geometry to extracted ink.
 */
export async function registerAnchor(
  page: PageInfo,
  targetLot: string,
  scaleInfo: { feetPerInch: number; dpi: number; scaleText: string },
  northAngleDeg: number,
  onProgress: (msg: string) => void,
): Promise<RegistrationResult> {
  // Step 1: Find approximate lot area via VLM
  onProgress("Locating lot area on map…");
  const overview = await overviewTile(page.pngBase64, page.width, page.height);

  const lotLocResponse = await nimVision(
    overview.base64,
    `Find Lot ${targetLot} on this subdivision/tract map.
Return the bounding box of the lot as percentages of the image:
{ "x_pct": 30, "y_pct": 40, "width_pct": 15, "height_pct": 20 }

x_pct/y_pct = top-left corner. width_pct/height_pct = size.
Include some padding around the lot boundaries.`,
    { maxTokens: 256, temperature: 0.1 },
  );

  let cropRegion: CropRegion;
  try {
    const loc = parseJsonResponse<{
      x_pct: number; y_pct: number; width_pct: number; height_pct: number;
    }>(lotLocResponse);
    const pad = 0.05; // 5% padding
    cropRegion = {
      x: Math.max(0, Math.round(((loc.x_pct - pad * 100) / 100) * page.width)),
      y: Math.max(0, Math.round(((loc.y_pct - pad * 100) / 100) * page.height)),
      width: Math.round(((loc.width_pct + pad * 200) / 100) * page.width),
      height: Math.round(((loc.height_pct + pad * 200) / 100) * page.height),
      label: `lot-${targetLot}-registration`,
    };
  } catch {
    // Fallback: center 40% of image
    cropRegion = {
      x: Math.round(page.width * 0.2),
      y: Math.round(page.height * 0.2),
      width: Math.round(page.width * 0.4),
      height: Math.round(page.height * 0.4),
      label: `lot-${targetLot}-registration-fallback`,
    };
  }
  onProgress(`Lot area: (${cropRegion.x}, ${cropRegion.y}) ${cropRegion.width}x${cropRegion.height}px`);

  // Step 2: Extract centerlines from the crop
  onProgress("Extracting ink centerlines from crop…");
  const cropPng = await getCropBase64(page.pngBase64, cropRegion);
  const segments = await extractCenterlines(cropPng, { minLength: 50 });
  onProgress(`Found ${segments.length} line segments in crop`);

  // Step 3: Read bearings/distances from the crop via VLM
  onProgress("Reading bearings and distances from crop…");
  const tile = await cropTile(page.pngBase64, cropRegion);
  const extractResponse = await nimVision(
    tile.base64,
    `This is a close-up of Lot ${targetLot} on a tract map.
Read ALL boundary line segments of this lot. For each line, read:
- bearing (e.g., "N 75°39'10\" W")
- distance in feet (e.g., 146.31)

Return a JSON array in clockwise order from the bottom-right corner:
[
  { "bearing": "N 75°39'10\\" W", "distance": 146.31 },
  { "bearing": "S 15°33'02\\" E", "distance": 130.42 }
]

Read ONLY the lot boundary lines (solid lines). Ignore easement dashes, road lines, and curve data.`,
    { maxTokens: 1024, temperature: 0.1 },
  );

  let cogoLegs: Array<{ bearing: string; distance: number; azimuth: number; anglePx: number; lengthPx: number }> = [];
  try {
    const raw = parseJsonResponse<Array<{ bearing: string; distance: number }>>(extractResponse);
    const pxPerFoot = scaleInfo.dpi / scaleInfo.feetPerInch;
    const northRad = (northAngleDeg * Math.PI) / 180;

    cogoLegs = raw.filter(l => l.bearing && l.distance).map(l => {
      const az = parseBearing(l.bearing);
      // Convert survey azimuth to image angle:
      // Survey: clockwise from north. Image: atan2(dy, dx) from positive X.
      // Image angle = -(azimuth + northRad) + π/2 (because image Y is down)
      const imgAngle = Math.PI / 2 - (az + northRad);
      return {
        bearing: l.bearing,
        distance: l.distance,
        azimuth: az,
        anglePx: imgAngle,
        lengthPx: l.distance * pxPerFoot,
      };
    });
    onProgress(`Read ${cogoLegs.length} boundary legs from crop`);
  } catch {
    onProgress("Failed to parse bearings from VLM response");
  }

  if (cogoLegs.length === 0 || segments.length === 0) {
    // Can't do geometric matching — fall back
    onProgress("Insufficient data for geometric matching, using center of crop");
    const cs = registerCoordSystem({
      feetPerInch: scaleInfo.feetPerInch,
      dpi: scaleInfo.dpi,
      northAngleDeg,
      anchorPixel: {
        px: cropRegion.x + cropRegion.width / 2,
        py: cropRegion.y + cropRegion.height / 2,
      },
      scaleText: scaleInfo.scaleText,
    });
    return {
      coordSystem: cs,
      anchorPixel: cs.anchorPixel,
      matchConfidence: 0,
      matches: [],
      cropRegion,
    };
  }

  // Step 4: Geometric matching — find the best anchor position
  onProgress("Matching COGO geometry to extracted segments…");
  const bestMatch = findBestAnchor(cogoLegs, segments, cropRegion);
  onProgress(`Best match: ${bestMatch.matchCount}/${cogoLegs.length} legs matched, anchor at (${bestMatch.anchor.x}, ${bestMatch.anchor.y})`);

  const coordSystem = registerCoordSystem({
    feetPerInch: scaleInfo.feetPerInch,
    dpi: scaleInfo.dpi,
    northAngleDeg,
    anchorPixel: { px: bestMatch.anchor.x, py: bestMatch.anchor.y },
    scaleText: scaleInfo.scaleText,
  });

  return {
    coordSystem,
    anchorPixel: { px: bestMatch.anchor.x, py: bestMatch.anchor.y },
    matchConfidence: bestMatch.matchCount / cogoLegs.length,
    matches: bestMatch.matches,
    cropRegion,
  };
}

// ─── Geometric Matching ──────────────────────────────────

interface CogoLeg {
  bearing: string;
  distance: number;
  azimuth: number;
  anglePx: number;
  lengthPx: number;
}

interface MatchResult {
  anchor: { x: number; y: number };
  matchCount: number;
  totalError: number;
  matches: Array<{
    cogoAngle: number;
    cogoLength: number;
    extractedAngle: number;
    extractedLength: number;
    startPx: { x: number; y: number };
  }>;
}

/**
 * Find the anchor position that best aligns COGO legs with extracted segments.
 *
 * For the FIRST COGO leg, find all extracted segments with similar angle and length.
 * For each candidate, compute the implied anchor (the start of the matched segment),
 * then check how many remaining COGO legs also match segments at the predicted positions.
 * The candidate with the most total matches wins.
 */
function findBestAnchor(
  cogoLegs: CogoLeg[],
  segments: ExtractedSegment[],
  cropRegion: CropRegion,
): MatchResult {
  const ANGLE_TOL = 0.15; // ~8.5 degrees
  const LENGTH_TOL = 0.25; // 25% length tolerance

  const firstLeg = cogoLegs[0];
  let best: MatchResult = {
    anchor: { x: cropRegion.x + cropRegion.width / 2, y: cropRegion.y + cropRegion.height / 2 },
    matchCount: 0,
    totalError: Infinity,
    matches: [],
  };

  // Find candidate matches for the first leg
  for (const seg of segments) {
    // Check both directions (segment could go either way)
    for (const flip of [false, true]) {
      const segAngle = flip ? seg.angle + Math.PI : seg.angle;
      const normalizedSegAngle = ((segAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const normalizedCogoAngle = ((firstLeg.anglePx % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

      let angleDiff = Math.abs(normalizedSegAngle - normalizedCogoAngle);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

      const lengthRatio = seg.length / firstLeg.lengthPx;

      if (angleDiff > ANGLE_TOL || lengthRatio < (1 - LENGTH_TOL) || lengthRatio > (1 + LENGTH_TOL)) {
        continue;
      }

      // This segment is a candidate match for the first COGO leg.
      // The anchor is at the start of this segment (in full-image coords).
      const startPx = flip ? seg.endPx : seg.startPx;
      const candidateAnchor = {
        x: cropRegion.x + startPx.x,
        y: cropRegion.y + startPx.y,
      };

      // Check how many remaining legs also match
      const matches = [{
        cogoAngle: firstLeg.anglePx,
        cogoLength: firstLeg.lengthPx,
        extractedAngle: segAngle,
        extractedLength: seg.length,
        startPx: candidateAnchor,
      }];

      // Predict where each subsequent leg should be and check for matches
      let currentPx = flip ? seg.startPx : seg.endPx; // end of first matched segment
      let totalError = angleDiff + Math.abs(1 - lengthRatio);

      for (let i = 1; i < cogoLegs.length; i++) {
        const leg = cogoLegs[i];
        const bestSeg = findClosestSegment(
          segments,
          { x: cropRegion.x + currentPx.x, y: cropRegion.y + currentPx.y },
          leg.anglePx,
          leg.lengthPx,
          ANGLE_TOL * 1.5,
          LENGTH_TOL * 1.5,
          cropRegion,
        );

        if (bestSeg) {
          matches.push({
            cogoAngle: leg.anglePx,
            cogoLength: leg.lengthPx,
            extractedAngle: bestSeg.angle,
            extractedLength: bestSeg.length,
            startPx: { x: cropRegion.x + bestSeg.startPx.x, y: cropRegion.y + bestSeg.startPx.y },
          });
          currentPx = bestSeg.endPx;
          totalError += bestSeg.error;
        } else {
          // No match — advance using COGO prediction
          const dx = leg.lengthPx * Math.cos(leg.anglePx);
          const dy = leg.lengthPx * Math.sin(leg.anglePx);
          currentPx = { x: currentPx.x + dx, y: currentPx.y + dy };
        }
      }

      if (matches.length > best.matchCount ||
          (matches.length === best.matchCount && totalError < best.totalError)) {
        best = { anchor: candidateAnchor, matchCount: matches.length, totalError, matches };
      }
    }
  }

  return best;
}

function findClosestSegment(
  segments: ExtractedSegment[],
  expectedStart: { x: number; y: number },
  expectedAngle: number,
  expectedLength: number,
  angleTol: number,
  lengthTol: number,
  cropRegion: CropRegion,
): { startPx: { x: number; y: number }; endPx: { x: number; y: number }; angle: number; length: number; error: number } | null {
  let best: ReturnType<typeof findClosestSegment> = null;
  let bestError = Infinity;
  const proxThreshold = expectedLength * 0.5; // start point must be within half the line length

  for (const seg of segments) {
    for (const flip of [false, true]) {
      const sPx = flip ? seg.endPx : seg.startPx;
      const ePx = flip ? seg.startPx : seg.endPx;
      const segAngle = flip ? seg.angle + Math.PI : seg.angle;

      // Check proximity to expected start
      const fullStart = { x: cropRegion.x + sPx.x, y: cropRegion.y + sPx.y };
      const dist = Math.sqrt((fullStart.x - expectedStart.x) ** 2 + (fullStart.y - expectedStart.y) ** 2);
      if (dist > proxThreshold) continue;

      // Check angle
      const normSeg = ((segAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const normExp = ((expectedAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let angleDiff = Math.abs(normSeg - normExp);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
      if (angleDiff > angleTol) continue;

      // Check length
      const lengthRatio = seg.length / expectedLength;
      if (lengthRatio < (1 - lengthTol) || lengthRatio > (1 + lengthTol)) continue;

      const error = dist / expectedLength + angleDiff + Math.abs(1 - lengthRatio);
      if (error < bestError) {
        bestError = error;
        best = { startPx: sPx, endPx: ePx, angle: segAngle, length: seg.length, error };
      }
    }
  }

  return best;
}

// ─── Helper ──────────────────────────────────────────────

async function getCropBase64(fullPngBase64: string, region: CropRegion): Promise<string> {
  const sharpMod = (await import("sharp")).default;
  const buf = Buffer.from(fullPngBase64, "base64");
  const meta = await sharpMod(buf).metadata();
  const imgW = meta.width ?? 1;
  const imgH = meta.height ?? 1;

  let left = Math.max(0, Math.round(region.x));
  let top = Math.max(0, Math.round(region.y));
  let width = Math.round(region.width);
  let height = Math.round(region.height);
  if (left + width > imgW) width = imgW - left;
  if (top + height > imgH) height = imgH - top;
  width = Math.max(1, width);
  height = Math.max(1, height);

  const cropped = await sharpMod(buf)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();

  return cropped.toString("base64");
}
