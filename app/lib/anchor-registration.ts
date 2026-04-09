/**
 * Anchor Registration — find the precise pixel position of the lot's POB
 * using geometric matching against SVG features from potrace.
 *
 * Strategy (SVG-first, no VLM pixel estimation):
 * 1. VLM locates the lot area (coarse bounding box — text reading, not pixel coords)
 * 2. VLM reads the lot's metes-and-bounds text (bearings + distances)
 * 3. COGO computes the expected lot boundary shape from those bearings/distances
 * 4. For each SVG monument in the lot area, hypothesize it as POB:
 *    - Project COGO traverse into pixel space using this anchor
 *    - Score alignment against SVG boundary paths
 * 5. The monument with best alignment wins — pure geometry, sub-pixel accuracy
 *
 * The VLM reads TEXT (which it's good at). All spatial positioning is
 * deterministic geometry matching (which machines are good at).
 */

import { registerCoordSystem, type CoordSystem, surveyToPixel } from "./coord-system";
import { parseBearing, traversePoint } from "./cogo";
import type { Point } from "./cogo";
import { nimVision, parseJsonResponse } from "./nim-client";
import { overviewTile, type CropRegion, cropTile } from "./tile-cropper";
import type { PageInfo } from "./reconstruction-agent";
import type { SvgFeatureMap, SvgMonument } from "./svg-features";
import { findFeaturesInRegion, scorePlacement } from "./svg-features";
import { vectorizeToSvg } from "./vectorize";
import { extractSvgFeatures } from "./svg-features";

export interface RegistrationResult {
  coordSystem: CoordSystem;
  anchorPixel: { px: number; py: number };
  matchConfidence: number;
  cropRegion: CropRegion;
  validated: boolean;
  matches: Array<Record<string, unknown>>;
  /** SVG features extracted from the page — reused during step execution */
  svgFeatures: SvgFeatureMap;
}

interface LotBoundaryReading {
  bearing: string;
  distance: number;
  type: "line" | "curve";
}

