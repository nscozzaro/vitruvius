import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/collect_assessor
 * Fetches property details from OpenStreetMap and public sources.
 * Falls back gracefully if no data is available.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { address, latitude, longitude } = body;

    if (!address) {
      return NextResponse.json(
        { error: "Missing address" },
        { status: 400 }
      );
    }

    const result: Record<string, unknown> = {
      sqft: null,
      lot_sqft: null,
      bedrooms: null,
      bathrooms: null,
      year_built: null,
      stories: null,
      roof_type: null,
      exterior_material: null,
    };

    // 1. Try OSM Nominatim reverse geocode for building info
    try {
      const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1&extratags=1&namedetails=1`;
      const resp = await fetch(nominatimUrl, {
        headers: { "User-Agent": "Vitruvius/1.0 (building-design-app)" },
      });
      if (resp.ok) {
        const data = await resp.json();
        const tags = data.extratags || {};
        if (tags["building:levels"]) {
          result.stories = parseInt(tags["building:levels"]);
        }
        if (tags["roof:shape"]) {
          result.roof_type = tags["roof:shape"];
        }
        if (tags["building:material"]) {
          result.exterior_material = tags["building:material"];
        }
        if (tags["start_date"]) {
          const year = parseInt(tags["start_date"]);
          if (year > 1800 && year < 2100) result.year_built = year;
        }
      }
    } catch (err) {
      console.warn("Nominatim reverse geocode failed:", err);
    }

    // 2. Try Overpass for detailed building tags
    try {
      const query = `
        [out:json][timeout:10];
        (
          way["building"](around:30,${latitude},${longitude});
        );
        out tags;
      `.trim();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (resp.ok) {
        const data = await resp.json();
        for (const el of data.elements || []) {
          const tags = el.tags || {};
          if (tags["building:levels"] && !result.stories) {
            result.stories = parseInt(tags["building:levels"]);
          }
          if (tags["roof:shape"] && !result.roof_type) {
            result.roof_type = tags["roof:shape"];
          }
          if (tags["building:material"] && !result.exterior_material) {
            result.exterior_material = tags["building:material"];
          }
          if (tags["start_date"] && !result.year_built) {
            const year = parseInt(tags["start_date"]);
            if (year > 1800 && year < 2100) result.year_built = year;
          }
          if (tags["height"] && !result.sqft) {
            // Store height as metadata even if not sqft
            result.building_height = parseFloat(tags["height"]);
          }
        }
      }
    } catch {
      // Overpass may timeout, that's OK
    }

    const hasData = Object.values(result).some((v) => v != null);

    return NextResponse.json({
      source: "assessor",
      data: hasData ? result : null,
    });
  } catch (error) {
    console.error("Assessor Error:", error);
    return NextResponse.json({ source: "assessor", data: null });
  }
}
