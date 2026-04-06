/**
 * AI-powered map analysis — 2-stage extraction from survey/tract map images.
 *
 * Stage 1: Identify non-geometry areas (title block, signatures, etc.),
 *          extract their text content, return bounding boxes for masking.
 *
 * Stage 2: Extract detailed geometry data (lot boundaries, bearings,
 *          distances, monuments, easements) from the geometry portion.
 *
 * Uses Llama 4 Maverick via Nvidia NIM (free tier).
 */

import { callVisionLLM } from "@/app/lib/llm";

// ── Stage 1 types ────────────────────────────────────────────────────

export interface MaskRegion {
  label: string;
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct: number;
}

export interface MapMetadata {
  tract_name?: string;
  book?: string;
  pages?: string;
  date_filed?: string;
  surveyor?: string;
  license?: string;
  company?: string;
  legal_description?: string;
  scale?: string;
  notes?: string[];
  certifications?: string[];
}

export interface Stage1Result {
  metadata: MapMetadata;
  mask_regions: MaskRegion[];
}

// ── Stage 2 types ────────────────────────────────────────────────────

export interface ExtractedBoundary {
  side: string;
  type: "line" | "curve";
  bearing?: string;
  distance_ft?: number;
  radius_ft?: number;
  arc_length_ft?: number;
  delta?: string;
  direction?: string;
}

export interface ExtractedLot {
  number: string;
  boundaries: ExtractedBoundary[];
}

export interface ExtractedMonument {
  type: string;
  description?: string;
  at_corner_of?: string[];
}

export interface ExtractedEasement {
  type: string;
  width_ft: number;
  side: string;
  lots: string[];
}

export interface ExtractedStreet {
  name: string;
  width_ft?: number;
  type?: string;
  centerline_radius_ft?: number;
}

export interface Stage2Result {
  lots: ExtractedLot[];
  streets: ExtractedStreet[];
  easements: ExtractedEasement[];
  monuments: ExtractedMonument[];
}

// ── Stage 1: Extract metadata and identify mask regions ──────────────

const STAGE1_SYSTEM = `You are an expert surveyor analyzing a Santa Barbara County recorded map. Your task is to identify and extract content from non-geometry areas of the map.`;

const STAGE1_USER = `Analyze this survey/tract map.

1. READ all text from non-geometry areas: title block, surveyor certifications, engineer stamps, legal descriptions, general notes, scale notation, filing info, signatures.

2. Return BOUNDING BOXES for each non-geometry area so it can be masked out before vectorizing.

Return ONLY JSON:
{
  "metadata": {
    "tract_name": "TRACT 10780",
    "book": "76",
    "pages": "20-22",
    "date_filed": "3/12/1968",
    "surveyor": "Roland I. Groom",
    "license": "PLS 3253",
    "company": "Penfield & Smith",
    "legal_description": "being lot 8 of tract 10629",
    "scale": "1 inch = 60 feet",
    "notes": ["6' general PUE on south side of all lots"],
    "certifications": ["Surveyor cert...", "County Recorder cert..."]
  },
  "mask_regions": [
    { "label": "title_block", "x_pct": 60, "y_pct": 0, "w_pct": 40, "h_pct": 35 },
    { "label": "signatures", "x_pct": 0, "y_pct": 85, "w_pct": 100, "h_pct": 15 },
    { "label": "vicinity_map", "x_pct": 0, "y_pct": 40, "w_pct": 15, "h_pct": 20 },
    { "label": "north_arrow", "x_pct": 5, "y_pct": 5, "w_pct": 10, "h_pct": 10 }
  ]
}

Coordinates are percentages of image width/height (0-100). Be generous with bounding boxes — better to mask slightly too much than leave signatures in the geometry trace.`;

export async function analyzeStage1(imageBase64: string): Promise<Stage1Result> {
  const raw = await callVisionLLM(
    STAGE1_SYSTEM,
    imageBase64,
    "image/png",
    STAGE1_USER,
    { maxTokens: 2048, temperature: 0 },
  );

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { metadata: {}, mask_regions: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      metadata: parsed.metadata || {},
      mask_regions: parsed.mask_regions || [],
    };
  } catch {
    return { metadata: {}, mask_regions: [] };
  }
}

// ── Stage 2: Extract geometry details ────────────────────────────────

const STAGE2_SYSTEM = `You are an expert surveyor reading a Santa Barbara County tract/survey map. Extract every lot boundary with precise bearings and distances.`;

const STAGE2_USER = `Extract ALL geometry features from this survey map as JSON:

{
  "lots": [
    {
      "number": "5",
      "boundaries": [
        { "side": "east", "type": "line", "bearing": "N 75°22'10\\" W", "distance_ft": 146.31 },
        { "side": "front", "type": "curve", "radius_ft": 628, "arc_length_ft": 82.78, "delta": "7°33'10\\"", "direction": "left" },
        { "side": "west", "type": "line", "bearing": "N 82°55'25\\" W", "distance_ft": 146.31 },
        { "side": "rear", "type": "line", "bearing": "...", "distance_ft": 0 }
      ]
    }
  ],
  "streets": [
    { "name": "LINFIELD PLACE", "width_ft": 56, "type": "cul-de-sac", "centerline_radius_ft": 48 }
  ],
  "easements": [
    { "type": "PUE", "width_ft": 6, "side": "south", "lots": ["5", "6"] }
  ],
  "monuments": [
    { "type": "open_circle", "description": "set", "at_corner_of": ["lot 5 east", "lot 4 west"] }
  ]
}

IMPORTANT:
- Read ALL lots with ALL boundary segments
- For curves: R= (radius), L= (arc length), Δ= (delta angle)
- Use exact bearing format from the map (degrees, minutes, seconds)
- List boundaries going CLOCKWISE around each lot
- Identify monument symbols: ○ = set, ● = found
- Note ALL easements with widths
- Reply with ONLY the JSON`;

export async function analyzeStage2(imageBase64: string): Promise<Stage2Result> {
  const raw = await callVisionLLM(
    STAGE2_SYSTEM,
    imageBase64,
    "image/png",
    STAGE2_USER,
    { maxTokens: 4096, temperature: 0 },
  );

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { lots: [], streets: [], easements: [], monuments: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      lots: parsed.lots || [],
      streets: parsed.streets || [],
      easements: parsed.easements || [],
      monuments: parsed.monuments || [],
    };
  } catch {
    return { lots: [], streets: [], easements: [], monuments: [] };
  }
}
