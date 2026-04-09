"use client";

import { Suspense, useCallback, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import SurveyViewer from "@/app/components/SurveyViewer";
import AgentTimeline, { type TimelineStep } from "@/app/components/AgentTimeline";
import LayerControls, { type LayerVisibility } from "@/app/components/LayerControls";
import type {
  SurveyElement,
  ExtractionPlanItem,
  MonumentLegendEntry,
  InitResult,
} from "@/app/lib/reconstruction-agent";
import type { CoordSystem } from "@/app/lib/coord-system";
import type { Point } from "@/app/lib/cogo";

export default function ReconstructPageWrapper() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center text-zinc-400">Loading…</div>}>
      <ReconstructPageInner />
    </Suspense>
  );
}

type SessionState =
  | { phase: "idle" }
  | { phase: "initializing"; messages: string[] }
  | { phase: "ready"; data: InitData }
  | { phase: "running"; data: InitData; stepIndex: number }
  | { phase: "paused"; data: InitData; stepIndex: number }
  | { phase: "complete"; data: InitData }
  | { phase: "error"; message: string };

interface InitData {
  coordSystem: CoordSystem;
  pages: Array<{ pageIndex: number; pageNumber: number; imageUrl: string; width: number; height: number }>;
  monumentLegend: MonumentLegendEntry[];
  extractionPlan: ExtractionPlanItem[];
  pageKey: string;
}

