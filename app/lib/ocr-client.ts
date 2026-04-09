/**
 * Client-side OCR engine using pdfjs-dist + Tesseract.js.
 *
 * Renders PDF pages to high-res canvas via pdfjs-dist,
 * then runs Tesseract OCR to extract text with bounding boxes.
 * Designed for survey maps with handwritten annotations at all angles.
 */

import { createWorker, PSM, OEM } from "tesseract.js";
import type { Worker, LoggerMessage, Word, Line, Page } from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";

// Use local worker from node_modules (bundled by Next.js)
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: OcrBbox;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBbox;
  words: OcrWord[];
}

export interface OcrPageResult {
  pageIndex: number;
  width: number;
  height: number;
  dpi: number;
  confidence: number;
  lines: OcrLine[];
  fullText: string;
}

export interface OcrResult {
  pages: OcrPageResult[];
  fullText: string;
}

export interface OcrProgress {
  phase: "loading" | "rendering" | "recognizing" | "done" | "error";
  pageIndex: number;
  totalPages: number;
  percent: number; // 0-100 overall
  message: string;
}

/* ------------------------------------------------------------------ */
/*  PDF → Canvas rendering via pdfjs-dist                              */
/* ------------------------------------------------------------------ */

async function renderPdfPageToCanvas(
  pdfBytes: Uint8Array,
  pageIndex: number,
  dpi: number,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  // Copy bytes — getDocument detaches the underlying ArrayBuffer
  const pdf = await getDocument({ data: pdfBytes.slice().buffer }).promise;
  const page = await pdf.getPage(pageIndex + 1); // pdfjs is 1-indexed
  const viewport = page.getViewport({ scale: dpi / 72 });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2d context");

  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();

  return { canvas, width: canvas.width, height: canvas.height };
}

/* ------------------------------------------------------------------ */
/*  Tesseract OCR                                                      */
/* ------------------------------------------------------------------ */

function mapWords(words: Word[]): OcrWord[] {
  return words.map((w) => ({
    text: w.text,
    confidence: w.confidence,
    bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
  }));
}

function mapLines(lines: Line[]): OcrLine[] {
  return lines.map((l) => ({
    text: l.text,
    confidence: l.confidence,
    bbox: { x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 },
    words: mapWords(l.words),
  }));
}

function extractLines(page: Page): OcrLine[] {
  if (!page.blocks) return [];
  const lines: OcrLine[] = [];
  for (const block of page.blocks) {
    for (const para of block.paragraphs) {
      lines.push(...mapLines(para.lines));
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/*  Main pipeline                                                      */
/* ------------------------------------------------------------------ */

const TARGET_DPI = 400;
const FALLBACK_DPI = 300;

export async function ocrDocument(
  pdfUrl: string,
  onProgress: (p: OcrProgress) => void,
): Promise<OcrResult> {
  onProgress({
    phase: "loading",
    pageIndex: 0,
    totalPages: 0,
    percent: 0,
    message: "Downloading PDF...",
  });

  // Try direct fetch first; fall back to proxy for CORS-restricted origins
  let resp = await fetch(pdfUrl).catch(() => null);
  if (!resp || !resp.ok) {
    const proxyUrl = `/api/proxy-pdf?url=${encodeURIComponent(pdfUrl)}`;
    resp = await fetch(proxyUrl);
  }
  if (!resp.ok) throw new Error(`Failed to fetch PDF: ${resp.status}`);
  const pdfBytes = new Uint8Array(await resp.arrayBuffer());

  // Get page count (copy bytes since getDocument detaches the buffer)
  const countDoc = await getDocument({ data: pdfBytes.slice().buffer }).promise;
  const totalPages = countDoc.numPages;
  countDoc.destroy();

  const pages: OcrPageResult[] = [];

  for (let i = 0; i < totalPages; i++) {
    // Render PDF page to canvas
    onProgress({
      phase: "rendering",
      pageIndex: i,
      totalPages,
      percent: Math.round((i / totalPages) * 100),
      message: `Rendering page ${i + 1} of ${totalPages} at high resolution...`,
    });

    let rendered: { canvas: HTMLCanvasElement; width: number; height: number };
    let usedDpi = TARGET_DPI;

    try {
      rendered = await renderPdfPageToCanvas(pdfBytes, i, TARGET_DPI);
    } catch {
      // Canvas allocation failure — fall back to lower DPI
      console.warn(`[ocr] 400 DPI failed for page ${i + 1}, falling back to 300 DPI`);
      usedDpi = FALLBACK_DPI;
      rendered = await renderPdfPageToCanvas(pdfBytes, i, FALLBACK_DPI);
    }

    // Run Tesseract OCR
    onProgress({
      phase: "recognizing",
      pageIndex: i,
      totalPages,
      percent: Math.round((i / totalPages) * 100),
      message: `Recognizing text on page ${i + 1} of ${totalPages}...`,
    });

    const worker: Worker = await createWorker("eng", OEM.DEFAULT, {
      logger: (m: LoggerMessage) => {
        if (m.status === "recognizing text") {
          onProgress({
            phase: "recognizing",
            pageIndex: i,
            totalPages,
            percent: Math.round(((i + m.progress) / totalPages) * 100),
            message: `Recognizing text on page ${i + 1} (${Math.round(m.progress * 100)}%)...`,
          });
        }
      },
    });

    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      user_defined_dpi: String(usedDpi),
    });

    const { data } = await worker.recognize(rendered.canvas, undefined, {
      blocks: true,
    });
    await worker.terminate();

    // Free canvas memory
    rendered.canvas.width = 0;
    rendered.canvas.height = 0;

    const lines = extractLines(data);

    pages.push({
      pageIndex: i,
      width: rendered.width,
      height: rendered.height,
      dpi: usedDpi,
      confidence: data.confidence,
      lines,
      fullText: data.text,
    });
  }

  onProgress({
    phase: "done",
    pageIndex: totalPages - 1,
    totalPages,
    percent: 100,
    message: "OCR complete",
  });

  return {
    pages,
    fullText: pages.map((p) => p.fullText).join("\n\n--- Page Break ---\n\n"),
  };
}
