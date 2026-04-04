import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * POST /api/refine_footprint
 *
 * Iterative point-by-point calibration:
 *
 * 1. Sends a CLEAN satellite image to Gemini vision
 * 2. AI identifies the actual roof polygon and property boundary
 * 3. AI returns ADJUSTED lat/lon coordinates for each point
 * 4. Repeats if confidence is low (up to 2 iterations)
 *
 * Key insight: Municipal GIS parcel boundaries go to street centerline,
 * but site plans need the actual lot edge (sidewalk/fence). The AI
 * must distinguish between the legal lot line and the usable property edge.
 */

const VISION_PROMPT = `You are a precision geospatial calibration AI specializing in residential property mapping.

You will receive:
1. A high-resolution satellite image of a residential property
2. The current building footprint as a lat/lon polygon
3. The current parcel boundary as a lat/lon polygon
4. The geocoded address point
5. Legal context from the title report (easements, lot description)

YOUR TASK: Return CORRECTED coordinates for both polygons.

FOR THE BUILDING FOOTPRINT:
- Trace the ACTUAL ROOF OUTLINE visible in the satellite image
- Return new lat/lon coordinates for each vertex of the roof
- The roof is the ground truth — adjust all points to match what you see
- If the current polygon has roughly the right number of points, adjust each one
- If the shape is fundamentally wrong, return a new set of points that traces the roof

FOR THE PARCEL BOUNDARY:
- IMPORTANT: Municipal GIS data often extends to the street centerline, but the ACTUAL usable lot boundary is at the sidewalk/fence/curb edge
- Identify the real property boundary from visual features: fences, hedges, sidewalk edges, driveway edges, changes in landscaping
- The EASTERN boundary (toward the cul-de-sac) should be at the edge of the private property, NOT the center of the street
- The WESTERN boundary should be at the edge of the lot, NOT in the middle of the parking area
- Return corrected lat/lon coordinates that represent the actual buildable lot

COORDINATE FORMAT: Return lat/lon with 7 decimal places.

Return ONLY valid JSON (no markdown):
{
  "adjustedFootprint": [
    {"lat": 34.1234567, "lon": -119.1234567},
    ...
  ],
  "adjustedParcel": [
    {"lat": 34.1234567, "lon": -119.1234567},
    ...
  ],
  "confidence": 0.85,
  "notes": "Description of changes made",
  "roofDescription": "What the roof looks like",
  "boundaryDescription": "What boundaries are visible"
}`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { footprint, parcelBoundary, origin, geocoded, context, iteration = 0 } = body;

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_STREET_VIEW_API_KEY;
    const mapsKey = process.env.GOOGLE_STREET_VIEW_API_KEY;

    if (!apiKey || !mapsKey || !geocoded) {
      return NextResponse.json({ error: "Missing API key or geocoded data" }, { status: 400 });
    }

    const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);

    // Convert footprint x/y to lat/lon
    const fpLatLon = (footprint || []).map((p: { x: number; y: number }) => ({
      lat: Number((origin.latitude + p.y / 110540).toFixed(7)),
      lon: Number((origin.longitude + p.x / (111320 * cosDeg(origin.latitude))).toFixed(7)),
    }));

    // Fetch CLEAN satellite image (no overlays)
    const cleanUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${geocoded.latitude},${geocoded.longitude}&zoom=20&size=800x600&scale=2&maptype=satellite&key=${mapsKey}`;

    const imgResp = await fetch(cleanUrl);
    if (!imgResp.ok) {
      return NextResponse.json({ error: "Failed to fetch satellite image" }, { status: 500 });
    }

    const imgBuffer = await imgResp.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString("base64");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      systemInstruction: VISION_PROMPT,
    });

    const prompt = `Iteration ${iteration + 1}. Satellite image centered at ${geocoded.latitude}, ${geocoded.longitude} for ${geocoded.address || "the property"}.

CURRENT BUILDING FOOTPRINT (${fpLatLon.length} points, lat/lon):
${JSON.stringify(fpLatLon, null, 1)}

CURRENT PARCEL BOUNDARY (${parcelBoundary?.length || 0} points, lat/lon):
${JSON.stringify(parcelBoundary || [], null, 1)}

LEGAL CONTEXT:
${context || "No title report data available."}

INSTRUCTIONS:
1. Look at the satellite image carefully
2. Identify the actual roof outline of the building at this address
3. Identify the actual property boundaries (fences, hedges, sidewalk edges — NOT the street centerline)
4. Return adjusted coordinates for BOTH polygons that match what you see
5. For the parcel: pull the eastern boundary back from the street centerline to the sidewalk/curb edge
6. For the footprint: adjust each point to match the visible roof edge

Return the corrected polygons as JSON.`;

    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType: "image/png" } },
      { text: prompt },
    ]);

    let responseText = result.response.text();
    responseText = responseText.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      return NextResponse.json({
        error: "Failed to parse AI response",
        raw: responseText.slice(0, 500),
      });
    }

    const adjustedFp = parsed.adjustedFootprint || [];
    const adjustedParcel = parsed.adjustedParcel || [];
    const confidence = parsed.confidence || 0.5;

    // Convert adjusted footprint back to x/y relative to origin
    const refOrigin = origin || geocoded;
    const newFootprint = adjustedFp
      .filter((p: { lat?: number; lon?: number }) => p && typeof p.lat === "number" && typeof p.lon === "number")
      .map((p: { lat: number; lon: number }) => ({
        x: Math.round((p.lon - refOrigin.longitude) * 111320 * cosDeg(refOrigin.latitude) * 1000) / 1000,
        y: Math.round((p.lat - refOrigin.latitude) * 110540 * 1000) / 1000,
      }));

    // If confidence < 0.7 and this is the first iteration, run again
    const shouldIterate = confidence < 0.7 && iteration < 1;

    return NextResponse.json({
      footprint: newFootprint.length >= 3 ? newFootprint : null,
      parcelBoundary: adjustedParcel.length >= 3 ? adjustedParcel : null,
      confidence,
      notes: parsed.notes || "",
      roofDescription: parsed.roofDescription || "",
      boundaryDescription: parsed.boundaryDescription || "",
      shouldIterate,
      iteration: iteration + 1,
    });
  } catch (error) {
    console.error("Refinement error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
