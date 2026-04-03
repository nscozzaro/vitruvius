"use client";

import { useEffect, useState } from "react";
import {
  type CollectionResults,
  type GeocodedAddress,
  collectOsm,
  collectStreet,
  collectAssessor,
  collectElevation,
  collectPhotos,
} from "@/app/lib/api";

type StepStatus = "pending" | "loading" | "done" | "error";

interface Step {
  label: string;
  status: StepStatus;
  detail?: string;
}

interface DataCollectionProps {
  geocoded: GeocodedAddress;
  onComplete: (results: CollectionResults) => void;
}

export default function DataCollection({ geocoded, onComplete }: DataCollectionProps) {
  const [steps, setSteps] = useState<Step[]>([
    { label: "Building footprint", status: "pending" },
    { label: "Street imagery", status: "pending" },
    { label: "Property records", status: "pending" },
    { label: "Elevation data", status: "pending" },
    { label: "Listing photos", status: "pending" },
  ]);

  const doneCount = steps.filter((s) => s.status === "done" || s.status === "error").length;
  const progress = (doneCount / steps.length) * 100;

  useEffect(() => {
    const { latitude: lat, longitude: lon, address } = geocoded;

    const updateStep = (index: number, update: Partial<Step>) => {
      setSteps((prev) =>
        prev.map((s, i) => (i === index ? { ...s, ...update } : s))
      );
    };

    const results: Partial<CollectionResults> = { geocoded };

    const collectors = [
      async () => {
        updateStep(0, { status: "loading" });
        try {
          const r = await collectOsm(lat, lon);
          results.footprint = r.footprint;
          const pts = r.footprint?.length ?? 0;
          updateStep(0, {
            status: "done",
            detail: pts > 0 ? `${pts}-point polygon` : "Not found",
          });
        } catch {
          updateStep(0, { status: "error", detail: "Failed" });
          results.footprint = null;
        }
      },
      async () => {
        updateStep(1, { status: "loading" });
        try {
          const r = await collectStreet(lat, lon);
          results.streetImages = r.images;
          updateStep(1, {
            status: "done",
            detail: `${r.images.length} images`,
          });
        } catch {
          updateStep(1, { status: "error", detail: "Failed" });
          results.streetImages = [];
        }
      },
      async () => {
        updateStep(2, { status: "loading" });
        try {
          const r = await collectAssessor(address, lat, lon);
          results.assessor = r.data;
          const fields = r.data
            ? Object.values(r.data).filter((v) => v != null).length
            : 0;
          updateStep(2, {
            status: "done",
            detail: fields > 0 ? `${fields} fields` : "No data",
          });
        } catch {
          updateStep(2, { status: "error", detail: "Failed" });
          results.assessor = null;
        }
      },
      async () => {
        updateStep(3, { status: "loading" });
        try {
          const r = await collectElevation(lat, lon);
          results.elevation_m = r.elevation_m;
          updateStep(3, {
            status: "done",
            detail:
              r.elevation_m != null ? `${r.elevation_m}m` : "Not available",
          });
        } catch {
          updateStep(3, { status: "error", detail: "Failed" });
          results.elevation_m = null;
        }
      },
      async () => {
        updateStep(4, { status: "loading" });
        try {
          const r = await collectPhotos(address);
          results.listingPhotos = r.images;
          updateStep(4, {
            status: "done",
            detail: `${r.images.length} photos`,
          });
        } catch {
          updateStep(4, { status: "error", detail: "Failed" });
          results.listingPhotos = [];
        }
      },
    ];

    Promise.allSettled(collectors.map((fn) => fn())).then(() => {
      onComplete(results as CollectionResults);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geocoded]);

  return (
    <div className="w-full max-w-xl">
      <div className="rounded-2xl border border-zinc-200 bg-white/80 p-6 shadow-sm backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Collecting data
          </h3>
          <span className="text-xs tabular-nums text-zinc-400">
            {doneCount}/{steps.length}
          </span>
        </div>

        {/* Progress bar */}
        <div className="mb-5 h-1 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        <ul className="space-y-3">
          {steps.map((step, i) => (
            <li key={i} className="flex items-center gap-3 text-sm">
              <StatusIcon status={step.status} />
              <span
                className={
                  step.status === "error"
                    ? "text-red-500"
                    : step.status === "done"
                    ? "text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500"
                }
              >
                {step.label}
              </span>
              {step.detail && (
                <span className="ml-auto text-xs text-zinc-400">
                  {step.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "pending":
      return (
        <span className="h-4 w-4 rounded-full border-2 border-zinc-200 dark:border-zinc-700" />
      );
    case "loading":
      return (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      );
    case "done":
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white">
          <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </span>
      );
    case "error":
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
          !
        </span>
      );
  }
}
