"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import type { CollectionResults, UploadedDocument } from "@/app/lib/api";
import {
  collectOsm, collectStreet, collectAssessor,
  collectElevation, collectPhotos, collectSatellite, collectParcel,
} from "@/app/lib/api";

// ── Types ───────────────────────────────────────────────────────────
type Phase = "collecting" | "uploading" | "categorizing" | "analysis" | "chat";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "upload-prompt" | "gap-analysis";
  content: string;
  toolName?: string;
  toolStatus?: "running" | "done" | "error";
  thumbnails?: { url: string; alt: string }[];
  attachments?: { name: string; size: number; text: string }[];
}

interface ChatPanelProps {
  data: CollectionResults;
  onDataUpdate: (updater: (prev: CollectionResults) => CollectionResults) => void;
}

let msgId = 0;
const nextId = () => `msg-${++msgId}`;

// ── Document categories for upload ──────────────────────────────────
const DOC_CATEGORIES = [
  { id: "survey", label: "Survey / Topo Map", icon: "📐", hint: "Boundary survey, topographic map, ALTA survey" },
  { id: "floor_plan", label: "Floor Plans", icon: "📋", hint: "Existing floor plans, archive drawings" },
  { id: "site_plan", label: "Existing Site Plan", icon: "🗺️", hint: "Previous site plan or plot plan" },
  { id: "title", label: "Title Report", icon: "📄", hint: "Title report, deed, or legal description" },
  { id: "other", label: "Other Documents", icon: "📎", hint: "Photos, permits, reports, etc." },
];

