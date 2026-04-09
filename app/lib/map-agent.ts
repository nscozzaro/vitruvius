/**
 * Multi-Pass Map Agent Orchestrator.
 *
 * Runs Llama 4 Maverick through 5 passes to extract architect-grade
 * survey data from tract map images:
 *
 *   Pass 0: Legend & Sheet Index
 *   Pass 1: Semantic Feature Survey
 *   Pass 2: Metes & Bounds DSL Extraction
 *   Pass 3: Text & Annotation Extraction
 *   Pass 4: Self-Validation (refinement loop)
 */

import { nimVision, nimVisionMulti, parseJsonResponse } from "./nim-client";
import { overviewTile, detectLotRegions, lotCropRegions, cropTile, gridTiles } from "./tile-cropper";
import type { LotExtraction, BoundarySequenceItem } from "./surveying-language";

// ─── Types ────────────────────────────────────────────────────

export interface LegendSymbol {
  symbol: string;
  meaning: string;
  layer: string;
}

export interface LegendContext {
  legend: LegendSymbol[];
  surveyor: string;
  date: string;
  scale: string;
  basis_of_bearings: string;
  sheet_index: Array<{ page: number; content: string }>;
}

export interface Feature {
  id: string;
  semantic_meaning: string;
  feature_type:
    | "lot_line"
    | "easement"
    | "monument"
    | "centerline"
    | "dimension"
    | "text"
    | "title_block"
    | "other";
  visual_description: string;
  confidence: number;
}

export interface FeatureSurvey {
  features: Feature[];
}

export interface TextAnnotation {
  text: string;
  type:
    | "bearing"
    | "distance"
    | "lot_number"
    | "easement_label"
    | "street_name"
    | "title"
    | "recording_info"
    | "other";
  x_pct: number;
  y_pct: number;
  rotation_deg: number;
  associated_feature?: string;
}

export interface ValidationResult {
  is_valid: boolean;
  issues: Array<{
    severity: "error" | "warning";
    description: string;
    affected_lot?: string;
    affected_feature?: string;
    suggested_correction?: string;
  }>;
  confidence: number;
}

export interface AgentResult {
  legend: LegendContext;
  features: FeatureSurvey;
  lots: LotExtraction[];
  annotations: TextAnnotation[];
  validation: ValidationResult;
}

// ─── System Prompts ───────────────────────────────────────────

const LEGEND_SYSTEM_PROMPT = `You are an expert land surveyor analyzing recorded tract maps. Your task is to extract the legend/symbol table from this tract map.

You MUST respond with valid JSON only — no markdown, no explanation. Output this exact structure:
{
  "legend": [
    { "symbol": "description of visual symbol", "meaning": "what it represents", "layer": "AIA layer name" }
  ],
  "surveyor": "name and license number",
  "date": "YYYY-MM-DD or approximate",
  "scale": "e.g. 1\\" = 40'",
  "basis_of_bearings": "description of the basis of bearings if stated",
  "sheet_index": [
    { "page": 1, "content": "brief description of page contents" }
  ]
}

AIA layer names to use:
- C-PROP: Property/lot boundary lines
- C-PROP-ESMT: Easements (PUE, drainage, etc.)
- C-PROP-MONU: Survey monuments
- C-PROP-BRNG: Bearing and distance annotations
- C-ROAD-CNTR: Road centerlines
- C-ANNO-TEXT: General text labels
- C-ANNO-DIMS: Dimension text
- C-ANNO-TTLB: Title block

If no legend is visible, infer standard civil survey conventions.`;

const FEATURE_SYSTEM_PROMPT = `You are an expert land surveyor identifying features on a tract map.

For EACH feature, you MUST first describe what it is semantically BEFORE describing its visual appearance. This grounds your spatial reasoning in meaning.

Respond with valid JSON only:
{
  "features": [
    {
      "id": "F1",
      "semantic_meaning": "Description of what this feature represents in the survey",
      "feature_type": "lot_line | easement | monument | centerline | dimension | text | title_block | other",
      "visual_description": "What it looks like on the map",
      "confidence": 0.0-1.0
    }
  ]
}

Use the following legend context to correctly interpret symbols:
`;

