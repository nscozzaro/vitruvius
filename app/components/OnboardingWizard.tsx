"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { CollectionResults, UploadedDocument } from "@/app/lib/api";
import {
  collectOsm, collectStreet, collectAssessor,
  collectElevation, collectPhotos, collectSatellite, collectParcel,
} from "@/app/lib/api";

type Step = "collecting" | "documents" | "processing" | "review";

interface WizardProps {
  data: CollectionResults;
  onDataUpdate: (updater: (prev: CollectionResults) => CollectionResults) => void;
  onComplete: () => void;
}

interface ToolState {
  name: string;
  label: string;
  source: string;
  status: "pending" | "running" | "done" | "error";
  summary?: string;
  thumbnails?: { url: string; alt: string }[];
}

const DOC_CATEGORIES = [
  { id: "survey", label: "Survey / Topo Map", icon: "📐", desc: "Boundary survey, topographic map, ALTA survey", accept: ".pdf,.dwg,.dxf,.jpg,.png,.tif" },
  { id: "floor_plan", label: "Floor Plans", icon: "📋", desc: "Existing floor plans or archive drawings", accept: ".pdf,.dwg,.dxf,.jpg,.png" },
  { id: "site_plan", label: "Existing Site Plan", icon: "🗺️", desc: "Previous site plan or plot plan", accept: ".pdf,.dwg,.dxf,.jpg,.png" },
  { id: "title", label: "Title Report", icon: "📄", desc: "Title report, deed, or legal description", accept: ".pdf,.txt" },
  { id: "other", label: "Other", icon: "📎", desc: "Photos, permits, reports", accept: ".pdf,.dwg,.dxf,.jpg,.png,.txt" },
];

