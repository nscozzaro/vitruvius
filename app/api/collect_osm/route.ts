import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/collect_osm
 *
 * Robust building footprint collection (parallel):
 *   - Nominatim reverse geocode with polygon_geojson (fast, reliable, ~1s)
 *   - Overpass API for neighbors (slow, may timeout, runs in parallel)
 *
 * Even if all Overpass servers are down, we still get the building footprint
 * from Nominatim. Overpass only adds neighbor context.
 */

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { latitude, longitude, address } = body;

    if (latitude === undefined || longitude === undefined) {
      return NextResponse.json({ error: "Missing coordinates" }, { status: 400 });
    }

    // Run Nominatim and Overpass in PARALLEL
    const [nomResult, overpassResult] = await Promise.allSettled([
      fetchNominatim(latitude, longitude),
      fetchOverpass(latitude, longitude, address),
    ]);

    let footprint: { x: number; y: number }[] | null = null;
    let origin: { latitude: number; longitude: number } | null = null;
    let neighbors: { footprint: { x: number; y: number }[]; address: string | null }[] = [];

    // Use Nominatim result (primary)
    if (nomResult.status === "fulfilled" && nomResult.value) {
      footprint = nomResult.value.footprint;
      origin = nomResult.value.origin;
    }

    // Use Overpass result (for neighbors + fallback footprint)
    if (overpassResult.status === "fulfilled" && overpassResult.value) {
      const ov = overpassResult.value;

      // Fallback: if Nominatim failed, use Overpass footprint
      if (!footprint && ov.footprint) {
        footprint = ov.footprint;
        origin = ov.origin;
      }

      // Always use neighbors from Overpass
      const originRef = origin || { latitude, longitude };
      neighbors = ov.neighborWays.map(w => {
        const fp = w.nodeIds
          .filter((id: number) => ov.nodes[id])
          .map((id: number) => {
            const [nLat, nLon] = ov.nodes[id];
            return {
              x: Math.round((nLon - originRef.longitude) * 111320 * cosDeg(originRef.latitude) * 1000) / 1000,
              y: Math.round((nLat - originRef.latitude) * 110540 * 1000) / 1000,
            };
          });
        return {
          footprint: fp,
          address: w.tags["addr:housenumber"]
            ? `${w.tags["addr:housenumber"]} ${w.tags["addr:street"] || ""}`
            : null,
        };
      }).filter(n => n.footprint.length >= 3);
    }

    return NextResponse.json({ source: "osm", footprint, origin, neighbors });
  } catch (error) {
    console.error("OSM Error:", error);
    return NextResponse.json({ source: "osm", footprint: null, origin: null, neighbors: [] });
  }
}

// ── Nominatim: fast building polygon (~1s) ──────────────────────────
async function fetchNominatim(lat: number, lon: number) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&polygon_geojson=1&addressdetails=1`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Vitruvius/1.0 (building-design-app)" },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const geo = data.geojson;

  if (geo?.type !== "Polygon" || !geo.coordinates?.[0] || geo.coordinates[0].length < 3) {
    return null;
  }

  const coords: [number, number][] = geo.coordinates[0]; // [lon, lat]
  const originLon = coords[0][0];
  const originLat = coords[0][1];

  let footprint = coords.map(([lon, lat]) => ({
    x: Math.round((lon - originLon) * 111320 * cosDeg(originLat) * 1000) / 1000,
    y: Math.round((lat - originLat) * 110540 * 1000) / 1000,
  }));

  // Remove closing duplicate
  if (footprint.length > 1 && footprint[0].x === footprint[footprint.length - 1].x && footprint[0].y === footprint[footprint.length - 1].y) {
    footprint.pop();
  }

  return footprint.length >= 3
    ? { footprint, origin: { latitude: originLat, longitude: originLon } }
    : null;
}

// ── Overpass: neighbors + fallback footprint ────────────────────────
async function fetchOverpass(lat: number, lon: number, address?: string) {
  const query = `[out:json][timeout:15];(way["building"](around:80,${lat},${lon}););out body;>;out skel qt;`;

  let data: { elements?: Array<{ type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string> }> } | null = null;

  for (const url of OVERPASS_URLS) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        data = await resp.json();
        break;
      }
    } catch {
      continue;
    }
  }

  if (!data?.elements) return null;

  const nodes: Record<number, [number, number]> = {};
  const ways: { id: number; nodeIds: number[]; tags: Record<string, string> }[] = [];

  for (const el of data.elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      nodes[el.id] = [el.lat, el.lon];
    } else if (el.type === "way" && el.tags?.building) {
      ways.push({ id: el.id, nodeIds: el.nodes || [], tags: el.tags || {} });
    }
  }

  // Find target building by address tag
  const houseNum = address?.match(/^(\d+)/)?.[1];
  const targetIdx = houseNum
    ? ways.findIndex(w => w.tags["addr:housenumber"] === houseNum)
    : -1;

  let footprint: { x: number; y: number }[] | null = null;
  let origin: { latitude: number; longitude: number } | null = null;

  if (targetIdx >= 0) {
    const target = ways[targetIdx];
    const firstNode = target.nodeIds[0];
    if (nodes[firstNode]) {
      const [oLat, oLon] = nodes[firstNode];
      origin = { latitude: oLat, longitude: oLon };
      footprint = target.nodeIds
        .filter(id => nodes[id])
        .map(id => {
          const [nLat, nLon] = nodes[id];
          return {
            x: Math.round((nLon - oLon) * 111320 * cosDeg(oLat) * 1000) / 1000,
            y: Math.round((nLat - oLat) * 110540 * 1000) / 1000,
          };
        });
      if (footprint.length > 1 && footprint[0].x === footprint[footprint.length - 1].x && footprint[0].y === footprint[footprint.length - 1].y) {
        footprint.pop();
      }
      if (footprint.length < 3) footprint = null;
    }
  }

  // Neighbor ways (everything except the target)
  const neighborWays = ways.filter((_, i) => i !== targetIdx);

  return { footprint, origin, neighborWays, nodes };
}
