import { NextRequest } from "next/server";
import { downloadPage, searchRecorder } from "@/app/lib/recorder";
import { renderPdfToPng, vectorize } from "@/app/lib/vectorize";
import type { TracedPath } from "@/app/lib/vectorize";
import { DxfWriter, Units } from "@tarikjabiri/dxf";

/**
 * POST /api/generate-dxf
 *
 * Simple PDF → PNG → potrace → DXF conversion.
 * No AI — just vectorize the map and output clean DXF geometry.
 */

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const { book, page, endPage } = await request.json();

    if (!book || !page) {
      return new Response(JSON.stringify({ error: "Missing book/page" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // For multi-page maps, process the geometry page (page 2)
    const startPage = parseInt(page, 10);
    const lastPage = endPage ? parseInt(endPage, 10) : startPage;
    const geometryPageNum = lastPage > startPage ? startPage + 1 : startPage;

    // Download the geometry page
    const pdfBuf = await downloadPage(book, String(geometryPageNum));
    if (!pdfBuf) {
      // Fallback: try merged PDF
      const merged = await searchRecorder(book, page, endPage);
      if (!merged) {
        return new Response(
          JSON.stringify({ error: "Could not download map" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return await generateFromPdf(merged, book, page, endPage);
    }

    return await generateFromPdf(pdfBuf, book, page, endPage);
  } catch (err) {
    console.error("[generate-dxf] Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "DXF generation failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

async function generateFromPdf(
  pdfBuf: Buffer,
  book: string,
  page: string,
  endPage?: string,
): Promise<Response> {
  // Render to PNG
  const rendered = await renderPdfToPng(pdfBuf, 2048);
  if (!rendered) {
    return new Response(
      JSON.stringify({ error: "Could not render PDF to image" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Vectorize
  const traces = await vectorize(rendered.base64);
  if (traces.length === 0) {
    return new Response(
      JSON.stringify({ error: "Vectorization produced no paths" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Convert to DXF
  const dxfContent = tracesToDxf(traces, rendered.width, rendered.height);

  const filename = endPage
    ? `site-plan-bk${book}-pg${page}-${endPage}.dxf`
    : `site-plan-bk${book}-pg${page}.dxf`;

  return new Response(dxfContent, {
    headers: {
      "Content-Type": "application/dxf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * Convert potrace paths to a DXF file.
 * Coordinates are in the PDF's native units (points, 1/72 inch).
 */
function tracesToDxf(
  traces: TracedPath[],
  imageWidth: number,
  imageHeight: number,
): string {
  const dxf = new DxfWriter();
  dxf.setUnits(Units.Inches);

  dxf.addLayer("0", 7, "CONTINUOUS");

  dxf.setCurrentLayerName("0");

  // Convert image pixel coords to inches (assuming ~150 DPI effective)
  // The PDF was rendered at "scale-to 2048", so we need to map back
  // to the original document size. Typical tract maps are ~18"x24" or ~24"x36".
  // At 2048px on the long side, scale = 2048 / (longSide * 72) where 72 = points/inch
  // We don't know the exact DPI, so use pixels directly — the user can scale in CAD.
  // Just flip Y so it's right-side up.

  for (const path of traces) {
    const pts = path.points;
    if (pts.length < 2) continue;

    for (let i = 0; i < pts.length - 1; i++) {
      dxf.addLine(
        { x: pts[i].x, y: imageHeight - pts[i].y, z: 0 },
        { x: pts[i + 1].x, y: imageHeight - pts[i + 1].y, z: 0 },
      );
    }
  }

  return dxf.stringify();
}
