import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/collect
 * Geocodes an address to return latitude and longitude.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const address = body.address;

    if (!address) {
      return NextResponse.json({ error: "No address provided" }, { status: 400 });
    }

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      address
    )}&format=json&limit=1`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Vitruvius/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Nominatim error: ${response.status}`);
    }

    const data = await response.json();

    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Could not geocode address" }, { status: 404 });
    }

    const { lat, lon } = data[0];

    return NextResponse.json({
      address,
      latitude: parseFloat(lat),
      longitude: parseFloat(lon),
    });
  } catch (error) {
    console.error("Geocoding Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to geocode address" },
      { status: 500 }
    );
  }
}
