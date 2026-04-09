import { NextRequest } from "next/server";
import { vlmOcrDocument } from "@/app/lib/vlm-ocr";
import type { OcrProgress, DocumentContext } from "@/app/lib/vlm-ocr";
import { createSearchablePdf } from "@/app/lib/pdf-builder";
import { downloadPage, searchRecorder } from "@/app/lib/recorder";

/**
 * POST /api/ocr
 *
 * Accepts { book, page, endPage?, documentType?, tractNumber? }
 * Downloads the PDF, runs tiled VLM OCR with QC verification,
 * then generates a searchable PDF with invisible text layer.
 * Streams progress via SSE, then sends the final result + searchable PDF.
 */

export const maxDuration = 300; // 5 minutes for multi-page OCR

export async function POST(request: NextRequest) {
  const { book, page, endPage, documentType, tractNumber } = await request.json();

  if (!book || !page) {
    return new Response(JSON.stringify({ error: "Missing book/page" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const docContext: DocumentContext = {
    documentType: documentType || "Tract Map",
    book,
    page,
    endPage,
    tractNumber,
  };

  // Download the PDF
  const pdfBuf = await searchRecorder(book, page, endPage);
  if (!pdfBuf) {
    const singlePage = await downloadPage(book, page);
    if (!singlePage) {
      return new Response(
        JSON.stringify({ error: "Could not download map PDF" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    return streamOcr(singlePage, 1, docContext);
  }

  const startPage = parseInt(page, 10);
  const lastPage = endPage ? parseInt(endPage, 10) : startPage;
  const pageCount = Math.min(lastPage - startPage + 1, 10);

  return streamOcr(pdfBuf, pageCount, docContext);
}

function streamOcr(
  pdfBuf: Buffer,
  pageCount: number,
  docContext: DocumentContext,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const result = await vlmOcrDocument(
          pdfBuf,
          pageCount,
          docContext,
          (p: OcrProgress) => {
            send({ type: "progress", ...p });
          },
        );

        // Generate searchable PDF with invisible text layer
        send({ type: "progress", phase: "merging", pageIndex: pageCount - 1, totalPages: pageCount, percent: 99, message: "Building searchable PDF..." });

        let pdfBase64: string | null = null;
        try {
          const searchablePdf = await createSearchablePdf(pdfBuf, result.pages);
          pdfBase64 = Buffer.from(searchablePdf).toString("base64");
        } catch (err) {
          console.error("[ocr] Searchable PDF generation failed:", err);
        }

        send({ type: "result", data: { ...result, pdfBase64 } });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "OCR failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
