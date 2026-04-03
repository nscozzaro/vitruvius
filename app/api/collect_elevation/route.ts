import { NextRequest, NextResponse } from "next/server";

const USGS_ELEVATION_URL = "https://epqs.nationalmap.gov/v1/json";

/**
 * POST /api/collect_elevation
 * Proxies USGS National Map Elevation Point Query Service.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { latitude, longitude } = body;

    if (latitude === undefined || longitude === undefined) {
      return NextResponse.json({ error: "Missing coordinates" }, { status: 400 });
    }

    const params = new URLSearchParams({
      x: longitude.toString(),
      y: latitude.toString(),
      wkid: "4326",
      units: "Meters",
      includeDate: "false",
    });

    const url = `${USGS_ELEVATION_URL}?${params.toString()}`;

    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "Vitruvius/1.0" },
    });

    if (!response.ok) {
      throw new Error(`USGS error: ${response.status}`);
    }

    const data = await response.json();
    const elevation_m = data.value !== null ? parseFloat(data.value) : null;

    return NextResponse.json({
      source: "usgs",
      elevation_m: elevation_m !== null ? Math.round(elevation_m * 100) / 100 : null,
    });
  } catch (error) {
    console.error("Elevation Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch elevation data" },
      { status: 500 }
    );
  }
}
