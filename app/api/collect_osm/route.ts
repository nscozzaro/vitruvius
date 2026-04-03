import { NextRequest, NextResponse } from "next/server";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/**
 * POST /api/collect_osm
 * Proxies Overpass API to fetch building footprints.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { latitude, longitude } = body;

    if (latitude === undefined || longitude === undefined) {
      return NextResponse.json({ error: "Missing coordinates" }, { status: 400 });
    }

    const radius = 50;
    const query = `
      [out:json][timeout:10];
      (
        way["building"](around:${radius},${latitude},${longitude});
      );
      out body;
      >;
      out skel qt;
    `.trim();

    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
    });

    if (!response.ok) {
      throw new Error(`Overpass error: ${response.status}`);
    }

    const data = await response.json();

    const nodes: Record<number, [number, number]> = {};
    const ways: number[][] = [];

    for (const element of data.elements || []) {
      if (element.type === "node") {
        nodes[element.id] = [element.lat, element.lon];
      } else if (element.type === "way") {
        ways.push(element.nodes || []);
      }
    }

    if (ways.length === 0) {
      return NextResponse.json({ source: "osm", footprint: null });
    }

    const wayNodes = ways[0];
    if (wayNodes.length === 0 || !nodes[wayNodes[0]]) {
      return NextResponse.json({ source: "osm", footprint: null });
    }

    const [originLat, originLon] = nodes[wayNodes[0]];
    const footprint: { x: number; y: number }[] = [];

    const cosDeg = (deg: number) => Math.cos((deg * Math.PI) / 180);

    for (const nodeId of wayNodes) {
      if (!nodes[nodeId]) continue;
      const [nLat, nLon] = nodes[nodeId];

      // Conversion logic to relative meters
      const x = (nLon - originLon) * 111320 * cosDeg(originLat);
      const y = (nLat - originLat) * 110540;

      footprint.push({
        x: Math.round(x * 1000) / 1000,
        y: Math.round(y * 1000) / 1000,
      });
    }

    // Clean up closing point
    if (
      footprint.length > 1 &&
      footprint[0].x === footprint[footprint.length - 1].x &&
      footprint[0].y === footprint[footprint.length - 1].y
    ) {
      footprint.pop();
    }

    return NextResponse.json({
      source: "osm",
      footprint: footprint.length >= 3 ? footprint : null,
    });
  } catch (error) {
    console.error("OSM Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch building footprint" },
      { status: 500 }
    );
  }
}
