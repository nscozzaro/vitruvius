"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface LayerVisibility {
  lot_boundary: boolean;
  monument: boolean;
  easement: boolean;
  road_centerline: boolean;
  label: boolean;
  quality: boolean;
}

interface SurveyViewerProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  svgFragments: Array<{ layerType: string; svg: string }>;
  qualityHalos: string[];
  labels: string[];
  layers: LayerVisibility;
  svgOpacity: number;
  activeElementId: string | null;
  /** Auto-pan to follow the active element being drawn */
  autoFollow?: boolean;
}

/**
 * Survey map viewer with zoom-to-cursor, drag-to-pan, and auto-follow.
 *
 * Uses a transform-based approach where (viewX, viewY) is the image-space
 * point that maps to the top-left of the viewport, and scale controls zoom.
 */
export default function SurveyViewer({
  imageUrl,
  imageWidth,
  imageHeight,
  svgFragments,
  qualityHalos,
  labels,
  layers,
  svgOpacity,
  activeElementId,
  autoFollow = true,
}: SurveyViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // View state: which image-space point is at the viewport origin, and zoom level
  const [scale, setScale] = useState<number | null>(null); // null = fit-to-view
  const [viewX, setViewX] = useState(0); // image-space X at viewport left edge
  const [viewY, setViewY] = useState(0); // image-space Y at viewport top edge
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, vx: 0, vy: 0 });

  // Compute the effective scale (fit-to-view when scale is null)
  const getEffectiveScale = useCallback(() => {
    if (scale !== null) return scale;
    const c = containerRef.current;
    if (!c || !imageWidth || !imageHeight) return 0.2;
    return Math.min(c.clientWidth / imageWidth, c.clientHeight / imageHeight);
  }, [scale, imageWidth, imageHeight]);

  // Initialize view to fit the image
  useEffect(() => {
    if (!containerRef.current || !imageWidth) return;
    const fitScale = Math.min(
      containerRef.current.clientWidth / imageWidth,
      containerRef.current.clientHeight / imageHeight,
    );
    setScale(fitScale);
    // Center the image
    const cx = (containerRef.current.clientWidth / fitScale - imageWidth) / 2;
    const cy = (containerRef.current.clientHeight / fitScale - imageHeight) / 2;
    setViewX(-cx);
    setViewY(-cy);
  }, [imageWidth, imageHeight, imageUrl]);

  // ─── Zoom to cursor ────────────────────────────────────
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const c = containerRef.current;
      if (!c) return;

      const s = getEffectiveScale();
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      const newScale = Math.max(0.05, Math.min(15, s * factor));

      // Mouse position in viewport
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Image-space point under the cursor (before zoom)
      const imgX = viewX + mx / s;
      const imgY = viewY + my / s;

      // After zoom, the same image point should stay under the cursor
      setViewX(imgX - mx / newScale);
      setViewY(imgY - my / newScale);
      setScale(newScale);
    },
    [getEffectiveScale, viewX, viewY],
  );

  // ─── Drag to pan ───────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      setDragging(true);
      dragStart.current = { mx: e.clientX, my: e.clientY, vx: viewX, vy: viewY };
    },
    [viewX, viewY],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const s = getEffectiveScale();
      setViewX(dragStart.current.vx - (e.clientX - dragStart.current.mx) / s);
      setViewY(dragStart.current.vy - (e.clientY - dragStart.current.my) / s);
    },
    [dragging, getEffectiveScale],
  );

  const handleMouseUp = useCallback(() => setDragging(false), []);

  // ─── Auto-follow active element ────────────────────────
  useEffect(() => {
    if (!autoFollow || !activeElementId || !containerRef.current) return;

    // Find the active element's position from SVG data attributes
    // We look through fragments for the matching element
    const timer = setTimeout(() => {
      const el = containerRef.current?.querySelector(
        `[data-element-id="${activeElementId}"]`,
      );
      if (!el) return;

      // Get the element's bounding box in image-space via SVG getBBox
      try {
        const svgEl = el as SVGGraphicsElement;
        const bbox = svgEl.getBBox();
        if (bbox.width === 0 && bbox.height === 0) return;

        const s = getEffectiveScale();
        const c = containerRef.current!;
        const vpW = c.clientWidth / s;
        const vpH = c.clientHeight / s;

        // Center the element in the viewport
        const centerX = bbox.x + bbox.width / 2;
        const centerY = bbox.y + bbox.height / 2;

        setViewX(centerX - vpW / 2);
        setViewY(centerY - vpH / 2);
      } catch { /* SVG element may not support getBBox */ }
    }, 100);

    return () => clearTimeout(timer);
  }, [activeElementId, autoFollow, getEffectiveScale]);

  // ─── Keyboard shortcuts ────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "0" || e.key === "Home") {
        // Reset to fit view
        const c = containerRef.current;
        if (!c) return;
        const fitScale = Math.min(
          c.clientWidth / imageWidth,
          c.clientHeight / imageHeight,
        );
        setScale(fitScale);
        const cx = (c.clientWidth / fitScale - imageWidth) / 2;
        const cy = (c.clientHeight / fitScale - imageHeight) / 2;
        setViewX(-cx);
        setViewY(-cy);
      }
    },
    [imageWidth, imageHeight],
  );

  // Group fragments by layer
  const byLayer: Record<string, string[]> = {};
  for (const f of svgFragments) {
    (byLayer[f.layerType] ??= []).push(f.svg);
  }

  const s = getEffectiveScale();

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-zinc-100 outline-none dark:bg-zinc-900"
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div
        style={{
          transform: `scale(${s}) translate(${-viewX}px, ${-viewY}px)`,
          transformOrigin: "0 0",
          width: imageWidth,
          height: imageHeight,
          position: "absolute",
          top: 0,
          left: 0,
        }}
      >
        {/* Original raster image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt="Survey map"
          width={imageWidth}
          height={imageHeight}
          className="absolute inset-0"
          style={{ imageRendering: s > 2 ? "pixelated" : "auto" }}
          draggable={false}
        />

        {/* SVG overlay */}
        <svg
          viewBox={`0 0 ${imageWidth} ${imageHeight}`}
          width={imageWidth}
          height={imageHeight}
          className="absolute inset-0"
          style={{ opacity: svgOpacity / 100 }}
        >
          {/* Quality halos layer */}
          <g id="layer-quality" style={{ display: layers.quality ? "block" : "none" }}>
            {qualityHalos.map((h, i) => (
              <g key={`halo-${i}`} dangerouslySetInnerHTML={{ __html: h }} />
            ))}
          </g>

          {/* Road centerlines */}
          <g id="layer-road_centerline" style={{ display: layers.road_centerline ? "block" : "none" }}>
            {(byLayer["road_centerline"] ?? []).map((s, i) => (
              <g key={`road-${i}`} dangerouslySetInnerHTML={{ __html: s }} />
            ))}
          </g>

          {/* Easements */}
          <g id="layer-easement" style={{ display: layers.easement ? "block" : "none" }}>
            {(byLayer["easement"] ?? []).map((s, i) => (
              <g key={`esmt-${i}`} dangerouslySetInnerHTML={{ __html: s }} />
            ))}
          </g>

          {/* Lot boundaries */}
          <g id="layer-lot_boundary" style={{ display: layers.lot_boundary ? "block" : "none" }}>
            {(byLayer["lot_boundary"] ?? []).map((s, i) => (
              <g key={`lot-${i}`} dangerouslySetInnerHTML={{ __html: s }} />
            ))}
          </g>

          {/* Monuments */}
          <g id="layer-monument" style={{ display: layers.monument ? "block" : "none" }}>
            {(byLayer["monument"] ?? []).map((s, i) => (
              <g key={`mon-${i}`} dangerouslySetInnerHTML={{ __html: s }} />
            ))}
          </g>

          {/* Labels */}
          <g id="layer-label" style={{ display: layers.label ? "block" : "none" }}>
            {labels.map((l, i) => (
              <g key={`lbl-${i}`} dangerouslySetInnerHTML={{ __html: l }} />
            ))}
          </g>

          {/* Active element pulse animation */}
          {activeElementId && (
            <style>{`
              [data-element-id="${activeElementId}"] {
                animation: pulse-element 1.5s ease-in-out infinite;
              }
              @keyframes pulse-element {
                0%, 100% { filter: drop-shadow(0 0 4px #00ffff); stroke-width: 3; }
                50% { filter: drop-shadow(0 0 12px #00ffff); stroke-width: 4; }
              }
            `}</style>
          )}
        </svg>
      </div>

      {/* HUD overlay */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex gap-2">
        <div className="rounded bg-black/70 px-2 py-1 text-xs text-white">
          {Math.round(s * 100)}%
        </div>
        <div className="rounded bg-black/70 px-2 py-1 text-xs text-zinc-300">
          Scroll to zoom &middot; Drag to pan &middot; Press 0 to fit
        </div>
      </div>
    </div>
  );
}
