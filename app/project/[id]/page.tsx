"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { CollectionResults } from "@/app/lib/api";
import Viewer3D from "@/app/components/Viewer3D";
import ChatPanel from "@/app/components/ChatPanel";
import PropertyInspector from "@/app/components/PropertyInspector";
import ImageGallery from "@/app/components/ImageGallery";

type Tab = "3d" | "images" | "data";

export default function ProjectPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [data, setData] = useState<CollectionResults | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("images");

  useEffect(() => {
    const stored = sessionStorage.getItem(`vitruvius-project-${projectId}`);
    if (stored) {
      setData(JSON.parse(stored));
    }
  }, [projectId]);

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-zinc-500">
        <div className="flex items-center gap-3">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-transparent" />
          Loading project...
        </div>
      </div>
    );
  }

  const totalImages = data.streetImages.length + data.listingPhotos.length;

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-zinc-950">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-zinc-200 px-4 dark:border-zinc-800">
        <button
          onClick={() => router.push("/")}
          className="flex items-center gap-2 text-sm font-bold tracking-tight text-zinc-900 transition-colors hover:text-zinc-600 dark:text-zinc-100 dark:hover:text-zinc-400"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Vitruvius
        </button>

        <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />

        <span className="truncate text-sm text-zinc-500">
          {data.geocoded?.address}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
            Generate IFC
          </button>
          <button className="rounded-lg border border-zinc-200 px-3.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            Export
          </button>
        </div>
      </header>

      {/* Main workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: tabs + content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Tab bar */}
          <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 px-4 dark:border-zinc-800">
            {(
              [
                { id: "images" as Tab, label: "Images", count: totalImages },
                { id: "3d" as Tab, label: "3D Model" },
                { id: "data" as Tab, label: "Property Data" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative px-3 py-3 text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? "text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  {tab.label}
                  {"count" in tab && tab.count !== undefined && (
                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {tab.count}
                    </span>
                  )}
                </span>
                {activeTab === tab.id && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-zinc-900 dark:bg-zinc-100" />
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {activeTab === "images" && (
              <ImageGallery
                streetImages={data.streetImages}
                listingPhotos={data.listingPhotos}
              />
            )}
            {activeTab === "3d" && <Viewer3D />}
            {activeTab === "data" && <PropertyInspector data={data} />}
          </div>
        </div>

        {/* Right: Chat Panel */}
        <div className="w-[420px] shrink-0 border-l border-zinc-200 dark:border-zinc-800">
          <ChatPanel data={data} />
        </div>
      </div>
    </div>
  );
}
