import { NextRequest, NextResponse } from "next/server";

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface WayInfo {
  id: number;
  nodeIds: number[];
  tags: Record<string, string>;
  centroidLat: number;
  centroidLon: number;
}

/**
 * POST /api/collect_osm
 * Fetches building footprints from OpenStreetMap.
 * Selects the correct building by:
 *   1. Matching addr:housenumber + addr:street tags
 *   2. Falling back to the building whose centroid is closest to the geocoded point
 * Also returns neighboring buildings for context.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { latitude, longitude, address } = body;

    if (latitude === undefined || longitude === undefined) {
      return NextResponse.json(
        { error: "Missing coordinates" },
        { status: 400 }
      );
    }

    const radius = 80;
    const query = `
      [out:json][timeout:25];
      (
        way["building"](around:${radius},${latitude},${longitude});
      );
      out body;
      >;
      out skel qt;
    `.trim();

    let data: any = null;

    for (const url of OVERPASS_URLS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          data = await response.json();
          break;
        }
      } catch (err) {
        console.warn(`Overpass ${url} failed:`, err);
        continue;
      }
    }

    if (!data) {
      return NextResponse.json({ source: "osm", footprint: null, origin: null, neighbors: [] });
    }

    const nodes: Record<number, [number, number]> = {};
    const wayInfos: WayInfo[] = [];

    for (const element of data.elements || []) {
      if (element.type === "node") {
        nodes[element.id] = [element.lat, element.lon];
      } else if (element.type === "way" && element.tags?.building) {
        wayInfos.push({
          id: element.id,
          nodeIds: element.nodes || [],
          tags: element.tags || {},
          centroidLat: 0,
          centroidLon: 0,
        });
      }
    }

    // Calculate centroids for each way
    for (const way of wayInfos) {
      const pts = way.nodeIds.filter((id) => nodes[id]).map((id) => nodes[id]);
      if (pts.length > 0) {
        way.centroidLat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        way.centroidLon = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      }
    }

    if (wayInfos.length === 0) {
      return NextResponse.json({ source: "osm", footprint: null, origin: null, neighbors: [] });
    }

    // Extract house number from address for matching
    const houseNum = address?.match(/^(\d+)/)?.[1];
    const streetName = address
      ?.replace(/^\d+\s*,?\s*/, "")
      ?.split(",")[0]
      ?.trim()
      ?.toLowerCase();

    // Strategy 1: Match by addr:housenumber tag
    let bestWay: WayInfo | null = null;
    if (houseNum) {
      bestWay =
        wayInfos.find(
          (w) =>
            w.tags["addr:housenumber"] === houseNum &&
            (!streetName ||
              w.tags["addr:street"]?.toLowerCase().includes(streetName.split(" ")[0]))
        ) || null;
    }

    // Strategy 2: Closest centroid to geocoded point
    if (!bestWay) {
      const dist = (w: WayInfo) =>
        Math.pow(w.centroidLat - latitude, 2) +
        Math.pow(w.centroidLon - longitude, 2);
      bestWay = wayInfos.reduce((a, b) => (dist(a) < dist(b) ? a : b));
    }

    const cosDeg = (deg: number) => Math.cos((deg * Math.PI) / 180);

    // Convert a way's nodes to footprint points relative to an origin
    function wayToFootprint(
      way: WayInfo,
      originLat: number,
      originLon: number
    ): { x: number; y: number }[] {
      const fp: { x: number; y: number }[] = [];
      for (const nodeId of way.nodeIds) {
        if (!nodes[nodeId]) continue;
        const [nLat, nLon] = nodes[nodeId];
        const x = (nLon - originLon) * 111320 * cosDeg(originLat);
        const y = (nLat - originLat) * 110540;
        fp.push({
          x: Math.round(x * 1000) / 1000,
          y: Math.round(y * 1000) / 1000,
        });
      }
      // Remove closing duplicate
      if (
        fp.length > 1 &&
        fp[0].x === fp[fp.length - 1].x &&
        fp[0].y === fp[fp.length - 1].y
      ) {
        fp.pop();
      }
      return fp;
    }

    // Use the first node of the best way as origin
    const firstNodeId = bestWay.nodeIds[0];
    if (!nodes[firstNodeId]) {
      return NextResponse.json({ source: "osm", footprint: null, origin: null, neighbors: [] });
    }
    const [originLat, originLon] = nodes[firstNodeId];

    const footprint = wayToFootprint(bestWay, originLat, originLon);

    // Build neighbor footprints (other buildings, for context)
    const neighbors = wayInfos
      .filter((w) => w.id !== bestWay!.id)
      .map((w) => ({
        footprint: wayToFootprint(w, originLat, originLon),
        address: w.tags["addr:housenumber"]
          ? `${w.tags["addr:housenumber"]} ${w.tags["addr:street"] || ""}`
          : null,
      }))
      .filter((n) => n.footprint.length >= 3);

    return NextResponse.json({
      source: "osm",
      footprint: footprint.length >= 3 ? footprint : null,
      origin:
        footprint.length >= 3
          ? { latitude: originLat, longitude: originLon }
          : null,
      neighbors,
    });
  } catch (error) {
    console.error("OSM Error:", error);
    return NextResponse.json({ source: "osm", footprint: null, origin: null, neighbors: [] });
  }
}
