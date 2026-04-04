import { NextRequest, NextResponse } from "next/server";

const STATIC_MAP_URL = "https://maps.googleapis.com/maps/api/staticmap";

/**
 * POST /api/collect_satellite
 * Fetches overhead satellite imagery using Google Maps Static API.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { latitude, longitude } = body;

    if (latitude === undefined || longitude === undefined) {
      return NextResponse.json(
        { error: "Missing coordinates" },
        { status: 400 }
      );
    }

    const googleKey = process.env.GOOGLE_STREET_VIEW_API_KEY;
    if (!googleKey) {
      return NextResponse.json({ source: "satellite", images: [] });
    }

    const views = [
      {
        zoom: 20,
        maptype: "satellite",
        size: "800x800",
        desc: "Satellite close-up (zoom 20)",
      },
      {
        zoom: 19,
        maptype: "hybrid",
        size: "800x800",
        desc: "Satellite + streets (zoom 19)",
      },
      {
        zoom: 18,
        maptype: "hybrid",
        size: "800x600",
        desc: "Neighborhood context (zoom 18)",
      },
      {
        zoom: 17,
        maptype: "hybrid",
        size: "800x600",
        desc: "Area overview (zoom 17)",
      },
    ];

    const images = views.map((view) => ({
      url: `${STATIC_MAP_URL}?center=${latitude},${longitude}&zoom=${view.zoom}&size=${view.size}&maptype=${view.maptype}&scale=2&key=${googleKey}`,
      source: "google_satellite",
      description: view.desc,
    }));

    return NextResponse.json({
      source: "satellite",
      images,
    });
  } catch (error) {
    console.error("Satellite Imagery Error:", error);
    return NextResponse.json({ source: "satellite", images: [] });
  }
}
