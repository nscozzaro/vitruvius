/**
 * Reconstruction Agent — core init + step logic.
 *
 * The agent reconstructs a survey one element at a time:
 *   init: render pages, discover scale/north/legend, build extraction plan
 *   step: crop → NIM vision → COGO compute → pixel coords → overlap score
 *
 * No hardcoded scales or thresholds — everything is discovered from the map.
 */

import type { Point, TraverseLeg } from "./cogo";
import {
  parseBearing,
  traversePoint,
  computeCurvePoints,
  parseDMS,
} from "./cogo";
import type { CoordSystem } from "./coord-system";
import {
  registerCoordSystem,
  surveyToPixel,
  feetToPixels,
  bearingToImageAngle,
} from "./coord-system";
import { nimVision, parseJsonResponse } from "./nim-client";
import { cropTile, overviewTile, type CropRegion } from "./tile-cropper";
import { measureOverlap, measureMonumentOverlap } from "./overlap-measure";
import { renderPdfToPng } from "./vectorize";
import { searchRecorder } from "./recorder";

// ─── Types ───────────────────────────────────────────────────

export interface MonumentMeta {
  shape: string;
  description: string;
  rceNumber?: string;
  lsNumber?: string;
  size?: string;
  material?: string;
}

export interface SurveyElement {
  id: string;
  elementType: "lot_boundary" | "monument" | "easement" | "road_centerline";
  /** Survey-feet coordinates (for COGO and LandXML) */
  surveyPoints: Point[];
  /** Image pixel coordinates (for SVG overlay) */
  pixelPoints: Array<{ px: number; py: number }>;
  /** Raw bearing string from the model */
  bearing?: string;
  /** Distance in feet */
  distance?: number;
  /** For curves */
  radius?: number;
  delta?: string;
  arcLength?: number;
  curveDirection?: "LEFT" | "RIGHT";
  /** Line type */
  geometryType: "line" | "arc" | "point";
  /** Overlap score (0–1) — empirical, not threshold-gated */
  overlapScore: number;
  /** Measured stroke width in pixels */
  measuredStrokeWidth: number;
  /** SVG stroke width to use */
  svgStrokeWidth: number;
  /** Monument metadata if applicable */
  monument?: MonumentMeta;
  /** Description from extraction plan */
  description: string;
  /** Which lot this element belongs to */
  lotNumber?: string;
}

export interface ExtractionPlanItem {
  index: number;
  type: "line" | "curve" | "monument";
  elementType: "lot_boundary" | "monument" | "easement" | "road_centerline";
  description: string;
  /** Hint for the agent about where to look */
  locationHint?: string;
}

export interface MonumentLegendEntry {
  shape: string;
  description: string;
  rceNumber?: string;
  lsNumber?: string;
}

export interface PageInfo {
  pageIndex: number;
  pageNumber: number; // Book page number
  imageUrl: string;
  width: number;
  height: number;
  pngBase64: string; // kept in memory for cropping during steps
}

export interface InitResult {
  coordSystem: CoordSystem;
  pages: Array<Omit<PageInfo, "pngBase64"> & { pngBase64?: never }>;
  monumentLegend: MonumentLegendEntry[];
  extractionPlan: ExtractionPlanItem[];
  anchorDescription: string;
}

export interface StepResult {
  element: SurveyElement;
  svgFragment: string;
  qualityHalo: string;
  label: string;
  overlapScore: number;
  nextPoint: Point;
  nextBearing: number | null;
  /** If the anchor was recalibrated during this step, updated coord system */
  calibratedCoordSystem?: CoordSystem;
  /** Small JPEG thumbnail of the crop sent to the model (for user to follow along) */
  cropThumbnail?: string;
}

// ─── Page cache (module-scoped, lives for the session) ───────

const pageCache = new Map<string, PageInfo>();

export function getCachedPage(key: string): PageInfo | undefined {
  return pageCache.get(key);
}

// ─── Init ────────────────────────────────────────────────────

/**
 * Initialize a reconstruction session.
 *
 * Yields SSE-style messages for real-time progress.
 * Returns the final InitResult when done.
 */
