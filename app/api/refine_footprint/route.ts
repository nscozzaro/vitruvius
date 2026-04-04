import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * POST /api/refine_footprint
 *
 * Two-pass calibration strategy:
 *
 * Pass 1 (Geometric): Cross-reference OSM footprint, municipal parcel, and geocoded point.
 *   - The geocoded point (Nominatim) is typically the most accurate single point (address centroid).
 *   - OSM building footprints have ~1-3m accuracy but consistent relative shape.
 *   - Municipal GIS parcel boundaries can have 2-5m systematic offsets from different datums.
 *   - Strategy: Use the footprint centroid-to-geocode offset as a correction hint.
 *
 * Pass 2 (Vision): Send a CLEAN satellite image (no overlays) to Gemini vision.
 *   - AI identifies the roof outline and property boundaries visible in the image.
 *   - Compares against the coordinate data to suggest fine-grained adjustments.
 *   - Returns pixel-level observations about misalignment direction.
 */

const VISION_PROMPT = `You are a precision geospatial calibration AI. You are analyzing a high-resolution satellite image of a residential property.

I will provide you with:
1. A CLEAN satellite image (no overlays) of the property at zoom level 20
2. The building footprint coordinates (as lat/lon polygon)
3. The parcel/lot boundary coordinates (as lat/lon polygon)
4. The geocoded address point (lat/lon)
5. Title report data if available (legal description, easements, lot dimensions)

YOUR TASK: Determine how to shift the footprint and parcel polygons to better align with what's visible in the satellite image.

METHODOLOGY:
- Identify the actual roof outline in the satellite image
- Identify property boundaries (fences, hedges, pavement edges, walls)
- Compare the centroid of the provided footprint polygon with the centroid of the visible roof
- Compare the parcel polygon edges with visible boundary features
- Estimate the offset in meters (north/south and east/west) needed to correct each

IMPORTANT CALIBRATION NOTES:
- Positive X = east, negative X = west
- Positive Y = north, negative Y = south
- For parcel offset: positive lat = north, positive lon = east
- Typical municipal GIS offset is 2-5 meters in one direction
- OSM data is typically accurate to 1-2 meters
- If you can see the roof clearly, use its edges as the primary reference for the footprint
- If you can see fences/hedges, use them as reference for the parcel boundary

Return ONLY valid JSON (no markdown fences):
{
  "footprintOffset": { "x": 0.0, "y": 0.0 },
  "parcelOffset": { "lat": 0.0, "lon": 0.0 },
  "confidence": 0.7,
  "notes": "Explanation of what you see and why these offsets are recommended",
  "roofDescription": "Description of the building shape visible in the satellite image",
  "boundaryDescription": "Description of visible property boundaries"
}`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { footprint, parcelBoundary, origin, geocoded, context } = body;

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_STREET_VIEW_API_KEY;
    const mapsKey = process.env.GOOGLE_STREET_VIEW_API_KEY;

    if (!apiKey) {
      return NextResponse.json({ error: "No API key" }, { status: 500 });
    }

    // ── Pass 1: Geometric calibration ───────────────────────────────
    const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);
    let geoOffset = { x: 0, y: 0 };
    let parcelGeoOffset = { lat: 0, lon: 0 };

    if (footprint && origin && geocoded) {
      // Calculate footprint centroid in lat/lon
      const fpLatLon = footprint.map((p: { x: number; y: number }) => ({
        lat: origin.latitude + p.y / 110540,
        lon: origin.longitude + p.x / (111320 * cosDeg(origin.latitude)),
      }));
      const fpCLat = fpLatLon.reduce((s: number, p: { lat: number }) => s + p.lat, 0) / fpLatLon.length;
      const fpCLon = fpLatLon.reduce((s: number, p: { lon: number }) => s + p.lon, 0) / fpLatLon.length;

      // Geocoded point should be near the building center
      // Small offset is expected (1-2m), large offset suggests data misalignment
      const fpToGeoY = (geocoded.latitude - fpCLat) * 110540;
      const fpToGeoX = (geocoded.longitude - fpCLon) * 111320 * cosDeg(geocoded.latitude);

      // Only apply geometric correction if offset > 2m (significant)
      if (Math.abs(fpToGeoX) > 2 || Math.abs(fpToGeoY) > 2) {
        // Apply half the correction (conservative — don't overshoot)
        geoOffset = { x: fpToGeoX * 0.5, y: fpToGeoY * 0.5 };
      }

      // For parcel: check if parcel center is significantly offset from geocoded point
      if (parcelBoundary && parcelBoundary.length > 2) {
        const pCLat = parcelBoundary.reduce((s: number, p: { lat: number }) => s + p.lat, 0) / parcelBoundary.length;
        const pCLon = parcelBoundary.reduce((s: number, p: { lon: number }) => s + p.lon, 0) / parcelBoundary.length;

        // If parcel center is >3m from geocoded point, apply partial correction
        const pToGeoLat = geocoded.latitude - pCLat;
        const pToGeoLon = geocoded.longitude - pCLon;
        const pOffsetM = Math.sqrt(
          Math.pow(pToGeoLat * 110540, 2) +
          Math.pow(pToGeoLon * 111320 * cosDeg(geocoded.latitude), 2)
        );

        if (pOffsetM > 3) {
          // Apply partial correction toward the geocoded point
          parcelGeoOffset = {
            lat: pToGeoLat * 0.3,
            lon: pToGeoLon * 0.3,
          };
        }
      }
    }

    // ── Pass 2: AI Vision calibration ───────────────────────────────
    let visionOffset = { footprint: { x: 0, y: 0 }, parcel: { lat: 0, lon: 0 } };
    let notes = "";
    let roofDesc = "";
    let boundaryDesc = "";
    let confidence = 0.5;

    if (mapsKey && geocoded) {
      try {
        // Fetch a CLEAN satellite image (no overlays)
        const cleanUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${geocoded.latitude},${geocoded.longitude}&zoom=20&size=600x400&scale=2&maptype=satellite&key=${mapsKey}`;

        const imgResp = await fetch(cleanUrl);
        if (imgResp.ok) {
          const imgBuffer = await imgResp.arrayBuffer();
          const base64 = Buffer.from(imgBuffer).toString("base64");

          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            systemInstruction: VISION_PROMPT,
          });

          // Build lat/lon footprint for the AI
          const fpLatLon = footprint?.map((p: { x: number; y: number }) => ({
            lat: (origin.latitude + p.y / 110540).toFixed(7),
            lon: (origin.longitude + p.x / (111320 * cosDeg(origin.latitude))).toFixed(7),
          }));

          const prompt = `Satellite image is centered at ${geocoded.latitude.toFixed(7)}, ${geocoded.longitude.toFixed(7)} (the geocoded address point for ${geocoded.address || "the property"}).

Building footprint polygon (lat/lon): ${JSON.stringify(fpLatLon)}
Parcel boundary polygon (lat/lon): ${JSON.stringify(parcelBoundary?.slice(0, 20))}

Geometric pre-analysis suggests the footprint should shift ${geoOffset.x.toFixed(1)}m east, ${geoOffset.y.toFixed(1)}m north.
Parcel pre-analysis suggests shifting ${(parcelGeoOffset.lat * 110540).toFixed(1)}m north, ${(parcelGeoOffset.lon * 111320 * cosDeg(geocoded.latitude)).toFixed(1)}m east.

${context ? `Title/legal context:\n${context}` : ""}

Analyze the satellite image and suggest the optimal meter-level offsets to align the building footprint with the visible roof, and the parcel with visible property boundaries.`;

          const result = await model.generateContent([
            { inlineData: { data: base64, mimeType: "image/png" } },
            { text: prompt },
          ]);

          let responseText = result.response.text();
          responseText = responseText.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

          try {
            const parsed = JSON.parse(responseText);
            visionOffset = {
              footprint: parsed.footprintOffset || { x: 0, y: 0 },
              parcel: parsed.parcelOffset || { lat: 0, lon: 0 },
            };
            notes = parsed.notes || "";
            roofDesc = parsed.roofDescription || "";
            boundaryDesc = parsed.boundaryDescription || "";
            confidence = parsed.confidence || 0.5;
          } catch {
            notes = "Vision analysis returned non-JSON: " + responseText.slice(0, 200);
          }
        }
      } catch (err) {
        console.warn("Vision calibration failed:", err);
        notes = "Vision calibration unavailable. Using geometric calibration only.";
      }
    }

    // ── Combine offsets ─────────────────────────────────────────────
    // Weight: geometric 40%, vision 60% (vision sees the actual image)
    const finalFootprintOffset = {
      x: geoOffset.x * 0.4 + visionOffset.footprint.x * 0.6,
      y: geoOffset.y * 0.4 + visionOffset.footprint.y * 0.6,
    };

    const finalParcelOffset = {
      lat: parcelGeoOffset.lat * 0.4 + visionOffset.parcel.lat * 0.6,
      lon: parcelGeoOffset.lon * 0.4 + visionOffset.parcel.lon * 0.6,
    };

    return NextResponse.json({
      footprintOffset: {
        x: Math.round(finalFootprintOffset.x * 10) / 10,
        y: Math.round(finalFootprintOffset.y * 10) / 10,
      },
      parcelOffset: {
        lat: Math.round(finalParcelOffset.lat * 10000000) / 10000000,
        lon: Math.round(finalParcelOffset.lon * 10000000) / 10000000,
      },
      confidence,
      notes,
      roofDescription: roofDesc,
      boundaryDescription: boundaryDesc,
      geometric: { footprint: geoOffset, parcel: parcelGeoOffset },
      vision: visionOffset,
    });
  } catch (error) {
    console.error("Refinement error:", error);
    return NextResponse.json({ error: "Refinement failed" }, { status: 500 });
  }
}
