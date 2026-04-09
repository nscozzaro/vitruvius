import { NextRequest } from "next/server";
import { downloadPage, searchRecorder } from "@/app/lib/recorder";
import { renderPdfToPng } from "@/app/lib/vectorize";
import { DxfWriter, Units } from "@tarikjabiri/dxf";
import { runMapAgent, type AgentResult } from "@/app/lib/map-agent";
import {
  parseBoundarySequence,
  strokesToLegs,
  type LotExtraction,
} from "@/app/lib/surveying-language";
import {
  computeTraverse,
  bowditchAdjust,
  closureError,
  type Point,
} from "@/app/lib/cogo";
import type { TextAnnotation, LegendContext } from "@/app/lib/map-agent";

/**
 * POST /api/generate-dxf
 *
 * Agent-based pipeline:
 *   PDF → render all pages at 300 DPI
 *     → Llama 4 Maverick multi-pass agent (legend, features, DSL, text, validation)
 *     → COGO engine (DSL → coordinates, Bowditch adjustment)
 *     → Multi-layer DXF (AIA-standard layers)
 */

export const maxDuration = 300; // Agent pipeline needs more time

export async function POST(request: NextRequest) {
  try {
    const { book, page, endPage } = await request.json();

    if (!book || !page) {
      return new Response(JSON.stringify({ error: "Missing book/page" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const startPage = parseInt(page, 10);
    const lastPage = endPage ? parseInt(endPage, 10) : startPage;

    console.log(
      `[generate-dxf] Agent mode: book=${book} pages=${startPage}-${lastPage}`,
    );

    // Download all pages
    const pageImages: Array<{
      base64: string;
      width: number;
      height: number;
      pageNum: number;
    }> = [];

    for (let p = startPage; p <= lastPage; p++) {
      const pdfBuf = await downloadPage(book, String(p));
      if (!pdfBuf) continue;

      const rendered = await renderPdfToPng(pdfBuf, 0, 300);
      if (!rendered) continue;

      pageImages.push({
        base64: rendered.base64,
        width: rendered.width,
        height: rendered.height,
        pageNum: p,
      });
    }

    if (pageImages.length === 0) {
      // Try merged PDF fallback
      const merged = await searchRecorder(book, page, endPage);
      if (!merged) {
        return new Response(
          JSON.stringify({ error: "Could not download map pages" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Render each page of the merged PDF
      const mupdf = await import("mupdf");
      const doc = mupdf.Document.openDocument(merged, "application/pdf");
      const numPages = doc.countPages();

      for (let i = 0; i < numPages; i++) {
        const rendered = await renderPdfToPng(merged, i, 300);
        if (rendered) {
          pageImages.push({
            base64: rendered.base64,
            width: rendered.width,
            height: rendered.height,
            pageNum: startPage + i,
          });
        }
      }
    }

    if (pageImages.length === 0) {
      return new Response(
        JSON.stringify({ error: "Could not render any pages" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    console.log(`[generate-dxf] Rendered ${pageImages.length} pages, running agent...`);

    // Run the multi-pass agent
    const agentResult = await runMapAgent(pageImages);

    console.log(
      `[generate-dxf] Agent complete: ${agentResult.lots.length} lots, ${agentResult.annotations.length} annotations, valid=${agentResult.validation.is_valid}`,
    );

    // Generate multi-layer DXF
    const dxfContent = agentResultToDxf(agentResult);

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

// ─── DXF Generation ───────────────────────────────────────────

/**
 * AIA-standard layer definitions for civil survey drawings.
 */
const LAYERS = {
  "C-PROP": { color: 7, lineType: "CONTINUOUS" }, // White — lot lines
  "C-PROP-ESMT": { color: 2, lineType: "DASHED" }, // Yellow — easements
  "C-PROP-MONU": { color: 1, lineType: "CONTINUOUS" }, // Red — monuments
  "C-PROP-BRNG": { color: 3, lineType: "CONTINUOUS" }, // Green — bearings
  "C-ROAD-CNTR": { color: 6, lineType: "CENTER" }, // Magenta — centerlines
  "C-ANNO-TEXT": { color: 4, lineType: "CONTINUOUS" }, // Cyan — text labels
  "C-ANNO-DIMS": { color: 3, lineType: "CONTINUOUS" }, // Green — dimensions
  "C-ANNO-TTLB": { color: 8, lineType: "CONTINUOUS" }, // Gray — title block
} as const;

/**
 * Convert the full agent result into a multi-layer DXF string.
 */
function agentResultToDxf(result: AgentResult): string {
  const dxf = new DxfWriter();
  dxf.setUnits(Units.Feet);

  // Add DASHED and CENTER linetypes
  // @tarikjabiri/dxf includes CONTINUOUS by default
  try {
    dxf.addLType("DASHED", "__ __ __ __", [0.5, -0.25]);
    dxf.addLType("CENTER", "____ _ ____ _ ____", [1.25, -0.25, 0.25, -0.25]);
  } catch {
    // Linetypes may already exist
  }

  // Create all layers
  for (const [name, def] of Object.entries(LAYERS)) {
    dxf.addLayer(name, def.color, def.lineType);
  }

  // === Lot boundary polylines (C-PROP) ===
  dxf.setCurrentLayerName("C-PROP");

  for (const lot of result.lots) {
    try {
      const strokes = parseBoundarySequence(lot.boundary_sequence);
      const legs = strokesToLegs(strokes);
      const rawPoints = computeTraverse({ x: 0, y: 0 }, legs);

      // Bowditch adjustment for closure
      const closure = closureError(rawPoints);
      const points =
        closure.error > 0.001 ? bowditchAdjust(rawPoints) : rawPoints;

      if (points.length < 3) continue;

      console.log(
        `[dxf] Lot ${lot.lot}: ${points.length} points, closure=${closure.error.toFixed(3)}' (${closure.ratio})`,
      );

      // Write closed LWPOLYLINE
      addLwPolyline(dxf, points, true);

      // Add lot number text at centroid (C-ANNO-TEXT)
      dxf.setCurrentLayerName("C-ANNO-TEXT");
      const centroid = computeCentroid(points);
      dxf.addText(
        { x: centroid.x, y: centroid.y, z: 0 },
        5, // text height
        `LOT ${lot.lot}`,
      );
      dxf.setCurrentLayerName("C-PROP");

      // Add bearing/distance annotations along each leg (C-PROP-BRNG)
      dxf.setCurrentLayerName("C-PROP-BRNG");
      for (let i = 0; i < lot.boundary_sequence.length && i < points.length - 1; i++) {
        const item = lot.boundary_sequence[i];
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        const dx = points[i + 1].x - points[i].x;
        const dy = points[i + 1].y - points[i].y;
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

        // Extract bearing and distance from the stroke text
        const strokeText = extractStrokeLabel(item.stroke);
        if (strokeText) {
          // Use addText with rotation
          dxf.addText(
            { x: midX, y: midY + 2, z: 0 },
            2.5,
            strokeText,
          );
        }
      }
      dxf.setCurrentLayerName("C-PROP");
    } catch (err) {
      console.error(`[dxf] Error processing lot ${lot.lot}:`, err);
    }
  }

  // === Monuments (C-PROP-MONU) ===
  dxf.setCurrentLayerName("C-PROP-MONU");

  // Extract monuments from lot boundary sequences
  for (const lot of result.lots) {
    for (const item of lot.boundary_sequence) {
      if (item.stroke.toUpperCase().includes("MONUMENT")) {
        // Monument at the POB or along the boundary
        // Use the traverse start point for POB monuments
      }
    }

    // Add monument circles at lot corners (traverse points)
    try {
      const strokes = parseBoundarySequence(lot.boundary_sequence);
      const legs = strokesToLegs(strokes);
      const points = computeTraverse({ x: 0, y: 0 }, legs);

      for (const pt of points) {
        dxf.addCircle({ x: pt.x, y: pt.y, z: 0 }, 1.5);
        dxf.addPoint(pt.x, pt.y, 0);
      }
    } catch {
      // Skip if parsing fails
    }
  }

  // === Easements (C-PROP-ESMT) ===
  dxf.setCurrentLayerName("C-PROP-ESMT");

  const easementFeatures = result.features.features.filter(
    (f) => f.feature_type === "easement",
  );
  const easementAnnotations = result.annotations.filter(
    (a) => a.type === "easement_label",
  );

  // Add easement labels as text
  for (const ann of easementAnnotations) {
    // Validate annotation structure before using
    if (typeof ann.x_pct !== "number" || typeof ann.y_pct !== "number" || !ann.text) continue;
    // Position annotations relative to DXF coordinate space
    // (these are approximate since we're using percentages)
    dxf.addText({ x: ann.x_pct, y: 100 - ann.y_pct, z: 0 }, 2, ann.text);
  }

  // === Text annotations (C-ANNO-TEXT) ===
  dxf.setCurrentLayerName("C-ANNO-TEXT");

  for (const ann of result.annotations) {
    if ((ann.type === "street_name" || ann.type === "other") &&
        typeof ann.x_pct === "number" && typeof ann.y_pct === "number" && ann.text) {
      dxf.addText(
        { x: ann.x_pct, y: 100 - ann.y_pct, z: 0 },
        3,
        ann.text,
      );
    }
  }

  // === Title block (C-ANNO-TTLB) ===
  dxf.setCurrentLayerName("C-ANNO-TTLB");

  const titleAnnotations = result.annotations.filter(
    (a) => (a.type === "title" || a.type === "recording_info") &&
           typeof a.x_pct === "number" && typeof a.y_pct === "number" && a.text
  );
  for (const ann of titleAnnotations) {
    dxf.addText(
      { x: ann.x_pct, y: 100 - ann.y_pct, z: 0 },
      2.5,
      ann.text,
    );
  }

  // Add metadata as a comment in the title block area
  if (result.legend.surveyor) {
    dxf.addText({ x: 0, y: -10, z: 0 }, 2, `Surveyor: ${result.legend.surveyor}`);
  }
  if (result.legend.scale) {
    dxf.addText({ x: 0, y: -15, z: 0 }, 2, `Scale: ${result.legend.scale}`);
  }
  if (result.legend.date) {
    dxf.addText({ x: 0, y: -20, z: 0 }, 2, `Date: ${result.legend.date}`);
  }

  return dxf.stringify();
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Add an LWPOLYLINE to the DXF from a series of points.
 */
function addLwPolyline(dxf: DxfWriter, points: Point[], closed: boolean) {
  // @tarikjabiri/dxf doesn't have a direct LWPOLYLINE with close flag,
  // so we add individual line segments and close manually
  for (let i = 0; i < points.length - 1; i++) {
    dxf.addLine(
      { x: points[i].x, y: points[i].y, z: 0 },
      { x: points[i + 1].x, y: points[i + 1].y, z: 0 },
    );
  }
  if (closed && points.length > 2) {
    const last = points[points.length - 1];
    const first = points[0];
    dxf.addLine(
      { x: last.x, y: last.y, z: 0 },
      { x: first.x, y: first.y, z: 0 },
    );
  }
}

/**
 * Compute the centroid of a polygon.
 */
function computeCentroid(points: Point[]): Point {
  let sumX = 0,
    sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  return { x: sumX / points.length, y: sumY / points.length };
}

/**
 * Extract a human-readable label from a DSL stroke string.
 */
function extractStrokeLabel(stroke: string): string | null {
  const lineMatch = stroke.match(
    /<LINE\s*\|\s*([^|]+)\s*\|\s*([^>]+)>/i,
  );
  if (lineMatch) {
    return `${lineMatch[1].trim()}  ${lineMatch[2].trim()}'`;
  }

  const curveMatch = stroke.match(
    /<CURVE\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^>]+)>/i,
  );
  if (curveMatch) {
    return `R=${curveMatch[1].trim()}'  L=${curveMatch[3].trim()}'`;
  }

  return null;
}