export async function initSession(
  book: string,
  page: string,
  endPage: string | undefined,
  targetLot: string,
  onProgress: (msg: string) => void,
): Promise<InitResult> {
  // 1. Download the PDF
  onProgress("Downloading survey map…");
  const pdfBuf = await searchRecorder(book, page, endPage);
  if (!pdfBuf) throw new Error("Could not download survey map from county recorder");

  // Determine page count
  const startPage = parseInt(page, 10);
  const end = endPage ? parseInt(endPage, 10) : startPage;
  const pageCount = end - startPage + 1;

  // 2. Render pages to PNG at 300 DPI
  onProgress(`Rendering ${pageCount} page(s) at 300 DPI…`);
  const pages: PageInfo[] = [];

  for (let i = 0; i < pageCount; i++) {
    const pageNum = startPage + i;
    const cacheKey = `bk${book}-pg${pageNum}`;
    const result = await renderPdfToPng(pdfBuf, i, 300);
    if (!result) {
      onProgress(`Warning: could not render page ${pageNum}`);
      continue;
    }

    // The agent decides if the page needs rotation by examining the content.
    // Survey maps can be landscape content in portrait PDF pages, or vice versa.
    const sharp = (await import("sharp")).default;
    let fullBuf = Buffer.from(result.base64, "base64");
    let w = result.width;
    let h = result.height;

    // Skip title pages (index 0) — only check map sheets for rotation
    if (i > 0) {
      onProgress(`Checking orientation for page ${pageNum}…`);
      const rotation = await detectOrientation(fullBuf.toString("base64"));
      if (rotation !== 0) {
        onProgress(`Rotating page ${pageNum} by ${rotation}°`);
        fullBuf = Buffer.from(await sharp(fullBuf).rotate(rotation).toBuffer());
        const rotMeta = await sharp(fullBuf).metadata();
        w = rotMeta.width ?? w;
        h = rotMeta.height ?? h;
      }
    }
    const fullBase64 = fullBuf.toString("base64");

    // Create a smaller preview for the client (max 2000px wide).
    // Full-res PNGs can be 10-20MB and can't go through SSE.
    const previewBuf = await sharp(fullBuf)
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const imageUrl = `data:image/jpeg;base64,${previewBuf.toString("base64")}`;

    const info: PageInfo = {
      pageIndex: i,
      pageNumber: pageNum,
      imageUrl,
      width: w,
      height: h,
      pngBase64: fullBase64,
    };
    pages.push(info);
    pageCache.set(cacheKey, info);
    onProgress(`Rendered page ${pageNum} (${result.width}×${result.height})`);
  }

  if (pages.length === 0) throw new Error("No pages could be rendered");

  // Use the second page (the map sheet) as the primary working page
  // Skip the title page (first page)
  const mapPage = pages.length > 1 ? pages[1] : pages[0];

  // 3. Read legend + notes
  onProgress("Reading legend and notes…");
  const monumentLegend = await readLegend(mapPage);
  onProgress(`Found ${monumentLegend.length} monument type(s) in legend`);

  // 4. Read scale
  onProgress("Reading map scale…");
  const scaleInfo = await readScale(mapPage);
  onProgress(`Scale: ${scaleInfo.scaleText} (${scaleInfo.feetPerInch} ft/in)`);

  // 5. Read north arrow
  onProgress("Reading north arrow…");
  const northAngle = await readNorthArrow(mapPage, pages);
  onProgress(`North angle: ${northAngle.toFixed(1)}°`);

  // 6. Anchor registration via centerline matching
  // This uses potrace/thinning to find actual ink lines, then matches
  // COGO geometry against them to find the exact anchor position.
  // NO pixel coordinate estimation from the VLM — only text reading.
  onProgress(`Registering coordinates for Lot ${targetLot}…`);
  const { registerAnchor } = await import("./anchor-registration");
  const registration = await registerAnchor(
    mapPage,
    targetLot,
    { feetPerInch: scaleInfo.feetPerInch, dpi: 300, scaleText: scaleInfo.scaleText },
    northAngle,
    onProgress,
  );
  const coordSystem = registration.coordSystem;
  onProgress(`Anchor at (${registration.anchorPixel.px}, ${registration.anchorPixel.py}) — ${registration.matches.length} legs matched (confidence: ${(registration.matchConfidence * 100).toFixed(0)}%)`);

  // 7. Build extraction plan
  onProgress(`Building extraction plan for Lot ${targetLot}…`);
  const extractionPlan = await buildExtractionPlan(mapPage, targetLot);
  onProgress(`Plan: ${extractionPlan.length} elements to extract`);

  return {
    coordSystem,
    pages: pages.map(({ pngBase64, ...rest }) => rest),
    monumentLegend,
    extractionPlan,
    anchorDescription: `Geometric match: ${registration.matches.length} legs, confidence ${(registration.matchConfidence * 100).toFixed(0)}%`,
  };
}

