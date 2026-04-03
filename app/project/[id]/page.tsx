"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { CollectionResults } from "@/app/lib/api";
import Viewer3D from "@/app/components/Viewer3D";
import ChatPanel from "@/app/components/ChatPanel";
import PropertyInspector from "@/app/components/PropertyInspector";

export default function ProjectPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [data, setData] = useState<CollectionResults | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem(`vitruvius-project-${projectId}`);
    if (stored) {
      setData(JSON.parse(stored));
    }
  }, [projectId]);

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-zinc-500">
        Loading project...
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-sm font-bold tracking-tight">Vitruvius</span>
        <span className="text-sm text-zinc-500">
          {data.geocoded?.address}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
            Generate IFC
          </button>
          <button className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
            Export
          </button>
        </div>
      </header>

      {/* Main workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: 3D Viewer + Property Inspector */}
        <div className="flex flex-1 flex-col">
          <div className="flex-1">
            <Viewer3D />
          </div>
          <PropertyInspector data={data} />
        </div>

        {/* Right: Chat Panel */}
        <div className="w-[400px] shrink-0 border-l border-zinc-200 dark:border-zinc-800">
          <ChatPanel data={data} />
        </div>
      </div>
    </div>
  );
}
