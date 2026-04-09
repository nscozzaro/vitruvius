/**
 * SVG Feature Extraction — parse potrace SVG output and classify
 * geometric features (monuments, boundary lines, dashed lines).
 *
 * Potrace traces ink outlines at full 300 DPI resolution. Each ink mark
 * becomes one or more closed SVG subpaths. We classify these by geometry:
 *   - Small closed loops with high circularity → monument circles
 *   - Long paths → boundary line edges (paired into centerlines)
 *   - Short collinear segments with regular spacing → dashed easement lines
 *
 * A grid-based spatial index enables O(1) nearest-feature lookups.
 */

// ─── Types ──────────────────────────────────────────────────

export interface SvgPoint {
  x: number;
  y: number;
}

export interface SvgMonument {
  id: string;
  center: SvgPoint;
  radius: number;
  circularity: number;
  area: number;
  /** Bounding box in image pixels */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface SvgBoundarySegment {
  id: string;
  /** Centerline points (after pairing parallel outline edges) */
  points: SvgPoint[];
  /** Total length in pixels */
  length: number;
  /** Bounding box */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface SvgFeatureMap {
  monuments: SvgMonument[];
  boundaryLines: SvgBoundarySegment[];
  /** Grid-based spatial index: cell key → feature IDs */
  grid: Map<string, string[]>;
  gridCellSize: number;
  imageWidth: number;
  imageHeight: number;
}

// ─── Constants ──────────────────────────────────────────────

/** Monuments are typically 2mm on paper → ~8-24px at 300 DPI */
const MONUMENT_MAX_BBOX = 40;
const MONUMENT_MIN_BBOX = 4;
const MONUMENT_MIN_CIRCULARITY = 0.55;

/** Boundary lines must be at least this long (pixels) */
const MIN_LINE_LENGTH = 80;

const GRID_CELL_SIZE = 500;

// ─── Main Entry ─────────────────────────────────────────────

/**
 * Extract and classify geometric features from a potrace SVG string.
 */
export function extractSvgFeatures(
  rawSvg: string,
  imageWidth: number,
  imageHeight: number,
): SvgFeatureMap {
  const subpaths = parseAllSubpaths(rawSvg);

  const monuments: SvgMonument[] = [];
  const longPaths: Array<{ id: string; points: SvgPoint[]; length: number; bbox: ReturnType<typeof computeBbox> }> = [];

  let mIdx = 0;
  let lIdx = 0;

  // Diagnostic: track why closed paths are rejected
  const diag = { tooSmall: 0, tooLarge: 0, notCircular: 0, lowArea: 0, notClosed: 0, accepted: 0, closedTotal: 0 };

  for (const sp of subpaths) {
    if (sp.points.length < 3) continue;

    const bbox = computeBbox(sp.points);
    const bboxW = bbox.w;
    const bboxH = bbox.h;
    const maxDim = Math.max(bboxW, bboxH);

    // Classify as monument candidate: small, closed, circular
    if (sp.closed && maxDim <= MONUMENT_MAX_BBOX * 2) {
      diag.closedTotal++;
    }

    if (
      sp.closed &&
      maxDim >= MONUMENT_MIN_BBOX &&
      maxDim <= MONUMENT_MAX_BBOX
    ) {
      const area = Math.abs(shoelaceArea(sp.points));
      const perimeter = polylineLength(sp.points, true);
      const circularity = perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;

      if (area <= 10) {
        diag.lowArea++;
      } else if (circularity < MONUMENT_MIN_CIRCULARITY) {
        diag.notCircular++;
      } else {
        const center = centroid(sp.points);
        const radius = Math.sqrt(area / Math.PI);
        monuments.push({
          id: `mon-${mIdx++}`,
          center,
          radius,
          circularity,
          area,
          bbox,
        });
        diag.accepted++;
        continue;
      }
    } else if (sp.closed && maxDim < MONUMENT_MIN_BBOX) {
      diag.tooSmall++;
    } else if (sp.closed && maxDim > MONUMENT_MAX_BBOX && maxDim <= MONUMENT_MAX_BBOX * 2) {
      diag.tooLarge++;
    }

    // Classify as boundary line candidate: long path
    const len = polylineLength(sp.points, sp.closed);
    if (len >= MIN_LINE_LENGTH) {
      longPaths.push({
        id: `seg-${lIdx++}`,
        points: sp.points,
        length: len,
        bbox,
      });
    }
  }

  console.log(`[svg-features] Monument detection: ${diag.closedTotal} small closed paths, ${diag.tooSmall} too small, ${diag.tooLarge} too large, ${diag.notCircular} not circular, ${diag.lowArea} low area, ${diag.accepted} accepted`);

  // For boundary lines, simplify long paths with Douglas-Peucker
  const boundaryLines: SvgBoundarySegment[] = longPaths.map((p) => ({
    id: p.id,
    points: douglasPeucker(p.points, 3),
    length: p.length,
    bbox: p.bbox,
  }));

  // Build spatial index
  const grid = new Map<string, string[]>();

  for (const m of monuments) {
    const key = gridKey(m.center.x, m.center.y, GRID_CELL_SIZE);
    const list = grid.get(key) ?? [];
    list.push(m.id);
    grid.set(key, list);
  }

  for (const seg of boundaryLines) {
    // Index each segment's simplified points
    const seen = new Set<string>();
    for (const p of seg.points) {
      const key = gridKey(p.x, p.y, GRID_CELL_SIZE);
      if (!seen.has(key)) {
        seen.add(key);
        const list = grid.get(key) ?? [];
        list.push(seg.id);
        grid.set(key, list);
      }
    }
  }

  return {
    monuments,
    boundaryLines,
    grid,
    gridCellSize: GRID_CELL_SIZE,
    imageWidth,
    imageHeight,
  };
}

// ─── Queries ────────────────────────────────────────────────

/**
 * Find the nearest monument to a given pixel position.
 */
export function findNearestMonument(
  features: SvgFeatureMap,
  point: SvgPoint,
  maxDistPx = 100,
): SvgMonument | null {
  let best: SvgMonument | null = null;
  let bestDist = maxDistPx;

  // Check nearby grid cells
  const radius = Math.ceil(maxDistPx / features.gridCellSize);
  const cx = Math.floor(point.x / features.gridCellSize);
  const cy = Math.floor(point.y / features.gridCellSize);

  const candidateIds = new Set<string>();
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const key = `${cx + dx},${cy + dy}`;
      const ids = features.grid.get(key);
      if (ids) ids.forEach((id) => candidateIds.add(id));
    }
  }