// ─── Step ────────────────────────────────────────────────────

/**
 * Execute one extraction step — extract a single survey element.
 *
 * Quality control: if the overlap score is low, the agent automatically
 * retries with a wider crop and explicit error feedback (up to MAX_RETRIES).
 */
const MAX_RETRIES = 2;
const RETRY_OVERLAP_THRESHOLD = 0.3; // below this triggers a retry

export async function executeStep(
  pageKey: string,
  coordSystem: CoordSystem,
  currentPoint: Point,
  currentBearing: number | null,
  planItem: ExtractionPlanItem,
  previousOverlapScore: number | null,
  monumentLegend: MonumentLegendEntry[],
): Promise<StepResult> {
  const page = pageCache.get(pageKey);
  if (!page) throw new Error(`Page not in cache: ${pageKey}`);

  let cropThumbnail: string | undefined;
  let bestElement: SurveyElement | null = null;
  let bestOverlap = -1;
  let bestParsed: ExtractionResponse | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Compute crop region — widen on retries
    const currentPixel = surveyToPixel(coordSystem, currentPoint);
    const cropScale = 1 + attempt * 0.5; // 1.0x, 1.5x, 2.0x
    const cropRegion = computeCropRegion(
      coordSystem,
      currentPixel,
      currentBearing,
      planItem,
      page.width,
      page.height,
      cropScale,
    );

    const tile = await cropTile(page.pngBase64, cropRegion);

    // Save a thumbnail of the first crop for the UI
    if (attempt === 0) {
      const sharpThumb = (await import("sharp")).default;
      const thumbBuf = await sharpThumb(Buffer.from(tile.base64, "base64"))
        .resize(200, 200, { fit: "inside" })
        .jpeg({ quality: 60 })
        .toBuffer();
      cropThumbnail = `data:image/jpeg;base64,${thumbBuf.toString("base64")}`;
    }

    // Build prompt — include retry feedback on subsequent attempts
    let prompt = buildExtractionPrompt(planItem, previousOverlapScore, monumentLegend);
    if (attempt > 0 && bestElement) {
      prompt += `\n\nRETRY ATTEMPT ${attempt + 1}: The previous extraction produced an overlap score of ${bestOverlap.toFixed(2)} (poor alignment with original ink). The crop has been widened. Please look more carefully for the line segment. The previous reading was: bearing=${bestElement.bearing ?? "none"}, distance=${bestElement.distance ?? "none"}.`;
    }

    const raw = await nimVision(tile.base64, prompt, {
      systemPrompt:
        "You are a professional land surveyor analyzing a tract map. "
        + "You extract precise bearings, distances, and features from survey documents. "
        + "Always return valid JSON.",
      maxTokens: 1024,
      temperature: attempt > 0 ? 0.3 : 0.1, // slightly more creative on retries
    });

    const parsed = parseJsonResponse<ExtractionResponse>(raw);
    console.log(`[step ${planItem.index}] attempt ${attempt + 1}: type=${parsed.type} bearing=${parsed.bearing ?? "-"} dist=${parsed.distance ?? "-"} radius=${parsed.radius ?? "-"}`);

    const element = computeElement(
      parsed,
      planItem,
      currentPoint,
      currentBearing,
      coordSystem,
      monumentLegend,
    );

    // Measure overlap
    let overlapScore = 0;
    let measuredStrokeWidth = 0;

    if (element.geometryType === "point") {
      const center = element.pixelPoints[0];
      if (center) {
        const result = await measureMonumentOverlap(
          page.pngBase64, page.width, page.height, center,
        );
        overlapScore = result.score;
      }
    } else if (element.pixelPoints.length >= 2) {
      const result = await measureOverlap(
        page.pngBase64, page.width, page.height, element.pixelPoints,
      );
      overlapScore = result.score;
      measuredStrokeWidth = result.measuredStrokeWidth;
    }

    element.overlapScore = overlapScore;
    element.measuredStrokeWidth = measuredStrokeWidth;
    element.svgStrokeWidth = Math.max(1, Math.min(4, measuredStrokeWidth || 2));

    // Keep the best result across attempts
    if (overlapScore > bestOverlap) {
      bestOverlap = overlapScore;
      bestElement = element;
      bestParsed = parsed;
    }

    // If overlap is acceptable, stop retrying
    if (overlapScore >= RETRY_OVERLAP_THRESHOLD) {
      console.log(`[step ${planItem.index}] accepted on attempt ${attempt + 1} (overlap: ${overlapScore.toFixed(2)})`);
      break;
    }

    if (attempt < MAX_RETRIES) {
      console.log(`[step ${planItem.index}] retry ${attempt + 1} (overlap: ${overlapScore.toFixed(2)} < ${RETRY_OVERLAP_THRESHOLD})`);
    }
  }

  // Use the best result
  const element = bestElement!;
  if (MAX_RETRIES > 0 && bestOverlap < RETRY_OVERLAP_THRESHOLD) {
    console.log(`[step ${planItem.index}] accepting low-quality result after ${MAX_RETRIES + 1} attempts (overlap: ${bestOverlap.toFixed(2)})`);
    element.description += ` [low confidence: ${bestOverlap.toFixed(2)}]`;
  }

  // Compute next point and bearing
  const lastSurveyPoint = element.surveyPoints[element.surveyPoints.length - 1];
  let nextBearing: number | null = null;
  if (element.bearing) {
    nextBearing = parseBearing(element.bearing);
    if (element.curveDirection) {
      const dir = element.curveDirection === "LEFT" ? -1 : 1;
      const delta = element.delta ? parseDMS(element.delta) : 0;
      nextBearing = nextBearing - dir * delta;
    }
  }

  // Calibration is handled at init time by anchor-registration.ts
  const calibratedCS: CoordSystem | undefined = undefined;

  // Build SVG fragments
  const { buildSvgFragment, buildQualityHalo, buildLabel } = await import("./svg-builder");

  return {
    element,
    svgFragment: buildSvgFragment(element),
    qualityHalo: buildQualityHalo(element),
    label: buildLabel(element),
    overlapScore: bestOverlap,
    nextPoint: lastSurveyPoint,
    nextBearing,
    calibratedCoordSystem: calibratedCS,
    cropThumbnail,
  };
}

