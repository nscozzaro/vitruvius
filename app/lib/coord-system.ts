/**
 * Coordinate System — pixel ↔ survey-feet transforms.
 *
 * All parameters are discovered by the agent from the map itself
 * (scale annotation, north arrow, anchor monument). Nothing is hardcoded.
 *
 * Convention:
 * - Survey: x = easting (feet), y = northing (feet), origin at anchor monument
 * - Image:  px = pixels from left, py = pixels from top, origin at top-left
 * - North angle θ: clockwise rotation of image "up" relative to true north
 *   (0 = north is straight up in the image)
 */

import type { Point } from "./cogo";

export interface CoordSystem {
  /** Anchor monument pixel location in the full-resolution image */
  anchorPixel: { px: number; py: number };
  /** Survey-feet coordinates of the anchor (usually 0,0) */
  anchorSurvey: Point;
  /** Pixels per foot — derived from DPI / feetPerInch */
  pxPerFoot: number;
  /** North angle in radians (clockwise from image "up" to true north) */
  northAngleRad: number;
  /** Original scale text discovered from the map, e.g., '1"=30'' */
  scaleText: string;
  /** Rendering DPI used to produce the image */
  dpi: number;
  /** Feet per inch as read from the map scale */
  feetPerInch: number;
}

/**
 * Build a CoordSystem from discovered map parameters.
 */
export function registerCoordSystem(opts: {
  feetPerInch: number;
  dpi: number;
  northAngleDeg: number;
  anchorPixel: { px: number; py: number };
  anchorSurvey?: Point;
  scaleText?: string;
}): CoordSystem {
  const pxPerFoot = opts.dpi / opts.feetPerInch;
  return {
    anchorPixel: opts.anchorPixel,
    anchorSurvey: opts.anchorSurvey ?? { x: 0, y: 0 },
    pxPerFoot,
    northAngleRad: (opts.northAngleDeg * Math.PI) / 180,
    scaleText: opts.scaleText ?? `1"=${opts.feetPerInch}'`,
    dpi: opts.dpi,
    feetPerInch: opts.feetPerInch,
  };
}

/**
 * Convert survey coordinates (feet) to image pixel coordinates.
 *
 * Math:
 *   dx_survey = point.x - anchor.x   (easting offset in feet)
 *   dy_survey = point.y - anchor.y   (northing offset in feet)
 *   Rotate by north angle θ (clockwise) and scale:
 *     px = anchor.px + (dx * cos(θ) + dy * sin(θ)) * pxPerFoot
 *     py = anchor.py - (-dx * sin(θ) + dy * cos(θ)) * pxPerFoot
 *   (py subtracts because image Y grows downward, northing grows upward)
 */
export function surveyToPixel(
  cs: CoordSystem,
  point: Point,
): { px: number; py: number } {
  const dx = point.x - cs.anchorSurvey.x;
  const dy = point.y - cs.anchorSurvey.y;
  const cosT = Math.cos(cs.northAngleRad);
  const sinT = Math.sin(cs.northAngleRad);

  return {
    px: cs.anchorPixel.px + (dx * cosT + dy * sinT) * cs.pxPerFoot,
    py: cs.anchorPixel.py - (-dx * sinT + dy * cosT) * cs.pxPerFoot,
  };
}

/**
 * Convert image pixel coordinates to survey coordinates (feet).
 * Inverse of surveyToPixel.
 */
export function pixelToSurvey(
  cs: CoordSystem,
  pixel: { px: number; py: number },
): Point {
  const dpx = pixel.px - cs.anchorPixel.px;
  // Negate dpy because image Y is inverted relative to northing
  const dpy = -(pixel.py - cs.anchorPixel.py);
  const cosT = Math.cos(cs.northAngleRad);
  const sinT = Math.sin(cs.northAngleRad);

  // Inverse rotation: rotate by -θ
  return {
    x: cs.anchorSurvey.x + (dpx * cosT - dpy * sinT) / cs.pxPerFoot,
    y: cs.anchorSurvey.y + (dpx * sinT + dpy * cosT) / cs.pxPerFoot,
  };
}

/**
 * Convert a bearing (azimuth in radians, clockwise from true north)
 * to an image angle (radians, clockwise from image "up").
 *
 * This is needed to orient crop regions along the expected line direction.
 */
export function bearingToImageAngle(
  cs: CoordSystem,
  bearingRad: number,
): number {
  return bearingRad + cs.northAngleRad;
}

/**
 * Convert a survey distance (feet) to pixels.
 */
export function feetToPixels(cs: CoordSystem, feet: number): number {
  return feet * cs.pxPerFoot;
}

/**
 * Convert pixels to survey distance (feet).
 */
export function pixelsToFeet(cs: CoordSystem, pixels: number): number {
  return pixels / cs.pxPerFoot;
}
