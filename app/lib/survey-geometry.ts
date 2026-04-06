/**
 * Survey geometry engine — compute lot boundaries from metes and bounds.
 *
 * Converts surveyor's bearings/distances/curves into XY coordinates.
 * Coordinate system: local feet, +X = East, +Y = North.
 */

const DEG = Math.PI / 180;

/** A straight line segment defined by bearing and distance. */
export interface LineSurveyCall {
  type: "line";
  bearing: string; // e.g., "N 75°22'10\" W"
  distance_ft: number;
}

/** A curve segment defined by radius, arc length, and delta angle. */
export interface CurveSurveyCall {
  type: "curve";
  radius_ft: number;
  arc_length_ft?: number;
  delta?: string; // e.g., "7°33'10\""
  direction: "left" | "right"; // which side the center is on
}

export type SurveyCall = LineSurveyCall | CurveSurveyCall;

export interface Point {
  x: number;
  y: number;
}

export interface TraversedSegment {
  start: Point;
  end: Point;
  call: SurveyCall;
  midpoint: Point;
  length_ft: number;
  // For arcs
  center?: Point;
  radius_ft?: number;
  startAngle?: number;
  endAngle?: number;
}

/**
 * Parse a surveyor's bearing string to an azimuth in radians.
 *
 * Input: "N 75°22'10\" W" or "N 75 22 10 W" or "S43°00'E"
 * Output: azimuth from North, clockwise, in radians
 *
 * Convention:
 *   N 0° E  → 0          (due north)
 *   N 90° E → π/2        (due east)
 *   S 0° E  → π          (due south)
 *   N 90° W → 3π/2       (due west)
 */
export function parseBearing(s: string): number | null {
  const match = s.match(
    /([NS])\s*(\d+)\s*[°\s]+(\d+)\s*['\s]*(\d+(?:\.\d+)?)\s*["\s]*([EW])/i,
  );
  if (!match) {
    // Try simpler format: "N75°22'W" without seconds
    const simple = s.match(/([NS])\s*(\d+)\s*[°\s]+(\d+)\s*['\s]*([EW])/i);
    if (!simple) return null;
    const [, ns, d, m, ew] = simple;
    const degrees = parseInt(d) + parseInt(m) / 60;
    return bearingToAzimuth(ns, degrees, ew);
  }
  const [, ns, d, m, sec, ew] = match;
  const degrees = parseInt(d) + parseInt(m) / 60 + parseFloat(sec) / 3600;
  return bearingToAzimuth(ns, degrees, ew);
}

function bearingToAzimuth(ns: string, degrees: number, ew: string): number {
  // Convert quadrant bearing to azimuth (clockwise from north)
  if (ns.toUpperCase() === "N" && ew.toUpperCase() === "E")
    return degrees * DEG;
  if (ns.toUpperCase() === "N" && ew.toUpperCase() === "W")
    return (360 - degrees) * DEG;
  if (ns.toUpperCase() === "S" && ew.toUpperCase() === "E")
    return (180 - degrees) * DEG;
  // S + W
  return (180 + degrees) * DEG;
}

/**
 * Parse a delta angle string like "7°33'10\"" to radians.
 */
export function parseDelta(s: string): number | null {
  const match = s.match(/(\d+)\s*[°\s]+(\d+)\s*['\s]*(\d+(?:\.\d+)?)?/);
  if (!match) return null;
  const degrees =
    parseInt(match[1]) +
    parseInt(match[2]) / 60 +
    (match[3] ? parseFloat(match[3]) / 3600 : 0);
  return degrees * DEG;
}

/**
 * Traverse a sequence of survey calls, computing XY coordinates.
 *
 * Starts at `start` and follows each call in order.
 * Returns an array of traversed segments with computed geometry.
 */
export function traverseSurveyCalls(
  calls: SurveyCall[],
  start: Point = { x: 0, y: 0 },
  initialAzimuth?: number,
): TraversedSegment[] {
  const segments: TraversedSegment[] = [];
  let current = { ...start };
  let lastAzimuth = initialAzimuth ?? 0;

  for (const call of calls) {
    if (call.type === "line") {
      const az = parseBearing(call.bearing);
      if (az === null) continue;
      lastAzimuth = az;

      const dx = Math.sin(az) * call.distance_ft;
      const dy = Math.cos(az) * call.distance_ft;
      const end = { x: current.x + dx, y: current.y + dy };

      segments.push({
        start: { ...current },
        end,
        call,
        midpoint: { x: (current.x + end.x) / 2, y: (current.y + end.y) / 2 },
        length_ft: call.distance_ft,
      });

      current = end;
    } else if (call.type === "curve") {
      const delta = call.delta ? parseDelta(call.delta) : null;
      const R = call.radius_ft;

      let deltaAngle: number;
      if (delta) {
        deltaAngle = delta;
      } else if (call.arc_length_ft) {
        deltaAngle = call.arc_length_ft / R;
      } else {
        continue;
      }

      // Compute arc center based on direction
      const perpOffset = call.direction === "left" ? -Math.PI / 2 : Math.PI / 2;
      const toCenterAz = lastAzimuth + perpOffset;
      const center = {
        x: current.x + Math.sin(toCenterAz) * R,
        y: current.y + Math.cos(toCenterAz) * R,
      };

      // Start angle (from center to current point)
      const startAngle = Math.atan2(
        current.x - center.x,
        current.y - center.y,
      );

      // End angle
      const sign = call.direction === "left" ? 1 : -1;
      const endAngle = startAngle + sign * deltaAngle;

      // End point
      const end = {
        x: center.x + Math.sin(endAngle) * R,
        y: center.y + Math.cos(endAngle) * R,
      };

      // Midpoint on arc
      const midAngle = (startAngle + endAngle) / 2;
      const midpoint = {
        x: center.x + Math.sin(midAngle) * R,
        y: center.y + Math.cos(midAngle) * R,
      };

      const arcLength = call.arc_length_ft ?? R * Math.abs(deltaAngle);

      segments.push({
        start: { ...current },
        end,
        call,
        midpoint,
        length_ft: arcLength,
        center,
        radius_ft: R,
        startAngle,
        endAngle,
      });

      // Update last azimuth to tangent at end of arc
      lastAzimuth = lastAzimuth + sign * deltaAngle;
      current = end;
    }
  }

  return segments;
}

/**
 * Compute the closure error — distance between the last point and the start.
 */
export function closureError(segments: TraversedSegment[]): number {
  if (segments.length === 0) return 0;
  const first = segments[0].start;
  const last = segments[segments.length - 1].end;
  return Math.sqrt((last.x - first.x) ** 2 + (last.y - first.y) ** 2);
}

/**
 * Format an azimuth back to a bearing string.
 */
export function azimuthToBearing(azimuth: number): string {
  let az = ((azimuth / DEG) % 360 + 360) % 360;
  let ns: string, ew: string, angle: number;

  if (az <= 90) {
    ns = "N"; ew = "E"; angle = az;
  } else if (az <= 180) {
    ns = "S"; ew = "E"; angle = 180 - az;
  } else if (az <= 270) {
    ns = "S"; ew = "W"; angle = az - 180;
  } else {
    ns = "N"; ew = "W"; angle = 360 - az;
  }

  const d = Math.floor(angle);
  const mFloat = (angle - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60);

  return `${ns} ${d}°${m.toString().padStart(2, "0")}'${s.toString().padStart(2, "0")}" ${ew}`;
}