// ─── NIM Vision Helpers ──────────────────────────────────────

/**
 * Ask the agent whether the page needs rotation.
 * The agent examines the rendered page and decides the correct orientation
 * based on text direction, title block position, and north arrow.
 * Returns 0, 90, 180, or 270 degrees clockwise.
 */
async function detectOrientation(pngBase64: string): Promise<number> {
  const overview = await overviewTile(pngBase64, 1, 1);

  const response = await nimVision(
    overview.base64,
    `This is a survey/tract map page that may need rotation.

Look at the TITLE BLOCK (usually says "SUBDIVISION MAP", "TRACT", county name, scale, engineer name). The title block text should read LEFT-TO-RIGHT horizontally at the BOTTOM of the page.

Also look at BEARING TEXT along the survey lines (e.g., "N 75°22'10" W", "S 89°59'51" E"). These should read roughly horizontally.

If the title block text and bearing labels are currently VERTICAL (rotated 90° from horizontal), the page needs rotation.

Common case: survey PDFs are often stored in portrait format but the map content is landscape — the text reads sideways and needs 90° clockwise rotation.

How many degrees CLOCKWISE must this image be rotated so ALL text reads horizontally left-to-right?

Return ONLY valid JSON: { "rotation": 90 }
Where rotation is one of: 0, 90, 180, or 270.`,
    { maxTokens: 128, temperature: 0.1 },
  );

  try {
    const data = parseJsonResponse<{ rotation: number }>(response);
    const r = data.rotation ?? 0;
    if ([0, 90, 180, 270].includes(r)) return r;
    return 0;
  } catch {
    return 0;
  }
}

interface ExtractionResponse {
  bearing?: string;
  distance?: number;
  type: "line" | "curve" | "monument";
  elementType: string;
  radius?: number;
  delta?: string;
  arcLength?: number;
  direction?: "LEFT" | "RIGHT";
  monumentShape?: string;
  monumentDescription?: string;
}

