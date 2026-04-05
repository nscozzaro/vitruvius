/**
 * Santa Barbara County parcel lookups.
 *
 * geocode        – address → lat/lon via Nominatim
 * getAPN         – lat/lon → APN (MAGNET → SB City ArcGIS → SB County ArcGIS)
 * apnToAssessorMapUrl – APN → assessor parcel map PDF URL
 */

const GOLETA_MAGNET =
  "https://goleta.magnetserver.com/core4/map";
const SB_CITY_PARCELS =
  "https://services3.arcgis.com/hMpg7vsYb74pEKjX/arcgis/rest/services/ODS_Master_Parcel_Layer_2023_04_withR2/FeatureServer/0/query";
const SB_COUNTY_PARCELS =
  "https://services.arcgis.com/KkJhFbLnXVqahKz2/arcgis/rest/services/Parcel_layers_ArcGISonline_LUZO/FeatureServer/0/query";

export async function geocode(
  address: string,
): Promise<{ lat: number; lon: number }> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const resp = await fetch(url, { headers: { "User-Agent": "Vitruvius/1.0" } });
  if (!resp.ok) throw new Error(`Geocoding failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.length) throw new Error(`Address not found: ${address}`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

export async function getAPN(
  lat: number,
  lon: number,
): Promise<string | null> {
  // Try Goleta MAGNET first (covers unincorporated + Goleta)
  try {
    const resp = await fetch(`${GOLETA_MAGNET}/mapClick/portal//`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Vitruvius/1.0",
      },
      body: `lat=${lat}&lng=${lon}&zoom=18`,
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const raw = await resp.json();
      if (raw.found) {
        const text = (raw.content || "") + (raw.parcel_info || "");
        const m = text.match(/(\d{3}-\d{3}-\d{3})/);
        if (m) return m[1];
      }
    }
  } catch { /* fall through */ }

  // Try SB City ArcGIS (covers the city of Santa Barbara)
  try {
    const url =
      `${SB_CITY_PARCELS}?geometry=${lon},${lat}` +
      `&geometryType=esriGeometryPoint&inSR=4326` +
      `&spatialRel=esriSpatialRelIntersects&outFields=APN&returnGeometry=false&f=json`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Vitruvius/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const apn = data.features?.[0]?.attributes?.APN;
      if (apn) return apn;
    }
  } catch { /* fall through */ }

  // Try SB County Planning ArcGIS (covers entire county including unincorporated areas)
  try {
    const url =
      `${SB_COUNTY_PARCELS}?geometry=${lon},${lat}` +
      `&geometryType=esriGeometryPoint&inSR=4326` +
      `&spatialRel=esriSpatialRelIntersects&outFields=APN&returnGeometry=false&f=json`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Vitruvius/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const apn = data.features?.[0]?.attributes?.APN;
      if (apn) return apn;
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * Derives the assessor parcel map PDF URL from an APN.
 *
 * APN format: XXX-XXX-XXX  →  strip dashes  →  first 5 digits  →  key
 * e.g. 039-061-023  →  "03906"  →  http://sbcvote.com/assessor/maps_pdfs/03906.pdf
 */
export function apnToAssessorMapUrl(apn: string): string {
  const key = apn.replace(/-/g, "").slice(0, 5);
  return `http://sbcvote.com/assessor/maps_pdfs/${key}.pdf`;
}
