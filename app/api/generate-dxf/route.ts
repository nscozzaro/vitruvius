import { NextRequest } from "next/server";
import { searchRecorder } from "@/app/lib/recorder";
import { renderPdfToPng, applyMask, vectorize } from "@/app/lib/vectorize";
import {
  analyzeStage1, analyzeStage2,
  type Stage1Result, type Stage2Result, type MapMetadata,
} from "@/app/lib/map-analyzer";
import { generateDxf } from "@/app/lib/dxf";
import type { TracedPath } from "@/app/lib/vectorize";

/**
 * POST /api/generate-dxf
 *
 * Generates a DXF site plan from a county surveyor map.
 * Gracefully handles PDF rendering failures — outputs whatever
 * data is available (AI-extracted geometry and/or vectorized traces).
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

    // Step 2: Render to PNG (may fail on serverless — that's OK)
    const rendered = await renderPdfToPng(pdfBuf, 2048);

    let metadata: MapMetadata = {
      book,
      pages: endPage ? `${page}-${endPage}` : page,
    };
    let geometry: Stage2Result = {
      lots: [], streets: [], easements: [], monuments: [],
    };
    let traces: TracedPath[] = [];
    let imgWidth = 1396;
    let imgHeight = 2048;

    if (rendered) {
      imgWidth = rendered.width;
      imgHeight = rendered.height;

      // Step 3: AI call #1 — extract metadata + mask regions
      let stage1: Stage1Result = { metadata: {}, mask_regions: [] };
      try {
        stage1 = await analyzeStage1(rendered.base64);
        metadata = { ...metadata, ...stage1.metadata };
      } catch (err) {
        console.error("[generate-dxf] Stage 1 AI error:", err);
      }

      // Step 4: Mask and vectorize
      try {
        const maskedBase64 = await applyMask(
          rendered.base64, rendered.width, rendered.height, stage1.mask_regions,
        );
        traces = await vectorize(maskedBase64);
      } catch (err) {
        console.error("[generate-dxf] Vectorize error:", err);
      }

      // Step 5: AI call #2 — extract geometry
      try {
        geometry = await analyzeStage2(rendered.base64);
      } catch (err) {
        console.error("[generate-dxf] Stage 2 AI error:", err);
      }
    } else {
      console.warn("[generate-dxf] PDF rendering failed — geometry-only DXF");
    }

    // Step 6: Generate DXF
    const dxfContent = generateDxf(traces, geometry, metadata, imgWidth, imgHeight);

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
