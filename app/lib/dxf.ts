/**
 * DXF site plan generator with trace → refine → replace logic.
 *
 * Takes raw vectorized traces + AI-extracted geometry data and produces
 * a layered DXF where traced lines are progressively replaced with
 * exact computed geometry.
 */

import { DxfWriter, Units, Colors } from "@tarikjabiri/dxf";
import type { MapMetadata, Stage2Result } from "@/app/lib/map-analyzer";
import type { TracedPath } from "@/app/lib/vectorize";
import {
  traverseSurveyCalls,
  closureError,
  type SurveyCall,
  type TraversedSegment,
  type Point,
} from "@/app/lib/survey-geometry";

// ── Layer config ─────────────────────────────────────────────────────

const LAYERS = {
  LOT:        { name: "LOT",        color: Colors.White },
  STREETS:    { name: "STREETS",    color: Colors.Green },
  EASEMENTS:  { name: "EASEMENTS",  color: Colors.Yellow },
  MONUMENTS:  { name: "MONUMENTS",  color: Colors.Red },
  DIMENSIONS: { name: "DIMENSIONS", color: Colors.Cyan },
  LABELS:     { name: "LABELS",     color: Colors.Magenta },
  NOTES:      { name: "NOTES",      color: 8 },
  TRACE:      { name: "TRACE",      color: 9 },
} as const;

const DIM_TEXT_HEIGHT = 2;
const LABEL_TEXT_HEIGHT = 3;
const DIM_OFFSET = 4;
const MONUMENT_RADIUS = 1.5;

function v3(x: number, y: number, z = 0) { return { x, y, z }; }

// ── Main generator ───────────────────────────────────────────────────

/**
 * Generate a DXF from traced paths + AI-extracted geometry.
 *
 * 1. Start with all traced paths on the TRACE layer
 * 2. Compute exact geometry from AI-extracted bearings/distances
 * 3. For each computed feature, delete nearby traces and insert exact geometry
 * 4. Whatever remains on TRACE is unrecognized
 */