export default function OnboardingWizard({ data, onDataUpdate, onComplete }: WizardProps) {
  const [step, setStep] = useState<Step>("collecting");
  const [tools, setTools] = useState<ToolState[]>([]);
  const [pendingFiles, setPendingFiles] = useState<Map<string, { name: string; size: number; text: string }[]>>(new Map());
  const [processing, setProcessing] = useState(false);
  const [gap, setGap] = useState<{ avail: string[]; miss: string[] }>({ avail: [], miss: [] });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeCat = useRef("");
  const started = useRef(false);

  // ── Step 1: Collection ────────────────────────────────────────────
  const runCollection = useCallback(async () => {
    if (started.current || !data.geocoded) return;
    started.current = true;

    const defs = [
      { name: "satellite", label: "Satellite imagery", source: "Google Maps Static API",
        run: async () => { const r = await collectSatellite(data.geocoded!.latitude, data.geocoded!.longitude); return { satelliteImages: r.images } as Partial<CollectionResults>; },
        sum: (r: Partial<CollectionResults>) => ({ text: `${r.satelliteImages?.length || 0} overhead views`, thumbs: r.satelliteImages?.slice(0, 3).map(i => ({ url: i.url, alt: "" })) }),
      },
      { name: "street", label: "Street-level views", source: "Google Street View + Mapillary",
        run: async () => { const r = await collectStreet(data.geocoded!.latitude, data.geocoded!.longitude); return { streetImages: r.images } as Partial<CollectionResults>; },
        sum: (r: Partial<CollectionResults>) => ({ text: `${r.streetImages?.length || 0} views from 8 directions`, thumbs: r.streetImages?.slice(0, 4).map(i => ({ url: i.url, alt: "" })) }),
      },
      { name: "footprint", label: "Building footprint", source: "OpenStreetMap Overpass",
        run: async () => { const r = await collectOsm(data.geocoded!.latitude, data.geocoded!.longitude, data.geocoded!.address); return { footprint: r.footprint, footprintOrigin: r.origin, neighbors: r.neighbors } as Partial<CollectionResults>; },
        sum: (r: Partial<CollectionResults>) => ({ text: r.footprint ? `${r.footprint.length}-point polygon, ${r.neighbors?.length || 0} neighbors` : "Not found", thumbs: undefined as { url: string; alt: string }[] | undefined }),
      },
      { name: "parcel", label: "Parcel, zoning & permits", source: "Municipal GIS",
        run: async () => { const r = await collectParcel(data.geocoded!.latitude, data.geocoded!.longitude, data.geocoded!.address); return { parcel: r.data } as Partial<CollectionResults>; },
        sum: (r: Partial<CollectionResults>): { text: string; thumbs?: { url: string; alt: string }[] } => {
          if (!r.parcel) return { text: "Outside covered jurisdictions" };
          return { text: [r.parcel.apn, r.parcel.zoning, r.parcel.parcelBoundary?.length ? "lot lines" : null, r.parcel.permits?.length ? `${r.parcel.permits.length} permits` : null].filter(Boolean).join(" · ") };
        },
      },
      { name: "elevation", label: "Site elevation", source: "USGS National Map",
        run: async () => { const r = await collectElevation(data.geocoded!.latitude, data.geocoded!.longitude); return { elevation_m: r.elevation_m } as Partial<CollectionResults>; },
        sum: (r: Partial<CollectionResults>) => ({ text: r.elevation_m != null ? `${r.elevation_m}m (${(r.elevation_m * 3.281).toFixed(1)}ft)` : "Not available", thumbs: undefined as { url: string; alt: string }[] | undefined }),
      },
      { name: "assessor", label: "Building metadata", source: "OSM Nominatim",
        run: async () => { const r = await collectAssessor(data.geocoded!.address, data.geocoded!.latitude, data.geocoded!.longitude); return { assessor: r.data } as Partial<CollectionResults>; },
        sum: (r: Partial<CollectionResults>) => ({ text: r.assessor ? "Tags collected" : "No additional data", thumbs: undefined as { url: string; alt: string }[] | undefined }),
      },
      { name: "photos", label: "Detail close-ups", source: "Google Street View",
        run: async () => { const r = await collectPhotos(data.geocoded!.address, data.geocoded!.latitude, data.geocoded!.longitude); return { listingPhotos: r.images } as Partial<CollectionResults>; },
        sum: (r: Partial<CollectionResults>) => ({ text: `${r.listingPhotos?.length || 0} angled views`, thumbs: r.listingPhotos?.slice(0, 3).map(i => ({ url: i.url, alt: "" })) }),
      },
    ];

    setTools(defs.map(d => ({ name: d.name, label: d.label, source: d.source, status: "pending" })));

    for (let i = 0; i < defs.length; i++) {
      setTools(prev => prev.map((t, j) => j === i ? { ...t, status: "running" } : t));
      try {
        const result = await defs[i].run();
        const s = defs[i].sum(result);
        onDataUpdate(prev => ({ ...prev, ...result }));
        setTools(prev => prev.map((t, j) => j === i ? { ...t, status: "done", summary: s.text, thumbnails: s.thumbs } : t));
      } catch {
        setTools(prev => prev.map((t, j) => j === i ? { ...t, status: "error", summary: "Failed" } : t));
      }
    }

    // Auto-advance after brief pause
    setTimeout(() => setStep("documents"), 800);
  }, [data, onDataUpdate]);

  useEffect(() => { if (step === "collecting") runCollection(); }, [step, runCollection]);

  // ── File upload ───────────────────────────────────────────────────
  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const cat = activeCat.current || "other";
    for (const file of Array.from(files)) {
      let text = "";
      if (file.name.match(/\.(dwg|dxf)$/i)) {
        text = `[CAD file: ${file.name}, ${(file.size / 1024).toFixed(0)}KB — AutoCAD vector drawing]`;
      } else if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
        try {
          const fd = new FormData(); fd.append("file", file);
          const resp = await fetch("/api/extract_pdf", { method: "POST", body: fd });
          if (resp.ok) { const r = await resp.json(); text = r.scanned ? `[Vector/scanned PDF: ${file.name}, ${r.pages} pages]` : (r.text?.trim() || `[PDF: ${file.name}]`); }
        } catch { text = `[PDF: ${file.name}]`; }
      } else if (file.type.startsWith("image/")) {
        text = `[Image: ${file.name}, ${(file.size / 1024).toFixed(0)}KB]`;
      } else {
        try { text = await file.text(); } catch { text = `[File: ${file.name}]`; }
      }
      setPendingFiles(prev => { const n = new Map(prev); n.set(cat, [...(n.get(cat) || []), { name: file.name, size: file.size, text: text.slice(0, 20000) }]); return n; });
    }
  }, []);

  // ── Process uploads ───────────────────────────────────────────────
  const handleProcess = useCallback(async () => {
    setStep("processing"); setProcessing(true);
    for (const file of Array.from(pendingFiles.values()).flat()) {
      try {
        const resp = await fetch("/api/categorize_document", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, text: file.text }),
        });
        const r = await resp.json();
        let extractedFields = r.extractedFields || {};

        // For title reports, do deep extraction
        if (r.category === "title" && file.text.length > 100) {
          try {
            const titleResp = await fetch("/api/extract_title_data", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: file.text }),
            });
            if (titleResp.ok) {
              const titleData = await titleResp.json();
              if (titleData.data) extractedFields = { ...extractedFields, ...titleData.data };
            }
          } catch { /* skip */ }
        }

        const doc: UploadedDocument = { filename: file.name, category: r.category, confidence: r.confidence, summary: r.summary, extractedFields, text: file.text };
        onDataUpdate(prev => ({ ...prev, uploadedDocuments: [...(prev.uploadedDocuments || []), doc] }));
      } catch { /* skip */ }
    }
    setProcessing(false); setStep("review");
  }, [pendingFiles, onDataUpdate]);

  // ── Gap analysis ──────────────────────────────────────────────────
  useEffect(() => {
    if (step !== "review") return;
    const a: string[] = [], m: string[] = [];
    if (data.footprint) a.push(`Building footprint — ${data.footprint.length} points`);
    else m.push("Building footprint");
    if (data.parcel?.parcelBoundary?.length) a.push(`Lot boundary — ${data.parcel.parcelBoundary.length} points`);
    else m.push("Lot boundary");
    if (data.elevation_m != null) a.push(`Elevation — ${data.elevation_m}m`);
    if (data.parcel?.zoning) a.push(`Zoning — ${data.parcel.zoning} ${data.parcel.landUse ? `(${data.parcel.landUse})` : ""}`);
    if (data.parcel?.apn) a.push(`APN — ${data.parcel.apn}`);
    const ups = data.uploadedDocuments || [];
    if (ups.some(d => d.category === "survey")) a.push("Survey (uploaded)");
    else m.push("Survey / topographic map");
    if (ups.some(d => d.category === "floor_plan")) a.push("Floor plans (uploaded)");
    else m.push("Floor plans");
    m.push("Setback lines"); m.push("Utility locations"); m.push("Easements");
    setGap({ avail: a, miss: m });
  }, [step, data]);

  const totalPending = Array.from(pendingFiles.values()).flat().length;
  const doneTools = tools.filter(t => t.status === "done" || t.status === "error").length;
  const progress = tools.length > 0 ? (doneTools / tools.length) * 100 : 0;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col bg-white dark:bg-zinc-950">
      {/* Minimal header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 px-6 dark:border-zinc-800">
        <span className="text-sm font-bold tracking-tight">Vitruvius</span>
        <span className="truncate text-xs text-zinc-400 max-w-[300px]">{data.geocoded?.address}</span>
      </div>

      {/* Main content — centered typeform style */}
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-12">
        <div className="w-full max-w-lg">

          {/* ── STEP 1: Collecting ──────────────────────────────── */}
          {step === "collecting" && (
            <div className="animate-in fade-in">
              <h1 className="mb-2 text-2xl font-bold tracking-tight">
                Gathering property data
              </h1>
              <p className="mb-6 text-zinc-500">
                Searching public databases and mapping services...
              </p>

              {/* Progress bar */}
              <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all duration-500" style={{ width: `${progress}%` }} />
              </div>

              <div className="space-y-2">
                {tools.map(tool => (
                  <div key={tool.name} className={`flex items-start gap-3 rounded-xl border p-3 transition-all ${
                    tool.status === "running" ? "border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20"
                      : tool.status === "done" ? "border-zinc-100 dark:border-zinc-800"
                      : tool.status === "error" ? "border-red-100 dark:border-red-900"
                      : "border-zinc-100 opacity-40 dark:border-zinc-800"
                  }`}>
                    <div className="mt-0.5">
                      {tool.status === "running" ? <span className="block h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-500" />
                        : tool.status === "done" ? <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[9px] text-white">✓</span>
                        : tool.status === "error" ? <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] text-white">!</span>
                        : <span className="block h-4 w-4 rounded-full border-2 border-zinc-200 dark:border-zinc-700" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium">{tool.label}</span>
                        <span className="text-[10px] text-zinc-400">{tool.source}</span>
                      </div>
                      {tool.summary && <div className="mt-0.5 text-xs text-zinc-500">{tool.summary}</div>}
                      {tool.thumbnails && (
                        <div className="mt-1.5 flex gap-1">
                          {tool.thumbnails.map((t, i) => (
                            <div key={i} className="h-10 w-14 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={t.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── STEP 2: Documents ───────────────────────────────── */}
          {step === "documents" && (
            <div>
              <h1 className="mb-2 text-2xl font-bold tracking-tight">
                Upload your documents
              </h1>
              <p className="mb-6 text-zinc-500">
                Add surveys, floor plans, or other project files.
                Supports PDF, DWG, DXF, and images.
              </p>

              <input ref={fileInputRef} type="file" multiple className="hidden"
                accept=".pdf,.dwg,.dxf,.jpg,.png,.tif,.txt"
                onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />

              <div className="space-y-2.5">
                {DOC_CATEGORIES.map(cat => {
                  const files = pendingFiles.get(cat.id) || [];
                  return (
                    <button key={cat.id}
                      onClick={() => { activeCat.current = cat.id; fileInputRef.current?.click(); }}
                      className="flex w-full items-center gap-4 rounded-xl border-2 border-dashed border-zinc-200 px-5 py-4 text-left transition-all hover:border-blue-300 hover:bg-blue-50/30 dark:border-zinc-700 dark:hover:border-blue-700"
                    >
                      <span className="text-3xl">{cat.icon}</span>
                      <div className="flex-1">
                        <div className="text-sm font-semibold">{cat.label}</div>
                        <div className="text-xs text-zinc-400">{cat.desc}</div>
                        {files.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {files.map((f, i) => (
                              <span key={i} className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                                {f.name.match(/\.(dwg|dxf)$/i) && <span className="text-[9px] font-bold">CAD</span>}
                                {f.name.endsWith(".pdf") && <span className="text-[9px] font-bold">PDF</span>}
                                {f.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <svg className="h-5 w-5 shrink-0 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 flex gap-3">
                <button onClick={() => { setStep("review"); }}
                  className="flex-1 rounded-xl border border-zinc-200 py-3 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-50 dark:border-zinc-700">
                  Skip for now
                </button>
                {totalPending > 0 && (
                  <button onClick={handleProcess}
                    className="flex-1 rounded-xl bg-zinc-900 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">
                    Analyze {totalPending} file{totalPending !== 1 ? "s" : ""} →
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── STEP 3: Processing ──────────────────────────────── */}
          {step === "processing" && (
            <div className="flex flex-col items-center py-12 text-center">
              <span className="mb-6 block h-10 w-10 animate-spin rounded-full border-[3px] border-zinc-200 border-t-blue-500" />
              <h1 className="mb-2 text-2xl font-bold tracking-tight">
                Analyzing documents
              </h1>
              <p className="text-zinc-500">
                AI is reading and categorizing your uploads...
              </p>
            </div>
          )}

          {/* ── STEP 4: Review ──────────────────────────────────── */}
          {step === "review" && (
            <div>
              <h1 className="mb-2 text-2xl font-bold tracking-tight">
                Ready to go
              </h1>
              <p className="mb-6 text-zinc-500">
                Here&apos;s what we have for your project:
              </p>

              {gap.avail.length > 0 && (
                <div className="mb-5">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-emerald-600">Available</div>
                  <div className="space-y-1.5">
                    {gap.avail.map((item, i) => (
                      <div key={i} className="flex items-start gap-2.5 text-sm">
                        <svg className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-zinc-700 dark:text-zinc-300">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {gap.miss.length > 0 && (
                <div className="mb-5">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-amber-600">Missing / Will Estimate</div>
                  <div className="space-y-1.5">
                    {gap.miss.map((item, i) => (
                      <div key={i} className="flex items-start gap-2.5 text-sm text-zinc-500">
                        <span className="mt-0.5 h-4 w-4 shrink-0 text-center text-amber-400">○</span>
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(data.uploadedDocuments?.length ?? 0) > 0 && (
                <div className="mb-5 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-400">Uploaded Documents</div>
                  {data.uploadedDocuments?.map((doc, i) => (
                    <div key={i} className="flex items-center gap-2 py-1.5 text-sm">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800">
                        {doc.category.replace("_", " ")}
                      </span>
                      <span className="text-zinc-700 dark:text-zinc-300">{doc.filename}</span>
                    </div>
                  ))}
                </div>
              )}

              <button onClick={onComplete}
                className="w-full rounded-xl bg-zinc-900 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
                Open project workspace →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Step dots at bottom */}
      <div className="flex h-10 shrink-0 items-center justify-center gap-2">
        {(["collecting", "documents", "processing", "review"] as Step[]).map((s, i) => {
          const idx = ["collecting", "documents", "processing", "review"].indexOf(step);
          return (
            <div key={s} className={`h-1.5 rounded-full transition-all ${
              i === idx ? "w-6 bg-zinc-900 dark:bg-zinc-100"
                : i < idx ? "w-1.5 bg-zinc-400"
                : "w-1.5 bg-zinc-200 dark:bg-zinc-700"
            }`} />
          );
        })}
      </div>
    </div>
  );
}