const METES_BOUNDS_SYSTEM_PROMPT = `You are an expert land surveyor extracting metes and bounds from a tract map.

You MUST extract boundaries using this strict Surveying Language DSL.
Output a sequential array of strokes forming a CLOSED polygon for each lot.

Stroke types:
  <LINE | quadrant_bearing | distance_ft>
  <CURVE | radius_ft | delta_angle | arc_length_ft | direction>
  <MONUMENT | type | description>

Rules:
- quadrant_bearing format: "N dd°mm'ss" W" (always quadrant notation with degrees, minutes, seconds)
- distance_ft: decimal feet (e.g., "146.31")
- delta_angle: same DMS format (e.g., "7°33'15"")
- direction: "LEFT" or "RIGHT" (which side the curve bows toward looking in the direction of travel)
- You MUST state the semantic meaning of each stroke BEFORE the stroke data
- The boundary MUST close — the last stroke should return to the point of beginning

For each lot, output:
{
  "lot": "lot number",
  "tract": "tract number",
  "point_of_beginning": "description of POB monument or location",
  "boundary_sequence": [
    {
      "semantic_meaning": "What this boundary segment represents",
      "stroke": "<LINE | N 75°22'10\\" W | 146.31>",
      "confidence": 0.0-1.0
    }
  ]
}

If extracting multiple lots, wrap in: { "lots": [...] }

Read the bearing and distance values EXACTLY as printed on the map.
Do NOT compute or estimate values — read them directly from the annotation text.

Legend context:
`;

const ANNOTATION_SYSTEM_PROMPT = `You are an expert land surveyor reading all text annotations from a tract map.

For each text element visible on the map, output its content, approximate position (as percentage of image width/height from top-left), rotation angle, and classification.

Respond with valid JSON only — an array of annotations:
[
  {
    "text": "exact text content",
    "type": "bearing | distance | lot_number | easement_label | street_name | title | recording_info | other",
    "x_pct": 0-100,
    "y_pct": 0-100,
    "rotation_deg": angle in degrees (0 = horizontal, positive = counterclockwise),
    "associated_feature": "feature ID if applicable, e.g. F1"
  }
]

Read text EXACTLY as printed. Do not correct, round, or modify values.

Legend context:
`;

const VALIDATION_SYSTEM_PROMPT = `You are an expert land surveyor performing quality assurance on extracted tract map data.

Given the original tract map image and the extracted data, verify:
1. Every lot boundary should close (returning to its starting point)
2. Adjacent lots should share common boundary segments
3. Bearing and distance text on the map should match the extracted DSL strokes
4. All monuments referenced in the point of beginning should be present
5. Easement widths should match their labels
6. The total number of lots matches what's visible on the map

Respond with valid JSON:
{
  "is_valid": true/false,
  "issues": [
    {
      "severity": "error | warning",
      "description": "description of the issue",
      "affected_lot": "lot number if applicable",
      "affected_feature": "feature ID if applicable",
      "suggested_correction": "how to fix it"
    }
  ],
  "confidence": 0.0-1.0
}`;

// ─── Agent Passes ─────────────────────────────────────────────

/**
 * Pass 0: Extract legend and sheet index from all pages.
 */
async function extractLegend(
  pageImages: Array<{ base64: string }>,
): Promise<LegendContext> {
  console.log("[map-agent] Pass 0: Legend extraction");

  let response: string;
  if (pageImages.length === 1) {
    response = await nimVision(
      pageImages[0].base64,
      "Extract the legend, symbol table, surveyor info, scale, and sheet index from this tract map. If no explicit legend is shown, infer standard civil survey symbol conventions based on what you see.",
      { systemPrompt: LEGEND_SYSTEM_PROMPT, maxTokens: 2048 },
    );
  } else {
    response = await nimVisionMulti(
      pageImages.map((p) => ({ base64: p.base64 })),
      `This tract map has ${pageImages.length} pages. Extract the legend, symbol table, surveyor info, scale, and sheet index. The legend is typically on the first or last page. Describe what content each page contains.`,
      { systemPrompt: LEGEND_SYSTEM_PROMPT, maxTokens: 2048 },
    );
  }

  return parseJsonResponse<LegendContext>(response);
}