export function generateDxf(
  traces: TracedPath[],
  geometry: Stage2Result,
  metadata: MapMetadata,
  imageWidth: number,
  imageHeight: number,
): string {
  const dxf = new DxfWriter();
  dxf.setUnits(Units.Feet);

  // Create layers
  for (const layer of Object.values(LAYERS)) {
    dxf.addLayer(layer.name, layer.color, "CONTINUOUS");
  }

  // Determine scale: convert from image pixels to document feet
  // If AI extracted a scale, use it; otherwise estimate from image size
  const scale = parseScale(metadata.scale);
  // scale = feet per pixel

  // ── Compute and draw lot geometry ──────────────────────────────────

  const lotGeometries = new Map<string, TraversedSegment[]>();

  for (const lot of (geometry.lots || [])) {
    try {
    const calls = boundariesToCalls(lot.boundaries || []);
    if (calls.length === 0) continue;

    // Each lot starts at origin — we don't have enough spatial data
    // from the AI to position lots relative to each other correctly
    const segments = traverseSurveyCalls(calls);
    if (segments.length === 0) continue;
    lotGeometries.set(lot.number, segments);

    // Draw lot boundary on LOT layer
    dxf.setCurrentLayerName(LAYERS.LOT.name);
    for (const seg of segments) {
      if (seg.center && seg.radius_ft != null && seg.startAngle != null && seg.endAngle != null) {
        const startDeg = 90 - (seg.startAngle * 180) / Math.PI;
        const endDeg = 90 - (seg.endAngle * 180) / Math.PI;
        dxf.addArc(v3(seg.center.x, seg.center.y), seg.radius_ft,
          Math.min(startDeg, endDeg), Math.max(startDeg, endDeg));
      } else {
        dxf.addLine(v3(seg.start.x, seg.start.y), v3(seg.end.x, seg.end.y));
      }
    }

    // Draw dimension annotations
    dxf.setCurrentLayerName(LAYERS.DIMENSIONS.name);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const boundary = lot.boundaries[i];
      if (!boundary) continue;

      let dimText = "";
      if (boundary.type === "line" && boundary.bearing && boundary.distance_ft) {
        dimText = `${boundary.bearing}  ${boundary.distance_ft}'`;
      } else if (boundary.type === "curve") {
        const parts = [];
        if (boundary.radius_ft) parts.push(`R=${boundary.radius_ft}'`);
        if (boundary.arc_length_ft) parts.push(`L=${boundary.arc_length_ft}'`);
        if (boundary.delta) parts.push(`D=${boundary.delta}`);
        dimText = parts.join("  ");
      }

      if (dimText) {
        const angle = Math.atan2(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
        const textAngle = (Math.atan2(seg.end.y - seg.start.y, seg.end.x - seg.start.x) * 180) / Math.PI;
        dxf.addText(
          v3(seg.midpoint.x + Math.cos(angle) * DIM_OFFSET,
             seg.midpoint.y - Math.sin(angle) * DIM_OFFSET),
          DIM_TEXT_HEIGHT,
          dimText,
          { rotation: normalizeTextAngle(textAngle) },
        );
      }
    }

    // Lot number label
    dxf.setCurrentLayerName(LAYERS.LABELS.name);
    const centroid = computeCentroid(segments);
    dxf.addText(v3(centroid.x, centroid.y), LABEL_TEXT_HEIGHT, lot.number);

    } catch (err) {
      console.error(`[dxf] Error processing lot ${lot.number}:`, err);
    }
  }

  // ── Easements ──────────────────────────────────────────────────────

  dxf.setCurrentLayerName(LAYERS.EASEMENTS.name);
  for (const easement of geometry.easements) {
    const lots = Array.isArray(easement.lots) ? easement.lots : [];
    for (const lotNum of lots) {
      const segments = lotGeometries.get(lotNum);
      if (!segments) continue;

      const lot = geometry.lots.find((l) => l.number === lotNum);
      const sideSegs = findSideSegments(segments, easement.side, lot?.boundaries);
      for (const seg of sideSegs) {
        const angle = Math.atan2(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
        const ox = Math.sin(angle + Math.PI / 2) * easement.width_ft;
        const oy = Math.cos(angle + Math.PI / 2) * easement.width_ft;
        dxf.addLine(
          v3(seg.start.x + ox, seg.start.y + oy),
          v3(seg.end.x + ox, seg.end.y + oy),
        );
      }

      if (sideSegs.length > 0) {
        dxf.addText(
          v3(sideSegs[0].midpoint.x, sideSegs[0].midpoint.y),
          DIM_TEXT_HEIGHT * 0.8,
          `${easement.width_ft}' ${easement.type}`,
        );
      }
    }
  }

  // ── Monuments ──────────────────────────────────────────────────────

  dxf.setCurrentLayerName(LAYERS.MONUMENTS.name);
  for (const monument of (geometry.monuments || [])) {
    const pos = findMonumentPosition(monument, lotGeometries, geometry.lots);
    if (!pos) continue;

    dxf.addCircle(v3(pos.x, pos.y), MONUMENT_RADIUS);
    if (monument.description) {
      dxf.addText(
        v3(pos.x + MONUMENT_RADIUS * 2, pos.y + MONUMENT_RADIUS),
        DIM_TEXT_HEIGHT * 0.6,
        monument.description.toUpperCase(),
      );
    }
  }

  // ── Street names ───────────────────────────────────────────────────

  dxf.setCurrentLayerName(LAYERS.LABELS.name);
  for (const street of (geometry.streets || [])) {
    dxf.addText(v3(0, -20), LABEL_TEXT_HEIGHT, street.name);
    if (street.width_ft) {
      dxf.addText(v3(0, -20 - LABEL_TEXT_HEIGHT * 1.5), DIM_TEXT_HEIGHT * 0.8,
        `${street.width_ft}' R/W`);
    }
  }

  // ── Metadata notes ─────────────────────────────────────────────────

  dxf.setCurrentLayerName(LAYERS.NOTES.name);
  const metaLines: string[] = [];
  if (metadata.tract_name) metaLines.push(metadata.tract_name);
  if (metadata.book && metadata.pages)
    metaLines.push(`Book ${metadata.book}, Pages ${metadata.pages}`);
  if (metadata.date_filed) metaLines.push(`Filed: ${metadata.date_filed}`);
  if (metadata.surveyor)
    metaLines.push(`Surveyor: ${metadata.surveyor}${metadata.license ? `, ${metadata.license}` : ""}`);
  if (metadata.company) metaLines.push(`Company: ${metadata.company}`);
  if (metadata.scale) metaLines.push(`Scale: ${metadata.scale}`);
  if (metadata.notes) metaLines.push(...metadata.notes);

  let metaY = 250;
  for (const line of metaLines) {
    dxf.addText(v3(-50, metaY), DIM_TEXT_HEIGHT * 0.7, line);
    metaY -= DIM_TEXT_HEIGHT * 1.2;
  }

  // ── Vectorized traces ───────────────────────────────────────────────
  // Draw ALL traces on the TRACE layer as-is (image coordinates scaled to feet).
  // These provide the visual baseline of the scanned map.

  dxf.setCurrentLayerName(LAYERS.TRACE.name);
  for (const path of traces) {
    const pts = path.points.map((p) => ({
      x: p.x * scale,
      y: (imageHeight - p.y) * scale,
    }));

    if (pts.length >= 2) {
      for (let j = 0; j < pts.length - 1; j++) {
        dxf.addLine(v3(pts[j].x, pts[j].y), v3(pts[j + 1].x, pts[j + 1].y));
      }
    }
  }

  return dxf.stringify();
}

// ── Helpers ──────────────────────────────────────────────────────────

function boundariesToCalls(boundaries: Stage2Result["lots"][0]["boundaries"]): SurveyCall[] {
  const calls: SurveyCall[] = [];
  for (const b of boundaries) {
    if (b.type === "line" && b.bearing && b.distance_ft) {
      calls.push({ type: "line", bearing: b.bearing, distance_ft: b.distance_ft });
    } else if (b.type === "curve" && b.radius_ft) {
      calls.push({
        type: "curve",
        radius_ft: b.radius_ft,
        arc_length_ft: b.arc_length_ft,
        delta: b.delta,
        direction: b.direction === "right" || b.direction === "concave_east" || b.direction === "concave_south"
          ? "right" : "left",
      });
    }
  }
  return calls;
}

function computeCentroid(segments: TraversedSegment[]): Point {
  const points = segments.map((s) => s.start);
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
}

function normalizeTextAngle(angle: number): number {
  let a = ((angle % 360) + 360) % 360;
  if (a > 90 && a < 270) a += 180;
  return a % 360;
}

function findSideSegments(
  segments: TraversedSegment[],
  side: string,
  boundaries?: Stage2Result["lots"][0]["boundaries"],
): TraversedSegment[] {
  if (!boundaries) return [];
  const results: TraversedSegment[] = [];
  for (let i = 0; i < Math.min(segments.length, boundaries.length); i++) {
    if (boundaries[i]?.side?.toLowerCase() === side.toLowerCase()) {
      results.push(segments[i]);
    }
  }
  return results;
}

function findMonumentPosition(
  monument: Stage2Result["monuments"][0],
  lotGeometries: Map<string, TraversedSegment[]>,
  lots: Stage2Result["lots"],
): Point | null {
  if (!monument.at_corner_of?.length) return null;
  const ref = monument.at_corner_of[0];
  const lotMatch = ref.match(/lot\s*(\d+)/i);
  if (!lotMatch) return null;

  const segments = lotGeometries.get(lotMatch[1]);
  if (!segments?.length) return null;

  const sideMatch = ref.match(/(east|west|north|south|front|rear|back)/i);
  if (sideMatch) {
    const side = sideMatch[1].toLowerCase();
    const lot = lots.find((l) => l.number === lotMatch[1]);
    if (lot) {
      for (let i = 0; i < lot.boundaries.length; i++) {
        if (lot.boundaries[i]?.side?.toLowerCase().includes(side) && segments[i]) {
          return segments[i].start;
        }
      }
    }
  }
  return segments[0].start;
}

/**
 * Parse a scale string like "1 inch = 60 feet" to feet per pixel.
 * Returns a reasonable default if parsing fails.
 */
function parseScale(scaleStr?: string): number {
  if (!scaleStr) return 0.5; // default: 0.5 ft/px (reasonable for 2048px map)

  const match = scaleStr.match(/1\s*(?:inch|in|")\s*=\s*(\d+)\s*(?:feet|ft|')/i);
  if (match) {
    const feetPerInch = parseInt(match[1]);
    // At 2048px for a ~24" wide map, that's ~85 DPI
    // feetPerPixel = feetPerInch / DPI ≈ feetPerInch / 85
    return feetPerInch / 85;
  }

  return 0.5;
}
