import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/autocomplete?q=...
 * Proxies Nominatim to avoid CORS and provide a simple list of address suggestions.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q");

    if (!q || !q.trim()) {
      return NextResponse.json([]);
    }

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      q
    )}&format=json&addressdetails=1&limit=5&countrycodes=us`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Vitruvius-Autocomplete/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Nominatim error: ${response.status}`);
    }

    const data = await response.json();
    
    // Map to just strings for the UI and clean up formatting
    const suggestions = data
      .map((item: any) => {
        let name = item.display_name;
        // Nominatim often returns "1426, Bath Street..." 
        // We want "1426 Bath Street..." for US addresses.
        return name.replace(/^(\d+),\s*/, "$1 ");
      })
      .filter(Boolean);

    return NextResponse.json(suggestions);
  } catch (error) {
    console.error("Autocomplete Error:", error);
    return NextResponse.json({ error: "Failed to fetch suggestions" }, { status: 500 });
  }
}
