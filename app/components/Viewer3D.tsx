"use client";

import { useEffect, useRef } from "react";

/**
 * 3D IFC Viewer using @thatopen/components.
 * Phase 1: Shows a placeholder. Phase 2 will integrate the actual IFC viewer.
 */
export default function Viewer3D({ ifcUrl }: { ifcUrl?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !ifcUrl) return;

    // Phase 2: Initialize @thatopen/components viewer here
    // const components = new OBC.Components();
    // const worlds = components.get(OBC.Worlds);
    // const world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>();
    // ...load IFC from ifcUrl

  }, [ifcUrl]);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center bg-zinc-100 dark:bg-zinc-900"
    >
      {!ifcUrl ? (
        <div className="text-center text-zinc-400">
          <div className="mb-2 text-4xl">&#9633;</div>
          <p className="text-sm">3D Viewer</p>
          <p className="mt-1 text-xs">
            Generate a building model to view it here
          </p>
        </div>
      ) : (
        <div className="text-sm text-zinc-400">Loading IFC model...</div>
      )}
    </div>
  );
}
