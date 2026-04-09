/**
 * Surveying Language DSL Parser.
 *
 * Parses the strict DSL that the LLM agent outputs for metes & bounds:
 *   <LINE | bearing | distance>
 *   <CURVE | radius | delta_angle | arc_length | direction>
 *   <MONUMENT | type | description>
 *
 * Converts DSL strokes into COGO TraverseLeg objects for computation.
 */

import { parseBearing, parseDMS, type TraverseLeg } from "./cogo";

// ─── DSL Types ────────────────────────────────────────────────

export interface DslLine {
  kind: "LINE";
  bearing: string; // Raw bearing string, e.g., "N 75°22'10\" W"
  distance: number; // Feet
}

export interface DslCurve {
  kind: "CURVE";
  radius: number; // Feet
  delta: string; // DMS angle string
  arcLength: number; // Feet
  direction: "LEFT" | "RIGHT";
}

export interface DslMonument {
  kind: "MONUMENT";
  type: string; // e.g., "found_1in_ip", "set_1in_ip"
  description: string;
}

export type DslStroke = DslLine | DslCurve | DslMonument;

export interface BoundarySequenceItem {
  semantic_meaning: string;
  stroke: string; // Raw DSL string
  confidence?: number;
}

export interface LotExtraction {
  lot: string;
  tract: string;
  point_of_beginning: string;
  boundary_sequence: BoundarySequenceItem[];
}

// ─── Parsing ──────────────────────────────────────────────────

/**
 * Parse a single DSL stroke string into a typed object.
 *
 * Examples:
 *   '<LINE | N 75°22\'10" W | 146.31>'
 *   '<CURVE | 628.00 | 7°33\'15" | 82.78 | LEFT>'
 *   '<MONUMENT | found_1in_ip | Found 1" iron pipe at NE corner>'
 */
export function parseStroke(raw: string): DslStroke {
  // Strip angle brackets and whitespace
  const inner = raw.replace(/^<\s*/, "").replace(/\s*>$/, "");
  const parts = inner.split(/\s*\|\s*/);

  const kind = parts[0]?.toUpperCase().trim();

  if (kind === "LINE") {
    if (parts.length < 3) throw new Error(`LINE needs 3 parts: ${raw}`);
    return {
      kind: "LINE",
      bearing: parts[1].trim(),
      distance: parseFloat(parts[2].trim()),
    };
  }

  if (kind === "CURVE") {
    if (parts.length < 5) throw new Error(`CURVE needs 5 parts: ${raw}`);
    const dir = parts[4].trim().toUpperCase();
    if (dir !== "LEFT" && dir !== "RIGHT") {
      throw new Error(`CURVE direction must be LEFT or RIGHT: ${raw}`);
    }
    return {
      kind: "CURVE",
      radius: parseFloat(parts[1].trim()),
      delta: parts[2].trim(),
      arcLength: parseFloat(parts[3].trim()),
      direction: dir,
    };
  }

  if (kind === "MONUMENT") {
    return {
      kind: "MONUMENT",
      type: parts[1]?.trim() ?? "unknown",
      description: parts[2]?.trim() ?? "",
    };
  }

  throw new Error(`Unknown DSL stroke kind "${kind}": ${raw}`);
}

/**
 * Parse all strokes in a lot extraction's boundary sequence.
 */
export function parseBoundarySequence(
  items: BoundarySequenceItem[],
): DslStroke[] {
  return items.map((item) => parseStroke(item.stroke));
}

// ─── Conversion to COGO Legs ──────────────────────────────────

/**
 * Convert a DslLine stroke into a COGO TraverseLeg.
 */
function lineToLeg(line: DslLine): TraverseLeg {
  return {
    type: "line",
    bearing: parseBearing(line.bearing),
    distance: line.distance,
  };
}

/**
 * Convert a DslCurve stroke into a COGO TraverseLeg.
 *
 * The bearing for the curve is the tangent bearing at the point of curvature.
 * Since we don't know it from the DSL alone, it's derived from the
 * previous leg's ending bearing (the tangent is continuous).
 */
function curveToLeg(
  curve: DslCurve,
  previousBearing: number,
): TraverseLeg {
  return {
    type: "curve",
    bearing: previousBearing, // Incoming tangent bearing
    distance: curve.arcLength,
    radius: curve.radius,
    delta: parseDMS(curve.delta),
    arcLength: curve.arcLength,
    direction: curve.direction,
  };
}

/**
 * Convert a full boundary sequence of DSL strokes into COGO TraverseLegs.
 * Monuments are skipped (they don't contribute to geometry).
 * Curve tangent bearings are derived from the previous leg.
 */
export function strokesToLegs(strokes: DslStroke[]): TraverseLeg[] {
  const legs: TraverseLeg[] = [];
  let lastBearing = 0;

  for (const stroke of strokes) {
    if (stroke.kind === "LINE") {
      const leg = lineToLeg(stroke);
      lastBearing = leg.bearing;
      legs.push(leg);
    } else if (stroke.kind === "CURVE") {
      const leg = curveToLeg(stroke, lastBearing);
      // Update lastBearing: outgoing tangent = incoming + delta * direction
      const dir = stroke.direction === "LEFT" ? -1 : 1;
      lastBearing = lastBearing - dir * parseDMS(stroke.delta);
      legs.push(leg);
    }
    // MONUMENT strokes are informational only — no geometry
  }

  return legs;
}

/**
 * Extract all lot extractions from the agent's JSON response.
 * Handles both single-lot and multi-lot responses.
 */
export function parseLotExtractions(
  response: unknown,
): LotExtraction[] {
  if (Array.isArray(response)) return response as LotExtraction[];
  if (
    typeof response === "object" &&
    response !== null &&
    "lots" in response
  ) {
    return (response as { lots: LotExtraction[] }).lots;
  }
  if (
    typeof response === "object" &&
    response !== null &&
    "lot" in response
  ) {
    return [response as LotExtraction];
  }
  throw new Error("Cannot parse lot extractions from agent response");
}