/**
 * Pass 1: Identify all features on the geometry pages.
 */
async function surveyFeatures(
  pageImage: string,
  legend: LegendContext,
): Promise<FeatureSurvey> {
  console.log("[map-agent] Pass 1: Feature survey");

  const response = await nimVision(
    pageImage,
    "Identify ALL features visible on this tract map page. Include lot boundary lines, easements, monuments, road centerlines, dimension annotations, text labels, and title block elements.",
    {
      systemPrompt: FEATURE_SYSTEM_PROMPT + JSON.stringify(legend, null, 2),
      maxTokens: 4096,
    },
  );

  return parseJsonResponse<FeatureSurvey>(response);
}

/**
 * Pass 2: Extract metes & bounds for all lots using the Surveying Language DSL.
 */
async function extractMetesAndBounds(
  pageImage: string,
  legend: LegendContext,
  features: FeatureSurvey,
): Promise<LotExtraction[]> {
  console.log("[map-agent] Pass 2: Metes & bounds DSL extraction");

  const featureContext = features.features
    .filter((f) => f.feature_type === "lot_line" || f.feature_type === "monument")
    .map((f) => `${f.id}: ${f.semantic_meaning}`)
    .join("\n");

  const response = await nimVision(
    pageImage,
    `Extract the complete metes and bounds for EVERY lot visible on this page.

Previously identified features:
${featureContext}

For each lot, output the complete boundary as a sequence of Surveying Language DSL strokes.
Read ALL bearing values, distances, curve radii, delta angles, and arc lengths EXACTLY from the map.
The boundary must form a CLOSED polygon returning to the point of beginning.`,
    {
      systemPrompt:
        METES_BOUNDS_SYSTEM_PROMPT + JSON.stringify(legend, null, 2),
      maxTokens: 8192,
      temperature: 0.1,
    },
  );

  const parsed = parseJsonResponse<LotExtraction | { lots: LotExtraction[] }>(
    response,
  );
  if (Array.isArray(parsed)) return parsed;
  if ("lots" in parsed) return parsed.lots;
  return [parsed as LotExtraction];
}

/**
 * Pass 3: Extract all text annotations.
 */
async function extractAnnotations(
  pageImage: string,
  legend: LegendContext,
): Promise<TextAnnotation[]> {
  console.log("[map-agent] Pass 3: Text & annotation extraction");

  const response = await nimVision(
    pageImage,
    "Read and extract ALL text visible on this tract map page. Include every bearing, distance, lot number, easement label, street name, title block text, and any other annotations. Read values EXACTLY as printed.",
    {
      systemPrompt:
        ANNOTATION_SYSTEM_PROMPT + JSON.stringify(legend, null, 2),
      maxTokens: 8192,
    },
  );

  const parsed = parseJsonResponse<TextAnnotation[]>(response);

  // Validate and filter annotations
  const validated: TextAnnotation[] = [];
  for (const ann of (Array.isArray(parsed) ? parsed : [])) {
    if (typeof ann === "object" && ann !== null &&
        typeof ann.text === "string" &&
        typeof ann.type === "string" &&
        typeof ann.x_pct === "number" &&
        typeof ann.y_pct === "number") {
      validated.push(ann);
    }
  }

  if (validated.length < (Array.isArray(parsed) ? parsed.length : 0)) {
    console.warn(`[map-agent] Filtered out ${(Array.isArray(parsed) ? parsed.length : 0) - validated.length} malformed annotations from tile`);
  }

  return validated;
}

/**
 * Pass 2b: Merge and deduplicate lot extractions from multiple tiles.
 *
 * Tile-based extraction often produces duplicates (overlapping crops
 * extract the same lot) or partial lots (lot spans two tiles). The
 * model merges these into clean, complete lot extractions.
 */