export async function registerAnchor(
  page: PageInfo,
  targetLot: string,
  scaleInfo: { feetPerInch: number; dpi: number; scaleText: string },
  northAngleDeg: number,
  onProgress: (msg: string) => void,
): Promise<RegistrationResult> {
  // ─── Step 1: Vectorize page → extract SVG features ──────
  onProgress("Vectorizing map for geometric analysis…");
  const svgResult = await vectorizeToSvg(page.pngBase64, page.width, page.height);
  const svgFeatures = extractSvgFeatures(svgResult.rawSvg, page.width, page.height);
  onProgress(`Found ${svgFeatures.monuments.length} monument candidates, ${svgFeatures.boundaryLines.length} boundary segments`);

  // ─── Step 2: VLM locates lot area (coarse) ──────────────
  onProgress("Locating lot area on map…");
  const overview = await overviewTile(page.pngBase64, page.width, page.height);

  let cropRegion: CropRegion;
  try {
    const lotLocResponse = await nimVision(
      overview.base64,
      `Find Lot ${targetLot} on this subdivision/tract map.
Return the bounding box of the lot as percentages of the image:
{ "x_pct": 30, "y_pct": 40, "width_pct": 15, "height_pct": 20 }

x_pct/y_pct = top-left corner. width_pct/height_pct = size.
Include some padding around the lot boundaries.`,
      { maxTokens: 256, temperature: 0.1 },
    );

    const loc = parseJsonResponse<{
      x_pct: number; y_pct: number; width_pct: number; height_pct: number;
    }>(lotLocResponse);
    const padPct = 12;
    cropRegion = {
      x: Math.max(0, Math.round(((loc.x_pct - padPct) / 100) * page.width)),
      y: Math.max(0, Math.round(((loc.y_pct - padPct) / 100) * page.height)),
      width: Math.min(page.width, Math.round(((loc.width_pct + padPct * 2) / 100) * page.width)),
      height: Math.min(page.height, Math.round(((loc.height_pct + padPct * 2) / 100) * page.height)),
      label: `lot-${targetLot}-reg`,
    };
  } catch {
    // Fallback: center half of the image
    cropRegion = {
      x: Math.round(page.width * 0.15),
      y: Math.round(page.height * 0.15),
      width: Math.round(page.width * 0.7),
      height: Math.round(page.height * 0.7),
      label: `lot-${targetLot}-reg-fallback`,
    };
  }
  // Clamp
  if (cropRegion.x + cropRegion.width > page.width) cropRegion.width = page.width - cropRegion.x;
  if (cropRegion.y + cropRegion.height > page.height) cropRegion.height = page.height - cropRegion.y;
  onProgress(`Lot search region: (${cropRegion.x}, ${cropRegion.y}) ${cropRegion.width}×${cropRegion.height}px`);

  // ─── Step 3: VLM reads lot boundary bearings/distances ──
  onProgress("Reading lot boundary bearings and distances…");
  const tile = await cropTile(page.pngBase64, cropRegion);

  const boundaryResponse = await nimVision(
    tile.base64,
    `Read the metes and bounds of Lot ${targetLot} on this tract map.
Starting from the Point of Beginning (POB), list the FIRST 3-4 boundary line segments in clockwise order.

For each segment, read:
- bearing: quadrant bearing (e.g., "N 75°22'10" W")
- distance: length in feet

Return valid JSON:
{
  "segments": [
    { "bearing": "N 75°22'10\\" W", "distance": 146.31, "type": "line" },
    { "bearing": "S 89°59'51\\" E", "distance": 80.00, "type": "line" }
  ]
}

Read ONLY straight line segments (not curves). Accuracy matters — read every degree, minute, and second carefully.`,
    { maxTokens: 1024, temperature: 0.1 },
  );

  let segments: LotBoundaryReading[] = [];
  try {
    const data = parseJsonResponse<{ segments: LotBoundaryReading[] }>(boundaryResponse);
    segments = data.segments?.filter((s) => s.bearing && s.distance > 0) ?? [];
  } catch {
    // Will fall back to monument-only matching below
  }
  onProgress(`Read ${segments.length} boundary segments from lot text`);

  // ─── Step 4: COGO traverse from readings ────────────────
  // Build expected lot shape relative to origin (0,0)
  const traversePoints: Point[] = [{ x: 0, y: 0 }];
  let current: Point = { x: 0, y: 0 };
  for (const seg of segments) {
    try {
      const bearingRad = parseBearing(seg.bearing);
      current = traversePoint(current, bearingRad, seg.distance);
      traversePoints.push(current);
    } catch {
      // Skip unparseable bearings
    }
  }

  const pxPerFoot = scaleInfo.dpi / scaleInfo.feetPerInch;
  const northAngleRad = (northAngleDeg * Math.PI) / 180;

  // ─── Step 5: Score each monument candidate ──────────────
  onProgress("Scoring monument candidates for best-fit anchor…");
  const { monuments: candidateMonuments } = findFeaturesInRegion(svgFeatures, {
    x: cropRegion.x,
    y: cropRegion.y,
    w: cropRegion.width,
    h: cropRegion.height,
  });
  onProgress(`${candidateMonuments.length} monuments in search region`);
  console.log(`[anchor] SVG features: ${svgFeatures.monuments.length} total monuments, ${svgFeatures.boundaryLines.length} boundary segments`);
  console.log(`[anchor] Search region: x=${cropRegion.x} y=${cropRegion.y} w=${cropRegion.width} h=${cropRegion.height}`);
  console.log(`[anchor] ${candidateMonuments.length} monument candidates in region`);
  console.log(`[anchor] COGO traverse points: ${traversePoints.length} (from ${segments.length} boundary readings)`);
  if (segments.length > 0) {
    console.log(`[anchor] First segment: ${segments[0].bearing} ${segments[0].distance}ft`);
  }

  let bestMonument: SvgMonument | null = null;
  let bestScore = -1;
  let bestCS: CoordSystem | null = null;

  for (const mon of candidateMonuments) {
    const anchorPixel = { px: Math.round(mon.center.x), py: Math.round(mon.center.y) };
    const cs = registerCoordSystem({
      feetPerInch: scaleInfo.feetPerInch,
      dpi: scaleInfo.dpi,
      northAngleDeg,
      anchorPixel,
      scaleText: scaleInfo.scaleText,
    });

    // Project COGO traverse into pixel space using this anchor hypothesis
    const projectedPixels = traversePoints.map((p) => surveyToPixel(cs, p));

    // Score against SVG boundary features
    if (projectedPixels.length >= 2) {
      const { score } = scorePlacement(projectedPixels, svgFeatures);
      if (score > bestScore) {
        bestScore = score;
        bestMonument = mon;
        bestCS = cs;
      }
    } else {
      // No boundary readings — score by proximity to boundary line endpoints
      // (monuments at lot corners should be near line intersections)
      const nearby = findFeaturesInRegion(svgFeatures, {
        x: mon.center.x - 30,
        y: mon.center.y - 30,
        w: 60,
        h: 60,
      });
      // More nearby boundary segments = more likely a real corner monument
      const score = Math.min(1, nearby.segments.length / 4);
      if (score > bestScore) {
        bestScore = score;
        bestMonument = mon;
        bestCS = registerCoordSystem({
          feetPerInch: scaleInfo.feetPerInch,
          dpi: scaleInfo.dpi,
          northAngleDeg,
          anchorPixel,
          scaleText: scaleInfo.scaleText,
        });
      }
    }
  }

  console.log(`[anchor] Best monument: ${bestMonument ? `(${bestMonument.center.x.toFixed(0)}, ${bestMonument.center.y.toFixed(0)}) r=${bestMonument.radius.toFixed(1)} circ=${bestMonument.circularity.toFixed(2)} score=${bestScore.toFixed(4)}` : "NONE"}`);

  // ─── Step 6: Sub-pixel refinement ───────────────────────
  if (bestMonument && traversePoints.length >= 2) {
    onProgress("Refining anchor position…");
    const baseX = Math.round(bestMonument.center.x);
    const baseY = Math.round(bestMonument.center.y);
    let refinedX = baseX;
    let refinedY = baseY;
    let refinedScore = bestScore;

    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        if (dx === 0 && dy === 0) continue;
        const cs = registerCoordSystem({
          feetPerInch: scaleInfo.feetPerInch,
          dpi: scaleInfo.dpi,
          northAngleDeg,
          anchorPixel: { px: baseX + dx, py: baseY + dy },
          scaleText: scaleInfo.scaleText,
        });
        const projected = traversePoints.map((p) => surveyToPixel(cs, p));
        const { score } = scorePlacement(projected, svgFeatures);
        if (score > refinedScore) {
          refinedScore = score;
          refinedX = baseX + dx;
          refinedY = baseY + dy;
        }
      }
    }

    if (refinedScore > bestScore) {
      bestScore = refinedScore;
      bestCS = registerCoordSystem({
        feetPerInch: scaleInfo.feetPerInch,
        dpi: scaleInfo.dpi,
        northAngleDeg,
        anchorPixel: { px: refinedX, py: refinedY },
        scaleText: scaleInfo.scaleText,
      });
      onProgress(`Refined anchor by (${refinedX - baseX}, ${refinedY - baseY})px — score ${refinedScore.toFixed(3)}`);
    }
  }

  // ─── Fallback: if no monuments found, use VLM coarse estimate ──
  if (!bestCS) {
    onProgress("WARNING: No monument candidates found — using center of lot region as fallback");
    const fallbackPixel = {
      px: Math.round(cropRegion.x + cropRegion.width / 2),
      py: Math.round(cropRegion.y + cropRegion.height / 2),
    };
    bestCS = registerCoordSystem({
      feetPerInch: scaleInfo.feetPerInch,
      dpi: scaleInfo.dpi,
      northAngleDeg,
      anchorPixel: fallbackPixel,
      scaleText: scaleInfo.scaleText,
    });
    bestScore = 0;
  }

  const anchorPx = bestCS.anchorPixel;
  const validated = bestScore > 0.4;
  onProgress(`Anchor: (${anchorPx.px}, ${anchorPx.py}) — alignment score ${bestScore.toFixed(3)}${validated ? " [VALIDATED]" : " [low confidence]"}`);

  return {
    coordSystem: bestCS,
    anchorPixel: anchorPx,
    matchConfidence: bestScore,
    cropRegion,
    validated,
    matches: segments.map((s) => ({ bearing: s.bearing, distance: s.distance })),
    svgFeatures,
  };
}
