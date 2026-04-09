/**
 * Tiled VLM-based OCR using NVIDIA NIM (Llama 4 Maverick).
 *
 * Pipeline per page:
 *   1. Render PDF page at 300 DPI via mupdf
 *   2. Split into overlapping 2048×2048 grid tiles (25% overlap)
 *   3. Send each tile serially to Maverick with document context
 *   4. Convert tile-local positions to full-image coordinates
 *   5. Run VLM merge pass — Maverick reconciles overlapping detections,
 *      fixes text split across tile boundaries, and produces clean output
 */

import { renderPdfToPng } from "./vectorize";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrTextItem {
  text: string;
  bbox: OcrBbox;
  confidence: "high" | "medium" | "low";
  type: "bearing" | "distance" | "curve" | "label" | "lot" | "street" | "monument" | "note" | "title" | "other";
}

export interface OcrPageResult {
  pageIndex: number;
  width: number;
  height: number;
  dpi: number;
  items: OcrTextItem[];
  fullText: string;
  tileCount: number;
  rawItemCount: number;
  mergedItemCount: number;
}

export interface OcrResult {
  pages: OcrPageResult[];
  fullText: string;
  documentContext: DocumentContext;
}

export interface DocumentContext {
  documentType: string;
  book: string;
  page: string;
  endPage?: string;
  tractNumber?: string;
}

export interface OcrProgress {
  phase: "rendering" | "tiling" | "analyzing" | "merging" | "done" | "error";
  pageIndex: number;
  totalPages: number;
  tileIndex?: number;
  totalTiles?: number;
  percent: number;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Tile generation                                                    */
/* ------------------------------------------------------------------ */

interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
  col: number;
  base64: string;
}

const MAX_TILE_SIZE = 2048;
const OVERLAP_RATIO = 0.15; // 15% overlap — enough to catch boundary text, fewer tiles

function computeTileGrid(
  imgWidth: number,
  imgHeight: number,
): Array<{ x: number; y: number; w: number; h: number; row: number; col: number }> {
  const step = Math.floor(MAX_TILE_SIZE * (1 - OVERLAP_RATIO));
  const tiles: Array<{ x: number; y: number; w: number; h: number; row: number; col: number }> = [];

  let row = 0;
  for (let y = 0; y < imgHeight; y += step) {
    let col = 0;
    for (let x = 0; x < imgWidth; x += step) {
      const w = Math.min(MAX_TILE_SIZE, imgWidth - x);
      const h = Math.min(MAX_TILE_SIZE, imgHeight - y);
      if (w >= 256 && h >= 256) {
        tiles.push({ x, y, w, h, row, col });
      }
      col++;
    }
    row++;
  }

  return tiles;
}

/* ------------------------------------------------------------------ */
/*  Image tiling via sharp                                             */
/* ------------------------------------------------------------------ */

async function extractTiles(
  pngBase64: string,
  imgWidth: number,
  imgHeight: number,
): Promise<Tile[]> {
  const sharp = (await import("sharp")).default;
  const fullBuf = Buffer.from(pngBase64, "base64");
  const grid = computeTileGrid(imgWidth, imgHeight);

  const tiles = await Promise.all(
    grid.map(async (g) => {
      const tileBuf = await sharp(fullBuf)
        .extract({ left: g.x, top: g.y, width: g.w, height: g.h })
        .png()
        .toBuffer();
      return { ...g, base64: tileBuf.toString("base64") };
    }),
  );

  return tiles;
}

/* ------------------------------------------------------------------ */
/*  NIM API helpers                                                    */
/* ------------------------------------------------------------------ */

const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = "meta/llama-4-maverick-17b-128e-instruct";

/**
 * Adaptive rate limiter: starts fast, slows down on 429s.
 * Tracks a minimum interval between calls that increases on rate limits.
 */
