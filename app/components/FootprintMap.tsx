"use client";

import type { FootprintPoint } from "@/app/lib/api";

interface NeighborInfo {
  footprint: FootprintPoint[];
  address: string | null;
}

interface FootprintMapProps {
  footprint: FootprintPoint[];
  origin: { latitude: number; longitude: number };
  neighbors?: NeighborInfo[];
  parcelBoundary?: { lat: number; lon: number }[];
}

/**
 * Renders the building footprint polygon overlaid on a Google Maps satellite image.
 * Shows the target building (blue), neighbors (gray), and parcel boundary (red dashed).
 */
export default function FootprintMap({
  footprint,
  origin,
  neighbors = [],
  parcelBoundary = [],
}: FootprintMapProps) {
  const googleKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  const { latitude: originLat, longitude: originLon } = origin;

  const cosDeg = (deg: number) => Math.cos((deg * Math.PI) / 180);

  // Convert relative x/y (meters) back to lat/lon
  const toLatLon = (pt: FootprintPoint) => ({
    lat: originLat + pt.y / 110540,
    lon: originLon + pt.x / (111320 * cosDeg(originLat)),
  });

  const points = footprint.filter(p => p && typeof p.x === "number").map(toLatLon);
  if (points.length < 3) return null;
  const closedPoints = [...points, points[0]];

  // Build Google Static Maps URL with footprint overlay
  const pathStr = closedPoints
    .map((p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`)
    .join("|");
  const pathParam = `path=color:0x4488FFCC|weight:3|fillcolor:0x4488FF44|${pathStr}`;

  // Add neighbor paths (gray)
  const neighborPaths = neighbors
    .slice(0, 10) // Limit to avoid URL too long
    .map((n) => {
      const nPts = n.footprint.map(toLatLon);
      nPts.push(nPts[0]);
      const nStr = nPts
        .map((p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`)
        .join("|");
      return `path=color:0x88888888|weight:1|fillcolor:0x88888822|${nStr}`;
    })
    .join("&");

  const avgLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const avgLon = points.reduce((s, p) => s + p.lon, 0) / points.length;

  const key = googleKey || "";
  const keyParam = key ? `&key=${key}` : "";

  // Add parcel boundary path (red) to map
  let parcelPath = "";
  if (parcelBoundary.length > 2) {
    const pStr = [...parcelBoundary, parcelBoundary[0]]
      .map((p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`)
      .join("|");
    parcelPath = `&path=color:0xFF2222CC|weight:2|fillcolor:0xFF222211|${pStr}`;
  }

  const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${avgLat.toFixed(7)},${avgLon.toFixed(7)}&zoom=19&size=600x400&scale=2&maptype=satellite&${pathParam}${neighborPaths ? "&" + neighborPaths : ""}${parcelPath}${keyParam}`;

  // Convert parcel boundary lat/lon to relative x/y meters (same as footprint)
  const parcelXY = parcelBoundary.map((p) => ({
    x: (p.lon - originLon) * 111320 * cosDeg(originLat),
    y: (p.lat - originLat) * 110540,
  }));

  // SVG site plan — show target + neighbors + parcel in a single view
  const allPts = [
    ...footprint,
    ...neighbors.flatMap((n) => n.footprint),
    ...parcelXY,
  ];
  const minX = Math.min(...allPts.map((p) => p.x));
  const maxX = Math.max(...allPts.map((p) => p.x));
  const minY = Math.min(...allPts.map((p) => p.y));
  const maxY = Math.max(...allPts.map((p) => p.y));

  // Add margin
  const rangeX = (maxX - minX) || 1;
  const rangeY = (maxY - minY) || 1;
  const margin = Math.max(rangeX, rangeY) * 0.1;
  const vMinX = minX - margin;
  const vMaxX = maxX + margin;
  const vMinY = minY - margin;
  const vMaxY = maxY + margin;
  const vW = vMaxX - vMinX;
  const vH = vMaxY - vMinY;

  const toSvg = (p: FootprintPoint) => ({
    sx: ((p.x - vMinX) / vW) * 100,
    sy: 100 - ((p.y - vMinY) / vH) * 100,
  });

  const fpSvg = footprint.map(toSvg);
  const fpStr = fpSvg.map((p) => `${p.sx},${p.sy}`).join(" ");

  const fpMinX = Math.min(...footprint.map((p) => p.x));
  const fpMaxX = Math.max(...footprint.map((p) => p.x));
  const fpMinY = Math.min(...footprint.map((p) => p.y));
  const fpMaxY = Math.max(...footprint.map((p) => p.y));
  const widthM = (fpMaxX - fpMinX).toFixed(1);
  const heightM = (fpMaxY - fpMinY).toFixed(1);

  return (
    <div className="space-y-3">
      {/* Google Maps satellite with footprint overlay */}
      {key && (
        <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mapUrl}
            alt="Building footprint on satellite map"
            className="w-full"
            loading="lazy"
          />
        </div>
      )}

      {/* SVG site plan with neighbors */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Site Plan
          </span>
          <span className="text-xs text-zinc-400">
            {widthM}m × {heightM}m · {footprint.length} pts
            {neighbors.length > 0 && ` · ${neighbors.length} neighbors`}
          </span>
        </div>
        <svg
          viewBox="0 0 100 100"
          className="h-56 w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Grid */}
          {[20, 40, 60, 80].map((v) => (
            <g key={v}>
              <line x1={v} y1={0} x2={v} y2={100} stroke="currentColor" strokeOpacity={0.06} strokeWidth={0.2} />
              <line x1={0} y1={v} x2={100} y2={v} stroke="currentColor" strokeOpacity={0.06} strokeWidth={0.2} />
            </g>
          ))}

          {/* Parcel boundary / lot lines (red dashed) */}
          {parcelXY.length > 2 && (
            <polygon
              points={parcelXY.map(toSvg).map((p) => `${p.sx},${p.sy}`).join(" ")}
              fill="rgba(239, 68, 68, 0.06)"
              stroke="rgb(239, 68, 68)"
              strokeWidth={0.6}
              strokeDasharray="2,1"
              strokeLinejoin="round"
            />
          )}

          {/* Neighbor buildings (gray) */}
          {neighbors.map((n, ni) => {
            const nSvg = n.footprint.map(toSvg);
            const nStr = nSvg.map((p) => `${p.sx},${p.sy}`).join(" ");
            return (
              <g key={ni}>
                <polygon
                  points={nStr}
                  fill="rgba(161, 161, 170, 0.12)"
                  stroke="rgba(161, 161, 170, 0.4)"
                  strokeWidth={0.4}
                  strokeLinejoin="round"
                />
                {n.address && (
                  <text
                    x={nSvg.reduce((s, p) => s + p.sx, 0) / nSvg.length}
                    y={nSvg.reduce((s, p) => s + p.sy, 0) / nSvg.length}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={2.5}
                    fill="rgba(161, 161, 170, 0.5)"
                  >
                    {n.address.split(" ")[0]}
                  </text>
                )}
              </g>
            );
          })}

          {/* Target building (blue) */}
          <polygon
            points={fpStr}
            fill="rgba(59, 130, 246, 0.2)"
            stroke="rgb(59, 130, 246)"
            strokeWidth={0.8}
            strokeLinejoin="round"
          />
          {fpSvg.map((p, i) => (
            <circle key={i} cx={p.sx} cy={p.sy} r={0.8} fill="rgb(59, 130, 246)" />
          ))}
        </svg>
      </div>
    </div>
  );
}
