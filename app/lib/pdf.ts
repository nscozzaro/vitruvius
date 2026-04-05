/**
 * PDF utilities for the tract-map pipeline.
 *
 * fetchPdf             – download a PDF to a Buffer
 * extractTractReference – find the recorded map book/page inside a PDF
 *                         (tries text layer first, then vision LLM on rendered image)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink } from "fs/promises";
import { callLLM, callVisionLLM } from "@/app/lib/llm";
import type { TractInfo } from "@/app/lib/types";

const execFileAsync = promisify(execFile);

// pdftoppm may live in different places depending on the OS / install method.
const PDFTOPPM_CANDIDATES = [
  "/opt/homebrew/bin/pdftoppm", // macOS (Homebrew, Apple Silicon)
  "/usr/local/bin/pdftoppm",    // macOS (Homebrew, Intel)
  "pdftoppm",                   // Linux / PATH fallback
];

export async function fetchPdf(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Vitruvius/1.0" },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Attempts to extract a recorded-map book/page reference from a PDF.
 *
 * Strategy:
 *   1. Extract embedded text (fast, works for text-layer PDFs).
 *      a. Try regex patterns first.
 *      b. Fall back to a text LLM call.
 *   2. If no text layer, render page 1 to a PNG and call the vision LLM.
 */