async function mergeAndDeduplicateLots(
  overviewImage: string,
  legend: LegendContext,
  rawLots: LotExtraction[],
): Promise<LotExtraction[]> {
  console.log("[map-agent] Pass 2b: Merging and deduplicating tile extractions");

  // Step 1: Programmatic dedup — group by lot number, keep best version
  const byLot = new Map<string, LotExtraction[]>();
  for (const lot of rawLots) {
    const key = lot.lot?.toString().trim() || "unknown";
    if (!byLot.has(key)) byLot.set(key, []);
    byLot.get(key)!.push(lot);
  }

  const deduped: LotExtraction[] = [];
  for (const [lotNum, variants] of byLot) {
    if (lotNum === "unknown") continue; // Skip lots without numbers

    // Keep the variant with the most boundary segments
    const best = variants.reduce((a, b) =>
      (b.boundary_sequence?.length ?? 0) > (a.boundary_sequence?.length ?? 0) ? b : a,
    );
    deduped.push(best);
  }

  console.log(
    `[map-agent] Programmatic dedup: ${rawLots.length} → ${deduped.length} lots`,
  );

  // Step 2: Send to Maverick for model-assisted merge.
  // Batch into groups of 10 if there are many lots.
  const BATCH_SIZE = 10;
  const batches: LotExtraction[][] = [];
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    batches.push(deduped.slice(i, i + BATCH_SIZE));
  }

  const mergedLots: LotExtraction[] = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log(
      `[map-agent] Model merge batch ${b + 1}/${batches.length}: ${batch.length} lots`,
    );

    try {
      const response = await nimVision(
        overviewImage,
        `These lot extractions were merged from tile-based analysis of a tract map.
Review them against the original map image and:
1. Fix any misread bearings, distances, or lot numbers
2. Ensure each boundary forms a CLOSED polygon in the DSL format
3. Verify lot numbers match what's visible on the map
4. Correct any DSL format errors

EXTRACTED LOTS (batch ${b + 1} of ${batches.length}):
${JSON.stringify(batch, null, 2)}

Respond with valid JSON only: { "lots": [...] }`,
        {
          systemPrompt: METES_BOUNDS_SYSTEM_PROMPT + JSON.stringify(legend, null, 2),
          maxTokens: 16384,
          temperature: 0.1,
        },
      );

      const parsed = parseJsonResponse<{ lots: LotExtraction[] } | LotExtraction[]>(
        response,
      );
      const result = Array.isArray(parsed)
        ? parsed
        : "lots" in parsed
          ? parsed.lots
          : [parsed as unknown as LotExtraction];
      mergedLots.push(...result);
    } catch (err) {
      console.error(
        `[map-agent] Model merge batch ${b + 1} failed, keeping programmatic dedup:`,
        err,
      );
      mergedLots.push(...batch);
    }
  }

  console.log(`[map-agent] Model merge complete: ${mergedLots.length} lots`);
  return mergedLots;
}

/**
 * Merge and deduplicate text annotations from multiple grid tiles.
 *
 * The model reviews the raw annotations against the overview image,
 * removes duplicates, corrects OCR errors, and associates annotations
 * with the correct features.
 */
async function mergeAndDeduplicateAnnotations(
  overviewImage: string,
  legend: LegendContext,
  rawAnnotations: TextAnnotation[],
): Promise<TextAnnotation[]> {
  console.log("[map-agent] Merging tile annotations via model");

  // If there are too many annotations, truncate to avoid token limits
  const toMerge = rawAnnotations.slice(0, 200);

  const response = await nimVision(
    overviewImage,
    `These text annotations were extracted from overlapping tiles of this tract map.
Clean them up:
1. Remove duplicates (same text at nearly the same position)
2. Fix any obvious OCR misreadings by comparing against the map image
3. Ensure bearing values follow the format N dd°mm'ss" W/E
4. Ensure distance values are in feet with proper decimal places
5. Associate annotations with the correct feature types

RAW ANNOTATIONS:
${JSON.stringify(toMerge, null, 2)}

Respond with valid JSON: a cleaned array of annotations in the same format.`,
    {
      systemPrompt: ANNOTATION_SYSTEM_PROMPT + JSON.stringify(legend, null, 2),
      maxTokens: 8192,
      temperature: 0.1,
    },
  );

  const parsed = parseJsonResponse<TextAnnotation[]>(response);

  // Validate and filter annotations to ensure x_pct and y_pct are numbers
  const validated: TextAnnotation[] = [];
  for (const ann of (Array.isArray(parsed) ? parsed : [])) {
    if (typeof ann === "object" && ann !== null &&
        typeof ann.text === "string" &&
        typeof ann.type === "string" &&
        typeof ann.x_pct === "number" &&
        typeof ann.y_pct === "number") {
      validated.push(ann);
    }
  }

  if (validated.length < (Array.isArray(parsed) ? parsed.length : 0)) {
    console.warn(`[map-agent] Filtered out ${(Array.isArray(parsed) ? parsed.length : 0) - validated.length} malformed annotations`);
  }

  return validated;
}

