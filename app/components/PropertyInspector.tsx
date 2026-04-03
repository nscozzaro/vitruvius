"use client";

import type { CollectionResults } from "@/app/lib/api";

interface PropertyInspectorProps {
  data: CollectionResults;
}

export default function PropertyInspector({ data }: PropertyInspectorProps) {
  const { assessor, footprint, elevation_m, streetImages, listingPhotos, geocoded } = data;

  const sections = [
    {
      title: "Location",
      fields: [
        { label: "Address", value: geocoded?.address },
        { label: "Latitude", value: geocoded?.latitude?.toFixed(6) },
        { label: "Longitude", value: geocoded?.longitude?.toFixed(6) },
        elevation_m != null ? { label: "Elevation", value: `${elevation_m}m` } : null,
      ].filter(Boolean) as { label: string; value: string | undefined }[],
    },
    {
      title: "Building",
      fields: [
        assessor?.sqft ? { label: "Living Area", value: `${assessor.sqft.toLocaleString()} sqft` } : null,
        assessor?.lot_sqft ? { label: "Lot Size", value: `${assessor.lot_sqft.toLocaleString()} sqft` } : null,
        assessor?.bedrooms ? { label: "Bedrooms", value: String(assessor.bedrooms) } : null,
        assessor?.bathrooms ? { label: "Bathrooms", value: String(assessor.bathrooms) } : null,
        assessor?.stories ? { label: "Stories", value: String(assessor.stories) } : null,
        assessor?.year_built ? { label: "Year Built", value: String(assessor.year_built) } : null,
      ].filter(Boolean) as { label: string; value: string }[],
    },
    {
      title: "Materials",
      fields: [
        assessor?.roof_type ? { label: "Roof", value: assessor.roof_type } : null,
        assessor?.exterior_material ? { label: "Exterior", value: assessor.exterior_material } : null,
      ].filter(Boolean) as { label: string; value: string }[],
    },
    {
      title: "Collected Data",
      fields: [
        footprint ? { label: "Footprint", value: `${footprint.length}-point polygon` } : null,
        { label: "Street Images", value: String(streetImages.length) },
        { label: "Listing Photos", value: String(listingPhotos.length) },
      ].filter(Boolean) as { label: string; value: string }[],
    },
  ];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        {sections.map((section) => {
          if (section.fields.length === 0) return null;
          return (
            <div key={section.title}>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {section.title}
              </h3>
              <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                {section.fields.map((field, i) => (
                  <div
                    key={field.label}
                    className={`flex items-center justify-between px-4 py-3 ${
                      i > 0 ? "border-t border-zinc-100 dark:border-zinc-800" : ""
                    }`}
                  >
                    <span className="text-sm text-zinc-500">{field.label}</span>
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {field.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