// ── Tool definitions with source attribution ────────────────────────
function getTools() {
  return [
    {
      name: "satellite",
      label: "Fetching satellite imagery from Google Maps Static API",
      run: async (d: CollectionResults) => {
        const r = await collectSatellite(d.geocoded!.latitude, d.geocoded!.longitude);
        return { satelliteImages: r.images } as Partial<CollectionResults>;
      },
      summarize: (r: Partial<CollectionResults>) => ({
        text: `**Google Maps**: ${r.satelliteImages?.length || 0} overhead satellite views at zoom levels 17–20`,
        thumbnails: r.satelliteImages?.slice(0, 2).map((img) => ({ url: img.url, alt: img.description || "Satellite" })),
      }),
    },
    {
      name: "street",
      label: "Fetching street-level imagery from Google Street View + Mapillary",
      run: async (d: CollectionResults) => {
        const r = await collectStreet(d.geocoded!.latitude, d.geocoded!.longitude);
        return { streetImages: r.images } as Partial<CollectionResults>;
      },
      summarize: (r: Partial<CollectionResults>) => {
        const gsv = r.streetImages?.filter((i) => i.source === "google_street_view").length || 0;
        const mapillary = r.streetImages?.filter((i) => i.source === "mapillary").length || 0;
        const parts = [];
        if (gsv) parts.push(`${gsv} from Google Street View`);
        if (mapillary) parts.push(`${mapillary} from Mapillary`);
        return {
          text: `**Street View**: ${parts.join(", ") || "0 images"} — views from all 8 compass directions`,
          thumbnails: r.streetImages?.slice(0, 4).map((img) => ({ url: img.url, alt: img.description || "" })),
        };
      },
    },
    {
      name: "footprint",
      label: "Querying OpenStreetMap Overpass API for building footprint",
      run: async (d: CollectionResults) => {
        const r = await collectOsm(d.geocoded!.latitude, d.geocoded!.longitude, d.geocoded!.address);
        return { footprint: r.footprint, footprintOrigin: r.origin, neighbors: r.neighbors } as Partial<CollectionResults>;
      },
      summarize: (r: Partial<CollectionResults>) => {
        if (!r.footprint) return { text: "**OpenStreetMap**: No building footprint found", thumbnails: undefined };
        const n = r.neighbors?.length || 0;
        return { text: `**OpenStreetMap**: ${r.footprint.length}-point building polygon${n > 0 ? `, ${n} neighbors` : ""}`, thumbnails: undefined };
      },
    },
    {
      name: "parcel",
      label: "Querying municipal GIS for parcel boundaries & permits",
      run: async (d: CollectionResults) => {
        const r = await collectParcel(d.geocoded!.latitude, d.geocoded!.longitude, d.geocoded!.address);
        return { parcel: r.data } as Partial<CollectionResults>;
      },
      summarize: (r: Partial<CollectionResults>) => {
        if (!r.parcel) return { text: "**Municipal GIS**: Outside covered jurisdictions", thumbnails: undefined };
        const src = r.parcel.source === "goleta_magnet" ? "City of Goleta MAGNET" : "City of Santa Barbara ArcGIS";
        const parts = [];
        if (r.parcel.apn) parts.push(`APN ${r.parcel.apn}`);
        if (r.parcel.zoning) parts.push(`zoned ${r.parcel.zoning}`);
        if (r.parcel.parcelBoundary?.length) parts.push(`${r.parcel.parcelBoundary.length}-pt lot boundary`);
        if (r.parcel.permits?.length) parts.push(`${r.parcel.permits.length} permits`);
        return { text: `**${src}**: ${parts.join(" · ")}`, thumbnails: undefined };
      },
    },
    {
      name: "elevation",
      label: "Querying USGS National Map Elevation Point Query Service",
      run: async (d: CollectionResults) => {
        const r = await collectElevation(d.geocoded!.latitude, d.geocoded!.longitude);
        return { elevation_m: r.elevation_m } as Partial<CollectionResults>;
      },
      summarize: (r: Partial<CollectionResults>): { text: string; thumbnails?: { url: string; alt: string }[] } => ({
        text: r.elevation_m != null
          ? `**USGS National Map**: Elevation ${r.elevation_m}m (${(r.elevation_m * 3.281).toFixed(1)}ft)`
          : "**USGS**: Elevation not available",
      }),
    },
    {
      name: "assessor",
      label: "Searching OpenStreetMap for building tags",
      run: async (d: CollectionResults) => {
        const r = await collectAssessor(d.geocoded!.address, d.geocoded!.latitude, d.geocoded!.longitude);
        return { assessor: r.data } as Partial<CollectionResults>;
      },
      summarize: (r: Partial<CollectionResults>) => {
        if (!r.assessor) return { text: "**OSM Nominatim**: No additional building tags", thumbnails: undefined };
        const parts = [];
        if (r.assessor.stories) parts.push(`${r.assessor.stories} stories`);
        if (r.assessor.roof_type) parts.push(`${r.assessor.roof_type} roof`);
        return { text: `**OSM Nominatim**: ${parts.length ? parts.join(", ") : "Tags collected"}`, thumbnails: undefined };
      },
    },
    {
      name: "photos",
      label: "Fetching close-up views from Google Street View",
      run: async (d: CollectionResults) => {
        const r = await collectPhotos(d.geocoded!.address, d.geocoded!.latitude, d.geocoded!.longitude);
        return { listingPhotos: r.images } as Partial<CollectionResults>;
      },
      summarize: (r: Partial<CollectionResults>) => ({
        text: `**Google Street View**: ${r.listingPhotos?.length || 0} close-up detail views`,
        thumbnails: r.listingPhotos?.slice(0, 3).map((img) => ({ url: img.url, alt: img.description || "" })),
      }),
    },
  ];
}

