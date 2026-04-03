"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AddressInput from "@/app/components/AddressInput";
import DataCollection from "@/app/components/DataCollection";
import {
  type GeocodedAddress,
  type CollectionResults,
  geocodeAddress,
} from "@/app/lib/api";

type Phase = "input" | "geocoding" | "collecting" | "done";

export default function Home() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("input");
  const [geocoded, setGeocoded] = useState<GeocodedAddress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAddressSubmit = async (address: string) => {
    setError(null);
    setPhase("geocoding");

    try {
      const result = await geocodeAddress(address);
      setGeocoded(result);
      setPhase("collecting");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to geocode address");
      setPhase("input");
    }
  };

  const handleCollectionComplete = (results: CollectionResults) => {
    setPhase("done");
    // Store results and navigate to project workspace
    // For now, store in sessionStorage and navigate
    const projectId = crypto.randomUUID();
    sessionStorage.setItem(
      `vitruvius-project-${projectId}`,
      JSON.stringify(results)
    );
    router.push(`/project/${projectId}`);
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4">
      <div className="text-center">
        <h1 className="mb-2 text-4xl font-bold tracking-tight">Vitruvius</h1>
        <p className="text-lg text-zinc-500 dark:text-zinc-400">
          Vibe code your house — AI-powered building design and BIM generation
        </p>
      </div>

      <AddressInput
        onSubmit={handleAddressSubmit}
        disabled={phase !== "input"}
      />

      {phase === "geocoding" && (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          Geocoding address...
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {geocoded && (phase === "collecting" || phase === "done") && (
        <DataCollection
          geocoded={geocoded}
          onComplete={handleCollectionComplete}
        />
      )}
    </div>
  );
}
