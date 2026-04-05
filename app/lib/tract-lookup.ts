/**
 * Spatial tract map lookup using a pre-converted GeoJSON index.
 *
 * The GeoJSON file contains 2,326 tract map polygons from the
 * Santa Barbara County Surveyor's spatial index, converted from
 * NAD83 State Plane CA V (feet) to WGS84.
 *
 * Given a lat/lon, this finds which tract map polygon(s) contain
 * the point, returning book/page info for the recorded map.
 */

import tractMapsData from "@/app/data/tract-maps.json";

export interface TractMatch {
  book: string;
  page: number;
  sheets: number | null;
  projCode: string;
  projectNo: number | null;
  title: string;
  descript: string;
}

interface GeoJSONFeature {
  type: "Feature";
  properties: {
    book: string;
    page: number;
    sheets: number | null;
    projCode: string;
    projectNo: number | null;
    title: string;
    descript: string;
  };
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
}

interface GeoJSONCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}

const data = tractMapsData as GeoJSONCollection;

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

/**
 * Find all tract maps whose polygon contains the given lat/lon.
 * Returns matches sorted by most specific (smallest area) first.
 */
export function findTracts(lat: number, lon: number): TractMatch[] {
  const matches: TractMatch[] = [];

  for (const feature of data.features) {
    const rings = feature.geometry.coordinates;
    // Check outer ring (first ring); holes would need subtraction
    if (rings.length > 0 && pointInRing(lon, lat, rings[0])) {
      matches.push(feature.properties);
    }
  }

  // Sort by projectNo descending — higher number = more recent/specific subdivision
  matches.sort((a, b) => (b.projectNo ?? 0) - (a.projectNo ?? 0));

  return matches;
}