export async function extractTractReference(
  pdfBuf: Buffer,
): Promise<TractInfo | null> {
  // ── Path A: text layer ─────────────────────────────────────────────
  const text = await extractPdfText(pdfBuf);
  if (text) {
    const fromRegex = parseTractFromText(text);
    if (fromRegex) return fromRegex;

    try {
      const raw = await callLLM(
        [
          {
            role: "system",
            content:
              `You are analyzing text from a Santa Barbara County Assessor's parcel map PDF. ` +
              `Find the RECORDED MAP reference. Look for patterns like:\n` +
              `- "R.M. Bk. 15, Pg. 81" (most common format)\n` +
              `- "T.M. 76/20-22", "P.M. 45/67", "BK 76 PG 20"\n\n` +
              `Reply ONLY with JSON: {"book":"15","page":"81","tractNumber":null,"mapType":"Recorded Map","rawText":"R.M. Bk. 15, Pg. 81"}\n` +
              `If not found: {"book":null,"page":null}`,
          },
          { role: "user", content: text.slice(0, 8000) },
        ],
        { maxTokens: 256, temperature: 0 },
      );
      return tractInfoFromJSON(raw);
    } catch { /* fall through to vision */ }
  }

  // ── Path B: scanned image ──────────────────────────────────────────
  const pngBase64 = await renderPdfToPng(pdfBuf);
  if (!pngBase64) return null;

  try {
    const raw = await callVisionLLM(
      `You are analyzing a Santa Barbara County Assessor's parcel map (scanned document). ` +
      `Find the RECORDED MAP reference. It is usually printed at the BOTTOM of the page in small text. Look for these patterns:\n` +
      `- "R.M. Bk. 15, Pg. 81" (Recorded Map Book/Page — most common)\n` +
      `- "T.M. 76/20-22" or "TRACT MAP BOOK 76 PAGE 20"\n` +
      `- "P.M. 45/67" (Parcel Map)\n` +
      `- "BK 76 PG 20" or "76/20" annotations within the map\n` +
      `- "R.M. Bk. XX, Pg. YY — [Tract Name]"\n\n` +
      `The reference may include a page range like "Pg. 20-22" (3 pages) or a tract name like "Isla Vista Tract".\n\n` +
      `Reply ONLY with JSON: {"book":"15","page":"81","tractNumber":null,"mapType":"Recorded Map","rawText":"R.M. Bk. 15, Pg. 81 — Isla Vista Tract"}\n` +
      `If not found: {"book":null,"page":null}`,
      pngBase64,
      "image/png",
      "Look carefully at the BOTTOM of the map for the recorded map book and page reference (R.M. Bk. XX, Pg. YY).",
      { maxTokens: 256, temperature: 0 },
    );
    console.log("[vision] LLM response:", raw);
    return tractInfoFromJSON(raw);
  } catch (err) {
    console.error("[vision] LLM error:", err);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function extractPdfText(buf: Buffer): Promise<string | null> {
  try {
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
    const result = await pdfParse(buf);
    return result.text?.trim() || null;
  } catch {
    return null;
  }
}

async function renderPdfToPng(buf: Buffer): Promise<string | null> {
  const id = Math.random().toString(36).slice(2);
  const pdfPath = join(tmpdir(), `tractmap-${id}.pdf`);
  const pngPrefix = join(tmpdir(), `tractmap-${id}`);

  try {
    await writeFile(pdfPath, buf);

    // Render page 1 to PNG, capped at 2048px on the longest side
    // (Llama Maverick vision model max resolution is 2048x2048)
    let rendered = false;
    for (const bin of PDFTOPPM_CANDIDATES) {
      try {
        await execFileAsync(bin, [
          "-png", "-f", "1", "-l", "1",
          "-scale-to", "2048",
          pdfPath, pngPrefix,
        ]);
        rendered = true;
        break;
      } catch { /* try next candidate */ }
    }
    if (!rendered) return null;

    for (const suffix of ["-1.png", "-01.png", "-001.png"]) {
      try {
        const png = await readFile(pngPrefix + suffix);
        return png.toString("base64");
      } catch { /* try next suffix */ }
    }
    return null;
  } finally {
    await unlink(pdfPath).catch(() => {});
  }
}

function parseTractFromText(text: string): TractInfo | null {
  // Match patterns with page ranges first (e.g., "T.M. 76/20-22")
  const withRange =
    text.match(/R\.?\s*M\.?\s+Bk\.?\s*(\d+)\s*,?\s*Pg\.?\s*(\d+)\s*[-–]\s*(\d+)/i) ||
    text.match(/T\.?M\.?\s+(\d+)\s*[/\-]\s*(\d+)\s*[-–]\s*(\d+)/i) ||
    text.match(/P\.?M\.?\s+(\d+)\s*[/\-]\s*(\d+)\s*[-–]\s*(\d+)/i) ||
    text.match(/[Bb](?:oo)?k\.?\s*(\d+)[,\s]+[Pp](?:age|g)s?\.?\s*(\d+)\s*[-–]\s*(\d+)/i) ||
    text.match(/BK\s+(\d+)\s+PG\s+(\d+)\s*[-–]\s*(\d+)/i);
  if (withRange) return { book: withRange[1], page: withRange[2], endPage: withRange[3] };

  // Single page patterns
  const m =
    text.match(/R\.?\s*M\.?\s+Bk\.?\s*(\d+)\s*,?\s*Pg\.?\s*(\d+)/i) ||
    text.match(/T\.?M\.?\s+(\d+)\s*[/\-]\s*(\d+)/i) ||
    text.match(/P\.?M\.?\s+(\d+)\s*[/\-]\s*(\d+)/i) ||
    text.match(/[Bb](?:oo)?k\.?\s*(\d+)[,\s]+[Pp](?:age|g)s?\.?\s*(\d+)/i) ||
    text.match(/BK\s+(\d+)\s+PG\s+(\d+)/i);
  if (!m) return null;
  return { book: m[1], page: m[2] };
}

function tractInfoFromJSON(text: string): TractInfo | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!json.book || !json.page) return null;

  // Parse endPage from rawText if present (e.g., "Pg. 20-22")
  let endPage: string | undefined;
  if (json.rawText) {
    const rangeMatch = String(json.rawText).match(
      /[Pp](?:g|age)s?\.?\s*(\d+)\s*[-–]\s*(\d+)/,
    );
    if (rangeMatch) endPage = rangeMatch[2];
  }

  return {
    book: String(json.book),
    page: String(json.page),
    endPage,
    tractNumber: json.tractNumber ? String(json.tractNumber) : undefined,
    mapType: json.mapType ? String(json.mapType) : undefined,
    rawText: json.rawText ? String(json.rawText) : undefined,
  };
}
