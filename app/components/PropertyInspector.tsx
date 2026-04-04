"use client";

import type { CollectionResults } from "@/app/lib/api";

interface PropertyInspectorProps {
  data: CollectionResults;
}

export default function PropertyInspector({ data }: PropertyInspectorProps) {
  const { assessor, footprint, elevation_m, streetImages, listingPhotos, geocoded, parcel } = data;

  const sections = [
    {
      title: "Location",
      fields: [
        { label: "Address", value: geocoded?.address },
        parcel?.apn ? { label: "APN", value: parcel.apn } : null,
        { label: "Latitude", value: geocoded?.latitude?.toFixed(6) },
        { label: "Longitude", value: geocoded?.longitude?.toFixed(6) },
        elevation_m != null ? { label: "Elevation", value: `${elevation_m}m` } : null,
      ].filter(Boolean) as { label: string; value: string | undefined }[],
    },
    {
      title: "Zoning & Land Use",
      fields: [
        parcel?.zoning ? { label: "Zoning District", value: parcel.zoning } : null,
        parcel?.landUse ? { label: "Land Use", value: parcel.landUse } : null,
        parcel?.neighborhood ? { label: "Neighborhood", value: parcel.neighborhood } : null,
        parcel?.parcelBoundary?.length ? { label: "Lot Lines", value: `${parcel.parcelBoundary.length}-point boundary` } : null,
      ].filter(Boolean) as { label: string; value: string }[],
    },
    // Extra fields from SB City ArcGIS (FEMA, fire, historic, etc.)
    ...(parcel?.extra && Object.values(parcel.extra).some((v) => v && v !== "-")
      ? [
          {
            title: "Hazards & Overlays",
            fields: [
              parcel.extra.femaFloodZone && parcel.extra.femaFloodZone !== "-"
                ? { label: "FEMA Flood Zone", value: parcel.extra.femaFloodZone }
                : null,
              parcel.extra.highFireHazard && parcel.extra.highFireHazard !== "-"
                ? { label: "High Fire Hazard", value: parcel.extra.highFireHazard }
                : null,
              parcel.extra.coastalZone && parcel.extra.coastalZone !== "-"
                ? { label: "Coastal Zone", value: parcel.extra.coastalZone }
                : null,
              parcel.extra.historicDistrict && parcel.extra.historicDistrict !== "-"
                ? { label: "Historic District", value: parcel.extra.historicDistrict }
                : null,
              parcel.extra.historicInventory && parcel.extra.historicInventory !== "-"
                ? { label: "Historic Inventory", value: parcel.extra.historicInventory }
                : null,
              parcel.extra.streetSetback && parcel.extra.streetSetback !== "-"
                ? { label: "Street Setback", value: parcel.extra.streetSetback }
                : null,
              parcel.extra.cbd && parcel.extra.cbd !== "-"
                ? { label: "CBD", value: parcel.extra.cbd }
                : null,
              parcel.extra.archMonitoring && parcel.extra.archMonitoring !== "-"
                ? { label: "Arch. Monitoring", value: parcel.extra.archMonitoring }
                : null,
            ].filter(Boolean) as { label: string; value: string }[],
          },
        ]
      : []),
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
        { label: "Satellite Views", value: String(data.satelliteImages?.length ?? 0) },
      ].filter(Boolean) as { label: string; value: string }[],
    },
  ];

  // Build permits list from parcel data
  const permits = parcel?.permits || [];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        {/* Footprint visualization */}
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

        {/* Permits section */}
        {permits.length > 0 && (
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Permits & Cases ({permits.length})
            </h3>
            <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              {permits.map((permit, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between px-4 py-2.5 ${
                    i > 0 ? "border-t border-zinc-100 dark:border-zinc-800" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {permit.category}
                    </span>
                    {permit.type && (
                      <span className="text-xs text-zinc-500">{permit.type}</span>
                    )}
                  </div>
                  <span className="text-xs font-mono text-zinc-600 dark:text-zinc-400">
                    {permit.number}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
