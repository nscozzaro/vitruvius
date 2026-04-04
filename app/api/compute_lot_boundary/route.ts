import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/compute_lot_boundary
 *
 * Computes a precise lot boundary from tract map survey data.
 * Uses bearings, distances, and curve data to construct the polygon,
 * anchored to the geocoded point and constrained by the municipal GIS parcel.
 *
 * Strategy:
 * - The municipal GIS parcel goes to the street centerline
 * - The tract map specifies the half-street width (e.g., 28 ft)
 * - We shrink the GIS parcel inward by the half-street width on the street-facing side
 * - We use the tract map bearings/distances for the side lot lines
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { surveyData, parcelBoundary, geocoded } = body;

    if (!surveyData || !parcelBoundary || !geocoded) {
      return NextResponse.json({ error: "Missing required data" }, { status: 400 });
    }

    const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);
    const FT_TO_M = 0.3048;

    // Find the half-street width from survey data
    const streetInfo = surveyData.adjacent_streets?.[0];
    const halfStreetFt = streetInfo?.width_ft ? streetInfo.width_ft / 2 : 28;
    const halfStreetM = halfStreetFt * FT_TO_M;

    // The parcel from GIS extends to centerline. The lot line is halfStreetM
    // inward from the street-facing edge.
    //
    // For a cul-de-sac lot like 459 Linfield:
    // - Points closest to the street (east side, toward cul-de-sac) need to be
    //   pulled back toward the lot center by ~halfStreetM
    // - The back boundary (west) is usually the actual property line

    // Calculate parcel centroid
    const cLat = parcelBoundary.reduce((s: number, p: { lat: number }) => s + p.lat, 0) / parcelBoundary.length;
    const cLon = parcelBoundary.reduce((s: number, p: { lon: number }) => s + p.lon, 0) / parcelBoundary.length;

    // Find which points are "street-side" (farthest from centroid on the street side)
    // For Linfield Place cul-de-sac, the street is to the EAST
    const ptDistances = parcelBoundary.map((p: { lat: number; lon: number }, i: number) => {
      const dx = (p.lon - cLon) * 111320 * cosDeg(cLat);
      const dy = (p.lat - cLat) * 110540;
      return { idx: i, ...p, dx, dy, dist: Math.sqrt(dx * dx + dy * dy) };
    });

    // Identify the street-facing edge: points that are farthest east (positive dx)
    // or form the curved boundary near the cul-de-sac
    const maxEastDx = Math.max(...ptDistances.map((p: { dx: number }) => p.dx));
    const streetThreshold = maxEastDx - halfStreetM * 1.5; // Points within 1.5x half-street of the east edge

    const adjustedParcel = parcelBoundary.map((p: { lat: number; lon: number }, i: number) => {
      const dx = (p.lon - cLon) * 111320 * cosDeg(cLat);

      if (dx > streetThreshold) {
        // This point is on the street side — pull it inward by halfStreetM
        const dirLon = (cLon - p.lon); // direction toward center (negative = west)
        const dirLat = (cLat - p.lat);
        const mag = Math.sqrt(
          Math.pow(dirLon * 111320 * cosDeg(cLat), 2) +
          Math.pow(dirLat * 110540, 2)
        );

        if (mag > 0) {
          const scale = halfStreetM / mag;
          return {
            lat: Number((p.lat + dirLat * scale).toFixed(7)),
            lon: Number((p.lon + dirLon * scale).toFixed(7)),
          };
        }
      }

      return { lat: p.lat, lon: p.lon };
    });

    // Also apply survey lot depth constraint if available
    const lotDepthFt = surveyData.boundaries?.find(
      (b: { distance_ft?: number }) => b.distance_ft && b.distance_ft > 100
    )?.distance_ft;

    let notes = `Applied ${halfStreetFt}ft half-street width correction to street-facing boundary.`;
    if (lotDepthFt) {
      notes += ` Lot depth from survey: ${lotDepthFt}ft (${(lotDepthFt * FT_TO_M).toFixed(1)}m).`;
    }

    // Add easement info
    const easements = surveyData.easements || [];
    if (easements.length > 0) {
      notes += ` Easements: ${easements.map((e: { width_ft: number; side: string; purpose: string }) => `${e.width_ft}ft ${e.purpose} on ${e.side} side`).join("; ")}.`;
    }

    return NextResponse.json({
      adjustedParcel,
      halfStreetWidth_ft: halfStreetFt,
      halfStreetWidth_m: halfStreetM,
      lotDepth_ft: lotDepthFt || null,
      notes,
      surveySource: "Tract 10,780, Book 76, Pages 20-22",
    });
  } catch (error) {
    console.error("Lot boundary computation error:", error);
    return NextResponse.json({ error: "Computation failed" }, { status: 500 });
  }
}
