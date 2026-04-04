"use client";

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useEffect, useRef, useState, useCallback } from "react";

interface Viewer3DProps {
  modelCode?: string | null;
}

/**
 * 3D Viewer that renders AI-generated THREE.js code.
 * Provides scene, camera, renderer, lights, and orbit controls.
 * The AI code adds meshes to the scene.
 */
export default function Viewer3D({ modelCode }: Viewer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animFrameRef = useRef<number>(0);
  const [status, setStatus] = useState<string>(
    modelCode ? "Rendering model..." : "Click 'Generate IFC' to create a 3D model"
  );

  // Initialize the 3D scene once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#09090b");
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    camera.position.set(25, 20, 25);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 3, 0);
    controlsRef.current = controls;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(20, 30, 15);
    dirLight.castShadow = true;
    scene.add(dirLight);
    const hemiLight = new THREE.HemisphereLight(0xb1e1ff, 0xb97a20, 0.3);
    scene.add(hemiLight);

    // Animation loop
    function animate() {
      animFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    // Handle resize
    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(container);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      observer.disconnect();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  // Execute AI-generated code when modelCode changes
  const executeModelCode = useCallback((code: string) => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Clear existing model meshes (keep lights)
    const toRemove: THREE.Object3D[] = [];
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Group) {
        if (obj.parent === scene) toRemove.push(obj);
      }
    });
    toRemove.forEach((obj) => scene.remove(obj));

    try {
      // Execute the AI code with scene and THREE in scope
      const fn = new Function("scene", "THREE", code);
      fn(scene, THREE);
      setStatus("Model generated");
    } catch (err) {
      console.error("Model code execution error:", err);
      setStatus(`Error: ${err instanceof Error ? err.message : "Code execution failed"}`);
    }
  }, []);

  useEffect(() => {
    if (modelCode) {
      executeModelCode(modelCode);
    }
  }, [modelCode, executeModelCode]);

  return (
    <div className="relative flex h-full w-full flex-col bg-zinc-950">
      <div className="absolute top-4 right-4 z-10">
        <span className="rounded-full bg-zinc-900/80 px-3 py-1 text-xs font-medium text-zinc-400 backdrop-blur-sm border border-zinc-800">
          {status}
        </span>
      </div>

      <div ref={containerRef} className="h-full w-full" />

      {!modelCode && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-zinc-500">
            <div className="mb-3 flex justify-center">
              <svg className="h-10 w-10 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <p className="text-sm font-medium">3D Model</p>
            <p className="mt-1 text-xs text-zinc-600">
              Click &quot;Generate IFC&quot; to create a 3D building model from collected data
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
