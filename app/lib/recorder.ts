/**
 * Santa Barbara County Surveyor — recorded map lookup.
 *
 * The County Surveyor's office hosts all recorded maps at
 * surveyor.countyofsb.org with a clean REST API:
 *
 *   GET /mapview/api/rm/{book}/{page}
 *   → { FileURLFull, FileExists, ... }
 *
 * Multi-page maps (e.g., pages 20-22) are stored as separate PDFs.
 * This module downloads all pages and merges them into a single PDF.
 */

import { PDFDocument } from "pdf-lib";

const SURVEYOR_API = "https://surveyor.countyofsb.org/mapview/api/rm";

interface SurveyorResponse {
  FileURLFull: string;
  FileExists: boolean;
}

/**
 * Downloads a recorded map by book/page range from the County Surveyor.
 * Returns a merged PDF Buffer, or null if not found.
 *
 * @param book   - Book number (e.g., "76")
 * @param page   - Start page (e.g., "20")
 * @param endPage - End page if multi-page (e.g., "22" for pages 20-22)
 */
export async function searchRecorder(
  book: string,
  page: string,
  endPage?: string,
): Promise<Buffer | null> {
  const startPage = parseInt(page, 10);
  const lastPage = endPage ? parseInt(endPage, 10) : startPage;

  if (isNaN(startPage) || isNaN(lastPage) || lastPage < startPage) {
    return null;
  }

  // Cap at 10 pages to avoid runaway downloads
  const pageCount = Math.min(lastPage - startPage + 1, 10);

  try {
    // Download all pages in parallel
    const downloads = [];
    for (let p = startPage; p < startPage + pageCount; p++) {
      downloads.push(downloadPage(book, String(p)));
    }
    const pages = await Promise.all(downloads);

    // Filter out any pages that failed to download
    const validPages = pages.filter((buf): buf is Buffer => buf !== null);
    if (validPages.length === 0) return null;

    // If only one page, return it directly
    if (validPages.length === 1) return validPages[0];

    // Merge multiple pages into a single PDF
    const merged = await PDFDocument.create();
    for (const buf of validPages) {
      const doc = await PDFDocument.load(buf);
      const copiedPages = await merged.copyPages(doc, doc.getPageIndices());
      for (const cp of copiedPages) {
        merged.addPage(cp);
      }
    }

    const mergedBytes = await merged.save();
    return Buffer.from(mergedBytes);
  } catch (err) {
    console.error("Recorder merge error:", err);
    return null;
  }
}

/** Downloads a single page PDF from the surveyor. */
async function downloadPage(
  book: string,
  page: string,
): Promise<Buffer | null> {
  try {
    const resp = await fetch(`${SURVEYOR_API}/${book}/${page}`, {
      headers: { "User-Agent": "Vitruvius/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;

    const data: SurveyorResponse = await resp.json();
    if (!data.FileExists || !data.FileURLFull) return null;

    const pdfUrl = data.FileURLFull.replace("http://", "https://");
    const pdfResp = await fetch(pdfUrl, {
      headers: { "User-Agent": "Vitruvius/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!pdfResp.ok) return null;

    return Buffer.from(await pdfResp.arrayBuffer());
  } catch {
    return null;
  }
}
