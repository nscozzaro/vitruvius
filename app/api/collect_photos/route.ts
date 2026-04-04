import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/collect_photos
 * Fetches close-up detail shots from Google Street View at various angles.
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

    const results: Array<{ url: string; source: string; description?: string }> = [];

    const googleKey = process.env.GOOGLE_STREET_VIEW_API_KEY;
    if (googleKey && latitude && longitude) {
      const detailViews = [
        { heading: 0, pitch: 25, fov: 60, desc: "Front elevation (close-up)" },
        { heading: 180, pitch: 25, fov: 60, desc: "Rear view (close-up)" },
        { heading: 45, pitch: 15, fov: 70, desc: "Northeast angle" },
        { heading: 135, pitch: 15, fov: 70, desc: "Southeast angle" },
        { heading: 225, pitch: 15, fov: 70, desc: "Southwest angle" },
        { heading: 315, pitch: 15, fov: 70, desc: "Northwest angle" },
      ];

      for (const view of detailViews) {
        const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${latitude},${longitude}&heading=${view.heading}&key=${googleKey}`;
        try {
          const metaResp = await fetch(metaUrl);
          if (metaResp.ok) {
            const meta = await metaResp.json();
            if (meta.status === "OK") {
              const imageUrl = `https://maps.googleapis.com/maps/api/streetview?size=800x600&location=${latitude},${longitude}&heading=${view.heading}&pitch=${view.pitch}&fov=${view.fov}&key=${googleKey}`;
              results.push({
                url: imageUrl,
                source: "google_street_view_detail",
                description: view.desc,
              });
            }
          }
        } catch {
          // Skip this view
        }
      }
    }

    return NextResponse.json({
      source: "combined",
      images: results,
    });
  } catch (error) {
    console.error("Photos Error:", error);
    return NextResponse.json({ source: "combined", images: [] });
  }
}
