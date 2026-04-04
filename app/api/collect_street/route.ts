import { NextRequest, NextResponse } from "next/server";

const MAPILLARY_API_URL = "https://graph.mapillary.com/images";
const GOOGLE_SV_URL = "https://maps.googleapis.com/maps/api/streetview";
const GOOGLE_SV_META = "https://maps.googleapis.com/maps/api/streetview/metadata";

/**
 * POST /api/collect_street
 * Fetches street-level imagery from 8 headings (every 45°) with metadata
 * validation, plus Mapillary. This captures both street-facing and
 * alley-facing sides of buildings.
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

    const mapillaryToken = process.env.MAPILLARY_ACCESS_TOKEN;
    const googleKey = process.env.GOOGLE_STREET_VIEW_API_KEY;

    const results: Array<{
      url: string;
      source: string;
      description?: string;
    }> = [];

    // 1. Google Street View — 8 headings with metadata validation
    if (googleKey) {
      const headings = [
        { angle: 0, label: "North" },
        { angle: 45, label: "Northeast" },
        { angle: 90, label: "East" },
        { angle: 135, label: "Southeast" },
        { angle: 180, label: "South" },
        { angle: 225, label: "Southwest" },
        { angle: 270, label: "West" },
        { angle: 315, label: "Northwest" },
      ];

      // Check metadata for all headings in parallel
      const metaChecks = await Promise.allSettled(
        headings.map(async ({ angle, label }) => {
          const metaUrl = `${GOOGLE_SV_META}?location=${latitude},${longitude}&heading=${angle}&key=${googleKey}`;
          const resp = await fetch(metaUrl);
          if (!resp.ok) return null;
          const meta = await resp.json();
          if (meta.status !== "OK") return null;
          return { angle, label, panoId: meta.pano_id };
        })
      );

      // Deduplicate by pano_id (multiple headings may hit same panorama)
      const seenPanos = new Set<string>();

      for (const result of metaChecks) {
        if (result.status !== "fulfilled" || !result.value) continue;
        const { angle, label, panoId } = result.value;

        // Allow same pano from different angles (they show different views)
        // but track for informational purposes
        seenPanos.add(panoId);

        const url = `${GOOGLE_SV_URL}?size=640x480&location=${latitude},${longitude}&heading=${angle}&pitch=10&fov=90&key=${googleKey}`;
        results.push({
          url,
          source: "google_street_view",
          description: `Street view facing ${label} (${angle}°)`,
        });
      }
    }

    // 2. Mapillary — nearby community photos
    if (mapillaryToken) {
      try {
        const mapillaryParams = new URLSearchParams({
          access_token: mapillaryToken,
          fields: "id,thumb_1024_url,captured_at,compass_angle",
          closeto: `${longitude},${latitude}`,
          radius: "100",
          limit: "6",
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
                description: `Mapillary ${item.compass_angle != null ? `${Math.round(item.compass_angle)}°` : ""} (${item.id})`,
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
