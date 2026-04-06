import { NextRequest } from "next/server";
import { fetchPdf } from "@/app/lib/parcels";
import { searchRecorder } from "@/app/lib/recorder";
import { renderPdfToPng, applyMask, vectorize } from "@/app/lib/vectorize";
import { analyzeStage1, analyzeStage2 } from "@/app/lib/map-analyzer";
import { generateDxf } from "@/app/lib/dxf";

/**
 * POST /api/generate-dxf
 *
 * Pipeline:
 *   1. Download PDF from county surveyor
 *   2. Render to PNG (capped at 2048px)
 *   3. AI call #1: extract metadata, identify mask regions
 *   4. Mask non-geometry areas, vectorize remaining
 *   5. AI call #2: extract bearings, distances, lots, monuments, easements
 *   6. Compute exact geometry, match-and-replace traced paths
 *   7. Return DXF file
 */

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const { book, page, endPage } = await request.json();

    if (!book || !page) {
      return new Response(JSON.stringify({ error: "Missing book/page" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Step 1: Download PDF
    const pdfBuf = await searchRecorder(book, page, endPage);
    if (!pdfBuf) {
      return new Response(
        JSON.stringify({ error: "Could not download map from county surveyor" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    // Step 2: Render to PNG
    const rendered = await renderPdfToPng(pdfBuf, 2048);
    if (!rendered) {
      return new Response(
        JSON.stringify({ error: "Could not render PDF to image" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // Step 3: AI call #1 — extract metadata and mask regions
    let stage1;
    try {
      stage1 = await analyzeStage1(rendered.base64);
    } catch (err) {
      console.error("[generate-dxf] Stage 1 AI error:", err);
      stage1 = { metadata: {}, mask_regions: [] };
    }

    // Step 4: Mask and vectorize
    const maskedBase64 = await applyMask(
      rendered.base64,
      rendered.width,
      rendered.height,
      stage1.mask_regions,
    );
    const traces = await vectorize(maskedBase64);

    // Step 5: AI call #2 — extract geometry details
    let stage2;
    try {
      stage2 = await analyzeStage2(rendered.base64);
    } catch (err) {
      console.error("[generate-dxf] Stage 2 AI error:", err);
      stage2 = { lots: [], streets: [], easements: [], monuments: [] };
    }

    // Step 6: Generate DXF (compute geometry + match-and-replace traces)
    const dxfContent = generateDxf(
      traces,
      stage2,
      stage1.metadata,
      rendered.width,
      rendered.height,
    );

    // Step 7: Return DXF as file download
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
  } catch (err) {
    console.error("[generate-dxf] Error:", err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "DXF generation failed",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
