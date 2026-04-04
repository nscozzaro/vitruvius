import { NextRequest, NextResponse } from "next/server";

/**
 * Santa Barbara Region GIS Data Sources
 *
 * GOLETA (City) — MAGNET Government Portal:
 *   Base: https://goleta.magnetserver.com/core4/map
 *   Endpoints:
 *     - /mapSearch?term=<address>  → autocomplete [{value:"lon lat zoom", label:"address (APN)"}]
 *     - POST /mapClick/portal//    → body: lat=&lng=&zoom=18 → {found, content, geom[], parcel_info}
 *       geom[]: GeoJSON Polygon strings (lat,lon coordinate order)
 *       content: HTML with Property Info, Planning, Building permit tabs
 *     - /plotplanPopup/<id>        → plot plan details
 *   Portal: https://goleta.onlinegovt.com/mapping/results
 *   Parcels WMS layer_id: 208
 *
 * SANTA BARBARA (City) — ArcGIS FeatureServer:
 *   Parcel Layer: https://services3.arcgis.com/hMpg7vsYb74pEKjX/arcgis/rest/services/
 *                 ODS_Master_Parcel_Layer_2023_04_withR2/FeatureServer/0
 *   Owner: anares@santabarbaraca.gov
 *   Fields: APN, Zone, LUDesignations, GPNeighborhood, FemaFldZone, HighFireHazard,
 *           DesLandmrkArea, HistResInv, StreetSetback, CZJurisdiction, CBD, and more
 *   Geometry: esriGeometryPolygon (rings in lon,lat format, WGS84)
 *   Permits: Accela portal at https://aca-prod.accela.com/SANTABARBARA/ (requires browser)
 *
 * SANTA BARBARA COUNTY (unincorporated):
 *   Zoning: https://services.arcgis.com/KkJhFbLnXVqahKz2/arcgis/rest/services/Zoning_Color_Coded/FeatureServer
 *   County Parcels: https://services3.arcgis.com/cWFJLCeHRd2Du08V/arcgis/rest/services/
 *                   Santa_Barbara_County_Parcels_by_Land_Use/FeatureServer
 *   MapServer: https://gis.countyofsb.org/server2/rest/services/PL_GIS/
 *   Permits: Accela at https://aca-prod.accela.com/SBCO/
 *
 * DETECTION: The route auto-detects jurisdiction by trying each source.
 * Goleta MAGNET is tried first (returns found:true/false), then SB City ArcGIS.
 */

const GOLETA_MAGNET = "https://goleta.magnetserver.com/core4/map";
const SB_CITY_PARCELS =
  "https://services3.arcgis.com/hMpg7vsYb74pEKjX/arcgis/rest/services/ODS_Master_Parcel_Layer_2023_04_withR2/FeatureServer/0/query";

interface ParcelResult {
  apn: string | null;
  zoning: string | null;
  landUse: string | null;
  address: string | null;
  neighborhood: string | null;
  parcelBoundary: { lat: number; lon: number }[];
  permits: { type: string; number: string; category: string }[];
  extra: Record<string, string | null>;
  source: string;
}

