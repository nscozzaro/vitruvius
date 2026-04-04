"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AddressInput from "@/app/components/AddressInput";
import { geocodeAddress } from "@/app/lib/api";

type Phase = "input" | "geocoding";

export default function Home() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("input");
  const [error, setError] = useState<string | null>(null);

  const handleAddressSubmit = async (address: string) => {
    setError(null);

    // Check localStorage cache first
    const cacheKey = `vitruvius-cache-${address.toLowerCase().trim()}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const { projectId } = JSON.parse(cached);
        router.push(`/project/${projectId}`);
        return;
      } catch {
        localStorage.removeItem(cacheKey);
      }
    }

    setPhase("geocoding");
    try {
      const geocoded = await geocodeAddress(address);

      // Navigate immediately with just geocoded data — collection happens on project page
      const projectId = crypto.randomUUID();
      const initialData = {
        geocoded,
        footprint: null,
        footprintOrigin: null,
        neighbors: [],
        elevation_m: null,
        streetImages: [],
        listingPhotos: [],
        satelliteImages: [],
        assessor: null,
        parcel: null,
        uploadedDocuments: [],
        _needsCollection: true,
      };

      sessionStorage.setItem(
        `vitruvius-project-${projectId}`,
        JSON.stringify(initialData)
      );

      router.push(`/project/${projectId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to geocode address");
      setPhase("input");
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      {/* Background grid */}
      <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(to_right,#f0f0f0_1px,transparent_1px),linear-gradient(to_bottom,#f0f0f0_1px,transparent_1px)] bg-[size:4rem_4rem] dark:bg-[linear-gradient(to_right,#111_1px,transparent_1px),linear-gradient(to_bottom,#111_1px,transparent_1px)]" />
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-white via-transparent to-white dark:from-zinc-950 dark:via-transparent dark:to-zinc-950" />

      <div className="relative z-10 flex flex-col items-center gap-8">
        <div className="text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white/80 px-3 py-1 text-xs font-medium text-zinc-600 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            AI-powered building design
          </div>
          <h1 className="mb-3 text-5xl font-bold tracking-tight sm:text-6xl">
            Vitruvius
          </h1>
          <p className="max-w-md text-lg text-zinc-500 dark:text-zinc-400">
            Enter any address to collect property data and generate a building
            model with AI.
          </p>
        </div>

        <AddressInput
          onSubmit={handleAddressSubmit}
          disabled={phase !== "input"}
        />

        {phase === "geocoding" && (
          <div className="flex items-center gap-2.5 text-sm text-zinc-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            Looking up address...
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}

        {phase === "input" && (
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            {[
              "Street imagery",
              "Building footprints",
              "Property records",
              "Elevation data",
              "AI design chat",
            ].map((feature) => (
              <span
                key={feature}
                className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500"
              >
                {feature}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
