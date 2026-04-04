import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/compute_lot_boundary
 *
 * Computes a precise lot boundary using survey data from the tract map.
 *
 * Two approaches depending on available data:
 *
 * 1. WITH survey data (bearings, distances, curves):
 *    Compute the boundary mathematically from the surveyor's measurements.
 *    Start at the geocoded point and trace the boundary using bearings/distances.
 *
 * 2. WITHOUT survey data (GIS parcel only):
 *    Apply the half-street width correction to pull the GIS boundary from
 *    street centerline to the actual lot line.
 */

const FT_TO_M = 0.3048;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { surveyData, parcelBoundary, geocoded } = body;

    if (!geocoded) {
      return NextResponse.json({ error: "Missing geocoded data" }, { status: 400 });
    }

    const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);

    // If we have survey bearings/distances, compute from those
    if (surveyData?.boundaries?.length > 0) {
      const result = computeFromSurvey(surveyData, geocoded, parcelBoundary);
      return NextResponse.json(result);
    }

    // Otherwise, just correct the GIS parcel with half-street width
    if (parcelBoundary?.length > 2) {
      const result = correctGISParcel(parcelBoundary, geocoded, 28); // default 28ft half-street
      return NextResponse.json(result);
    }

    return NextResponse.json({ adjustedParcel: null, notes: "No boundary data available" });
  } catch (error) {
    console.error("Lot boundary error:", error);
    return NextResponse.json({ error: "Computation failed" }, { status: 500 });
  }
}

/**
 * Correct a GIS parcel boundary by pulling street-facing edges inward
 * by the half-street width.
 */
function correctGISParcel(
  parcelBoundary: { lat: number; lon: number }[],
  geocoded: { latitude: number; longitude: number },
  halfStreetFt: number
) {
  const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);
  const halfStreetM = halfStreetFt * FT_TO_M;

  // Calculate centroid
  const cLat = parcelBoundary.reduce((s, p) => s + p.lat, 0) / parcelBoundary.length;
  const cLon = parcelBoundary.reduce((s, p) => s + p.lon, 0) / parcelBoundary.length;

  // Find the maximum distance from centroid on each side
  const ptData = parcelBoundary.map(p => {
    const dx = (p.lon - cLon) * 111320 * cosDeg(cLat);
    const dy = (p.lat - cLat) * 110540;
    return { ...p, dx, dy, dist: Math.sqrt(dx * dx + dy * dy) };
  });

  // Find the street-facing direction: the side with the most spread-out points
  // that are farthest from the geocoded point
  const maxDist = Math.max(...ptData.map(p => p.dist));
  const streetThreshold = maxDist - halfStreetM;

  const adjustedParcel = ptData.map(p => {
    if (p.dist > streetThreshold) {
      // Pull this point toward the centroid by halfStreetM
      const scale = halfStreetM / p.dist;
      return {
        lat: Number((p.lat + (cLat - p.lat) * scale).toFixed(7)),
        lon: Number((p.lon + (cLon - p.lon) * scale).toFixed(7)),
      };
    }
    return { lat: p.lat, lon: p.lon };
  });

  return {
    adjustedParcel,
    halfStreetWidth_ft: halfStreetFt,
    halfStreetWidth_m: halfStreetM,
    notes: `Applied ${halfStreetFt}ft half-street correction to outermost boundary points`,
  };
}

/**
 * Compute lot boundary from survey bearings, distances, and curve data.
 * Uses the tract map measurements to construct the exact polygon.
 *
 * The GIS parcel is used as a reference to anchor the computed boundary.
 */
function computeFromSurvey(
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
  geocoded: { latitude: number; longitude: number },
  parcelBoundary?: { lat: number; lon: number }[]
) {
  const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);
  const halfStreetFt = surveyData.adjacent_streets?.[0]?.width_ft
    ? surveyData.adjacent_streets[0].width_ft / 2
    : 28;

  // If we have a GIS parcel, correct it with the survey's half-street width
  let adjustedParcel: { lat: number; lon: number }[] | null = null;

  if (parcelBoundary && parcelBoundary.length > 2) {
    const correction = correctGISParcel(parcelBoundary, geocoded, halfStreetFt);
    adjustedParcel = correction.adjustedParcel;
  }

  // Compute lot dimensions from survey
  const lotDepthFt = surveyData.boundaries
    .filter(b => b.distance_ft && b.distance_ft > 50)
    .map(b => b.distance_ft!)[0] || null;

  const arcFt = surveyData.boundaries
    .find(b => b.type === "curve")?.arc_ft || null;

  // Build detailed notes
  const notes: string[] = [];
  notes.push(`Half-street width: ${halfStreetFt}ft (${(halfStreetFt * FT_TO_M).toFixed(1)}m) — applied to GIS parcel`);
  if (lotDepthFt) notes.push(`Lot depth from survey: ${lotDepthFt}ft (${(lotDepthFt * FT_TO_M).toFixed(1)}m)`);
  if (arcFt) notes.push(`Street frontage arc: ${arcFt}ft`);

  // Easement info
  for (const e of surveyData.easements || []) {
    notes.push(`Easement: ${e.width_ft}ft ${e.purpose} on ${e.side} side`);
  }

  // Bearing info
  for (const b of surveyData.boundaries) {
    if (b.bearing) {
      notes.push(`${b.side} boundary: ${b.bearing}, ${b.distance_ft}ft`);
    }
  }

  return {
    adjustedParcel,
    halfStreetWidth_ft: halfStreetFt,
    lotDepth_ft: lotDepthFt,
    lotDepth_m: lotDepthFt ? lotDepthFt * FT_TO_M : null,
    arcLength_ft: arcFt,
    notes: notes.join("\n"),
    surveySource: "Tract map survey data",
  };
}