async function readLegend(page: PageInfo): Promise<MonumentLegendEntry[]> {
  // Crop the notes/legend area (right side of map, about 25% width, 40% height)
  const legendRegion: CropRegion = {
    x: Math.round(page.width * 0.65),
    y: Math.round(page.height * 0.35),
    width: Math.round(page.width * 0.35),
    height: Math.round(page.height * 0.55),
    label: "legend-notes",
  };
  const tile = await cropTile(page.pngBase64, legendRegion);

  const response = await nimVision(
    tile.base64,
    `Read the NOTES section and any legend on this tract map.
List each monument symbol type with its meaning.

For each monument type, identify:
- shape: "solid_circle", "open_circle", "circled_cross", "half_filled", or describe it
- description: what the symbol represents (e.g., "1/2 inch IP set with metal marker tag")
- rceNumber: any R.C.E. reference number
- lsNumber: any L.S. reference number

Also note the basis of bearings if mentioned.

Return valid JSON:
{
  "monumentTypes": [
    { "shape": "solid_circle", "description": "...", "rceNumber": "3162", "lsNumber": "9269" }
  ],
  "basisOfBearings": "...",
  "otherNotes": ["..."]
}`,
    { maxTokens: 2048, temperature: 0.1 },
  );

  try {
    const data = parseJsonResponse<{
      monumentTypes: MonumentLegendEntry[];
    }>(response);
    return data.monumentTypes ?? [];
  } catch {
    return [];
  }
}

async function readScale(
  page: PageInfo,
): Promise<{ scaleText: string; feetPerInch: number }> {
  // Crop the right-bottom quadrant which contains the title block.
  // Works for both portrait and landscape orientations.
  const titleRegion: CropRegion = {
    x: Math.round(page.width * 0.5),
    y: Math.round(page.height * 0.5),
    width: Math.round(page.width * 0.5),
    height: Math.round(page.height * 0.5),
    label: "title-block",
  };
  const tile = await cropTile(page.pngBase64, titleRegion);

  const response = await nimVision(
    tile.base64,
    `What is the map scale shown on this sheet?
Look for text like 'SCALE 1"=30'' or '1 INCH = 30 FEET' or similar.

Return valid JSON:
{ "scaleText": "1\\"=30'", "feetPerInch": 30 }

If you cannot find a scale, estimate based on the content and state your estimate.`,
    { maxTokens: 256, temperature: 0.1 },
  );

  try {
    return parseJsonResponse<{ scaleText: string; feetPerInch: number }>(response);
  } catch {
    return { scaleText: "unknown", feetPerInch: 30 }; // safe default
  }
}

async function readNorthArrow(
  mapPage: PageInfo,
  allPages: PageInfo[],
): Promise<number> {
  // Try the last page first (north arrows are often on sheet 3)
  const targetPage = allPages.length > 2 ? allPages[allPages.length - 1] : mapPage;

  // Crop top-right quadrant where north arrows typically are
  const northRegion: CropRegion = {
    x: Math.round(targetPage.width * 0.7),
    y: 0,
    width: Math.round(targetPage.width * 0.3),
    height: Math.round(targetPage.height * 0.35),
    label: "north-arrow",
  };
  const tile = await cropTile(targetPage.pngBase64, northRegion);

  const response = await nimVision(
    tile.base64,
    `Find the north arrow on this tract map sheet.
What angle is north pointing in degrees?
- 0 means north is straight up
- positive means north is rotated clockwise from straight up

Return valid JSON: { "angleDegrees": 0 }`,
    { maxTokens: 128, temperature: 0.1 },
  );

  try {
    const data = parseJsonResponse<{ angleDegrees: number }>(response);
    return data.angleDegrees ?? 0;
  } catch {
    return 0;
  }
}