/**
 * Pass 4: Validate the extracted data against the original image.
 */
async function validateExtraction(
  pageImage: string,
  lots: LotExtraction[],
  annotations: TextAnnotation[],
  closureErrors: Array<{ lot: string; error: number; ratio: string }>,
): Promise<ValidationResult> {
  console.log("[map-agent] Pass 4: Self-validation");

  const context = {
    extracted_lots: lots.map((l) => ({
      lot: l.lot,
      num_boundary_segments: l.boundary_sequence.length,
      point_of_beginning: l.point_of_beginning,
    })),
    closure_errors: closureErrors,
    num_annotations: annotations.length,
    bearing_annotations: annotations.filter((a) => a.type === "bearing").length,
    distance_annotations: annotations.filter((a) => a.type === "distance").length,
  };

  const response = await nimVision(
    pageImage,
    `Validate this tract map extraction against the original image.

Extraction summary:
${JSON.stringify(context, null, 2)}

Check: Are all lots accounted for? Do the closure errors indicate accurate extraction? Are there any obvious misreadings visible by comparing the image to the extracted data?`,
    {
      systemPrompt: VALIDATION_SYSTEM_PROMPT,
      maxTokens: 4096,
    },
  );

  return parseJsonResponse<ValidationResult>(response);
}

// ─── Main Orchestrator ────────────────────────────────────────

/**
 * Run the full multi-pass agent pipeline on a set of tract map page images.
 *
 * Uses tiled cropping strategy for maximum text resolution:
 * - Passes 0-1: Overview tile (full page → 2048×2048) for layout/legend
 * - Pass 2: Per-lot crops at native resolution → 2048×2048 for fine text
 * - Pass 3: Grid tiles for comprehensive text extraction
 * - Pass 4: Overview for validation
 *
 * @param pageImages - Array of { base64 PNG at 300 DPI, dimensions, pageNum }
 * @param geometryPageIndex - Which page contains lot geometry (0-indexed)
 */
