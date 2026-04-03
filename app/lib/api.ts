/**
 * Typed API client for Vitruvius backend endpoints.
 */

export interface GeocodedAddress {
  address: string;
  latitude: number;
  longitude: number;
}

export interface CollectedImage {
  url: string;
  source: string;
  description?: string;
}

export interface AssessorData {
  sqft?: number;
  lot_sqft?: number;
  bedrooms?: number;
  bathrooms?: number;
  year_built?: number;
  stories?: number;
  roof_type?: string;
  exterior_material?: string;
  raw_data?: Record<string, unknown>;
}

export interface FootprintPoint {
  x: number;
  y: number;
}

export interface CollectionResults {
  geocoded: GeocodedAddress | null;
  footprint: FootprintPoint[] | null;
  elevation_m: number | null;
  streetImages: CollectedImage[];
  listingPhotos: CollectedImage[];
  assessor: AssessorData | null;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `API error: ${resp.status}`);
  }
  return resp.json();
}

export async function geocodeAddress(address: string): Promise<GeocodedAddress> {
  return postJson("/api/collect", { address });
}

export async function collectOsm(lat: number, lon: number) {
  return postJson<{ source: string; footprint: FootprintPoint[] | null }>(
    "/api/collect_osm",
    { latitude: lat, longitude: lon }
  );
}

export async function collectStreet(lat: number, lon: number) {
  return postJson<{ source: string; images: CollectedImage[] }>(
    "/api/collect_street",
    { latitude: lat, longitude: lon }
  );
}

export async function collectAssessor(address: string, lat: number, lon: number) {
  return postJson<{ source: string; data: AssessorData | null }>(
    "/api/collect_assessor",
    { address, latitude: lat, longitude: lon }
  );
}

export async function collectElevation(lat: number, lon: number) {
  return postJson<{ source: string; elevation_m: number | null }>(
    "/api/collect_elevation",
    { latitude: lat, longitude: lon }
  );
}

export async function collectPhotos(address: string) {
  return postJson<{ source: string; images: CollectedImage[] }>(
    "/api/collect_photos",
    { address }
  );
}

/**
 * Run all data collection in parallel after geocoding.
 */
export async function collectAll(address: string): Promise<CollectionResults> {
  // Step 1: Geocode
  const geocoded = await geocodeAddress(address);
  const { latitude: lat, longitude: lon } = geocoded;

  // Step 2: Run all collectors in parallel
  const [osmResult, streetResult, assessorResult, elevationResult, photosResult] =
    await Promise.allSettled([
      collectOsm(lat, lon),
      collectStreet(lat, lon),
      collectAssessor(address, lat, lon),
      collectElevation(lat, lon),
      collectPhotos(address),
    ]);

  return {
    geocoded,
    footprint:
      osmResult.status === "fulfilled" ? osmResult.value.footprint : null,
    elevation_m:
      elevationResult.status === "fulfilled"
        ? elevationResult.value.elevation_m
        : null,
    streetImages:
      streetResult.status === "fulfilled" ? streetResult.value.images : [],
    listingPhotos:
      photosResult.status === "fulfilled" ? photosResult.value.images : [],
    assessor:
      assessorResult.status === "fulfilled" ? assessorResult.value.data : null,
  };
}
