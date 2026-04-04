import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/compute_lot_boundary
 *
 * Computes a precise lot boundary from survey data (bearings, distances, curves).
 * The survey data is the source of truth — the polygon is computed from
 * the surveyor's measurements, not from GIS approximations.
 *
 * For a cul-de-sac radial lot:
 * - Two side lines defined by bearings and distances (radial lines from cul-de-sac center)
 * - Front edge is an arc along the street
 * - Back edge connects the far ends of the side lines
 */

const FT_TO_M = 0.3048;
const DEG = Math.PI / 180;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { surveyData, geocoded } = body;

    if (!geocoded) {
      return NextResponse.json({ error: "Missing geocoded data" }, { status: 400 });
    }

    // If we have full survey data with bearings, compute from scratch
    if (surveyData?.boundaries?.length > 0) {
      const result = computeFromSurveyBearings(surveyData, geocoded);
      return NextResponse.json(result);
    }

    return NextResponse.json({
      computedParcel: null,
      notes: "No survey data available — using GIS parcel as-is",
    });
  } catch (error) {
    console.error("Lot boundary error:", error);
    return NextResponse.json({ error: "Computation failed" }, { status: 500 });
  }
}

function computeFromSurveyBearings(
  surveyData: {
    boundaries: Array<{
      side: string;
      bearing?: string;
      distance_ft?: number;
      radius_ft?: number;
      arc_ft?: number;
      delta?: string;
      type: string;
    }>;
    adjacent_streets?: Array<{ name: string; width_ft: number }>;
    easements?: Array<{ width_ft: number; side: string; purpose: string }>;
  },
  geocoded: { latitude: number; longitude: number }
) {
  // Extract survey measurements
  const eastBoundary = surveyData.boundaries.find(b => b.side === "east");
  const westBoundary = surveyData.boundaries.find(b => b.side === "west");
  const arcBoundary = surveyData.boundaries.find(b => b.type === "curve");

  if (!eastBoundary?.bearing || !westBoundary?.bearing || !eastBoundary?.distance_ft) {
    return { computedParcel: null, notes: "Incomplete survey data — need both side bearings and distances" };
  }

  const depth = (eastBoundary.distance_ft || 146.31) * FT_TO_M;
  const arcLen = (arcBoundary?.arc_ft || 82.78) * FT_TO_M;
  const R = (arcBoundary?.radius_ft || 628) * FT_TO_M;

  // Parse bearings to azimuths
  const eastAz = parseBearing(eastBoundary.bearing);
  const westAz = parseBearing(westBoundary.bearing);

  if (eastAz === null || westAz === null) {
    return { computedParcel: null, notes: "Could not parse bearing format" };
  }

  // Average direction: front-to-back along the lot
  const avgAz = (eastAz + westAz) / 2;

  // Front midpoint: go from geocoded point toward the FRONT (reverse of avg bearing)
  const frontDir = avgAz + Math.PI; // reverse direction = toward street
  const halfDepth = depth / 2;

  const frontMidX = Math.sin(frontDir) * halfDepth;
  const frontMidY = Math.cos(frontDir) * halfDepth;

  // Arc chord = straight-line distance between front corners
  // For small delta angles, chord ≈ arc length
  const delta = arcBoundary?.delta ? parseDelta(arcBoundary.delta) : (arcLen / R);
  const chord = 2 * R * Math.sin(delta / 2);

  // Perpendicular to the front-back direction
  const perpAz = avgAz + Math.PI / 2;
  const halfChord = chord / 2;

  // Front corners
  const feX = frontMidX + Math.sin(perpAz) * halfChord;
  const feY = frontMidY + Math.cos(perpAz) * halfChord;
  const fwX = frontMidX - Math.sin(perpAz) * halfChord;
  const fwY = frontMidY - Math.cos(perpAz) * halfChord;

  // Back corners: follow side lines from front corners
  const beX = feX + Math.sin(eastAz) * depth;
  const beY = feY + Math.cos(eastAz) * depth;
  const bwX = fwX + Math.sin(westAz) * depth;
  const bwY = fwY + Math.cos(westAz) * depth;

  // Convert meter offsets to lat/lon
  const cosLat = Math.cos(geocoded.latitude * DEG);
  const toLL = (dx: number, dy: number) => ({
    lat: Number((geocoded.latitude + dy / 110540).toFixed(7)),
    lon: Number((geocoded.longitude + dx / (111320 * cosLat)).toFixed(7)),
  });

  const computedParcel = [
    toLL(feX, feY),   // Front-East
    toLL(fwX, fwY),   // Front-West
    toLL(bwX, bwY),   // Back-West
    toLL(beX, beY),   // Back-East
  ];

  // Compute dimensions for display
  const frontW = Math.sqrt((feX - fwX) ** 2 + (feY - fwY) ** 2);
  const backW = Math.sqrt((beX - bwX) ** 2 + (beY - bwY) ** 2);

  const notes = [
    `Computed from Tract survey: ${(depth / FT_TO_M).toFixed(1)}ft depth × ${(frontW / FT_TO_M).toFixed(1)}ft front × ${(backW / FT_TO_M).toFixed(1)}ft back`,
    `East side: ${eastBoundary.bearing}, ${eastBoundary.distance_ft}ft`,
    `West side: ${westBoundary.bearing}, ${westBoundary.distance_ft || eastBoundary.distance_ft}ft`,
    `Street arc: ${(arcLen / FT_TO_M).toFixed(1)}ft, R=${(R / FT_TO_M).toFixed(0)}ft`,
  ];

  for (const e of surveyData.easements || []) {
    notes.push(`Easement: ${e.width_ft}ft ${e.purpose} on ${e.side}`);
  }

  return {
    computedParcel,
    frontWidth_ft: frontW / FT_TO_M,
    backWidth_ft: backW / FT_TO_M,
    depth_ft: depth / FT_TO_M,
    notes: notes.join("\n"),
  };
}

function parseBearing(s: string): number | null {
  // Parse formats like "N 75 22 10 W" or "N 75°22'10\" W"
  const match = s.match(/([NS])\s*(\d+)\s*[°\s]*(\d+)\s*['\s]*(\d+)\s*["\s]*([EW])/i);
  if (!match) return null;
  const [, ns, d, m, sec, ew] = match;
  let degrees = parseInt(d) + parseInt(m) / 60 + parseInt(sec) / 3600;
  if (ns === "N" && ew === "E") return degrees * DEG;
  if (ns === "N" && ew === "W") return (360 - degrees) * DEG;
  if (ns === "S" && ew === "E") return (180 - degrees) * DEG;
  return (180 + degrees) * DEG;
}

function parseDelta(s: string): number {
  const match = s.match(/(\d+)\s*[°\s]*(\d+)\s*['\s]*(\d+)/);
  if (!match) return 0;
  return (parseInt(match[1]) + parseInt(match[2]) / 60 + parseInt(match[3]) / 3600) * DEG;
}