export async function runMapAgent(
  pageImages: Array<{
    base64: string;
    width: number;
    height: number;
    pageNum: number;
  }>,
  geometryPageIndex?: number,
): Promise<AgentResult> {
  // === Pass 0: Legend extraction (overview of all pages) ===
  const overviewTiles = await Promise.all(
    pageImages.map((p) => overviewTile(p.base64, p.width, p.height)),
  );
  const legend = await extractLegend(
    overviewTiles.map((t) => ({ base64: t.base64 })),
  );
  console.log(
    `[map-agent] Legend extracted: ${legend.legend.length} symbols, scale=${legend.scale}`,
  );

  // Determine geometry page
  const geoIdx =
    geometryPageIndex ??
    legend.sheet_index.findIndex(
      (s) =>
        s.content.toLowerCase().includes("lot") ||
        s.content.toLowerCase().includes("geometry") ||
        s.content.toLowerCase().includes("plat"),
    );
  const geoPage = geoIdx >= 0 ? geoIdx : Math.min(1, pageImages.length - 1);
  const geoSrc = pageImages[geoPage];
  const geoOverview = overviewTiles[geoPage];

  console.log(
    `[map-agent] Using page ${geoSrc.pageNum} for geometry (${geoSrc.width}×${geoSrc.height}px)`,
  );

  // === Pass 1: Feature survey (overview) ===
  const features = await surveyFeatures(geoOverview.base64, legend);
  console.log(`[map-agent] Found ${features.features.length} features`);

  // === Detect lot regions for per-lot cropping ===
  console.log("[map-agent] Detecting lot regions for high-res cropping...");
  const lotRegions = await detectLotRegions(geoOverview.base64);
  console.log(`[map-agent] Detected ${lotRegions.length} lot regions`);

  // === Pass 2: Per-lot metes & bounds (cropped at native resolution) ===
  const cropRegions = lotCropRegions(
    lotRegions,
    geoSrc.width,
    geoSrc.height,
  );

  let lots: LotExtraction[] = [];
  for (const region of cropRegions) {
    console.log(
      `[map-agent] Cropping ${region.label}: ${region.width}×${region.height}px → 2048×2048`,
    );
    try {
      const tile = await cropTile(geoSrc.base64, region);
      const lotResults = await extractMetesAndBounds(
        tile.base64,
        legend,
        features,
      );
      lots.push(...lotResults);
    } catch (err) {
      console.error(`[map-agent] Failed to extract ${region.label}:`, err instanceof Error ? err.message : err);
    }
  }

  // Fallback: if per-lot cropping found nothing, try full page
  if (lots.length === 0) {
    console.log("[map-agent] Per-lot extraction found no lots, falling back to overview");
    lots = await extractMetesAndBounds(geoOverview.base64, legend, features);
  }

  console.log(`[map-agent] Raw extraction: ${lots.length} lots from tiles`);

  // === Pass 2b: Merge & Deduplicate tile extractions ===
  // Tiles may extract the same lot from overlapping crops, or miss parts.
  // Send all raw extractions to the model to merge into clean lot data.
  if (lots.length > 0) {
    lots = await mergeAndDeduplicateLots(geoOverview.base64, legend, lots);
    console.log(`[map-agent] After merge/dedup: ${lots.length} lots`);
  }

  // === Pass 3: Text annotations (grid tiles for comprehensive coverage) ===
  console.log("[map-agent] Generating grid tiles for text extraction...");
  const textTiles = await gridTiles(
    geoSrc.base64,
    geoSrc.width,
    geoSrc.height,
    1200,
    0.25,
  );
  console.log(`[map-agent] ${textTiles.length} grid tiles for annotation extraction`);

  let annotations: TextAnnotation[] = [];
  for (const tile of textTiles) {
    try {
      const tileAnnotations = await extractAnnotations(tile.base64, legend);
      if (!Array.isArray(tileAnnotations)) continue;

      // Remap positions from tile-local percentages to full-image percentages
      for (const ann of tileAnnotations) {
        if (typeof ann !== "object" || ann === null) continue;
        if (typeof ann.x_pct !== "number" || typeof ann.y_pct !== "number") continue;

        ann.x_pct =
          ((tile.bounds.x + (ann.x_pct / 100) * tile.bounds.width) /
            geoSrc.width) *
          100;
        ann.y_pct =
          ((tile.bounds.y + (ann.y_pct / 100) * tile.bounds.height) /
            geoSrc.height) *
          100;
        annotations.push(ann);
      }
    } catch (err) {
      console.error(`[map-agent] Annotation extraction failed for tile ${tile.label}:`, err);
    }
  }

  // Deduplicate annotations: first programmatic pass, then model merge
  annotations = deduplicateAnnotations(annotations);
  console.log(`[map-agent] ${annotations.length} annotations after programmatic dedup`);

  // Model-assisted merge for annotations too
  if (annotations.length > 0) {
    annotations = await mergeAndDeduplicateAnnotations(
      geoOverview.base64,
      legend,
      annotations,
    );
    console.log(`[map-agent] ${annotations.length} annotations after model merge`);
  }

  // === Compute closure errors ===
  const closureErrors = computeClosureErrorsForValidation(lots);

  // === Pass 4: Validation (overview) + refinement ===
  let validation = await validateExtraction(
    geoOverview.base64,
    lots,
    annotations,
    closureErrors,
  );

  if (
    !validation.is_valid &&
    validation.issues.some((i) => i.severity === "error")
  ) {
    console.log(
      `[map-agent] Validation failed with ${validation.issues.length} issues, refining...`,
    );

    const errorContext = validation.issues
      .filter((i) => i.severity === "error")
      .map(
        (i) =>
          `- ${i.description}${i.suggested_correction ? ` → Fix: ${i.suggested_correction}` : ""}`,
      )
      .join("\n");

    // Refinement: re-extract problematic lots using their crops
    const problemLots = new Set(
      validation.issues
        .filter((i) => i.affected_lot)
        .map((i) => i.affected_lot!),
    );

    if (problemLots.size > 0) {
      for (const region of cropRegions) {
        const lotNum = region.label.replace("lot-", "");
        if (!problemLots.has(lotNum)) continue;

        const tile = await cropTile(geoSrc.base64, region);
        const corrected = await extractMetesAndBoundsWithCorrections(
          tile.base64,
          legend,
          features,
          lots.filter((l) => l.lot === lotNum),
          errorContext,
        );
        // Replace the lot data
        lots = lots.filter((l) => l.lot !== lotNum);
        lots.push(...corrected);
      }
    } else {
      // No specific lots identified — re-run on overview
      lots = await extractMetesAndBoundsWithCorrections(
        geoOverview.base64,
        legend,
        features,
        lots,
        errorContext,
      );
    }

    const closureErrors2 = computeClosureErrorsForValidation(lots);
    validation = await validateExtraction(
      geoOverview.base64,
      lots,
      annotations,
      closureErrors2,
    );

    if (!validation.is_valid) {
      console.log(
        `[map-agent] Second validation: ${validation.issues.length} issues remain (accepting best-effort)`,
      );
    }
  }

  return { legend, features, lots, annotations, validation };
}

