"use client";

import { useState } from "react";
import type { CollectedImage } from "@/app/lib/api";

interface ImageGalleryProps {
  streetImages: CollectedImage[];
  listingPhotos: CollectedImage[];
}

export default function ImageGallery({ streetImages, listingPhotos }: ImageGalleryProps) {
  const [filter, setFilter] = useState<"all" | "street" | "listing">("all");
  const [selectedImage, setSelectedImage] = useState<CollectedImage | null>(null);

  const images =
    filter === "street"
      ? streetImages
      : filter === "listing"
      ? listingPhotos
      : [...streetImages, ...listingPhotos];

  if (images.length === 0 && streetImages.length === 0 && listingPhotos.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-400">
        <div className="text-center">
          <svg className="mx-auto mb-3 h-10 w-10 text-zinc-300 dark:text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
          </svg>
          <p className="text-sm">No images collected</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar */}
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        {(
          [
            { id: "all" as const, label: "All", count: streetImages.length + listingPhotos.length },
            { id: "street" as const, label: "Street View", count: streetImages.length },
            { id: "listing" as const, label: "Listing", count: listingPhotos.length },
          ] as const
        ).map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === f.id
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            {f.label} ({f.count})
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
          {images.map((img, i) => (
            <button
              key={i}
              onClick={() => setSelectedImage(img)}
              className="group relative aspect-[4/3] overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.description || `Image ${i + 1}`}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              <div className="absolute bottom-0 left-0 right-0 p-2 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="text-xs font-medium text-white">
                  {img.source === "google_street_view"
                    ? "Google Street View"
                    : img.source === "mapillary"
                    ? "Mapillary"
                    : img.source}
                </span>
                {img.description && (
                  <p className="mt-0.5 truncate text-[10px] text-white/70">
                    {img.description}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Lightbox */}
      {selectedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setSelectedImage(null)}
        >
          <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setSelectedImage(null)}
              className="absolute -right-3 -top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white text-zinc-900 shadow-lg transition-colors hover:bg-zinc-100"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={selectedImage.url}
              alt={selectedImage.description || "Image"}
              className="max-h-[85vh] rounded-lg object-contain"
            />
            {selectedImage.description && (
              <div className="mt-2 text-center text-sm text-white/80">
                {selectedImage.description}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
