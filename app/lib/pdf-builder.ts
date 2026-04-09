/**
 * Creates a searchable PDF by overlaying near-invisible OCR text on the original PDF.
 *
 * Uses 1pt near-white (rgb 0.99) text positioned at each OCR item's bbox.
 * Text is invisible to the eye but searchable via Cmd+F.
 *
 * Pages are kept in their original orientation (portrait, as scanned).
 * Text coordinates match the OCR pixel space directly, ensuring perfect
 * alignment with the scanned image content.
 *
 * Coordinate conversion:
 *   OCR: pixels at 200 DPI, origin top-left
 *   PDF: points (1/72 inch), origin bottom-left
 *   Scale: 72/200 = 0.36
 *   Y-flip: pdfY = pageHeight_pts - ocrY * scale
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { OcrPageResult } from "./vlm-ocr";

const OCR_DPI = 200;
const DPI_SCALE = 72 / OCR_DPI; // 0.36

export async function createSearchablePdf(
  originalPdf: Buffer,
  ocrPages: OcrPageResult[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(originalPdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { height: pageH } = page.getSize();

    const ocrPage = ocrPages.find((p) => p.pageIndex === i);
    if (!ocrPage) continue;

    let successCount = 0;

    for (const item of ocrPage.items) {
      if (!item.text.trim()) continue;

      const safeText = item.text
        .replace(/\u2018|\u2019/g, "'")
        .replace(/\u201C|\u201D/g, '"')
        .replace(/\u2013/g, "-")
        .replace(/\u2014/g, "--")
        .replace(/\u2026/g, "...")
        .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");

      if (!safeText.trim()) continue;

      // OCR bbox → PDF points (same orientation, just scale + Y-flip)
      const pdfX = item.bbox.x0 * DPI_SCALE;
      const bboxH = (item.bbox.y1 - item.bbox.y0) * DPI_SCALE;
      const pdfY = pageH - (item.bbox.y0 * DPI_SCALE) - bboxH;

      try {
        page.drawText(safeText, {
          x: pdfX,
          y: pdfY,
          size: 1,
          font,
          color: rgb(0.99, 0.99, 0.99),
        });
        successCount++;
      } catch {
        // Skip unencodable characters
      }
    }

    console.log(
      `[pdf-builder] Page ${i + 1}: ${successCount}/${ocrPage.items.length} items embedded`,
    );
  }

  return doc.save();
}