  for (const m of features.monuments) {
    if (!candidateIds.has(m.id)) continue;
    const d = dist(point, m.center);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }

  return best;
}

/**
 * Find all features within a bounding box region.
 */
export function findFeaturesInRegion(
  features: SvgFeatureMap,
  bbox: { x: number; y: number; w: number; h: number },
): { monuments: SvgMonument[]; segments: SvgBoundarySegment[] } {
  const x1 = bbox.x;
  const y1 = bbox.y;
  const x2 = bbox.x + bbox.w;
  const y2 = bbox.y + bbox.h;

  const mons = features.monuments.filter((m) =>
    m.center.x >= x1 && m.center.x <= x2 &&
    m.center.y >= y1 && m.center.y <= y2,
  );

  const segs = features.boundaryLines.filter((s) =>
    s.bbox.x + s.bbox.w >= x1 && s.bbox.x <= x2 &&
    s.bbox.y + s.bbox.h >= y1 && s.bbox.y <= y2,
  );

  return { monuments: mons, segments: segs };
}

/**
 * Score how well a set of projected pixel points align with SVG boundary features.
 * Returns average minimum distance from each point to the nearest SVG boundary path.
 *
 * Lower distance = better alignment. Score uses exponential decay:
 *   score = exp(-avgDist / decayPx)
 */