/**
 * Deduplicate annotations from overlapping tiles.
 * Two annotations are considered duplicates if their text matches
 * and their positions are within 2% of image dimensions.
 */
function deduplicateAnnotations(
  annotations: TextAnnotation[],
): TextAnnotation[] {
  const result: TextAnnotation[] = [];
  for (const ann of annotations) {
    const isDup = result.some(
      (existing) =>
        existing.text === ann.text &&
        Math.abs(existing.x_pct - ann.x_pct) < 2 &&
        Math.abs(existing.y_pct - ann.y_pct) < 2,
    );
    if (!isDup) result.push(ann);
  }
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Re-run metes & bounds extraction with error corrections from validation.
 */
async function extractMetesAndBoundsWithCorrections(
  pageImage: string,
  legend: LegendContext,
  features: FeatureSurvey,
  previousLots: LotExtraction[],
  errorContext: string,
): Promise<LotExtraction[]> {
  console.log("[map-agent] Pass 2 (refinement): Re-extracting with corrections");

  const previousContext = previousLots
    .map(
      (l) =>
        `Lot ${l.lot}: ${l.boundary_sequence.length} segments, POB: ${l.point_of_beginning}`,
    )
    .join("\n");

  const response = await nimVision(
    pageImage,
    `Re-extract the metes and bounds, correcting these errors from the previous extraction:

ERRORS TO FIX:
${errorContext}

PREVIOUS EXTRACTION:
${previousContext}

Read ALL values more carefully this time. Pay special attention to the errors noted above.`,
    {
      systemPrompt:
        METES_BOUNDS_SYSTEM_PROMPT + JSON.stringify(legend, null, 2),
      maxTokens: 8192,
      temperature: 0.1,
    },
  );

  const parsed = parseJsonResponse<LotExtraction | { lots: LotExtraction[] }>(
    response,
  );
  if (Array.isArray(parsed)) return parsed;
  if ("lots" in parsed) return parsed.lots;
  return [parsed as LotExtraction];
}

/**
 * Compute closure errors for all lots (for validation context).
 * Uses the COGO engine via dynamic import to avoid circular deps.
 */
function computeClosureErrorsForValidation(
  lots: LotExtraction[],
): Array<{ lot: string; error: number; ratio: string }> {
  // Inline the minimal COGO needed for closure check
  const results: Array<{ lot: string; error: number; ratio: string }> = [];

  for (const lot of lots) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cogo = require("./cogo");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sl = require("./surveying-language");
      const strokes = sl.parseBoundarySequence(lot.boundary_sequence);
      const legs = sl.strokesToLegs(strokes);
      const points = cogo.computeTraverse({ x: 0, y: 0 }, legs);
      const closure = cogo.closureError(points);
      results.push({
        lot: lot.lot,
        error: Math.round(closure.error * 1000) / 1000,
        ratio: closure.ratio,
      });
    } catch (err) {
      results.push({
        lot: lot.lot,
        error: -1,
        ratio: `parse_error: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
  }

  return results;
}
