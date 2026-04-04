import { NextRequest, NextResponse } from "next/server";
import { callLLM } from "@/app/lib/llm";

const SYSTEM_PROMPT = `You are a real estate title report analyzer. Given the text of a preliminary title report, extract ALL relevant property data into structured JSON.

Extract these fields when present:
- apn: Assessor Parcel Number
- legalDescription: Full legal description (lot, tract, book, page)
- lotNumber: Lot number from legal description
- tractNumber: Tract number
- tractMapReference: Book and page reference for tract map
- propertyAddress: Full property address
- county: County name
- city: City name
- propertyType: Type of property (SFR, multi-family, etc.)
- easements: Array of {purpose, affects, grantedTo, recordingDate, recordingNo}
- exceptions: Array of notable title exceptions (not standard boilerplate)
- assessments: Array of {district, purpose, amount}
- encumbrances: Array of {type, holder, amount, recordingDate}
- notes: Array of notable findings from the report

Return ONLY valid JSON, no markdown fences.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text } = body;

    if (!text) {
      return NextResponse.json({ error: "No text provided" }, { status: 400 });
    }

    const responseText = await callLLM(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Extract structured data from this title report:\n\n${text.slice(0, 30000)}` },
      ],
      { maxTokens: 2048 }
    );

    const cleaned = responseText.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

    try {
      const parsed = JSON.parse(cleaned);
      return NextResponse.json({ data: parsed });
    } catch {
      return NextResponse.json({ data: null, raw: cleaned });
    }
  } catch (error) {
    console.error("Title extraction error:", error);
    return NextResponse.json({ error: "Extraction failed" }, { status: 500 });
  }
}
