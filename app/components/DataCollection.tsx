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
    { label: "Building footprint (OSM)", status: "pending" },
    { label: "Street imagery", status: "pending" },
    { label: "Assessor records", status: "pending" },
    { label: "Elevation data (USGS)", status: "pending" },
    { label: "Listing photos", status: "pending" },
  ]);

  useEffect(() => {
    const { latitude: lat, longitude: lon, address } = geocoded;

    const updateStep = (index: number, update: Partial<Step>) => {
      setSteps((prev) =>
        prev.map((s, i) => (i === index ? { ...s, ...update } : s))
      );
    };

    const results: Partial<CollectionResults> = { geocoded };

    // Run all 5 collectors in parallel
    const collectors = [
      async () => {
        updateStep(0, { status: "loading" });
        try {
          const r = await collectOsm(lat, lon);
          results.footprint = r.footprint;
          const pts = r.footprint?.length ?? 0;
          updateStep(0, {
            status: "done",
            detail: pts > 0 ? `${pts}-point polygon` : "No footprint found",
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
            detail: fields > 0 ? `${fields} fields` : "No data found",
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
    <div className="w-full max-w-2xl rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Collecting data for {geocoded.address}
      </h3>
      <div className="mb-2 text-xs text-zinc-400">
        {geocoded.latitude.toFixed(6)}, {geocoded.longitude.toFixed(6)}
      </div>
      <ul className="space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="flex items-center gap-3 text-sm">
            <StatusIcon status={step.status} />
            <span className={step.status === "error" ? "text-red-500" : ""}>
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
  );
}

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "pending":
      return <span className="h-4 w-4 rounded-full border-2 border-zinc-300 dark:border-zinc-600" />;
    case "loading":
      return (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      );
    case "done":
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-[10px] text-white">
          &#10003;
        </span>
      );
    case "error":
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">
          !
        </span>
      );
  }
}