function ReconstructPageInner() {
  const searchParams = useSearchParams();
  const book = searchParams.get("book") ?? "";
  const page = searchParams.get("page") ?? "";
  const endPage = searchParams.get("endPage") ?? undefined;
  const targetLot = searchParams.get("lot") ?? "5";

  const [session, setSession] = useState<SessionState>({ phase: "idle" });
  const [elements, setElements] = useState<SurveyElement[]>([]);
  const [svgFragments, setSvgFragments] = useState<Array<{ layerType: string; svg: string }>>([]);
  const [qualityHalos, setQualityHalos] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [timelineSteps, setTimelineSteps] = useState<TimelineStep[]>([]);
  const [activeElementId, setActiveElementId] = useState<string | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point>({ x: 0, y: 0 });
  const [currentBearing, setCurrentBearing] = useState<number | null>(null);
  const [lastOverlap, setLastOverlap] = useState<number | null>(null);

  const [layers, setLayers] = useState<LayerVisibility>({
    lot_boundary: true,
    monument: true,
    easement: true,
    road_centerline: true,
    label: true,
    quality: true,
  });
  const [opacity, setOpacity] = useState(80);

  const pauseRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // ─── Init ────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!book || !page) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setSession({ phase: "initializing", messages: [] });
    setElements([]);
    setSvgFragments([]);
    setQualityHalos([]);
    setLabels([]);
    setTimelineSteps([]);
    pauseRef.current = false;

    try {
      const resp = await fetch("/api/reconstruct/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book, page, endPage, targetLot }),
        signal: ctrl.signal,
      });

      if (!resp.ok || !resp.body) {
        setSession({ phase: "error", message: `Init failed: ${resp.status}` });
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const msgs: string[] = [];
      let initResult: InitResult | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const chunk of lines) {
          const line = chunk.replace(/^data: /, "").trim();
          if (!line) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line); } catch { continue; }

          if (event.type === "step") {
            msgs.push(String(event.message));
            setSession({ phase: "initializing", messages: [...msgs] });
          } else if (event.type === "result") {
            initResult = event as unknown as InitResult;
          } else if (event.type === "error") {
            setSession({ phase: "error", message: String(event.message) });
            return;
          }
        }
      }

      if (!initResult) {
        setSession({ phase: "error", message: "Init returned no result" });
        return;
      }

      // Determine the working page key (skip title page)
      const mapPageNum = initResult.pages.length > 1
        ? initResult.pages[1].pageNumber
        : initResult.pages[0].pageNumber;
      const pageKey = `bk${book}-pg${mapPageNum}`;

      const data: InitData = {
        coordSystem: initResult.coordSystem,
        pages: initResult.pages,
        monumentLegend: initResult.monumentLegend,
        extractionPlan: initResult.extractionPlan,
        pageKey,
      };

      // Build timeline steps from plan
      const steps: TimelineStep[] = initResult.extractionPlan.map((item) => ({
        planItem: item,
        status: "pending" as const,
      }));
      setTimelineSteps(steps);

      setSession({ phase: "ready", data });

      // Auto-start extraction
      await runExtraction(data, steps, { x: 0, y: 0 }, null, null, ctrl);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setSession({ phase: "error", message: (err as Error).message });
    }
  }, [book, page, endPage, targetLot]);

  const [haltReason, setHaltReason] = useState<string | null>(null);

  // ─── Extraction loop (with quality gates) ───────────────
  const runExtraction = useCallback(
    async (
      data: InitData,
      steps: TimelineStep[],
      startPoint: Point,
      startBearing: number | null,
      startOverlap: number | null,
      ctrl: AbortController,
    ) => {
      let point = startPoint;
      let bearing = startBearing;
      let overlap = startOverlap;
      let consecutiveLow = 0;

      for (let i = 0; i < data.extractionPlan.length; i++) {
        if (ctrl.signal.aborted || pauseRef.current) {
          setSession({ phase: "paused", data, stepIndex: i });
          return;
        }

        const planItem = data.extractionPlan[i];

        // Mark active
        const updatedSteps = [...steps];
        updatedSteps[i] = { ...updatedSteps[i], status: "active" };
        setTimelineSteps([...updatedSteps]);
        setSession({ phase: "running", data, stepIndex: i });

        try {
          const resp = await fetch("/api/reconstruct/step", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pageKey: data.pageKey,
              coordSystem: data.coordSystem,
              currentPoint: point,
              currentBearing: bearing,
              planItem,
              previousOverlapScore: overlap,
              monumentLegend: data.monumentLegend,
              consecutiveLowCount: consecutiveLow,
            }),
            signal: ctrl.signal,
          });

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: "Step failed" }));
            updatedSteps[i] = { ...updatedSteps[i], status: "error" };
            setTimelineSteps([...updatedSteps]);
            consecutiveLow++;
            continue;
          }

          const result = await resp.json();

          // Update state
          const newElement: SurveyElement = result.element;
          setElements((prev) => [...prev, newElement]);
          setSvgFragments((prev) => [
            ...prev,
            { layerType: newElement.elementType, svg: result.svgFragment },
          ]);
          setQualityHalos((prev) => [...prev, result.qualityHalo]);
          if (result.label) setLabels((prev) => [...prev, result.label]);
          setActiveElementId(newElement.id);

          point = result.nextPoint;
          bearing = result.nextBearing;

          if (result.calibratedCoordSystem) {
            data.coordSystem = result.calibratedCoordSystem;
          }
          overlap = result.overlapScore;
          setCurrentPoint(point);
          setCurrentBearing(bearing);
          setLastOverlap(overlap);

          // Track consecutive low-quality elements
          if ((overlap ?? 0) < 0.2) {
            consecutiveLow++;
          } else {
            consecutiveLow = 0;
          }

          updatedSteps[i] = {
            ...updatedSteps[i],
            element: newElement,
            status: "done",
            cropThumbnail: result.cropThumbnail,
          };
          steps = updatedSteps;
          setTimelineSteps([...updatedSteps]);

          // ─── Quality gates: auto-pause on bad placement ──
          if (result.anchorFailed) {
            const correction = result.suggestedAnchorCorrection
              ? ` Suggested offset: (${result.suggestedAnchorCorrection.dx}, ${result.suggestedAnchorCorrection.dy})px.`
              : "";
            setHaltReason(
              `Anchor placement appears incorrect — first element has ${((overlap ?? 0) * 100).toFixed(0)}% alignment.${correction} The extraction has been paused to prevent placing incorrect elements.`,
            );
            pauseRef.current = true;
            setSession({ phase: "paused", data, stepIndex: i + 1 });
            return;
          }

          if (result.haltRecommended) {
            setHaltReason(
              `${consecutiveLow} consecutive elements with poor alignment (< 20%). The coordinate system may be off. Extraction paused.`,
            );
            pauseRef.current = true;
            setSession({ phase: "paused", data, stepIndex: i + 1 });
            return;
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          updatedSteps[i] = { ...updatedSteps[i], status: "error" };
          setTimelineSteps([...updatedSteps]);
          consecutiveLow++;
        }
      }

      setSession({ phase: "complete", data });
      setActiveElementId(null);
    },
    [],
  );

  // ─── Controls ────────────────────────────────────────────
  const handlePause = useCallback(() => {
    pauseRef.current = true;
  }, []);

  const handleResume = useCallback(() => {
    if (session.phase !== "paused") return;
    pauseRef.current = false;
    setHaltReason(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const steps = [...timelineSteps];
    runExtraction(
      session.data,
      steps,
      currentPoint,
      currentBearing,
      lastOverlap,
      ctrl,
    );
  }, [session, timelineSteps, currentPoint, currentBearing, lastOverlap, runExtraction]);

  const handleExport = useCallback(async () => {
    if (elements.length === 0) return;
    const sessionData = session.phase === "complete" || session.phase === "paused" || session.phase === "running"
      ? (session as { data: InitData }).data
      : null;
    if (!sessionData) return;

    const resp = await fetch("/api/reconstruct/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        elements,
        coordSystem: sessionData.coordSystem,
        metadata: { tractNumber: searchParams.get("tract"), lotNumber: targetLot, county: "Santa Barbara", state: "California" },
      }),
    });

    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `survey-tract-${searchParams.get("tract") ?? book}-lot${targetLot}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }, [elements, session, targetLot, book, searchParams]);

  // Determine the map image to display
  const mapImage = (() => {
    if (session.phase === "idle" || session.phase === "error") return null;
    if (session.phase === "initializing") return null;
    const data = (session as { data?: InitData }).data;
    if (!data) return null;
    // Use second page (map sheet) if available, else first
    return data.pages.length > 1 ? data.pages[1] : data.pages[0];
  })();

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-zinc-950">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <a
            href="/"
            className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            &larr; Back
          </a>
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Survey Reconstruction — Lot {targetLot}
          </h1>
          {book && page && (
            <span className="text-xs text-zinc-400">
              Book {book}, Page {page}{endPage ? `–${endPage}` : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {session.phase === "idle" && (
            <button
              onClick={handleStart}
              disabled={!book || !page}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Start Reconstruction
            </button>
          )}
          {session.phase === "running" && (
            <button
              onClick={handlePause}
              className="rounded-lg border border-zinc-300 px-4 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Pause
            </button>
          )}
          {session.phase === "paused" && (
            <button
              onClick={handleResume}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              Resume
            </button>
          )}
          {elements.length > 0 && (
            <button
              onClick={handleExport}
              className="rounded-lg border border-green-300 bg-green-50 px-4 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300"
            >
              Export LandXML
            </button>
          )}
        </div>
      </div>

      {/* Main content: viewer + sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Map viewer — takes remaining space, never pushes sidebar */}
        <div className="min-w-0 flex-1">
          {mapImage ? (
            <SurveyViewer
              imageUrl={mapImage.imageUrl}
              imageWidth={mapImage.width}
              imageHeight={mapImage.height}
              svgFragments={svgFragments}
              qualityHalos={qualityHalos}
              labels={labels}
              layers={layers}
              svgOpacity={opacity}
              activeElementId={activeElementId}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-400">
              {session.phase === "idle" ? (
                <div className="text-center">
                  <p className="text-lg font-medium">Ready to reconstruct</p>
                  <p className="mt-1 text-sm">Click &quot;Start Reconstruction&quot; to begin</p>
                </div>
              ) : session.phase === "initializing" ? (
                <div className="flex items-center gap-3">
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                  <span>Initializing session…</span>
                </div>
              ) : session.phase === "error" ? (
                <div className="text-center text-red-500">
                  <p className="font-medium">Error</p>
                  <p className="mt-1 text-sm">{(session as { message: string }).message}</p>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Sidebar (25%) */}
        <div className="flex w-72 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <AgentTimeline
            steps={timelineSteps}
            initMessages={
              session.phase === "initializing"
                ? (session as { messages: string[] }).messages
                : session.phase !== "idle" && session.phase !== "error"
                  ? ["Session initialized"]
                  : []
            }
            initDone={session.phase !== "initializing" && session.phase !== "idle"}
          />
          <LayerControls
            layers={layers}
            onToggle={(key) => setLayers((prev) => ({ ...prev, [key]: !prev[key] }))}
            opacity={opacity}
            onOpacityChange={setOpacity}
          />

          {/* Quality gate halt banner */}
          {haltReason && (
            <div className="border-t border-red-300 bg-red-50 px-3 py-2 dark:border-red-800 dark:bg-red-900/30">
              <p className="text-[11px] font-medium text-red-700 dark:text-red-300">
                Extraction Paused
              </p>
              <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
                {haltReason}
              </p>
            </div>
          )}

          {/* Stats footer */}
          {elements.length > 0 && (
            <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-700">
              <div className="flex justify-between text-[10px] text-zinc-400">
                <span>Elements: {elements.length}</span>
                <span>
                  Avg overlap:{" "}
                  {(
                    elements.reduce((s, e) => s + e.overlapScore, 0) / elements.length
                  ).toFixed(0)}
                  %
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
