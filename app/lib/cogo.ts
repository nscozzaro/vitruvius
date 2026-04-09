/**
 * COGO (Coordinate Geometry) Engine.
 *
 * Pure TypeScript math for survey computations:
 * - Quadrant bearing parsing → azimuth
 * - Traverse point computation (bearing + distance → next point)
 * - Arc/curve computation (radius, delta, arc length → points)
 * - Traverse closure error
 * - Bowditch (Compass Rule) adjustment
 */

export interface Point {
  x: number; // Easting (feet)
  y: number; // Northing (feet)
}

export interface TraverseLeg {
  bearing: number; // Azimuth in radians (clockwise from north)
  distance: number; // Feet
  type: "line" | "curve";
  // Curve-specific
  radius?: number;
  delta?: number; // Central angle in radians
  arcLength?: number;
  direction?: "LEFT" | "RIGHT";
}

export interface ClosureResult {
  error: number; // Linear misclosure in feet
  bearing: number; // Direction of misclosure (azimuth radians)
  ratio: string; // e.g., "1:15000"
  latError: number; // Northing error
  depError: number; // Easting error
}

// ─── Bearing Parsing ──────────────────────────────────────────

/**
 * Parse a quadrant bearing string into azimuth (radians, clockwise from north).
 *
 * Formats:
 *   "N 75°22'10\" W"  → azimuth
 *   "S 82°55'25\" E"  → azimuth
 *   "N75°22'10\"W"    → azimuth (no spaces)
 */
export function parseBearing(bearing: string): number {
  // Handle cardinal directions
  const cardinal = bearing.trim().toUpperCase();
  if (cardinal === "NORTH" || cardinal === "N") return 0;
  if (cardinal === "EAST" || cardinal === "E") return Math.PI / 2;
  if (cardinal === "SOUTH" || cardinal === "S") return Math.PI;
  if (cardinal === "WEST" || cardinal === "W") return (3 * Math.PI) / 2;
  if (cardinal === "NORTHEAST" || cardinal === "NE") return Math.PI / 4;
  if (cardinal === "SOUTHEAST" || cardinal === "SE") return (3 * Math.PI) / 4;
  if (cardinal === "SOUTHWEST" || cardinal === "SW") return (5 * Math.PI) / 4;
  if (cardinal === "NORTHWEST" || cardinal === "NW") return (7 * Math.PI) / 4;

  const re =
    /([NS])\s*(\d+)[°]\s*(\d+)[''′]\s*(\d+(?:\.\d+)?)[""″]?\s*([EW])/i;
  const m = bearing.match(re);
  if (!m) throw new Error(`Cannot parse bearing: "${bearing}"`);

  const ns = m[1].toUpperCase();
  const deg = parseInt(m[2], 10);
  const min = parseInt(m[3], 10);
  const sec = parseFloat(m[4]);
  const ew = m[5].toUpperCase();

  // Convert DMS to decimal degrees
  const angle = deg + min / 60 + sec / 3600;

  // Convert quadrant bearing to azimuth (clockwise from north)
  let azimuth: number;
  if (ns === "N" && ew === "E") {
    azimuth = angle;
  } else if (ns === "S" && ew === "E") {
    azimuth = 180 - angle;
  } else if (ns === "S" && ew === "W") {
    azimuth = 180 + angle;
  } else {
    // N-W
    azimuth = 360 - angle;
  }

  return (azimuth * Math.PI) / 180;
}

/**
 * Convert azimuth (radians) back to quadrant bearing string.
 */
