import { NextRequest } from "next/server";
import { downloadPage, searchRecorder } from "@/app/lib/recorder";
import { renderPdfToPng, vectorize } from "@/app/lib/vectorize";
import { DxfWriter, Units } from "@tarikjabiri/dxf";
import type { TracedChain } from "@/app/lib/vectorize";

/**
 * POST /api/generate-dxf
 *
 * PDF → PNG → Skeletonize → Chain-follow → Simplify → DXF
 * Clean single-line vectorization, no AI.
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

    const startPage = parseInt(page, 10);
    const lastPage = endPage ? parseInt(endPage, 10) : startPage;
    const geometryPageNum = lastPage > startPage ? startPage + 1 : startPage;

    console.log(`[generate-dxf] book=${book} page=${page} endPage=${endPage} → geometryPage=${geometryPageNum}`);
    const pdfBuf = await downloadPage(book, String(geometryPageNum));
    console.log(`[generate-dxf] downloadPage result: ${pdfBuf ? pdfBuf.length + ' bytes' : 'null'}`);
    if (!pdfBuf) {
      console.log(`[generate-dxf] FALLBACK to merged PDF`);
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
  pdfBuf: Buffer, book: string, page: string, endPage?: string,
): Promise<Response> {
  const rendered = await renderPdfToPng(pdfBuf);
  if (!rendered) {
    return new Response(
      JSON.stringify({ error: "Could not render PDF to image" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const chains = await vectorize(rendered.base64);
  if (chains.length === 0) {
    return new Response(
      JSON.stringify({ error: "Vectorization produced no paths" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const dxfContent = chainsToDxf(chains);

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

function chainsToDxf(chains: TracedChain[]): string {
  const dxf = new DxfWriter();
  dxf.setUnits(Units.Unitless);
  dxf.addLayer("0", 7, "CONTINUOUS");
  dxf.setCurrentLayerName("0");

  for (const chain of chains) {
    const pts = chain.points;
    for (let i = 0; i < pts.length - 1; i++) {
      dxf.addLine(
        { x: pts[i].x, y: pts[i].y, z: 0 },
        { x: pts[i + 1].x, y: pts[i + 1].y, z: 0 },
      );
    }
  }

  return dxf.stringify();
}
