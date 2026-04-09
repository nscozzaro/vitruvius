/**
 * SVG-based Placement Verification — replaces raster pixel overlap scoring.
 *
 * Instead of sampling pixels for ink darkness, we measure the geometric
 * distance between placed elements and actual SVG boundary paths from
 * potrace. This gives precise, sub-pixel alignment scores and can
 * diagnose WHY placement is wrong (offset, angle error, scale error).
 */

import type { SurveyElement } from "./reconstruction-agent";
import type { SvgFeatureMap } from "./svg-features";
import {
  findNearestMonument,
  scorePlacement,
  pointToPolylineDistance,
  findFeaturesInRegion,
} from "./svg-features";
import type { CoordSystem } from "./coord-system";
import { surveyToPixel } from "./coord-system";

// ─── Types ──────────────────────────────────────────────────

export interface VerificationResult {
  /** Alignment score 0–1, exponential decay from SVG distance */
  score: number;
  /** Average distance from placed element to nearest SVG path (pixels) */
  avgDistPx: number;
  /** Max distance from any sample point to nearest SVG path */
  maxDistPx: number;
  /** If score < 0.3, estimated pixel offset to improve alignment */
  estimatedOffset?: { dx: number; dy: number; improvedScore: number };
  /** If score < 0.3, estimated angle error in degrees */
  estimatedAngleError?: { degrees: number; improvedScore: number };
  /** Whether the anchor appears fundamentally wrong (first element far off) */
  anchorFailed: boolean;
  /** Recommend halting extraction */
  haltRecommended: boolean;
}

// ─── Constants ──────────────────────────────────────────────

const LOW_SCORE_THRESHOLD = 0.3;
const ANCHOR_FAIL_THRESHOLD = 0.1;
/** Grid search range for offset diagnosis (pixels) */
const OFFSET_SEARCH_RANGE = 40;
const OFFSET_SEARCH_STEP = 5;

// ─── Main Entry ─────────────────────────────────────────────

/**
 * Verify an element's placement against SVG features.
 */
export function verifyElementPlacement(
  element: SurveyElement,
  features: SvgFeatureMap,
  coordSystem: CoordSystem,
  isFirstElement = false,
  consecutiveLowCount = 0,
): VerificationResult {
  if (element.geometryType === "point") {
    return verifyMonument(element, features, isFirstElement, consecutiveLowCount);
  }
  return verifyLineOrCurve(element, features, coordSystem, isFirstElement, consecutiveLowCount);
}

// ─── Monument Verification ──────────────────────────────────

function verifyMonument(
  element: SurveyElement,
  features: SvgFeatureMap,
  isFirstElement: boolean,
  consecutiveLowCount: number,
): VerificationResult {
  const center = element.pixelPoints[0];
  if (!center) {
    return {
      score: 0, avgDistPx: Infinity, maxDistPx: Infinity,
      anchorFailed: isFirstElement, haltRecommended: consecutiveLowCount >= 2,
    };
  }

  const nearest = findNearestMonument(features, { x: center.px, y: center.py }, 60);

  if (!nearest) {
    return {
      score: 0, avgDistPx: Infinity, maxDistPx: Infinity,
      anchorFailed: isFirstElement, haltRecommended: consecutiveLowCount >= 2,
    };
  }

  const d = Math.sqrt(
    (center.px - nearest.center.x) ** 2 + (center.py - nearest.center.y) ** 2,
  );
  const score = Math.exp(-d / 8); // ~8px decay for monuments (smaller targets)

  const result: VerificationResult = {
    score,
    avgDistPx: d,
    maxDistPx: d,
    anchorFailed: isFirstElement && score < ANCHOR_FAIL_THRESHOLD,
    haltRecommended: consecutiveLowCount >= 2 && score < LOW_SCORE_THRESHOLD,
  };

  // Diagnostic: if score is low, report the offset to the nearest monument
  if (score < LOW_SCORE_THRESHOLD && nearest) {
    result.estimatedOffset = {
      dx: nearest.center.x - center.px,
      dy: nearest.center.y - center.py,
      improvedScore: 1.0, // snapping to the monument would be perfect
    };
  }

  return result;
}

// ─── Line / Curve Verification ──────────────────────────────

function verifyLineOrCurve(
  element: SurveyElement,
  features: SvgFeatureMap,
  coordSystem: CoordSystem,
  isFirstElement: boolean,
  consecutiveLowCount: number,
): VerificationResult {
  if (element.pixelPoints.length < 2) {
    return {
      score: 0, avgDistPx: Infinity, maxDistPx: Infinity,
      anchorFailed: isFirstElement, haltRecommended: consecutiveLowCount >= 2,
    };
  }

  const placement = scorePlacement(element.pixelPoints, features);

  const result: VerificationResult = {
    score: placement.score,
    avgDistPx: placement.avgDistPx,
    maxDistPx: placement.maxDistPx,
    anchorFailed: isFirstElement && placement.score < ANCHOR_FAIL_THRESHOLD,
    haltRecommended: consecutiveLowCount >= 2 && placement.score < LOW_SCORE_THRESHOLD,
  };

  // Diagnostic: if score is low, try offset grid search
  if (placement.score < LOW_SCORE_THRESHOLD) {
    const offset = diagnoseOffset(element.pixelPoints, features);
    if (offset && offset.improvedScore > placement.score + 0.15) {
      result.estimatedOffset = offset;
    }
  }

  return result;
}

// ─── Diagnostic: Offset Detection ───────────────────────────

/**
 * Grid search for a pixel offset that improves alignment.
 * If found, this indicates the anchor is displaced by a constant amount.
 */
function diagnoseOffset(
  pixelPoints: Array<{ px: number; py: number }>,
  features: SvgFeatureMap,
): { dx: number; dy: number; improvedScore: number } | null {
  let bestDx = 0;
  let bestDy = 0;
  let bestScore = 0;

  for (let dx = -OFFSET_SEARCH_RANGE; dx <= OFFSET_SEARCH_RANGE; dx += OFFSET_SEARCH_STEP) {
    for (let dy = -OFFSET_SEARCH_RANGE; dy <= OFFSET_SEARCH_RANGE; dy += OFFSET_SEARCH_STEP) {
      if (dx === 0 && dy === 0) continue;

      const shifted = pixelPoints.map((p) => ({ px: p.px + dx, py: p.py + dy }));
      const result = scorePlacement(shifted, features);

      if (result.score > bestScore) {
        bestScore = result.score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  if (bestScore > 0.3) {
    // Refine with smaller steps around the best
    for (let dx = bestDx - OFFSET_SEARCH_STEP; dx <= bestDx + OFFSET_SEARCH_STEP; dx++) {
      for (let dy = bestDy - OFFSET_SEARCH_STEP; dy <= bestDy + OFFSET_SEARCH_STEP; dy++) {
        const shifted = pixelPoints.map((p) => ({ px: p.px + dx, py: p.py + dy }));
        const result = scorePlacement(shifted, features);
        if (result.score > bestScore) {
          bestScore = result.score;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }

    return { dx: bestDx, dy: bestDy, improvedScore: bestScore };
  }

  return null;
}
