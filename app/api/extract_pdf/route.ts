import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/extract_pdf
 * Extracts text from an uploaded PDF file server-side.
 * For scanned PDFs (images), returns metadata about the document.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);

    const text = (data.text || "").trim();
    const pages = data.numpages || 0;
    const info = data.info || {};

    // If very little text extracted, it's likely a scanned document
    if (text.length < 50) {
      return NextResponse.json({
        text: `[Scanned PDF document: "${file.name}", ${pages} pages, ${(file.size / 1024).toFixed(0)}KB. This appears to be a scanned architectural plan with no extractable text. The document has ${pages} pages of drawings/plans.]`,
        pages,
        info,
        scanned: true,
      });
    }

    return NextResponse.json({
      text,
      pages,
      info,
      scanned: false,
    });
  } catch (error) {
    console.error("PDF extraction error:", error);
    return NextResponse.json(
      { error: "Failed to extract text from PDF" },
      { status: 500 }
    );
  }
}
