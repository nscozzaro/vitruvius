import { NextRequest } from "next/server";
import { downloadPage } from "@/app/lib/recorder";
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
 *
 * For multi-page maps (e.g., pages 20-22), the first page is typically
 * the title/certification page. We download individual pages and process
 * the SECOND page (the lot geometry sheet) for vectorization and AI analysis.
 * The title page is used only for metadata extraction.
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

    // Determine which page has the lot geometry
    // For multi-page maps: page 1 = title, page 2+ = geometry
    // For single-page maps: that page IS the geometry
    const startPage = parseInt(page, 10);
    const lastPage = endPage ? parseInt(endPage, 10) : startPage;
    const isMultiPage = lastPage > startPage;

    // The geometry page is page 2 for multi-page maps, page 1 for single-page
    const geometryPageNum = isMultiPage ? startPage + 1 : startPage;
    const titlePageNum = isMultiPage ? startPage : null;

    // Step 1: Download the geometry page
    const geometryPdf = await downloadPage(book, String(geometryPageNum));
    if (!geometryPdf) {
      return new Response(
        JSON.stringify({ error: `Could not download page ${geometryPageNum} from county surveyor` }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    // Step 2: Render geometry page to PNG
    const rendered = await renderPdfToPng(geometryPdf, 2048);

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

      // Step 3: If there's a separate title page, extract metadata from it
      if (titlePageNum) {
        try {
          const titlePdf = await downloadPage(book, String(titlePageNum));
          if (titlePdf) {
            const titleRendered = await renderPdfToPng(titlePdf, 2048);
            if (titleRendered) {
              const stage1 = await analyzeStage1(titleRendered.base64);
              metadata = { ...metadata, ...stage1.metadata };
            }
          }
        } catch (err) {
          console.error("[generate-dxf] Title page metadata error:", err);
        }
      }

      // Step 4: Mask and vectorize the GEOMETRY page
      let stage1Geometry: Stage1Result = { metadata: {}, mask_regions: [] };
      try {
        stage1Geometry = await analyzeStage1(rendered.base64);
        // Merge any additional metadata from the geometry page
        if (!metadata.scale && stage1Geometry.metadata.scale) {
          metadata.scale = stage1Geometry.metadata.scale;
        }
      } catch (err) {
        console.error("[generate-dxf] Stage 1 AI error:", err);
      }

      try {
        const maskedBase64 = await applyMask(
          rendered.base64, rendered.width, rendered.height, stage1Geometry.mask_regions,
        );
        traces = await vectorize(maskedBase64);
      } catch (err) {
        console.error("[generate-dxf] Vectorize error:", err);
      }

      // Step 5: Extract geometry from the lot layout page
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
