"use client";

import { useRef, useState } from "react";
import AddressInput from "@/app/components/AddressInput";

type Step = { message: string; done: boolean };

type TractInfo = {
  book: string;
  page: string;
  endPage?: string;
  tractNumber?: string;
  mapType?: string;
};

type ResultState =
  | { status: "idle" }
  | { status: "running"; steps: Step[] }
  | {
      status: "done";
      tractInfo: TractInfo | null;
      assessorUrl: string | null;
      tractMapUrl: string | null;
      message?: string;
    }
  | { status: "error"; message: string };

export default function Home() {
  const [state, setState] = useState<ResultState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = async (address: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ status: "running", steps: [] });

    try {
      const resp = await fetch("/api/tract-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
        signal: ctrl.signal,
      });

      if (!resp.ok || !resp.body) {
        setState({ status: "error", message: `Server error: ${resp.status}` });
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const steps: Step[] = [];

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
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "step") {
            steps.push({ message: String(event.message), done: false });
            if (steps.length > 1) steps[steps.length - 2].done = true;
            setState({ status: "running", steps: [...steps] });
          } else if (event.type === "result") {
            if (steps.length > 0) steps[steps.length - 1].done = true;
            setState({
              status: "done",
              tractInfo: (event.tractInfo as TractInfo) ?? null,
              assessorUrl: event.assessorUrl ? String(event.assessorUrl) : null,
              tractMapUrl: event.tractMapUrl ? String(event.tractMapUrl) : null,
              message: event.message ? String(event.message) : undefined,
            });
          } else if (event.type === "error") {
            setState({ status: "error", message: String(event.message) });
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Request failed",
      });
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* Background */}
      <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(to_right,#f0f0f0_1px,transparent_1px),linear-gradient(to_bottom,#f0f0f0_1px,transparent_1px)] bg-[size:4rem_4rem] dark:bg-[linear-gradient(to_right,#111_1px,transparent_1px),linear-gradient(to_bottom,#111_1px,transparent_1px)]" />
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-white via-transparent to-white dark:from-zinc-950 dark:via-transparent dark:to-zinc-950" />

      <div className="relative z-10 flex flex-1 flex-col items-center px-4 py-16">
        <div className="flex w-full max-w-3xl flex-col items-center gap-8">
          {/* Header */}
          <div className="text-center">
            <h1 className="mb-2 text-4xl font-bold tracking-tight sm:text-5xl">
              Tract Map Finder
            </h1>
            <p className="text-base text-zinc-500 dark:text-zinc-400">
              Enter a Santa Barbara County address to find its official recorded
              maps.
            </p>
          </div>

          {/* Search */}
          <div className="w-full max-w-xl">
            <AddressInput
              onSubmit={handleSubmit}
              disabled={state.status === "running"}
            />
          </div>

          {/* Progress */}
          {state.status === "running" && (
            <div className="w-full max-w-xl rounded-xl border border-zinc-200 bg-white/80 p-4 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/80">
              <ul className="space-y-2">
                {state.steps.map((step, i) => (
                  <li key={i} className="flex items-center gap-3 text-sm">
                    {step.done ? (
                      <svg
                        className="h-4 w-4 shrink-0 text-green-500"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                    )}
                    <span
                      className={
                        step.done
                          ? "text-zinc-400"
                          : "text-zinc-700 dark:text-zinc-200"
                      }
                    >
                      {step.message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Results: thumbnail cards */}
          {state.status === "done" && (
            <>
              {state.message && (
                <div className="w-full max-w-xl rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300">
                  {state.message}
                </div>
              )}

              {state.tractInfo && (
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  {state.tractInfo.mapType ?? "Tract Map"}
                  {state.tractInfo.tractNumber &&
                    ` ${state.tractInfo.tractNumber}`}
                  {state.tractInfo.endPage
                    ? ` — Book ${state.tractInfo.book}, Pages ${state.tractInfo.page}–${state.tractInfo.endPage}`
                    : ` — Book ${state.tractInfo.book}, Page ${state.tractInfo.page}`}
                </p>
              )}

              <div className="grid w-full gap-6 sm:grid-cols-2">
                {state.assessorUrl && (
                  <MapCard
                    title="Assessor Parcel Map"
                    description="County assessor's tax map showing parcel boundaries and APN numbers"
                    pdfUrl={state.assessorUrl}
                    icon="parcel"
                  />
                )}
                {state.tractMapUrl && (
                  <MapCard
                    title="Recorded Subdivision Map"
                    description="Original survey with lot dimensions, bearings, and easements"
                    pdfUrl={state.tractMapUrl}
                    icon="survey"
                  />
                )}
              </div>
            </>
          )}

          {/* Error */}
          {state.status === "error" && (
            <div className="w-full max-w-xl rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-400">
              {state.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MapCard({
  title,
  description,
  pdfUrl,
  icon,
}: {
  title: string;
  description: string;
  pdfUrl: string;
  icon: "parcel" | "survey";
}) {
  return (
    <a
      href={pdfUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white transition-all hover:border-zinc-400 hover:shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-500"
    >
      <div className="relative flex h-48 items-center justify-center bg-zinc-50 dark:bg-zinc-800">
        {icon === "parcel" ? (
          <svg
            className="h-16 w-16 text-zinc-300 dark:text-zinc-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={0.75}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
            />
          </svg>
        ) : (
          <svg
            className="h-16 w-16 text-zinc-300 dark:text-zinc-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={0.75}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/5 dark:group-hover:bg-white/5">
          <span className="flex items-center gap-1.5 rounded-full bg-white/90 px-4 py-2 text-sm font-medium text-zinc-800 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 dark:bg-zinc-700/90 dark:text-zinc-200">
            Open PDF
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </span>
        </div>
      </div>
      <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </h3>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {description}
        </p>
      </div>
    </a>
  );
}
