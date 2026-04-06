/**
 * Spatial recorded-map lookup using a pre-converted GeoJSON index.
 *
 * The GeoJSON file contains 11,628 polygons from the Santa Barbara
 * County Surveyor's spatial indices (Tract Maps, Records of Survey,
 * and Condo Maps), converted from NAD83 State Plane CA V (feet) to WGS84.
 *
 * Given a lat/lon, this finds which recorded map polygon(s) contain
 * the point, returning book/page info.
 */

import mapsData from "@/app/data/tract-maps.json";

export type RecordType = "tract" | "survey" | "condo";

export interface TractMatch {
  book: string;
  page: number;
  sheets: number | null;
  projCode: string;
  projectNo: number | null;
  title: string;
  descript: string;
  recordType: RecordType;
}

interface GeoJSONFeature {
  type: "Feature";
  properties: TractMatch;
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
}

interface GeoJSONCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}

const data = mapsData as unknown as GeoJSONCollection;

/**
 * Ray-casting algorithm for point-in-polygon test.
 * ring is an array of [lon, lat] coordinate pairs.
 */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Human-readable label for a record type. */
export function recordTypeLabel(rt: RecordType): string {
  switch (rt) {
    case "tract": return "Tract Map";
    case "survey": return "Record of Survey";
    case "condo": return "Condo Map";
  }
}

/**
 * Find all recorded maps whose polygon contains the given lat/lon.
 * Returns matches sorted: tracts first (by projectNo desc), then surveys, then condos.
 */
export function findTracts(lat: number, lon: number): TractMatch[] {
  const matches: TractMatch[] = [];

  for (const feature of data.features) {
    const rings = feature.geometry.coordinates;
    if (rings.length > 0 && pointInRing(lon, lat, rings[0])) {
      matches.push(feature.properties);
    }
  }

  // Sort: tracts first (most specific subdivision), then surveys, then condos
  const typeOrder: Record<RecordType, number> = { tract: 0, condo: 1, survey: 2 };
  matches.sort((a, b) => {
    const typeDiff = typeOrder[a.recordType] - typeOrder[b.recordType];
    if (typeDiff !== 0) return typeDiff;
    return (b.projectNo ?? 0) - (a.projectNo ?? 0);
  });

  return matches;
}

export interface NearbyMatch extends TractMatch {
  distanceMeters: number;
}

/**
 * Find recorded maps whose centroids are nearest to the given lat/lon.
 * Used as a fallback when no polygon contains the point.
 * De-duplicates by book/page and returns the closest N unique maps.
 */
export function findNearby(lat: number, lon: number, limit = 5): NearbyMatch[] {
  const candidates: { dist: number; props: TractMatch }[] = [];

  for (const feature of data.features) {
    const ring = feature.geometry.coordinates[0];
    if (!ring || ring.length < 3) continue;

    // Compute centroid
    let clon = 0, clat = 0;
    for (const pt of ring) { clon += pt[0]; clat += pt[1]; }
    clon /= ring.length;
    clat /= ring.length;

    // Approximate distance in meters
    const dlat = (clat - lat) * 111_000;
    const dlon = (clon - lon) * 111_000 * Math.cos(lat * Math.PI / 180);
    const dist = Math.sqrt(dlat * dlat + dlon * dlon);

    if (dist < 1000) { // within 1km
      candidates.push({ dist, props: feature.properties });
    }
  }

  candidates.sort((a, b) => a.dist - b.dist);

  // De-duplicate by book+page
  const seen = new Set<string>();
  const results: NearbyMatch[] = [];
  for (const c of candidates) {
    const key = `${c.props.book}/${c.props.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...c.props, distanceMeters: Math.round(c.dist) });
    if (results.length >= limit) break;
  }

  return results;
}
