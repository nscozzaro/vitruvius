import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * POST /api/extract_pdf_links
 *
 * Extracts hyperlinks from a PDF file using pdftohtml.
 * Returns SmartView Online URLs and their associated Book/Page references.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const tmpPath = join(tmpdir(), `vitruvius-pdf-${Date.now()}.pdf`);
    writeFileSync(tmpPath, buffer);

    let xml = "";
    try {
      xml = execSync(`pdftohtml -xml -stdout "${tmpPath}"`, {
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
      }).toString();
    } catch {
      // pdftohtml not available — try text-only extraction
      try {
        const pdfParse = require("pdf-parse");
        const data = await pdfParse(buffer);
        // Can't extract hyperlinks from text, but return the text for reference matching
        return NextResponse.json({ links: [], text: data.text, bookRefs: extractBookRefs(data.text) });
      } catch {
        return NextResponse.json({ links: [], text: "", bookRefs: [] });
      }
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }

    // Extract SmartView URLs
    const smartviewUrls = [...new Set(
      (xml.match(/https?:\/\/www\.smartviewonline\.net[^"<>\s]+/g) || [])
    )];

    // Also get the text content for Book/Page matching
    let text = "";
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      text = data.text;
    } catch { /* skip */ }

    const bookRefs = extractBookRefs(text);

    return NextResponse.json({
      links: smartviewUrls,
      text: text.slice(0, 50000),
      bookRefs,
    });
  } catch (error) {
    console.error("PDF link extraction error:", error);
    return NextResponse.json({ error: "Extraction failed" }, { status: 500 });
  }
}

function extractBookRefs(text: string): { book: string; pages: string; context: string }[] {
  const refs: { book: string; pages: string; context: string }[] = [];
  const regex = /Book\s+(\d+).*?Pages?\s+([\d\s,to\-and]+)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    // Get surrounding context (50 chars before and after)
    const start = Math.max(0, match.index - 80);
    const end = Math.min(text.length, match.index + match[0].length + 80);
    refs.push({
      book: match[1],
      pages: match[2].trim(),
      context: text.slice(start, end).replace(/\s+/g, " ").trim(),
    });
  }
  return refs;
}
