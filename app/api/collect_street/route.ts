import { NextRequest, NextResponse } from "next/server";

const MAPILLARY_API_URL = "https://graph.mapillary.com/images";
const GOOGLE_SV_URL = "https://maps.googleapis.com/maps/api/streetview";

/**
 * POST /api/collect_street
 * Fetches street-level imagery from Mapillary and Google Street View.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { latitude, longitude } = body;

    if (latitude === undefined || longitude === undefined) {
      return NextResponse.json({ error: "Missing coordinates" }, { status: 400 });
    }

    const mapillaryToken = process.env.MAPILLARY_ACCESS_TOKEN;
    const googleKey = process.env.GOOGLE_STREET_VIEW_API_KEY;

    const results: any[] = [];

    // 1. Google Street View
    if (googleKey) {
      const headings = [0, 90, 180, 270];
      const directions: Record<number, string> = {
        0: "North",
        90: "East",
        180: "South",
        270: "West",
      };

      for (const heading of headings) {
        const url = `${GOOGLE_SV_URL}?size=640x480&location=${latitude},${longitude}&heading=${heading}&pitch=10&fov=90&key=${googleKey}`;
        results.push({
          url,
          source: "google_street_view",
          description: `Street view facing ${directions[heading]}`,
        });
      }
    }

    // 2. Mapillary
    if (mapillaryToken) {
      try {
        const mapillaryParams = new URLSearchParams({
          access_token: mapillaryToken,
          fields: "id,thumb_1024_url,captured_at,compass_angle",
          closeto: `${longitude},${latitude}`,
          radius: "100",
          limit: "4",
        });

        const mapillaryResp = await fetch(
          `${MAPILLARY_API_URL}?${mapillaryParams.toString()}`
        );

        if (mapillaryResp.ok) {
          const data = await mapillaryResp.json();
          for (const item of data.data || []) {
            if (item.thumb_1024_url) {
              results.push({
                url: item.thumb_1024_url,
                source: "mapillary",
                description: `Street view at ${item.compass_angle ?? "?"}° (Mapillary ${item.id})`,
              });
            }
          }
        }
      } catch (err) {
        console.error("Mapillary Fetch Error:", err);
      }
    }

    return NextResponse.json({
      source: "combined",
      images: results,
    });
  } catch (error) {
    console.error("Street Imagery Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch street imagery" },
      { status: 500 }
    );
  }
}
