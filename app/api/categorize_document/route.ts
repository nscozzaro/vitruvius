import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const SYSTEM_PROMPT = `You are an architectural document analyzer. Given text extracted from a PDF document, you must:

1. CATEGORIZE the document as one of: survey, floor_plan, elevation, site_plan, title, permit, photos, other
2. EXTRACT relevant architectural/property data as key-value pairs
3. Provide a CONFIDENCE score (0-1) for your categorization

For each category, extract these specific fields when available:
- survey: lot_width, lot_depth, lot_area, setback_front, setback_side, setback_rear, easements, bearing, topography_notes
- floor_plan: total_sqft, num_rooms, num_bedrooms, num_bathrooms, floor_count, room_dimensions
- elevation: building_height, roof_type, roof_pitch, materials, window_count
- site_plan: impervious_coverage, landscaping_pct, parking_spaces, driveway_width, utility_locations
- title: legal_description, easements, restrictions, lot_number, tract_number
- permit: permit_number, permit_type, date_issued, conditions, scope_of_work

Respond in this exact JSON format (no markdown fences):
{
  "category": "survey",
  "confidence": 0.85,
  "summary": "One-line description of what was found",
  "extractedFields": {
    "lot_width": "50ft",
    "lot_depth": "120ft"
  }
}

If the document is a scanned image with no extractable text, still try to categorize based on the filename and any fragments available. Set confidence lower.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filename, text } = body;

    if (!filename) {
      return NextResponse.json({ error: "Missing filename" }, { status: 400 });
    }

    const apiKey =
      process.env.GOOGLE_GEMINI_API_KEY ||
      process.env.GOOGLE_STREET_VIEW_API_KEY;

    if (!apiKey) {
      // Fallback: categorize by filename only
      return NextResponse.json(categorizeByFilename(filename));
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      systemInstruction: SYSTEM_PROMPT,
    });

    const prompt = `Filename: "${filename}"\n\nExtracted text (may be limited for scanned docs):\n${(text || "[No text extracted — likely a scanned document]").slice(0, 15000)}`;

    const result = await model.generateContent(prompt);
    let responseText = result.response.text();

    // Strip markdown fences if present
    responseText = responseText
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();

    try {
      const parsed = JSON.parse(responseText);
      return NextResponse.json({
        category: parsed.category || "other",
        confidence: parsed.confidence || 0.5,
        summary: parsed.summary || "Document processed",
        extractedFields: parsed.extractedFields || {},
      });
    } catch {
      // If JSON parsing fails, return basic categorization
      return NextResponse.json(categorizeByFilename(filename));
    }
  } catch (error) {
    console.error("Document categorization error:", error);
    return NextResponse.json(
      categorizeByFilename((await request.json().catch(() => ({}))).filename || "unknown")
    );
  }
}

function categorizeByFilename(filename: string) {
  const lower = filename.toLowerCase();
  let category = "other";
  if (/survey|topo|boundary/.test(lower)) category = "survey";
  else if (/floor|plan|layout/.test(lower)) category = "floor_plan";
  else if (/elev|section/.test(lower)) category = "elevation";
  else if (/site/.test(lower)) category = "site_plan";
  else if (/title|deed/.test(lower)) category = "title";
  else if (/permit|approv/.test(lower)) category = "permit";
  else if (/photo|image/.test(lower)) category = "photos";
  else if (/archive|draw/.test(lower)) category = "floor_plan";

  return {
    category,
    confidence: 0.4,
    summary: `Categorized by filename as ${category}`,
    extractedFields: {},
  };
}
