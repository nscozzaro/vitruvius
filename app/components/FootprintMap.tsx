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

export default function FootprintMap({
  footprint,
  origin,
  neighbors = [],
  parcelBoundary = [],
}: FootprintMapProps) {
  const googleKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  const { latitude: originLat, longitude: originLon } = origin;
  const cosDeg = (deg: number) => Math.cos((deg * Math.PI) / 180);

  const toLatLon = (pt: FootprintPoint) => ({
    lat: originLat + pt.y / 110540,
    lon: originLon + pt.x / (111320 * cosDeg(originLat)),
  });

  // Building footprint (may be empty if OSM failed)
  const fpPoints = footprint.filter(p => p && typeof p.x === "number").map(toLatLon);
  const hasFp = fpPoints.length >= 3;

  // Need at least footprint or parcel to render anything
  if (!hasFp && parcelBoundary.length < 3) return null;

  // Determine map center — use footprint center if available, else parcel center, else origin
  let centerLat = originLat;
  let centerLon = originLon;
  if (hasFp) {
    centerLat = fpPoints.reduce((s, p) => s + p.lat, 0) / fpPoints.length;
    centerLon = fpPoints.reduce((s, p) => s + p.lon, 0) / fpPoints.length;
  } else if (parcelBoundary.length > 0) {
    centerLat = parcelBoundary.reduce((s, p) => s + p.lat, 0) / parcelBoundary.length;
    centerLon = parcelBoundary.reduce((s, p) => s + p.lon, 0) / parcelBoundary.length;
  }

  // Build Google Static Maps URL
  let paths = "";

  // Footprint path (blue)
  if (hasFp) {
    const closed = [...fpPoints, fpPoints[0]];
    const pathStr = closed.map(p => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`).join("|");
    paths += `&path=color:0x4488FFCC|weight:3|fillcolor:0x4488FF44|${pathStr}`;
  }

  // Neighbor paths (gray) — limit to 8 to avoid URL length issues
  for (const n of neighbors.slice(0, 8)) {
    const nPts = n.footprint.filter(p => p && typeof p.x === "number").map(toLatLon);
    if (nPts.length < 3) continue;
    nPts.push(nPts[0]);
    paths += `&path=color:0x88888888|weight:1|fillcolor:0x88888822|${nPts.map(p => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`).join("|")}`;
  }

  // Parcel boundary (red dashed)
  if (parcelBoundary.length > 2) {
    const closed = [...parcelBoundary, parcelBoundary[0]];
    paths += `&path=color:0xFF2222CC|weight:2|fillcolor:0xFF222211|${closed.map(p => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`).join("|")}`;
  }

  const key = googleKey ? `&key=${googleKey}` : "";
  const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${centerLat.toFixed(7)},${centerLon.toFixed(7)}&zoom=19&size=600x400&scale=2&maptype=satellite${paths}${key}`;

  // ── SVG Site Plan ─────────────────────────────────────────────────
  const parcelXY = parcelBoundary.map(p => ({
    x: (p.lon - originLon) * 111320 * cosDeg(originLat),
    y: (p.lat - originLat) * 110540,
  }));

  const allPts = [
    ...footprint.filter(p => p && typeof p.x === "number"),
    ...neighbors.flatMap(n => n.footprint.filter(p => p && typeof p.x === "number")),
    ...parcelXY,
  ];

  if (allPts.length === 0) return null;

  const minX = Math.min(...allPts.map(p => p.x));
  const maxX = Math.max(...allPts.map(p => p.x));
  const minY = Math.min(...allPts.map(p => p.y));
  const maxY = Math.max(...allPts.map(p => p.y));
  const rangeX = (maxX - minX) || 1;
  const rangeY = (maxY - minY) || 1;
  const margin = Math.max(rangeX, rangeY) * 0.1;
  const vMinX = minX - margin, vMaxX = maxX + margin;
  const vMinY = minY - margin, vMaxY = maxY + margin;
  const vW = vMaxX - vMinX, vH = vMaxY - vMinY;

  const toSvg = (p: FootprintPoint) => ({
    sx: ((p.x - vMinX) / vW) * 100,
    sy: 100 - ((p.y - vMinY) / vH) * 100,
  });

  const fpValid = footprint.filter(p => p && typeof p.x === "number");
  const fpSvg = fpValid.map(toSvg);

  // Dimensions from footprint (if available) or parcel
  const dimSource = hasFp ? fpValid : parcelXY;
  const dMinX = Math.min(...dimSource.map(p => p.x));
  const dMaxX = Math.max(...dimSource.map(p => p.x));
  const dMinY = Math.min(...dimSource.map(p => p.y));
  const dMaxY = Math.max(...dimSource.map(p => p.y));
  const widthM = (dMaxX - dMinX).toFixed(1);
  const heightM = (dMaxY - dMinY).toFixed(1);
  const ptsCount = hasFp ? fpValid.length : parcelXY.length;

  return (
    <div className="space-y-3">
      {/* Satellite map with overlays */}
      {googleKey && (
        <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mapUrl} alt="Site plan satellite view" className="w-full" loading="lazy" />
        </div>
      )}

      {/* SVG site plan */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Site Plan</span>
          <span className="text-xs text-zinc-400">
            {widthM}m × {heightM}m · {ptsCount} pts
            {neighbors.length > 0 && ` · ${neighbors.length} neighbors`}
          </span>
        </div>
        <svg viewBox="0 0 100 100" className="h-56 w-full" preserveAspectRatio="xMidYMid meet">
          {/* Grid */}
          {[20, 40, 60, 80].map(v => (
            <g key={v}>
              <line x1={v} y1={0} x2={v} y2={100} stroke="currentColor" strokeOpacity={0.06} strokeWidth={0.2} />
              <line x1={0} y1={v} x2={100} y2={v} stroke="currentColor" strokeOpacity={0.06} strokeWidth={0.2} />
            </g>
          ))}

          {/* Parcel boundary (red dashed) */}
          {parcelXY.length > 2 && (
            <polygon
              points={parcelXY.map(toSvg).map(p => `${p.sx},${p.sy}`).join(" ")}
              fill="rgba(239, 68, 68, 0.06)"
              stroke="rgb(239, 68, 68)"
              strokeWidth={0.6}
              strokeDasharray="2,1"
              strokeLinejoin="round"
            />
          )}

          {/* Neighbor buildings (gray) */}
          {neighbors.map((n, ni) => {
            const nValid = n.footprint.filter(p => p && typeof p.x === "number");
            if (nValid.length < 3) return null;
            const nSvg = nValid.map(toSvg);
            return (
              <g key={ni}>
                <polygon
                  points={nSvg.map(p => `${p.sx},${p.sy}`).join(" ")}
                  fill="rgba(161, 161, 170, 0.12)"
                  stroke="rgba(161, 161, 170, 0.4)"
                  strokeWidth={0.4}
                  strokeLinejoin="round"
                />
                {n.address && (
                  <text
                    x={nSvg.reduce((s, p) => s + p.sx, 0) / nSvg.length}
                    y={nSvg.reduce((s, p) => s + p.sy, 0) / nSvg.length}
                    textAnchor="middle" dominantBaseline="central"
                    fontSize={2.5} fill="rgba(161, 161, 170, 0.5)"
                  >
                    {n.address.split(" ")[0]}
                  </text>
                )}
              </g>
            );
          })}

          {/* Target building footprint (blue) */}
          {hasFp && (
            <>
              <polygon
                points={fpSvg.map(p => `${p.sx},${p.sy}`).join(" ")}
                fill="rgba(59, 130, 246, 0.2)"
                stroke="rgb(59, 130, 246)"
                strokeWidth={0.8}
                strokeLinejoin="round"
              />
              {fpSvg.map((p, i) => (
                <circle key={i} cx={p.sx} cy={p.sy} r={0.8} fill="rgb(59, 130, 246)" />
              ))}
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