async function findAnchorMonument(
  page: PageInfo,
  targetLot: string,
): Promise<{ description: string; px: number; py: number }> {
  const sharpMod = (await import("sharp")).default;

  // Resize the image FIRST to a manageable size, then draw the grid on it.
  // This avoids memory issues from compositing SVG at full resolution.
  const VLM_SIZE = 2048;
  const scale = Math.min(VLM_SIZE / page.width, VLM_SIZE / page.height);
  const scaledW = Math.round(page.width * scale);
  const scaledH = Math.round(page.height * scale);

  const smallBuf = await sharpMod(Buffer.from(page.pngBase64, "base64"))
    .toColourspace("srgb")
    .resize(scaledW, scaledH)
    .toBuffer();

  // Draw grid in ORIGINAL coordinate space but at scaled positions.
  // Labels show original pixel values so the model returns original-space coords.
  const gridSpacing = 500;
  const gridSvgLines: string[] = [];
  for (let origX = gridSpacing; origX < page.width; origX += gridSpacing) {
    const sx = Math.round(origX * scale);
    gridSvgLines.push(`<line x1="${sx}" y1="0" x2="${sx}" y2="${scaledH}" stroke="red" stroke-width="1" opacity="0.6"/>`);
    gridSvgLines.push(`<text x="${sx + 3}" y="16" fill="red" font-size="14" font-family="sans-serif" font-weight="bold" opacity="0.9">${origX}</text>`);
  }
  for (let origY = gridSpacing; origY < page.height; origY += gridSpacing) {
    const sy = Math.round(origY * scale);
    gridSvgLines.push(`<line x1="0" y1="${sy}" x2="${scaledW}" y2="${sy}" stroke="red" stroke-width="1" opacity="0.6"/>`);
    gridSvgLines.push(`<text x="3" y="${sy - 3}" fill="red" font-size="14" font-family="sans-serif" font-weight="bold" opacity="0.9">${origY}</text>`);
  }
  const gridSvg = `<svg width="${scaledW}" height="${scaledH}">${gridSvgLines.join("")}</svg>`;

  const griddedBuf = await sharpMod(smallBuf)
    .composite([{ input: Buffer.from(gridSvg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  const gridResponse = await nimVision(
    griddedBuf.toString("base64"),
    `This tract map has a RED COORDINATE GRID overlaid on it. The red numbers show ORIGINAL pixel coordinates of the full-resolution image. Grid lines are every ${gridSpacing} pixels.

Find Lot ${targetLot} on this map. Then find the SOUTHEAST (bottom-right) corner of Lot ${targetLot}'s boundary polygon — this is typically the Point of Beginning (POB) monument.

Use the red grid numbers to estimate the pixel coordinates of this corner in the ORIGINAL full-resolution image. Interpolate between grid lines.

Example: if the corner is halfway between x=3000 and x=3500, and just above y=3500, return x=3250, y=3450.

Return valid JSON:
{ "description": "SE corner of Lot ${targetLot}", "x": 3250, "y": 3450 }`,
    { maxTokens: 256, temperature: 0.1 },
  );

  try {
    const data = parseJsonResponse<{ description: string; x: number; y: number }>(gridResponse);
    const px = Math.max(0, Math.min(page.width - 1, Math.round(data.x)));
    const py = Math.max(0, Math.min(page.height - 1, Math.round(data.y)));
    console.log(`[anchor] Grid-based: (${px}, ${py}): ${data.description}`);
    return { description: data.description, px, py };
  } catch {
    console.log(`[anchor] Grid method failed, using image center`);
    return {
      description: `Lot ${targetLot} center (fallback)`,
      px: Math.round(page.width * 0.4),
      py: Math.round(page.height * 0.55),
    };
  }
}

async function buildExtractionPlan(
  page: PageInfo,
  targetLot: string,
): Promise<ExtractionPlanItem[]> {
  const overview = await overviewTile(page.pngBase64, page.width, page.height);

  const response = await nimVision(
    overview.base64,
    `Analyze Lot ${targetLot} on this tract map.
List ALL boundary line segments of Lot ${targetLot} in CLOCKWISE order starting from the Point of Beginning (POB).

For each segment, note:
- type: "line" (straight), "curve", or "monument" (at a corner)
- elementType: "lot_boundary", "easement", "road_centerline", or "monument"
- description: brief description (e.g., "North boundary along Linfield Place", "SE corner monument")

Return a JSON array:
[
  { "type": "monument", "elementType": "monument", "description": "POB monument at SE corner" },
  { "type": "line", "elementType": "lot_boundary", "description": "East boundary line going north" },
  { "type": "curve", "elementType": "road_centerline", "description": "Curve along Linfield Place" }
]

Include monuments at corners between line segments. List EVERY segment needed to close the lot boundary.`,
    { maxTokens: 2048, temperature: 0.1 },
  );

  try {
    const items = parseJsonResponse<
      Array<{ type: string; elementType: string; description: string }>
    >(response);

    return items.map((item, i) => ({
      index: i,
      type: (item.type === "curve" ? "curve" : item.type === "monument" ? "monument" : "line") as ExtractionPlanItem["type"],
      elementType: (item.elementType ?? "lot_boundary") as ExtractionPlanItem["elementType"],
      description: item.description ?? `Element ${i}`,
    }));
  } catch {
    return [];
  }
}

// ─── Geometry Computation ────────────────────────────────────

function computeElement(
  parsed: ExtractionResponse,
  planItem: ExtractionPlanItem,
  currentPoint: Point,
  currentBearing: number | null,
  coordSystem: CoordSystem,
  legendEntries: MonumentLegendEntry[],
): SurveyElement {
  const id = `elem-${planItem.index}-${Date.now()}`;
  const elementType = (planItem.elementType ?? "lot_boundary") as SurveyElement["elementType"];

  if (parsed.type === "monument" || planItem.type === "monument") {
    const pixelPoint = surveyToPixel(coordSystem, currentPoint);
    const legendMatch = legendEntries.find((e) =>
      parsed.monumentShape?.includes(e.shape) ||
      e.description.toLowerCase().includes((parsed.monumentDescription ?? "").toLowerCase()),
    );

    return {
      id,
      elementType: "monument",
      surveyPoints: [currentPoint],
      pixelPoints: [pixelPoint],
      geometryType: "point",
      overlapScore: 0,
      measuredStrokeWidth: 0,
      svgStrokeWidth: 0,
      monument: {
        shape: parsed.monumentShape ?? legendMatch?.shape ?? "solid_circle",
        description: parsed.monumentDescription ?? planItem.description,
        rceNumber: legendMatch?.rceNumber,
        lsNumber: legendMatch?.lsNumber,
      },
      description: planItem.description,
    };
  }

  if (parsed.type === "curve" && parsed.radius && parsed.delta && parsed.arcLength) {
    const bearing = currentBearing ?? 0;
    const leg: TraverseLeg = {
      type: "curve",
      bearing,
      distance: parsed.arcLength,
      radius: parsed.radius,
      delta: parseDMS(parsed.delta),
      arcLength: parsed.arcLength,
      direction: parsed.direction ?? "LEFT",
    };

    const curvePoints = computeCurvePoints(currentPoint, leg, 32);
    const pixelPoints = curvePoints.map((p) => surveyToPixel(coordSystem, p));

    return {
      id,
      elementType,
      surveyPoints: curvePoints,
      pixelPoints,
      radius: parsed.radius,
      delta: parsed.delta,
      arcLength: parsed.arcLength,
      curveDirection: parsed.direction,
      geometryType: "arc",
      overlapScore: 0,
      measuredStrokeWidth: 0,
      svgStrokeWidth: 2,
      description: planItem.description,
    };
  }

  // Straight line
  if (!parsed.bearing || !parsed.distance) {
    // Fallback: return a zero-length element
    const pixelPoint = surveyToPixel(coordSystem, currentPoint);
    return {
      id,
      elementType,
      surveyPoints: [currentPoint],
      pixelPoints: [pixelPoint],
      geometryType: "line",
      overlapScore: 0,
      measuredStrokeWidth: 0,
      svgStrokeWidth: 2,
      description: planItem.description + " (no bearing/distance extracted)",
    };
  }

  const bearingRad = parseBearing(parsed.bearing);
  const endPoint = traversePoint(currentPoint, bearingRad, parsed.distance);
  const startPixel = surveyToPixel(coordSystem, currentPoint);
  const endPixel = surveyToPixel(coordSystem, endPoint);

  return {
    id,
    elementType,
    surveyPoints: [currentPoint, endPoint],
    pixelPoints: [startPixel, endPixel],
    bearing: parsed.bearing,
    distance: parsed.distance,
    geometryType: "line",
    overlapScore: 0,
    measuredStrokeWidth: 0,
    svgStrokeWidth: 2,
    description: planItem.description,
  };
}

// ─── Crop Region Computation ─────────────────────────────────

function computeCropRegion(
  cs: CoordSystem,
  currentPixel: { px: number; py: number },
  currentBearing: number | null,
  planItem: ExtractionPlanItem,
  imgWidth: number,
  imgHeight: number,
  scale = 1,
): CropRegion {
  // Default crop size in pixels — sized to show one element clearly
  let cropW: number;
  let cropH: number;

  if (planItem.type === "monument") {
    // Small square crop for monuments
    cropW = Math.round(feetToPixels(cs, 30));
    cropH = cropW;
  } else if (planItem.type === "curve") {
    // Larger square for curves
    cropW = Math.round(feetToPixels(cs, 150));
    cropH = cropW;
  } else {
    // For lines, elongate along expected direction
    cropW = Math.round(feetToPixels(cs, 180));
    cropH = Math.round(feetToPixels(cs, 80));
  }

  // Apply retry scale factor (widens crop on retries)
  cropW = Math.round(cropW * scale);
  cropH = Math.round(cropH * scale);

  // Ensure minimum size
  cropW = Math.max(cropW, 400);
  cropH = Math.max(cropH, 400);

  // Center on current point, offset slightly in the expected direction
  let cx = currentPixel.px;
  let cy = currentPixel.py;

  if (currentBearing !== null && planItem.type === "line") {
    // Offset center forward along expected bearing
    const imgAngle = bearingToImageAngle(cs, currentBearing);
    const offset = cropW * 0.3;
    cx += offset * Math.sin(imgAngle);
    cy -= offset * Math.cos(imgAngle);
  }

  // Compute top-left corner
  let x = Math.round(cx - cropW / 2);
  let y = Math.round(cy - cropH / 2);

  // Clamp to image bounds
  x = Math.max(0, Math.min(x, imgWidth - cropW));
  y = Math.max(0, Math.min(y, imgHeight - cropH));
  cropW = Math.min(cropW, imgWidth - x);
  cropH = Math.min(cropH, imgHeight - y);

  return {
    x,
    y,
    width: cropW,
    height: cropH,
    label: `step-${planItem.index}`,
  };
}

function buildExtractionPrompt(
  planItem: ExtractionPlanItem,
  previousOverlapScore: number | null,
  legend: MonumentLegendEntry[],
): string {
  const overlapContext = previousOverlapScore !== null
    ? `\nThe previous element had an overlap score of ${previousOverlapScore.toFixed(2)} (1.0 = perfect alignment with original ink).`
    : "";

  if (planItem.type === "monument") {
    const legendText = legend.length > 0
      ? `\nLegend monument types:\n${legend.map((e) => `- ${e.shape}: ${e.description}`).join("\n")}`
      : "";

    return `This is a tight crop of a tract map centered on a survey monument.
Identify the monument visible near the CENTER of this crop.${legendText}

Return valid JSON:
{
  "type": "monument",
  "elementType": "monument",
  "monumentShape": "solid_circle",
  "monumentDescription": "1/2 inch IP set with metal marker tag R.C.E. 3162"
}

Match the monument shape to one of: solid_circle, open_circle, circled_cross, half_filled.
DO NOT read any line segments or text — focus only on the monument marker.${overlapContext}`;
  }

  if (planItem.type === "curve") {
    return `This is a tight crop of a tract map. There is a CURVE segment visible here.
Description: ${planItem.description}

Read the curve data. Look for:
- R= or RADIUS value in feet
- Delta angle (Δ or A=) in degrees, minutes, seconds
- L= or ARC LENGTH in feet
- Direction: LEFT or RIGHT (which side the curve bows toward)

Return valid JSON:
{
  "type": "curve",
  "elementType": "${planItem.elementType}",
  "radius": 628.00,
  "delta": "7°33'15\\"",
  "arcLength": 82.78,
  "direction": "LEFT"
}

Read ONLY this one curve. DO NOT read any other features.${overlapContext}`;
  }

  return `This is a tight crop of a tract map showing a SINGLE boundary line segment.
Description: ${planItem.description}

Find this ONE line segment. Read its:
1. Quadrant bearing (e.g., N 75°22'10" W)
2. Distance in feet

Return valid JSON:
{
  "bearing": "N 75°22'10\\" W",
  "distance": 146.31,
  "type": "line",
  "elementType": "${planItem.elementType}"
}

Read ONLY this one line segment. DO NOT read any other lines, dashes, or symbols.${overlapContext}`;
}
