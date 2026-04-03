import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/collect_assessor
 * Scrapes county property records to get building details.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { address } = body;

    if (!address) {
      return NextResponse.json({ error: "Missing address" }, { status: 400 });
    }

    const searchUrl = `https://www.countyoffice.org/property-records-search/?q=${encodeURIComponent(
      address
    )}`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    if (!response.ok) {
      return NextResponse.json({ source: "assessor", data: null });
    }

    const html = await response.text();
    const plainText = html.replace(/<[^>]*>?/gm, " ").toLowerCase();

    const result: any = {
      sqft: null,
      lot_sqft: null,
      bedrooms: null,
      bathrooms: null,
      year_built: null,
      stories: null,
      roof_type: null,
      exterior_material: null,
      raw_data: {},
    };

    // Simple regex matching mirroring the Python logic
    const sqftMatch = plainText.match(
      /(?:living\s*area|building\s*area|sqft|sq\s*ft)[:\s]*(\d[\d,]*)/
    );
    if (sqftMatch) {
      result.sqft = parseFloat(sqftMatch[1].replace(/,/g, ""));
    }

    const lotMatch = plainText.match(/(?:lot\s*(?:size|area))[:\s]*(\d[\d,]*)/);
    if (lotMatch) {
      result.lot_sqft = parseFloat(lotMatch[1].replace(/,/g, ""));
    }

    const bedMatch = plainText.match(/(\d+)\s*(?:bed(?:room)?s?)/);
    if (bedMatch) {
      result.bedrooms = parseInt(bedMatch[1]);
    }

    const bathMatch = plainText.match(/(\d+\.?\d*)\s*(?:bath(?:room)?s?)/);
    if (bathMatch) {
      result.bathrooms = parseFloat(bathMatch[1]);
    }

    const yearMatch = plainText.match(/(?:year\s*built|built\s*in)[:\s]*(\d{4})/);
    if (yearMatch) {
      result.year_built = parseInt(yearMatch[1]);
    }

    const storyMatch = plainText.match(/(\d+)\s*(?:stor(?:y|ies))/);
    if (storyMatch) {
      result.stories = parseInt(storyMatch[1]);
    }

    const hasData = Object.keys(result).some(
      (k) => result[k] !== null && k !== "raw_data"
    );

    return NextResponse.json({
      source: "assessor",
      data: hasData ? result : null,
    });
  } catch (error) {
    console.error("Assessor Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch assessor data" },
      { status: 500 }
    );
  }
}
