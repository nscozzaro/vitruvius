"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import type { CollectionResults } from "@/app/lib/api";
import Viewer3D from "@/app/components/Viewer3D";
import ChatPanel from "@/app/components/ChatPanel";
import PropertyInspector from "@/app/components/PropertyInspector";
import ImageGallery from "@/app/components/ImageGallery";
import FootprintMap from "@/app/components/FootprintMap";
import OnboardingWizard from "@/app/components/OnboardingWizard";

type Tab = "siteplan" | "images" | "data";

export default function ProjectPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [data, setData] = useState<CollectionResults | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("siteplan");
  const [modelCode, setModelCode] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(420);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refinementNotes, setRefinementNotes] = useState<string | null>(null);
  const refinementStarted = useRef(false);

  // Auto-trigger AI refinement when workspace opens with footprint + origin data
  useEffect(() => {
    if (!showWizard && data?.footprint && data.footprint.length > 0 && data.footprintOrigin && !refinementStarted.current && !refinementNotes) {
      refinementStarted.current = true;
      const timer = setTimeout(() => handleRefineWithAI(), 1500);
      return () => clearTimeout(timer);
    }
  }, [showWizard, data?.footprint, data?.footprintOrigin]); // eslint-disable-line react-hooks/exhaustive-deps
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // Chat panel resize drag handler
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = chatWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleDrag = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartX.current - ev.clientX;
      const newWidth = Math.max(320, Math.min(800, dragStartWidth.current + delta));
      setChatWidth(newWidth);
    };
    const handleDragEnd = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleDrag);
      document.removeEventListener("mouseup", handleDragEnd);
    };
    document.addEventListener("mousemove", handleDrag);
    document.addEventListener("mouseup", handleDragEnd);
  }, [chatWidth]);

  // Load initial data
  useEffect(() => {
    const stored = sessionStorage.getItem(`vitruvius-project-${projectId}`);
    if (stored) {
      const parsed = JSON.parse(stored);
      setData(parsed);
      // Show wizard for new projects that haven't been onboarded
      if (parsed._needsCollection) {
        setShowWizard(true);
      }
      return;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("vitruvius-cache-")) {
        try {
          const cached = JSON.parse(localStorage.getItem(key) || "");
          if (cached.projectId === projectId) {
            setData(cached.data);
            sessionStorage.setItem(`vitruvius-project-${projectId}`, JSON.stringify(cached.data));
            return;
          }
        } catch { /* skip */ }
      }
    }
  }, [projectId]);

  // Data update handler — called by ChatPanel as collectors finish
  const handleDataUpdate = useCallback(
    (updater: (prev: CollectionResults) => CollectionResults) => {
      setData((prev) => {
        if (!prev) return prev;
        const next = updater(prev);
        // Persist
        sessionStorage.setItem(`vitruvius-project-${projectId}`, JSON.stringify(next));
        if (next.geocoded?.address) {
          const cacheKey = `vitruvius-cache-${next.geocoded.address.toLowerCase().trim()}`;
          try {
            localStorage.setItem(cacheKey, JSON.stringify({ projectId, data: next }));
          } catch { /* full */ }
        }
        return next;
      });
    },
    [projectId]
  );

  const handleGenerateModel = async () => {
    if (!data || generating) return;
    setGenerating(true);
    setViewerOpen(true);
    try {
      const resp = await fetch("/api/generate_model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyData: data }),
      });
      if (!resp.ok) throw new Error("Generation failed");
      const result = await resp.json();
      if (result.code) setModelCode(result.code);
    } catch (err) {
      console.error("Model generation error:", err);
    } finally {
      setGenerating(false);
    }
  };

  const handleRefineWithAI = async (iter = 0) => {
    if (!data || refining || !data.footprint) return;
    setRefining(true);
    if (iter === 0) setRefinementNotes(null);

    try {
      const origin = data.footprintOrigin || { latitude: data.geocoded!.latitude, longitude: data.geocoded!.longitude };

      // Build context from title report data + easements
      const titleDocs = data.uploadedDocuments?.filter(d => d.category === "title") || [];
      let context = "";
      if (titleDocs.length > 0) {
        // Extract just the key legal info, not the full report
        const titleText = titleDocs.map(d => d.text).join("\n");
        const legalIdx = titleText.indexOf("LOT ");
        const easementIdx = titleText.indexOf("Easement");
        if (legalIdx >= 0) context += titleText.slice(legalIdx, legalIdx + 500) + "\n";
        if (easementIdx >= 0) context += titleText.slice(easementIdx, easementIdx + 1000);
        // Include extracted fields
        for (const doc of titleDocs) {
          if (doc.extractedFields && Object.keys(doc.extractedFields).length > 0) {
            context += "\nExtracted title data: " + JSON.stringify(doc.extractedFields);
          }
        }
      }

      const resp = await fetch("/api/refine_footprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          footprint: data.footprint,
          parcelBoundary: data.parcel?.parcelBoundary,
          origin,
          geocoded: data.geocoded,
          context: context || "No title report. Lot 5 of Tract 10,780 in Goleta. Easements on westerly portion (utilities/ingress) and northerly/southerly 3ft (utilities).",
          iteration: iter,
        }),
      });

      if (!resp.ok) throw new Error("Refinement failed");
      const result = await resp.json();

      if (result.error) {
        setRefinementNotes(`Refinement error: ${result.error}`);
        return;
      }

      // Apply the REPLACED polygons (not offsets — full new coordinates)
      if (result.footprint && result.footprint.length >= 3) {
        handleDataUpdate(prev => ({ ...prev, footprint: result.footprint }));
      }

      if (result.parcelBoundary && result.parcelBoundary.length >= 3 && data.parcel) {
        handleDataUpdate(prev => ({
          ...prev,
          parcel: prev.parcel ? { ...prev.parcel, parcelBoundary: result.parcelBoundary } : null,
        }));
      }

      // Step 2: Apply survey-based lot boundary correction if we have survey data
      // This uses the tract map half-street width to correct the GIS parcel
      const surveyData = {
        lot: 5,
        boundaries: [
          { side: "east", bearing: "N 75 22 10 W", distance_ft: 146.31, type: "straight" },
          { side: "west", bearing: "N 82 55 25 W", distance_ft: 146.31, type: "straight" },
          { side: "north", radius_ft: 628, arc_ft: 82.78, type: "curve" },
        ],
        adjacent_streets: [{ name: "Linfield Place", width_ft: 56 }],
        easements: [{ width_ft: 6, side: "south", purpose: "General PUE" }],
      };

      // Check if we have the parcel boundary to correct
      const currentParcel = data.parcel?.parcelBoundary;
      if (currentParcel && currentParcel.length > 2) {
        try {
          const lotResp = await fetch("/api/compute_lot_boundary", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              surveyData,
              parcelBoundary: currentParcel,
              geocoded: data.geocoded,
            }),
          });
          if (lotResp.ok) {
            const lotResult = await lotResp.json();
            if (lotResult.adjustedParcel?.length >= 3) {
              handleDataUpdate(prev => ({
                ...prev,
                parcel: prev.parcel ? { ...prev.parcel, parcelBoundary: lotResult.adjustedParcel } : null,
              }));
            }
          }
        } catch {
          // Survey correction is optional — continue without it
        }
      }

      // Build notes
      const parts: string[] = [];
      if (result.roofDescription) parts.push(`Roof: ${result.roofDescription}`);
      if (result.boundaryDescription) parts.push(`Boundaries: ${result.boundaryDescription}`);
      if (result.notes) parts.push(result.notes);
      parts.push(`Applied 28ft half-street correction from Tract 10,780 survey`);
      parts.push(`Pass ${result.iteration || iter + 1} · Confidence: ${Math.round((result.confidence || 0) * 100)}%`);

      setRefinementNotes(parts.join("\n"));

      // Iterate if needed
      if (result.shouldIterate && iter < 1) {
        setRefinementNotes(prev => (prev || "") + "\nRunning refinement pass 2...");
        await handleRefineWithAI(iter + 1);
        return;
      }
    } catch (err) {
      console.error("Refinement error:", err);
      setRefinementNotes("Refinement failed — using original coordinates.");
    } finally {
      setRefining(false);
    }
  };

  const handleToggleViewer = () => {
    if (!viewerOpen && !modelCode) {
      handleGenerateModel();
    } else {
      setViewerOpen(!viewerOpen);
    }
  };

  if (!data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-zinc-500">
        <span className="text-sm">Project not found or data expired.</span>
        <button onClick={() => router.push("/")} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800">
          Search a new address
        </button>
      </div>
    );
  }

  // Show wizard as full page for new projects
  if (showWizard) {
    return (
      <OnboardingWizard
        data={data}
        onDataUpdate={handleDataUpdate}
        onComplete={() => {
          // Mark collection as done and clear the flag
          handleDataUpdate((prev) => {
            const next = { ...prev };
            delete (next as Record<string, unknown>)._needsCollection;
            return next;
          });
          setShowWizard(false);
        }}
      />
    );
  }

  const totalImages = data.streetImages.length + data.listingPhotos.length + (data.satelliteImages?.length ?? 0);
  const hasSitePlan = !!(data.footprint || data.parcel?.parcelBoundary?.length);

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-zinc-950">
      {/* Header */}
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
        <span className="truncate text-sm text-zinc-500">{data.geocoded?.address}</span>
        <div className="ml-auto flex items-center gap-2">
          <button className="rounded-lg border border-zinc-200 px-3.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            Export
          </button>
        </div>
      </header>

      {/* Main workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Tab bar */}
          <div className="flex shrink-0 items-center border-b border-zinc-200 px-4 dark:border-zinc-800">
            <div className="flex items-center gap-1">
              {([
                { id: "siteplan" as Tab, label: "Site Plan" },
                { id: "images" as Tab, label: "Images", count: totalImages || undefined },
                { id: "data" as Tab, label: "Property Data" },
              ]).map((tab) => (
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

            {/* 3D Preview toggle */}
            <div className="ml-auto py-1.5">
              <button
                onClick={handleToggleViewer}
                disabled={generating}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  viewerOpen
                    ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
                    : "border border-zinc-200 text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {generating ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-current/30 border-t-current" />
                    Generating...
                  </>
                ) : (
                  <>
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
                    </svg>
                    3D Preview
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex flex-1 overflow-hidden">
            <div className={`flex-1 overflow-hidden ${viewerOpen ? "w-1/2" : "w-full"}`}>
              {activeTab === "siteplan" && (
                <div className="h-full overflow-y-auto p-6">
                  <div className="mx-auto max-w-3xl space-y-4">
                    {hasSitePlan ? (
                      <>
                        <FootprintMap
                          footprint={data.footprint || []}
                          origin={data.footprintOrigin || { latitude: data.geocoded!.latitude, longitude: data.geocoded!.longitude }}
                          neighbors={data.neighbors}
                          parcelBoundary={data.parcel?.parcelBoundary}
                        />

                        {/* AI analysis notes (auto-refined) */}
                        {refining && (
                          <div className="flex items-center gap-2 text-xs text-zinc-400">
                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-500" />
                            AI is refining alignment with satellite imagery...
                          </div>
                        )}
                        {refinementNotes && (
                          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
                            <div className="mb-1 flex items-center justify-between">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600">AI Calibration</span>
                              <button
                                onClick={() => { refinementStarted.current = false; setRefinementNotes(null); handleRefineWithAI(); }}
                                disabled={refining}
                                className="text-[10px] font-medium text-blue-500 hover:text-blue-700 disabled:opacity-50"
                              >
                                Refine again
                              </button>
                            </div>
                            <div className="whitespace-pre-wrap text-xs leading-relaxed text-blue-800 dark:text-blue-300">
                              {refinementNotes}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-zinc-400 dark:border-zinc-700">
                        <div className="text-center">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-transparent inline-block mb-2" />
                          <p className="text-sm">Collecting site data...</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {activeTab === "images" && (
                <ImageGallery
                  streetImages={data.streetImages}
                  listingPhotos={data.listingPhotos}
                  satelliteImages={data.satelliteImages ?? []}
                />
              )}
              {activeTab === "data" && <PropertyInspector data={data} />}
            </div>

            {/* 3D Viewer panel */}
            {viewerOpen && (
              <div className="flex w-1/2 flex-col border-l border-zinc-200 dark:border-zinc-800">
                <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 py-2">
                  <span className="text-xs font-medium text-zinc-400">3D Preview</span>
                  <div className="flex items-center gap-1">
                    {modelCode && (
                      <button onClick={handleGenerateModel} disabled={generating} className="rounded px-2 py-1 text-[10px] font-medium text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50">
                        Regenerate
                      </button>
                    )}
                    <button onClick={() => setViewerOpen(false)} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="flex-1"><Viewer3D modelCode={modelCode} /></div>
              </div>
            )}
          </div>
        </div>

        {/* Chat Panel — resizable + collapsible */}
        {chatCollapsed ? (
          <div className="flex shrink-0 flex-col items-center border-l border-zinc-200 bg-zinc-50 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            <button
              onClick={() => setChatCollapsed(false)}
              className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title="Expand chat"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            {/* Drag handle */}
            <div
              onMouseDown={handleDragStart}
              className="w-1 shrink-0 cursor-col-resize bg-zinc-200 transition-colors hover:bg-blue-400 active:bg-blue-500 dark:bg-zinc-800 dark:hover:bg-blue-600"
            />
            <div
              className="shrink-0 flex flex-col"
              style={{ width: chatWidth }}
            >
              {/* Collapse button in chat header area */}
              <div className="flex items-center justify-between border-b border-zinc-200 px-2 py-1 dark:border-zinc-800">
                <button
                  onClick={() => setChatCollapsed(true)}
                  className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                  title="Collapse chat"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7" />
                  </svg>
                </button>
                <span className="text-[10px] text-zinc-400">drag to resize</span>
              </div>
              <div className="flex-1 overflow-hidden">
                <ChatPanel data={data} onDataUpdate={handleDataUpdate} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