// ── Goleta (MAGNET) ─────────────────────────────────────────────────
async function tryGoleta(
  lat: number,
  lon: number,
  address?: string
): Promise<ParcelResult | null> {
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

    if (!resp.ok) return null;
    const raw = await resp.json();
    if (!raw.found) return null;

    // Parse parcel polygon
    let parcelBoundary: { lat: number; lon: number }[] = [];
    if (raw.geom?.length) {
      try {
        const geo =
          typeof raw.geom[0] === "string"
            ? JSON.parse(raw.geom[0])
            : raw.geom[0];
        if (geo.coordinates?.[0]) {
          parcelBoundary = geo.coordinates[0].map((pt: number[]) => ({
            lat: pt[0],
            lon: pt[1],
          }));
        }
      } catch {
        /* skip */
      }
    }

    const content = raw.content || "";
    const parcelInfo = raw.parcel_info || "";
    const plain = content.replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ");

    const apnMatch =
      content.match(/(\d{3}-\d{3}-\d{3})/) ||
      parcelInfo.match(/(\d{3}-\d{3}-\d{3})/);
    const zoningMatch = plain.match(/Zoning District:\s*\n?\s*([A-Z][A-Z0-9/-]*)/);
    const landUseMatch = plain.match(/Land Use:\s*\n?\s*(\w+)/);

    // Extract permits
    const permits: ParcelResult["permits"] = [];
    const permitRe =
      /(?:Building|Mechanical|Plumbing|Electrical|Planning|Ministerial|Miscellaneous)[^(\n]*?-\s*([^\s(]+(?:\s*-\s*[^\s(]+)*)\s*(?:\(([^)]*)\))?/g;
    let m;
    while ((m = permitRe.exec(plain)) !== null) {
      const full = m[0].trim();
      const cat = full.split(" - ")[0].trim();
      const rest = full.replace(cat + " - ", "").split("(")[0].trim();
      const parts = rest.split(" - ");
      permits.push({
        category: cat,
        type: parts.length > 1 ? parts[0].trim() : "",
        number: (parts.length > 1 ? parts.slice(1).join("-") : parts[0]).trim(),
      });
    }

    return {
      apn: apnMatch?.[1] || null,
      zoning: zoningMatch?.[1] || null,
      landUse: landUseMatch?.[1] || null,
      address: address || null,
      neighborhood: null,
      parcelBoundary,
      permits,
      extra: {},
      source: "goleta_magnet",
    };
  } catch {
    return null;
  }
}

// ── Santa Barbara City (ArcGIS) ─────────────────────────────────────
async function trySantaBarbara(
  lat: number,
  lon: number,
  address?: string
): Promise<ParcelResult | null> {
  try {
    const url = `${SB_CITY_PARCELS}?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Vitruvius/1.0" },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const features = data.features || [];
    if (features.length === 0) return null;

    const f = features[0];
    const a = f.attributes || {};
    const rings = f.geometry?.rings || [];

    let parcelBoundary: { lat: number; lon: number }[] = [];
    if (rings[0]) {
      parcelBoundary = rings[0].map((pt: number[]) => ({
        lat: pt[1],
        lon: pt[0],
      }));
    }

    return {
      apn: a.APN || null,
      zoning: a.Zone || null,
      landUse: a.LUDesignations || null,
      address: address || null,
      neighborhood: a.GPNeighborhood || null,
      parcelBoundary,
      permits: [], // Accela requires browser — no server-side API
      extra: {
        femaFloodZone: a.FemaFldZone || null,
        highFireHazard: a.HighFireHazard || null,
        historicDistrict: a.DesLandmrkArea || null,
        historicInventory: a.HistResInv || null,
        streetSetback: a.StreetSetback || null,
        coastalZone: a.CZJurisdiction || null,
        cbd: a.CBD || null,
        potentialHistoricDistrict: a.PotHistoricDist || null,
        demoReviewArea: a.DemoRSArea || null,
        archMonitoring: a.ArchMonitoring || null,
        schoolDistBuffer: a.SBSchDistBuff || null,
      },
      source: "sb_city_arcgis",
    };
  } catch {
    return null;
  }
}

// ── Route Handler ───────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { latitude, longitude, address } = body;

    if (latitude === undefined || longitude === undefined) {
      return NextResponse.json({ error: "Missing coordinates" }, { status: 400 });
    }

    // Try jurisdictions in order — Goleta first (more detailed), then SB City
    const result =
      (await tryGoleta(latitude, longitude, address)) ||
      (await trySantaBarbara(latitude, longitude, address));

    return NextResponse.json({
      source: result?.source || "none",
      data: result || null,
    });
  } catch (error) {
    console.error("Parcel collection error:", error);
    return NextResponse.json({ source: "none", data: null });
  }
}
