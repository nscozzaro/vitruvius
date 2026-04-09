"use client";

import type { SurveyElement, ExtractionPlanItem } from "@/app/lib/reconstruction-agent";

interface TimelineStep {
  planItem: ExtractionPlanItem;
  element?: SurveyElement;
  status: "pending" | "active" | "done" | "error";
  /** Thumbnail of what the model was shown */
  cropThumbnail?: string;
}

interface AgentTimelineProps {
  steps: TimelineStep[];
  initMessages: string[];
  initDone: boolean;
  onStepClick?: (index: number) => void;
}

function overlapBadge(score: number) {
  const pct = Math.round(score * 100);
  let colorClass: string;
  if (score >= 0.65) colorClass = "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
  else if (score >= 0.4) colorClass = "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400";
  else colorClass = "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";

  return (
    <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${colorClass}`}>
      {pct}%
    </span>
  );
}

function typeIcon(type: string) {
  switch (type) {
    case "monument":
      return (
        <svg className="h-3.5 w-3.5 text-red-500" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="8" r="5" />
        </svg>
      );
    case "curve":
      return (
        <svg className="h-3.5 w-3.5 text-blue-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 13 Q8 3 13 13" />
        </svg>
      );
    default:
      return (
        <svg className="h-3.5 w-3.5 text-blue-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="13" x2="13" y2="3" />
        </svg>
      );
  }
}

export default function AgentTimeline({
  steps,
  initMessages,
  initDone,
  onStepClick,
}: AgentTimelineProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <h3 className="border-b border-zinc-200 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        Agent Steps
      </h3>

      <div className="flex-1 overflow-y-auto">
        {/* Init phase */}
        <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <p className="text-[10px] font-semibold uppercase text-zinc-400">Initialization</p>
          <ul className="mt-1 space-y-1">
            {initMessages.map((msg, i) => (
              <li key={i} className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                {initDone || i < initMessages.length - 1 ? (
                  <svg className="h-3 w-3 shrink-0 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-blue-500 border-t-transparent" />
                )}
                <span className="truncate">{msg}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Extraction steps */}
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {steps.map((step, i) => (
            <li
              key={i}
              className={`cursor-pointer px-3 py-2 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50 ${
                step.status === "active" ? "bg-blue-50/50 dark:bg-blue-900/10" : ""
              }`}
              onClick={() => onStepClick?.(i)}
            >
              {/* Header row: status + description + overlap */}
              <div className="flex items-center gap-2 text-xs">
                {step.status === "done" ? (
                  <svg className="h-3.5 w-3.5 shrink-0 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                ) : step.status === "active" ? (
                  <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                ) : step.status === "error" ? (
                  <svg className="h-3.5 w-3.5 shrink-0 text-red-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-zinc-300 dark:border-zinc-600" />
                )}
                {typeIcon(step.planItem.type)}
                <span className={`flex-1 truncate ${
                  step.status === "pending" ? "text-zinc-400 dark:text-zinc-500" : "text-zinc-700 dark:text-zinc-200"
                }`}>
                  {step.planItem.description}
                </span>
                {step.element && overlapBadge(step.element.overlapScore)}
              </div>

              {/* Thumbnail + extracted data (shown for active/done steps) */}
              {(step.status === "active" || step.status === "done") && (step.cropThumbnail || step.element) && (
                <div className="mt-1.5 flex gap-2 pl-5">
                  {/* Crop thumbnail — what the model saw */}
                  {step.cropThumbnail && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={step.cropThumbnail}
                      alt="Model input crop"
                      className="h-14 w-14 shrink-0 rounded border border-zinc-300 object-cover dark:border-zinc-600"
                    />
                  )}
                  {/* Extracted data */}
                  {step.element && (step.element.bearing || step.element.distance || step.element.radius) && (
                    <div className="text-[10px] leading-tight text-zinc-400">
                      {step.element.bearing && <div>Bearing: <span className="text-zinc-300">{step.element.bearing}</span></div>}
                      {step.element.distance && <div>Distance: <span className="text-zinc-300">{step.element.distance.toFixed(2)} ft</span></div>}
                      {step.element.radius && <div>Radius: <span className="text-zinc-300">{step.element.radius.toFixed(2)} ft</span></div>}
                      {step.element.monument && <div>Type: <span className="text-zinc-300">{step.element.monument.shape}</span></div>}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export type { TimelineStep };