export function scorePlacement(
  projectedPoints: Array<{ px: number; py: number }>,
  features: SvgFeatureMap,
  decayPx = 5,
): { score: number; avgDistPx: number; maxDistPx: number } {
  if (projectedPoints.length === 0) return { score: 0, avgDistPx: Infinity, maxDistPx: Infinity };

  // Collect nearby boundary segments for the whole projected shape
  const allBbox = computeBbox(projectedPoints.map((p) => ({ x: p.px, y: p.py })));
  const pad = 50;
  const searchBbox = {
    x: allBbox.x - pad,
    y: allBbox.y - pad,
    w: allBbox.w + pad * 2,
    h: allBbox.h + pad * 2,
  };
  const { segments } = findFeaturesInRegion(features, searchBbox);

  if (segments.length === 0) return { score: 0, avgDistPx: Infinity, maxDistPx: Infinity };

  // Sample evenly along the projected line
  const numSamples = Math.min(30, projectedPoints.length);
  const step = Math.max(1, Math.floor(projectedPoints.length / numSamples));
  let totalDist = 0;
  let maxDist = 0;
  let count = 0;

  for (let i = 0; i < projectedPoints.length; i += step) {
    const p = { x: projectedPoints[i].px, y: projectedPoints[i].py };
    let minDist = Infinity;

    for (const seg of segments) {
      const d = pointToPolylineDistance(p, seg.points);
      if (d < minDist) minDist = d;
    }

    totalDist += minDist;
    if (minDist > maxDist) maxDist = minDist;
    count++;
  }

  const avgDistPx = count > 0 ? totalDist / count : Infinity;
  const score = Math.exp(-avgDistPx / decayPx);

  return { score, avgDistPx, maxDistPx: maxDist };
}

/**
 * Minimum distance from a point to a polyline (sequence of line segments).
 */
export function pointToPolylineDistance(p: SvgPoint, polyline: SvgPoint[]): number {
  let minD = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentDistance(p, polyline[i], polyline[i + 1]);
    if (d < minD) minD = d;
  }
  return minD;
}

// ─── SVG Parsing ────────────────────────────────────────────

interface ParsedSubpath {
  points: SvgPoint[];
  closed: boolean;
}

/**
 * Parse all subpaths from a potrace SVG string.
 * Potrace outputs a single <path> with a `d` attribute containing
 * multiple subpaths separated by M (moveto) commands.
 */
function parseAllSubpaths(svg: string): ParsedSubpath[] {
  // Extract all d="..." attributes
  const dMatches = svg.match(/d="([^"]+)"/g);
  if (!dMatches) return [];

  const results: ParsedSubpath[] = [];

  for (const dMatch of dMatches) {
    const d = dMatch.slice(3, -1); // strip d=" and trailing "

    // Split on M commands to get individual subpaths
    // Potrace uses "M x y" format (with space after M)
    const subpathStrs = d.split(/(?=M\s)/).filter((s) => s.trim());

    for (const sp of subpathStrs) {
      const points = extractAllPoints(sp);
      if (points.length < 2) continue;

      // Detect closure: potrace doesn't always use Z — check if first ≈ last point
      const hasZ = /[Zz]/.test(sp);
      const first = points[0];
      const last = points[points.length - 1];
      const closeDist = Math.sqrt((first.x - last.x) ** 2 + (first.y - last.y) ** 2);
      const closed = hasZ || closeDist < 3; // within 3px = effectively closed

      results.push({ points, closed });
    }
  }

  return results;
}

/**
 * Extract coordinate points from an SVG path data string.
 * Handles M (moveto), L (lineto), C (cubic bezier — sample endpoints + midpoint).
 */
function extractAllPoints(d: string): SvgPoint[] {
  const points: SvgPoint[] = [];
  // Match all coordinate pairs
  const regex = /(-?[\d.]+)\s*,\s*(-?[\d.]+)/g;
  let m;
  while ((m = regex.exec(d)) !== null) {
    points.push({
      x: parseFloat(m[1]),
      y: parseFloat(m[2]),
    });
  }
  return points;
}

// ─── Geometry Helpers ───────────────────────────────────────

function dist(a: SvgPoint, b: SvgPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function computeBbox(points: SvgPoint[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function centroid(points: SvgPoint[]): SvgPoint {
  let sx = 0, sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/** Shoelace formula for polygon area (signed). */
function shoelaceArea(points: SvgPoint[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

/** Total length of a polyline. If closed, includes the closing segment. */
function polylineLength(points: SvgPoint[], closed: boolean): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += dist(points[i - 1], points[i]);
  }
  if (closed && points.length > 2) {
    len += dist(points[points.length - 1], points[0]);
  }
  return len;
}

/** Douglas-Peucker polyline simplification. */
function douglasPeucker(points: SvgPoint[], epsilon: number): SvgPoint[] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function perpDistance(p: SvgPoint, a: SvgPoint, b: SvgPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Distance from point to line segment (a→b). */
function pointToSegmentDistance(p: SvgPoint, a: SvgPoint, b: SvgPoint): number {
  return perpDistance(p, a, b);
}

function gridKey(x: number, y: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
}