export function formatBearing(azimuthRad: number): string {
  let azDeg = ((azimuthRad * 180) / Math.PI) % 360;
  if (azDeg < 0) azDeg += 360;

  let ns: string, ew: string, angle: number;
  if (azDeg <= 90) {
    ns = "N";
    ew = "E";
    angle = azDeg;
  } else if (azDeg <= 180) {
    ns = "S";
    ew = "E";
    angle = 180 - azDeg;
  } else if (azDeg <= 270) {
    ns = "S";
    ew = "W";
    angle = azDeg - 180;
  } else {
    ns = "N";
    ew = "W";
    angle = 360 - azDeg;
  }

  const deg = Math.floor(angle);
  const minFloat = (angle - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;

  return `${ns} ${deg}°${String(min).padStart(2, "0")}'${sec.toFixed(2).padStart(5, "0")}" ${ew}`;
}

// ─── Traverse Computation ─────────────────────────────────────

/**
 * Compute the next point given a starting point, bearing, and distance.
 * Bearing is azimuth in radians (clockwise from north).
 */
export function traversePoint(
  start: Point,
  bearing: number,
  distance: number,
): Point {
  // Latitude (northing) = distance * cos(azimuth)
  // Departure (easting) = distance * sin(azimuth)
  return {
    x: start.x + distance * Math.sin(bearing),
    y: start.y + distance * Math.cos(bearing),
  };
}

/**
 * Compute a full traverse from a starting point and sequence of legs.
 * Returns all computed points (including the starting point).
 */
export function computeTraverse(
  start: Point,
  legs: TraverseLeg[],
): Point[] {
  const points: Point[] = [start];
  let current = start;

  for (const leg of legs) {
    if (leg.type === "line") {
      current = traversePoint(current, leg.bearing, leg.distance);
      points.push(current);
    } else if (leg.type === "curve") {
      const curvePoints = computeCurvePoints(current, leg);
      // Skip the first point (it's the current point)
      for (let i = 1; i < curvePoints.length; i++) {
        points.push(curvePoints[i]);
      }
      current = curvePoints[curvePoints.length - 1];
    }
  }

  return points;
}

// ─── Curve Computation ────────────────────────────────────────

/**
 * Compute points along a circular arc.
 *
 * Given a starting point, radius, delta (central) angle, and
 * the incoming tangent bearing, produces points along the arc.
 *
 * The direction ("LEFT" or "RIGHT") indicates which side of
 * the chord the curve bows toward.
 */
export function computeCurvePoints(
  start: Point,
  leg: TraverseLeg,
  numSegments = 32,
): Point[] {
  if (!leg.radius || !leg.delta || !leg.direction) {
    throw new Error("Curve leg missing radius, delta, or direction");
  }

  const R = leg.radius;
  const delta = leg.delta; // Central angle in radians
  const dir = leg.direction === "LEFT" ? -1 : 1;
  const incomingBearing = leg.bearing;

  // Center of the curve is perpendicular to the incoming tangent
  const toCenterBearing = incomingBearing + (dir * Math.PI) / 2;
  const center: Point = {
    x: start.x + R * Math.sin(toCenterBearing),
    y: start.y + R * Math.cos(toCenterBearing),
  };

  // Start angle (from center to start point)
  const startAngle = Math.atan2(start.x - center.x, start.y - center.y);

  const points: Point[] = [start];
  for (let i = 1; i <= numSegments; i++) {
    const t = i / numSegments;
    const angle = startAngle - dir * delta * t;
    points.push({
      x: center.x + R * Math.sin(angle),
      y: center.y + R * Math.cos(angle),
    });
  }

  return points;
}

/**
 * Compute chord length from radius and delta angle.
 */
export function chordLength(radius: number, deltaRad: number): number {
  return 2 * radius * Math.sin(deltaRad / 2);
}

/**
 * Compute arc length from radius and delta angle.
 */
export function arcLength(radius: number, deltaRad: number): number {
  return radius * Math.abs(deltaRad);
}

/**
 * Compute tangent length from radius and delta angle.
 */
export function tangentLength(radius: number, deltaRad: number): number {
  return radius * Math.tan(deltaRad / 2);
}

// ─── Closure & Adjustment ─────────────────────────────────────

/**
 * Compute the closure error of a traverse.
 * The traverse should return to its starting point; the error is the gap.
 */
export function closureError(points: Point[]): ClosureResult {
  if (points.length < 3) {
    return { error: 0, bearing: 0, ratio: "N/A", latError: 0, depError: 0 };
  }

  const first = points[0];
  const last = points[points.length - 1];

  const latError = last.y - first.y; // Northing error
  const depError = last.x - first.x; // Easting error
  const error = Math.sqrt(latError * latError + depError * depError);
  const bearing = Math.atan2(depError, latError);

  // Total traverse length
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    totalLength += Math.sqrt(dx * dx + dy * dy);
  }

  const ratioNum = error > 0 ? Math.round(totalLength / error) : Infinity;
  const ratio = ratioNum === Infinity ? "perfect" : `1:${ratioNum}`;

  return { error, bearing, ratio, latError, depError };
}

/**
 * Bowditch (Compass Rule) adjustment.
 *
 * Distributes the closure error proportionally by leg length.
 * Returns adjusted points.
 *
 * Formula:
 *   correction_lat_i = -(total_lat_error) × (leg_i_length / total_length)
 *   correction_dep_i = -(total_dep_error) × (leg_i_length / total_length)
 */
export function bowditchAdjust(points: Point[]): Point[] {
  if (points.length < 3) return [...points];

  const closure = closureError(points);
  if (closure.error < 1e-10) return [...points];

  // Compute leg lengths
  const legLengths: number[] = [];
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    legLengths.push(len);
    totalLength += len;
  }

  // Apply corrections
  const adjusted: Point[] = [{ ...points[0] }];
  let cumLength = 0;

  for (let i = 1; i < points.length; i++) {
    cumLength += legLengths[i - 1];
    const proportion = cumLength / totalLength;
    adjusted.push({
      x: points[i].x - closure.depError * proportion,
      y: points[i].y - closure.latError * proportion,
    });
  }

  return adjusted;
}

// ─── Utilities ────────────────────────────────────────────────

/**
 * Distance between two points.
 */
export function distance(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Inverse computation: given two points, return bearing and distance.
 */
export function inverse(
  from: Point,
  to: Point,
): { bearing: number; distance: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let bearing = Math.atan2(dx, dy);
  if (bearing < 0) bearing += 2 * Math.PI;
  return {
    bearing,
    distance: Math.sqrt(dx * dx + dy * dy),
  };
}

/**
 * Parse DMS string like "37°39'31\"" into radians.
 */
export function parseDMS(dms: string): number {
  const re = /(\d+)[°]\s*(\d+)[''′]\s*(\d+(?:\.\d+)?)[""″]?/;
  const m = dms.match(re);
  if (!m) throw new Error(`Cannot parse DMS: "${dms}"`);
  const deg = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = parseFloat(m[3]);
  return ((deg + min / 60 + sec / 3600) * Math.PI) / 180;
}