let callIntervalMs = 200; // Start aggressive (~300 req/min)
const MIN_INTERVAL = 200;
const MAX_INTERVAL = 3000;
let lastCallTime = 0;

async function nimCall(
  messages: Array<{ role: string; content: unknown }>,
  apiKey: string,
  maxTokens = 4096,
): Promise<string> {
  // Respect current rate limit interval
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < callIntervalMs) {
    await new Promise((r) => setTimeout(r, callIntervalMs - elapsed));
  }
  lastCallTime = Date.now();

  let resp: Response | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    resp = await fetch(NIM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (resp.status === 429) {
      // Back off: double the interval (capped at MAX_INTERVAL)
      callIntervalMs = Math.min(callIntervalMs * 2, MAX_INTERVAL);
      const wait = callIntervalMs * (attempt + 1);
      console.warn(`[vlm-ocr] 429 — interval now ${callIntervalMs}ms, waiting ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
      lastCallTime = Date.now();
      continue;
    }

    // Success — gradually speed back up
    callIntervalMs = Math.max(callIntervalMs * 0.9, MIN_INTERVAL);
    break;
  }

  if (!resp || !resp.ok) {
    const errText = await resp?.text().catch(() => "") ?? "";
    console.error(`[vlm-ocr] NIM error ${resp?.status}: ${errText}`);
    return "[]";
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "[]";
}

function parseJsonResponse(content: string): unknown[] {
  let jsonStr = content.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error("[vlm-ocr] JSON parse failed:", jsonStr.slice(0, 200));
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Step 1: Tile extraction                                            */
/* ------------------------------------------------------------------ */

function buildBatchTilePrompt(
  ctx: DocumentContext,
  tiles: Tile[],
  imgW: number,
  imgH: number,
): string {
  const tileDescs = tiles
    .map(
      (t, i) =>
        `Image ${i + 1}: tile at pixels (${t.x},${t.y}) to (${t.x + t.w},${t.y + t.h}), row ${t.row} col ${t.col}`,
    )
    .join("\n");

  return `You are reading tiles from a ${ctx.documentType} (Book ${ctx.book}, Page ${ctx.page}${ctx.tractNumber ? `, Tract ${ctx.tractNumber}` : ""}).
The full document is ${imgW}×${imgH} pixels at 200 DPI. Tiles overlap by 15%.

${tileDescs}

Extract ALL visible text from ALL images. For survey documents, pay special attention to:
- Bearings (e.g., N 45°30'15" W) — type: "bearing"
- Distances (e.g., 125.00') — type: "distance"
- Curve data (R=, L=, Δ=, T=) — type: "curve"
- Lot/block numbers — type: "lot"
- Street names — type: "street"
- Monument markers (I.P., R.C.E., L.S.) — type: "monument"
- Title text, sheet labels — type: "title"
- Notes, legal descriptions — type: "note"
- All other text — type: "other"

For EACH text item return:
{
  "image": 1-${tiles.length} (which image the text appears in),
  "text": "exact text as written",
  "type": "bearing|distance|curve|lot|street|monument|title|note|other",
  "confidence": "high|medium|low",
  "x_pct": 0-100 (horizontal center position as % of that tile's width),
  "y_pct": 0-100 (vertical center position as % of that tile's height),
  "w_pct": 0-100 (approximate text width as % of tile width),
  "h_pct": 0-100 (approximate text height as % of tile height)
}

Return ONLY a JSON array. No markdown fences, no explanation. Empty tiles → [].`;
}

interface RawTileItem {
  text: string;
  type?: string;
  confidence?: string;
  x_pct?: number;
  y_pct?: number;
  w_pct?: number;
  h_pct?: number;
}

function tileItemToOcrItem(raw: RawTileItem, tile: Tile): OcrTextItem {
  const tw = tile.w || 1;
  const th = tile.h || 1;
  const cx = (raw.x_pct ?? 50) / 100;
  const cy = (raw.y_pct ?? 50) / 100;
  const hw = ((raw.w_pct ?? 5) / 100) * tw / 2;
  const hh = ((raw.h_pct ?? 3) / 100) * th / 2;

  return {
    text: raw.text.trim(),
    type: (raw.type as OcrTextItem["type"]) || "other",
    confidence: (raw.confidence as OcrTextItem["confidence"]) || "medium",
    bbox: {
      x0: Math.round(tile.x + cx * tile.w - hw),
      y0: Math.round(tile.y + cy * tile.h - hh),
      x1: Math.round(tile.x + cx * tile.w + hw),
      y1: Math.round(tile.y + cy * tile.h + hh),
    },
  };
}

/** Analyze up to 5 tiles in a single VLM call (multi-image). */
async function analyzeTileBatch(
  tiles: Tile[],
  ctx: DocumentContext,
  imgW: number,
  imgH: number,
  apiKey: string,
): Promise<OcrTextItem[]> {
  const prompt = buildBatchTilePrompt(ctx, tiles, imgW, imgH);

  const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: "text", text: prompt },
  ];
  for (const tile of tiles) {
    contentParts.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${tile.base64}` },
    });
  }

  const content = await nimCall(
    [{ role: "user", content: contentParts }],
    apiKey,
    8192, // More tokens for multi-tile response
  );

  const rawItems = parseJsonResponse(content) as (RawTileItem & { image?: number })[];
  console.log(`[vlm-ocr] Batch of ${tiles.length} tiles returned ${rawItems.length} items. First 200 chars: ${content.substring(0, 200)}`);
  const results: OcrTextItem[] = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object" || !raw.text || !raw.text.trim()) continue;
    // Map image index (1-based) to the correct tile
    // Model may return image as number, string like "1", or string like "1-1"
    const imageNum = typeof raw.image === "number" ? raw.image : parseInt(String(raw.image ?? "1"), 10);
    const tileIdx = Math.max(0, Math.min(tiles.length - 1, (isNaN(imageNum) ? 1 : imageNum) - 1));
    const tile = tiles[tileIdx];
    if (!tile) continue;
    try {
      results.push(tileItemToOcrItem(raw, tile));
    } catch (err) {
      console.warn("[vlm-ocr] skipping malformed item:", raw, err);
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Step 2: Programmatic dedup + spatial sort (no VLM — preserves text)*/
/* ------------------------------------------------------------------ */

function centerDist(a: OcrBbox, b: OcrBbox): number {
  const cx1 = (a.x0 + a.x1) / 2;
  const cy1 = (a.y0 + a.y1) / 2;
  const cx2 = (b.x0 + b.x1) / 2;
  const cy2 = (b.y0 + b.y1) / 2;
  return Math.sqrt((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2);
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Purely programmatic dedup. Preserves original text exactly.
 *
 * Strategy:
 *  1. Exact match within 100px → keep higher confidence or longer text
 *  2. Normalized match (case/whitespace) within 100px → same
 *  3. One text is a substring of the other within 80px → keep the longer one
 *  4. Sort results spatially: top-to-bottom rows, left-to-right within rows
 */
function deduplicateAndSort(items: OcrTextItem[]): OcrTextItem[] {
  const kept: OcrTextItem[] = [];

  // Confidence ranking for comparison
  const confRank = { high: 3, medium: 2, low: 1 };

  for (const item of items) {
    let dominated = false;

    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i];
      const dist = centerDist(existing.bbox, item.bbox);

      // Exact text match nearby
      if (existing.text === item.text && dist < 100) {
        dominated = true;
        break;
      }

      // Normalized text match nearby
      if (normalizeText(existing.text) === normalizeText(item.text) && dist < 100) {
        // Keep the one with higher confidence, or longer raw text
        if (
          confRank[item.confidence] > confRank[existing.confidence] ||
          (confRank[item.confidence] === confRank[existing.confidence] &&
            item.text.length > existing.text.length)
        ) {
          kept[i] = { ...item };
        }
        dominated = true;
        break;
      }

      // Substring containment nearby — keep the longer one
      if (dist < 80) {
        const normA = normalizeText(existing.text);
        const normB = normalizeText(item.text);
        if (normA.includes(normB)) {
          dominated = true;
          break;
        }
        if (normB.includes(normA)) {
          kept[i] = { ...item };
          dominated = true;
          break;
        }
      }
    }

    if (!dominated) {
      kept.push({ ...item });
    }
  }

  // Default sort: top-to-bottom, left-to-right (used as fallback)
  kept.sort((a, b) => {
    const ay = (a.bbox.y0 + a.bbox.y1) / 2;
    const by = (b.bbox.y0 + b.bbox.y1) / 2;
    if (Math.abs(ay - by) > 30) return ay - by;
    return (a.bbox.x0 + a.bbox.x1) / 2 - (b.bbox.x0 + b.bbox.x1) / 2;
  });

  return kept;
}

/**
 * VLM QC pass — sends the full page image + OCR items list.
 * Model verifies each item's text against what it sees and returns corrections.
 * Only corrected items are updated; uncorrected items keep their original text.
 * Processes items in batches to stay within token limits.
 */
const QC_BATCH_SIZE = 30;

async function vlmQcPass(
  items: OcrTextItem[],
  ctx: DocumentContext,
  pageIndex: number,
  imgW: number,
  imgH: number,
  pageImageBase64: string,
  apiKey: string,
  onProgress: (msg: string) => void,
): Promise<OcrTextItem[]> {
  if (items.length === 0) return items;

  const result = [...items];
  const totalBatches = Math.ceil(items.length / QC_BATCH_SIZE);

  for (let b = 0; b < items.length; b += QC_BATCH_SIZE) {
    const batchItems = items.slice(b, b + QC_BATCH_SIZE);
    const batchNum = Math.floor(b / QC_BATCH_SIZE) + 1;
    onProgress(`QC batch ${batchNum}/${totalBatches} (${batchItems.length} items)...`);

    const itemList = batchItems
      .map((item, i) => {
        const cx = Math.round((item.bbox.x0 + item.bbox.x1) / 2);
        const cy = Math.round((item.bbox.y0 + item.bbox.y1) / 2);
        return `${b + i}: (${cx},${cy}) "${item.text}"`;
      })
      .join("\n");

    const prompt = `You are quality-checking OCR results from a ${ctx.documentType} (Book ${ctx.book}, Page ${ctx.page}${ctx.tractNumber ? `, Tract ${ctx.tractNumber}` : ""}, Sheet ${pageIndex + 1}).

The attached image shows the full page (${imgW}×${imgH}px). Look at each item's position on the page and verify the text is correct.

Items to verify (index, center position in pixels, current text):
${itemList}

For each item, compare the OCR text against what you actually see at that location in the image. Return ONLY items that need correction as a JSON array:
[{"i": <index>, "text": "<corrected text>"}]

Rules:
- ONLY return items that have errors. If all items are correct, return [].
- Fix misspellings, wrong characters, missing degree/minute/second symbols
- Bearings must be exact: N/S + degrees + ° + minutes + ' + seconds + " + E/W
- Distances must preserve decimal precision (e.g., 125.00' not 125')
- Do NOT add or remove items — only correct existing text
- Return ONLY the JSON array. No markdown, no explanation.`;

    const content = await nimCall(
      [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${pageImageBase64}` } },
          ],
        },
      ],
      apiKey,
      4096,
    );

    // Parse corrections
    const corrections = parseJsonResponse(content) as Array<{ i: number; text: string }>;
    let correctionCount = 0;

    for (const corr of corrections) {
      if (
        typeof corr.i === "number" &&
        corr.i >= 0 &&
        corr.i < items.length &&
        typeof corr.text === "string" &&
        corr.text.trim()
      ) {
        result[corr.i] = { ...result[corr.i], text: corr.text.trim() };
        correctionCount++;
      }
    }

    console.log(`[vlm-ocr] QC batch ${batchNum}: ${correctionCount} corrections applied`);
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Main pipeline                                                      */
/* ------------------------------------------------------------------ */

export async function vlmOcrDocument(
  pdfBuf: Buffer,
  totalPages: number,
  docContext: DocumentContext,
  onProgress: (p: OcrProgress) => void,
): Promise<OcrResult> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not set");

  const pages: OcrPageResult[] = [];

  for (let i = 0; i < totalPages; i++) {
    // Step 0: Render
    onProgress({
      phase: "rendering",
      pageIndex: i,
      totalPages,
      percent: Math.round((i / totalPages) * 100),
      message: `Rendering page ${i + 1} of ${totalPages} at 200 DPI...`,
    });

    const rendered = await renderPdfToPng(pdfBuf, i, 200);
    if (!rendered) continue;

    // Step 1: Tile
    onProgress({
      phase: "tiling",
      pageIndex: i,
      totalPages,
      percent: Math.round((i / totalPages) * 100),
      message: `Splitting page ${i + 1} into tiles...`,
    });

    const tiles = await extractTiles(rendered.base64, rendered.width, rendered.height);

    // Step 2: Analyze tiles — 1 tile per call for maximum detail
    const rawItems: OcrTextItem[] = [];

    for (let t = 0; t < tiles.length; t++) {
      onProgress({
        phase: "analyzing",
        pageIndex: i,
        totalPages,
        tileIndex: t,
        totalTiles: tiles.length,
        percent: Math.round(((i + t / tiles.length) / totalPages) * 100),
        message: `Page ${i + 1}: analyzing tile ${t + 1} of ${tiles.length}...`,
      });

      const items = await analyzeTileBatch(
        [tiles[t]],
        docContext,
        rendered.width,
        rendered.height,
        apiKey,
      );
      rawItems.push(...items);
    }

    // Step 3: Programmatic dedup (preserves original text exactly)
    onProgress({
      phase: "merging",
      pageIndex: i,
      totalPages,
      percent: Math.round(((i + 0.9) / totalPages) * 100),
      message: `Page ${i + 1}: deduplicating ${rawItems.length} items...`,
    });

    const deduped = deduplicateAndSort(rawItems);

    // Step 4: VLM QC verification pass — model checks OCR text against the image
    onProgress({
      phase: "merging",
      pageIndex: i,
      totalPages,
      percent: Math.round(((i + 0.93) / totalPages) * 100),
      message: `Page ${i + 1}: verifying ${deduped.length} items...`,
    });

    // Resize full page to fit Maverick's 2048×2048 input
    const sharp = (await import("sharp")).default;
    const pageBuf = await sharp(Buffer.from(rendered.base64, "base64"))
      .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const pageImageBase64 = pageBuf.toString("base64");

    const merged = await vlmQcPass(
      deduped,
      docContext,
      i,
      rendered.width,
      rendered.height,
      pageImageBase64,
      apiKey,
      (msg) =>
        onProgress({
          phase: "merging",
          pageIndex: i,
          totalPages,
          percent: Math.round(((i + 0.95) / totalPages) * 100),
          message: `Page ${i + 1}: ${msg}`,
        }),
    );

    pages.push({
      pageIndex: i,
      width: rendered.width,
      height: rendered.height,
      dpi: 200,
      items: merged,
      fullText: merged.map((d) => d.text).join("\n"),
      tileCount: tiles.length,
      rawItemCount: rawItems.length,
      mergedItemCount: merged.length,
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
    fullText: pages
      .map((p) => `--- Page ${p.pageIndex + 1} ---\n${p.fullText}`)
      .join("\n\n"),
    documentContext: docContext,
  };
}
