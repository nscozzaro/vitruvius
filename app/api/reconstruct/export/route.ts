import { NextRequest } from "next/server";
import { exportLandXML } from "@/app/lib/landxml-export";

/**
 * POST /api/reconstruct/export
 *
 * Generate a LandXML file from the accumulated survey elements.
 */
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const { elements, coordSystem, metadata } = await request.json();

  if (!elements || !coordSystem) {
    return Response.json(
      { error: "Missing elements or coordSystem" },
      { status: 400 },
    );
  }

  try {
    const xml = exportLandXML(elements, coordSystem, metadata ?? {});

    return new Response(xml, {
      headers: {
        "Content-Type": "application/xml",
        "Content-Disposition": `attachment; filename="survey-${metadata?.tractNumber ?? "export"}.xml"`,
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Export failed" },
      { status: 500 },
    );
  }
}
