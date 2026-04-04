import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const SYSTEM_PROMPT = `You are an architectural site analysis AI. You are given:
1. A satellite image URL showing a property with an overlay of the current building footprint (blue polygon) and property boundary (red dashed line)
2. The current footprint coordinates (relative x/y in meters from an origin point)
3. The current parcel boundary coordinates (lat/lon)
4. Additional context (legal description, easements, etc.)

Your task: Analyze the satellite image and suggest corrections to align the footprint and parcel boundary more accurately with what you observe.

For the BUILDING FOOTPRINT, compare the blue polygon overlay against the actual roof outline visible in the satellite image. Suggest x/y offset adjustments in meters to shift the polygon to better match the roof.

For the PARCEL BOUNDARY, if the red dashed line doesn't align with visible property boundaries (fences, hedges, driveways, edge of pavement), suggest a lat/lon offset.

Return ONLY valid JSON:
{
  "footprintOffset": { "x": 1.5, "y": -2.0 },
  "parcelOffset": { "lat": 0.00002, "lon": -0.00003 },
  "confidence": 0.7,
  "notes": "The footprint appears shifted ~2m north and 1.5m east of the actual roof. The parcel boundary needs to shift west to align with the fence line visible in the image.",
  "observations": [
    "Building has an L-shaped footprint with attached garage on east side",
    "Driveway visible on north side leading to garage",
    "Property boundary fence visible on west side"
  ]
}

If you cannot determine adjustments from the image, return offsets of 0 and explain in notes.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { satelliteImageUrl, footprint, parcelBoundary, origin, context } = body;

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_STREET_VIEW_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "No API key" }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      systemInstruction: SYSTEM_PROMPT,
    });

    // Fetch the satellite image and convert to base64 for Gemini vision
    let imagePart;
    if (satelliteImageUrl) {
      try {
        const imgResp = await fetch(satelliteImageUrl);
        if (imgResp.ok) {
          const imgBuffer = await imgResp.arrayBuffer();
          const base64 = Buffer.from(imgBuffer).toString("base64");
          const mimeType = imgResp.headers.get("content-type") || "image/png";
          imagePart = {
            inlineData: { data: base64, mimeType },
          };
        }
      } catch (err) {
        console.warn("Failed to fetch satellite image:", err);
      }
    }

    const prompt = `Analyze this satellite image of a property and suggest corrections to the building footprint and parcel boundary overlays.

Current footprint (x/y meters from origin): ${JSON.stringify(footprint?.slice(0, 20))}
Origin point: ${JSON.stringify(origin)}
Current parcel boundary (lat/lon): ${JSON.stringify(parcelBoundary?.slice(0, 20))}

Additional context:
${context || "None provided"}

The blue polygon is the building footprint from OpenStreetMap.
The red dashed line is the parcel boundary from municipal GIS.

Suggest x/y meter offsets for the footprint and lat/lon offsets for the parcel to better align with what you see in the image.`;

    const parts = imagePart
      ? [imagePart, { text: prompt }]
      : [{ text: prompt + "\n\n(No image available — provide best estimates based on coordinate data)" }];

    const result = await model.generateContent(parts);
    let responseText = result.response.text();
    responseText = responseText.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

    try {
      const parsed = JSON.parse(responseText);
      return NextResponse.json({
        footprintOffset: parsed.footprintOffset || { x: 0, y: 0 },
        parcelOffset: parsed.parcelOffset || { lat: 0, lon: 0 },
        confidence: parsed.confidence || 0.5,
        notes: parsed.notes || "",
        observations: parsed.observations || [],
      });
    } catch {
      return NextResponse.json({
        footprintOffset: { x: 0, y: 0 },
        parcelOffset: { lat: 0, lon: 0 },
        confidence: 0,
        notes: "Failed to parse AI response: " + responseText.slice(0, 200),
        observations: [],
      });
    }
  } catch (error) {
    console.error("Refinement error:", error);
    return NextResponse.json({ error: "Refinement failed" }, { status: 500 });
  }
}