// ── Component ───────────────────────────────────────────────────────
export default function ChatPanel({ data, onDataUpdate }: ChatPanelProps) {
  const [phase, setPhase] = useState<Phase>("collecting");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<Map<string, { name: string; text: string }[]>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const categoryFileRef = useRef<string>("");
  const collectionStartedRef = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, phase]);

  // ── Phase 1: Auto-collection ──────────────────────────────────────
  const runCollection = useCallback(async () => {
    if (collectionStartedRef.current || !data.geocoded) return;

    // Already collected (came from wizard or cache)? Go straight to chat.
    const hasData = data.footprint || data.streetImages.length > 0 || data.parcel;
    if (hasData) {
      setPhase("chat");
      setMessages([{
        id: nextId(), role: "assistant",
        content: `Ready to help with **${data.geocoded.address}**. Ask about the property, request a site plan, or upload documents with the 📎 button.`,
      }]);
      collectionStartedRef.current = true;
      return;
    }

    collectionStartedRef.current = true;
    setMessages([{
      id: nextId(), role: "assistant",
      content: `Analyzing **${data.geocoded.address}**...\nCollecting data from public sources.`,
    }]);

    const tools = getTools();
    for (const tool of tools) {
      const toolMsgId = nextId();
      setMessages((prev) => [...prev, {
        id: toolMsgId, role: "tool", content: tool.label,
        toolName: tool.name, toolStatus: "running",
      }]);

      try {
        const result = await tool.run(data);
        const summary = tool.summarize(result);
        onDataUpdate((prev) => ({ ...prev, ...result }));
        setMessages((prev) => prev.map((m) =>
          m.id === toolMsgId
            ? { ...m, toolStatus: "done" as const, content: summary.text, thumbnails: summary.thumbnails }
            : m
        ));
      } catch {
        setMessages((prev) => prev.map((m) =>
          m.id === toolMsgId
            ? { ...m, toolStatus: "error" as const, content: `${tool.label} — failed` }
            : m
        ));
      }
    }

    // Transition to Phase 2
    setPhase("uploading");
    setMessages((prev) => [...prev, {
      id: nextId(), role: "upload-prompt", content: "",
    }]);
  }, [data, onDataUpdate]);

  useEffect(() => { runCollection(); }, [runCollection]);

  // ── File upload handler ───────────────────────────────────────────
  const handleFileUpload = useCallback(async (files: FileList | null, category?: string) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      let text = "";
      if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
        try {
          const fd = new FormData();
          fd.append("file", file);
          const resp = await fetch("/api/extract_pdf", { method: "POST", body: fd });
          if (resp.ok) {
            const result = await resp.json();
            text = result.text?.trim() || `[Scanned PDF: ${file.name}, ${result.pages} pages]`;
          }
        } catch { text = `[PDF: ${file.name} — extraction failed]`; }
      } else {
        text = await file.text();
      }

      const cat = category || "other";
      setPendingFiles((prev) => {
        const next = new Map(prev);
        const existing = next.get(cat) || [];
        next.set(cat, [...existing, { name: file.name, text: text.slice(0, 20000) }]);
        return next;
      });
    }
  }, []);

  // ── Phase 2→3: Process uploads ────────────────────────────────────
  const handleProcessUploads = useCallback(async () => {
    const allFiles = Array.from(pendingFiles.values()).flat();
    if (allFiles.length === 0) {
      // Skip to gap analysis
      setPhase("analysis");
      setMessages((prev) => [...prev, { id: nextId(), role: "gap-analysis", content: "" }]);
      return;
    }

    setPhase("categorizing");

    for (const file of allFiles) {
      const catMsgId = nextId();
      setMessages((prev) => [...prev, {
        id: catMsgId, role: "tool", content: `Analyzing ${file.name}...`,
        toolName: "categorize", toolStatus: "running",
      }]);

      try {
        const resp = await fetch("/api/categorize_document", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, text: file.text }),
        });
        const result = await resp.json();

        const doc: UploadedDocument = {
          filename: file.name,
          category: result.category,
          confidence: result.confidence,
          summary: result.summary,
          extractedFields: result.extractedFields || {},
          text: file.text,
        };

        onDataUpdate((prev) => ({
          ...prev,
          uploadedDocuments: [...(prev.uploadedDocuments || []), doc],
        }));

        const fieldCount = Object.keys(result.extractedFields || {}).length;
        setMessages((prev) => prev.map((m) =>
          m.id === catMsgId ? {
            ...m, toolStatus: "done" as const,
            content: `**${file.name}** → ${result.category.replace("_", " ")} (${Math.round(result.confidence * 100)}% confidence)\n${result.summary}${fieldCount > 0 ? `\nExtracted ${fieldCount} fields` : ""}`,
          } : m
        ));
      } catch {
        setMessages((prev) => prev.map((m) =>
          m.id === catMsgId ? { ...m, toolStatus: "error" as const, content: `Failed to categorize ${file.name}` } : m
        ));
      }
    }

    // Transition to gap analysis
    setPhase("analysis");
    setMessages((prev) => [...prev, { id: nextId(), role: "gap-analysis", content: "" }]);
  }, [pendingFiles, onDataUpdate]);

  // ── Phase 4→5: Proceed to chat ────────────────────────────────────
  const handleProceedToChat = useCallback(() => {
    setPhase("chat");
    setMessages((prev) => [...prev, {
      id: nextId(), role: "assistant",
      content: "Ready to help. Ask me about the property, request a site plan, or upload more documents anytime.",
    }]);
  }, []);

  // ── Send chat message (Phase 5) ───────────────────────────────────
  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMsg: ChatMessage = { id: nextId(), role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const chatMsgs = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .concat(userMsg)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: chatMsgs, propertyData: data }),
      });
      if (!resp.ok) throw new Error("Chat failed");
      const result = await resp.json();
      setMessages((prev) => [...prev, { id: nextId(), role: "assistant", content: result.content }]);
    } catch {
      setMessages((prev) => [...prev, { id: nextId(), role: "assistant", content: "Sorry, I encountered an error." }]);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Build gap analysis data ───────────────────────────────────────
  const buildGapAnalysis = () => {
    const available: string[] = [];
    const missing: string[] = [];

    if (data.footprint) available.push(`Building footprint — ${data.footprint.length}-point polygon (OpenStreetMap)`);
    else missing.push("Building footprint — not found in OSM");

    if (data.parcel?.parcelBoundary?.length) available.push(`Lot boundary — ${data.parcel.parcelBoundary.length} points (${data.parcel.source === "goleta_magnet" ? "Goleta MAGNET" : "SB City ArcGIS"})`);
    else missing.push("Lot boundary / property lines");

    if (data.elevation_m != null) available.push(`Elevation — ${data.elevation_m}m / ${(data.elevation_m * 3.281).toFixed(1)}ft (USGS)`);
    else missing.push("Site elevation");

    if (data.parcel?.zoning) available.push(`Zoning — ${data.parcel.zoning} ${data.parcel.landUse ? `(${data.parcel.landUse})` : ""}`);
    else missing.push("Zoning classification");

    if (data.parcel?.apn) available.push(`APN — ${data.parcel.apn}`);

    // Check uploaded documents
    const uploads = data.uploadedDocuments || [];
    const hasSurvey = uploads.some((d) => d.category === "survey");
    const hasFloorPlan = uploads.some((d) => d.category === "floor_plan");
    const hasSitePlan = uploads.some((d) => d.category === "site_plan");

    if (hasSurvey) available.push("Survey / topographic map (uploaded)");
    else missing.push("Survey / topographic map — needed for precise lot dimensions");

    if (hasFloorPlan) available.push("Floor plans / archive drawings (uploaded)");
    else missing.push("Floor plans — needed for interior layout");

    if (hasSitePlan) available.push("Existing site plan (uploaded)");

    // Always missing from public data
    missing.push("Setback lines — will use zone defaults or upload survey");
    missing.push("Utility locations (water, sewer, gas, electric)");
    missing.push("Easements and restrictions");
    missing.push("Grading / drainage plan");

    return { available, missing };
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-zinc-900 dark:bg-zinc-100">
            <svg className="h-3.5 w-3.5 text-white dark:text-zinc-900" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
            </svg>
          </div>
          <h2 className="text-sm font-semibold">Vitruvius AI</h2>
          {phase === "collecting" && <span className="ml-2 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />}
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.role === "tool" ? <ToolMessage msg={msg} />
              : msg.role === "user" ? <UserMessage msg={msg} />
              : msg.role === "upload-prompt" ? (
                <UploadPrompt
                  categories={DOC_CATEGORIES}
                  pendingFiles={pendingFiles}
                  onUpload={(cat) => { categoryFileRef.current = cat; fileInputRef.current?.click(); }}
                  onProcess={handleProcessUploads}
                  onSkip={() => { setPhase("analysis"); setMessages((p) => [...p, { id: nextId(), role: "gap-analysis", content: "" }]); }}
                  disabled={phase !== "uploading"}
                />
              )
              : msg.role === "gap-analysis" ? (
                <GapAnalysis analysis={buildGapAnalysis()} onProceed={handleProceedToChat} />
              )
              : <AssistantMessage msg={msg} />
            }
          </div>
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
            </span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt,.jpg,.png"
        multiple
        className="hidden"
        onChange={(e) => { handleFileUpload(e.target.files, categoryFileRef.current); e.target.value = ""; }}
      />

      {/* Chat input — always visible */}
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex items-end gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 focus-within:border-zinc-300 focus-within:ring-1 focus-within:ring-zinc-300/50 dark:border-zinc-700 dark:bg-zinc-900">
          <button
            onClick={() => { categoryFileRef.current = "other"; fileInputRef.current?.click(); }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
            title="Attach file"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
            </svg>
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={phase === "chat" ? "Ask about the property or describe a design..." : "Type a message or use the upload prompts above..."}
            disabled={isLoading}
            rows={1}
            className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-zinc-400 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tool message ────────────────────────────────────────────────────
function ToolMessage({ msg }: { msg: ChatMessage }) {
  const isRunning = msg.toolStatus === "running";
  const isError = msg.toolStatus === "error";
  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
        {isRunning ? <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-zinc-400 border-t-transparent" />
          : isError ? <span className="text-[10px] font-bold text-red-500">!</span>
          : <svg className="h-3 w-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-xs leading-relaxed ${isError ? "text-red-500" : isRunning ? "text-zinc-400" : "text-zinc-600 dark:text-zinc-400"}`}>
          <ReactMarkdown>{msg.content}</ReactMarkdown>
        </div>
        {msg.thumbnails && msg.thumbnails.length > 0 && (
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto">
            {msg.thumbnails.map((t, i) => (
              <div key={i} className="h-14 w-20 shrink-0 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.url} alt={t.alt} className="h-full w-full object-cover" loading="lazy" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Upload prompt (Phase 2) ─────────────────────────────────────────
function UploadPrompt({
  categories, pendingFiles, onUpload, onProcess, onSkip, disabled,
}: {
  categories: typeof DOC_CATEGORIES;
  pendingFiles: Map<string, { name: string }[]>;
  onUpload: (category: string) => void;
  onProcess: () => void;
  onSkip: () => void;
  disabled: boolean;
}) {
  const totalFiles = Array.from(pendingFiles.values()).flat().length;

  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Upload your project documents:
      </p>
      <div className="space-y-2">
        {categories.map((cat) => {
          const files = pendingFiles.get(cat.id) || [];
          return (
            <button
              key={cat.id}
              onClick={() => !disabled && onUpload(cat.id)}
              disabled={disabled}
              className="flex w-full items-center gap-3 rounded-lg border border-dashed border-zinc-300 px-3 py-2.5 text-left transition-colors hover:border-zinc-400 hover:bg-white disabled:opacity-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
            >
              <span className="text-lg">{cat.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{cat.label}</div>
                <div className="text-[10px] text-zinc-400">{cat.hint}</div>
              </div>
              {files.length > 0 && (
                <div className="flex flex-col items-end gap-0.5">
                  {files.map((f, i) => (
                    <span key={i} className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                      {f.name}
                    </span>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2">
        {totalFiles > 0 && (
          <button
            onClick={onProcess}
            disabled={disabled}
            className="flex-1 rounded-lg bg-zinc-900 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Process {totalFiles} file{totalFiles !== 1 ? "s" : ""}
          </button>
        )}
        <button
          onClick={onSkip}
          disabled={disabled}
          className={`${totalFiles > 0 ? "" : "flex-1"} rounded-lg border border-zinc-200 py-2 px-4 text-xs font-medium text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800`}
        >
          {totalFiles > 0 ? "Skip rest" : "Skip — work with public data"}
        </button>
      </div>
    </div>
  );
}

// ── Gap Analysis (Phase 4) ──────────────────────────────────────────
function GapAnalysis({ analysis, onProceed }: { analysis: { available: string[]; missing: string[] }; onProceed: () => void }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        Site Plan Data Assessment
      </p>

      {analysis.available.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600">Available</p>
          <div className="space-y-1">
            {analysis.available.map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <svg className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {item}
              </div>
            ))}
          </div>
        </div>
      )}

      {analysis.missing.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600">Missing / Estimated</p>
          <div className="space-y-1">
            {analysis.missing.map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-zinc-500">
                <span className="mt-0.5 h-3 w-3 shrink-0 text-center text-[10px] text-amber-500">○</span>
                {item}
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onProceed}
        className="w-full rounded-lg bg-zinc-900 py-2 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        Continue — ready to design
      </button>
    </div>
  );
}

// ── User message ────────────────────────────────────────────────────
function UserMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="ml-8">
      <div className="rounded-2xl rounded-tr-sm bg-zinc-900 px-4 py-3 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
        {msg.content.split("\n--- Attached:")[0]}
      </div>
    </div>
  );
}

// ── Assistant message ───────────────────────────────────────────────
function AssistantMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="prose prose-sm prose-zinc max-w-none dark:prose-invert prose-headings:text-sm prose-headings:font-semibold prose-p:leading-relaxed prose-li:leading-relaxed prose-code:rounded prose-code:bg-zinc-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-xs dark:prose-code:bg-zinc-800">
      <ReactMarkdown>{msg.content}</ReactMarkdown>
    </div>
  );
}
