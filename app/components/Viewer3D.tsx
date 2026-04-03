"use client";

import * as OBC from "@thatopen/components";
import * as THREE from "three";
import { useEffect, useRef, useState } from "react";

/**
 * 3D IFC Viewer using @thatopen/components.
 * Ported from the original monorepo's IfcViewerPanel.
 */
export default function Viewer3D({ ifcUrl }: { ifcUrl?: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>(
    ifcUrl ? "Preparing IFC viewer..." : "No IFC model available yet."
  );

  useEffect(() => {
    if (!containerRef.current || !ifcUrl) {
      return;
    }

    const sourceUrl = ifcUrl;
    let mounted = true;
    let components: OBC.Components | null = null;

    async function bootViewer() {
      try {
        const container = containerRef.current;
        if (!container) return;

        components = new OBC.Components();
        const worlds = components.get(OBC.Worlds);
        const world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>();
        
        world.scene = new OBC.SimpleScene(components);
        world.renderer = new OBC.SimpleRenderer(components, container);
        world.camera = new OBC.SimpleCamera(components);

        components.init();
        world.scene.setup();
        world.scene.three.background = new THREE.Color("#09090b"); // Dark zinc background
        world.camera.controls.setLookAt(14, 14, 14, 0, 0, 0);

        const ifcLoader = components.get(OBC.IfcLoader);
        await ifcLoader.setup({
          autoSetWasm: true
        });

        const response = await fetch(sourceUrl);
        if (!response.ok) {
          throw new Error(`Unable to fetch IFC: ${response.status}`);
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        const model = await ifcLoader.load(bytes, true, "vitruvius-latest");
        world.scene.three.add(model as unknown as THREE.Object3D);

        if (mounted) {
          setStatus("IFC loaded successfully.");
        }
      } catch (error) {
        console.error("IFC Viewer Error:", error);
        if (mounted) {
          setStatus(
            error instanceof Error
              ? `Error: ${error.message}`
              : "Failed to load IFC viewer."
          );
        }
      }
    }

    void bootViewer();

    return () => {
      mounted = false;
      components?.dispose();
    };
  }, [ifcUrl]);

  return (
    <div className="relative flex h-full w-full flex-col bg-zinc-950">
      <div className="absolute top-4 right-4 z-10">
        <span className="rounded-full bg-zinc-900/80 px-3 py-1 text-xs font-medium text-zinc-400 backdrop-blur-sm border border-zinc-800">
          {status}
        </span>
      </div>
      
      <div ref={containerRef} className="h-full w-full" />

      {!ifcUrl && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-zinc-500">
            <div className="mb-3 flex justify-center">
              <svg className="h-10 w-10 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <p className="text-sm font-medium">3D Model Placeholder</p>
            <p className="mt-1 text-xs text-zinc-600">
              Select an address and generate a design to see it in 3D
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
