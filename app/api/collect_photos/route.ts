import { NextRequest, NextResponse } from "next/server";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/**
 * POST /api/collect_photos
 * Scrapes Redfin and Zillow for property listing photos.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { address } = body;

    if (!address) {
      return NextResponse.json({ error: "Missing address" }, { status: 400 });
    }

    const results: any[] = [];

    // 1. Redfin Scraper
    try {
      const redfinSearch = `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(
        address
      )}&v=2`;
      const redfinSearchResp = await fetch(redfinSearch, { headers: HEADERS });
      if (redfinSearchResp.ok) {
        const text = await redfinSearchResp.text();
        const urlMatch = text.match(/"url":"(\/[^"]+)"/);
        if (urlMatch) {
          const propertyUrl = `https://www.redfin.com${urlMatch[1]}`;
          const propertyResp = await fetch(propertyUrl, { headers: HEADERS });
          if (propertyResp.ok) {
            const html = await propertyResp.text();
            // Simple regex for img tags since we aren't using Cheerio
            const imgMatches = html.matchAll(/<img[^>]+src="([^">]+)"[^>]*>/g);
            let count = 0;
            for (const match of imgMatches) {
              const src = match[1];
              if (src.toLowerCase().includes("photo") || src.includes("genMid")) {
                results.push({
                  url: src,
                  source: "redfin",
                  description: "Redfin listing photo",
                });
                count++;
                if (count >= 10) break;
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("Redfin Scraper Error:", err);
    }

    // 2. Zillow Scraper
    try {
      const slug = address
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const zillowUrl = `https://www.zillow.com/homes/${slug}_rb/`;
      const zillowResp = await fetch(zillowUrl, { headers: HEADERS });
      if (zillowResp.ok) {
        const html = await zillowResp.text();
        const imgMatches = html.matchAll(/<img[^>]+src="([^">]+)"[^>]*>/g);
        let count = 0;
        for (const match of imgMatches) {
          const src = match[1];
          if (src.includes("zillowstatic") || src.toLowerCase().includes("photos")) {
            results.push({
              url: src,
              source: "zillow",
              description: "Zillow listing photo",
            });
            count++;
            if (count >= 10) break;
          }
        }
      }
    } catch (err) {
      console.error("Zillow Scraper Error:", err);
    }

    return NextResponse.json({
      source: "combined",
      images: results,
    });
  } catch (error) {
    console.error("Photos Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch property photos" },
      { status: 500 }
    );
  }
}
