"use client";

import type { CollectionResults } from "@/app/lib/api";

interface PropertyInspectorProps {
  data: CollectionResults;
}

export default function PropertyInspector({ data }: PropertyInspectorProps) {
  const { assessor, footprint, elevation_m, streetImages, listingPhotos } = data;

  return (
    <div className="h-48 shrink-0 overflow-y-auto border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Collected Property Data
      </h3>
      <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
        {assessor?.sqft && (
          <Field label="Area" value={`${assessor.sqft.toLocaleString()} sqft`} />
        )}
        {assessor?.lot_sqft && (
          <Field label="Lot" value={`${assessor.lot_sqft.toLocaleString()} sqft`} />
        )}
        {assessor?.bedrooms && (
          <Field label="Bedrooms" value={String(assessor.bedrooms)} />
        )}
        {assessor?.bathrooms && (
          <Field label="Bathrooms" value={String(assessor.bathrooms)} />
        )}
        {assessor?.year_built && (
          <Field label="Year Built" value={String(assessor.year_built)} />
        )}
        {assessor?.stories && (
          <Field label="Stories" value={String(assessor.stories)} />
        )}
        {elevation_m != null && (
          <Field label="Elevation" value={`${elevation_m}m`} />
        )}
        {footprint && (
          <Field label="Footprint" value={`${footprint.length} points`} />
        )}
        <Field
          label="Images"
          value={`${streetImages.length + listingPhotos.length} total`}
        />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
