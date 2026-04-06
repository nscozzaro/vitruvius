import { NextRequest } from "next/server";
import { geocode, getAPN, apnToAssessorMapUrl, fetchPdf } from "@/app/lib/parcels";
import { searchRecorder } from "@/app/lib/recorder";
import { findTracts, findNearby, recordTypeLabel } from "@/app/lib/tract-lookup";
import {
  ensureStored,
  assessorStoragePath,
  surveyorStoragePath,
} from "@/app/lib/storage";

/**
 * POST /api/tract-map
 *
 * Pipeline: address → geocode → spatial lookup (GeoJSON index) →
 *           book/page → download from surveyor → store in Supabase Storage
 *
 * The spatial index covers 11,628 recorded maps: Tract Maps, Records of
 * Survey, and Condo Maps. Returns stable Supabase CDN URLs.
 */

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const { address } = await request.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        // Step 1: Geocode
        send({ type: "step", message: "Geocoding address…" });
        const { lat, lon } = await geocode(address);
        send({ type: "step", message: `Found location (${lat.toFixed(4)}, ${lon.toFixed(4)})` });

        // Step 2: APN (for assessor map)
        send({ type: "step", message: "Looking up parcel…" });
        const apn = await getAPN(lat, lon);
        if (!apn) {
          send({ type: "error", message: "Could not find a Santa Barbara County parcel at this address. This tool only works for SB County properties." });
          return;
        }
        send({ type: "step", message: `Found parcel APN: ${apn}` });

        // Step 3: Spatial lookup — find recorded maps that contain this point
        send({ type: "step", message: "Looking up recorded maps…" });
        const tracts = findTracts(lat, lon);

        // Pick the best match (sorted: tracts first, then condos, then surveys)
        const tract = tracts.length > 0 ? tracts[0] : null;

        if (tract) {
          const endPage = tract.sheets && tract.sheets > 1
            ? String(tract.page + tract.sheets - 1)
            : undefined;
          const pageLabel = endPage
            ? `Pages ${tract.page}–${endPage}`
            : `Page ${tract.page}`;
          const label = recordTypeLabel(tract.recordType);
          const projLabel = tract.projectNo ? ` ${tract.projectNo}` : "";
          send({ type: "step", message: `Found: ${label}${projLabel} — Book ${tract.book}, ${pageLabel}` });

          // Step 4: Download assessor map + recorded map in parallel
          send({ type: "step", message: "Downloading maps…" });

          const assessorPath = assessorStoragePath(apn);
          const surveyorPath = surveyorStoragePath(
            tract.book,
            String(tract.page),
            endPage,
          );

          const [assessorStorageUrl, tractMapUrl] = await Promise.all([
            ensureStored(assessorPath, () => fetchPdf(apnToAssessorMapUrl(apn))),
            ensureStored(surveyorPath, () =>
              searchRecorder(tract.book, String(tract.page), endPage),
            ),
          ]);

          const tractInfo = {
            book: tract.book,
            page: String(tract.page),
            endPage,
            tractNumber: tract.projectNo ? String(tract.projectNo) : undefined,
            mapType: label,
          };

          if (tractMapUrl) {
            send({
              type: "result",
              tractInfo,
              assessorUrl: assessorStorageUrl,
              tractMapUrl,
            });
          } else {
            send({
              type: "result",
              tractInfo,
              assessorUrl: assessorStorageUrl,
              tractMapUrl: null,
              message: `Found the ${label.toLowerCase()} reference but could not download it from the county surveyor.`,
            });
          }
        } else {
          // No direct spatial match — try nearby maps as candidates
          send({ type: "step", message: "Searching nearby recorded maps…" });
          const nearby = findNearby(lat, lon, 5);

          // Download assessor map
          const assessorPath = assessorStoragePath(apn);
          const assessorStorageUrl = await ensureStored(assessorPath, () =>
            fetchPdf(apnToAssessorMapUrl(apn)),
          );

          if (nearby.length > 0) {
            // Pick the closest as the primary result, include others as candidates
            const best = nearby[0];
            const endPage = best.sheets && best.sheets > 1
              ? String(best.page + best.sheets - 1)
              : undefined;
            const label = recordTypeLabel(best.recordType);

            send({ type: "step", message: `Nearest: ${label} — Book ${best.book}, Page ${best.page} (${best.distanceMeters}m away)` });
            send({ type: "step", message: "Downloading maps…" });

            const surveyorPath = surveyorStoragePath(
              best.book, String(best.page), endPage,
            );
            const tractMapUrl = await ensureStored(surveyorPath, () =>
              searchRecorder(best.book, String(best.page), endPage),
            );

            const tractInfo = {
              book: best.book,
              page: String(best.page),
              endPage,
              tractNumber: best.projectNo ? String(best.projectNo) : undefined,
              mapType: label,
            };

            const otherCandidates = nearby.slice(1).map((n) => ({
              book: n.book,
              page: n.page,
              mapType: recordTypeLabel(n.recordType),
              descript: n.descript,
              distanceMeters: n.distanceMeters,
            }));

            send({
              type: "result",
              tractInfo,
              assessorUrl: assessorStorageUrl,
              tractMapUrl,
              nearby: otherCandidates,
              message: `No exact boundary match — showing the nearest ${label.toLowerCase()} (${best.distanceMeters}m from the property).`,
            });
          } else {
            send({
              type: "result",
              tractInfo: null,
              assessorUrl: assessorStorageUrl,
              tractMapUrl: null,
              message: "No recorded maps found near this location. Showing the assessor parcel map.",
            });
          }
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : "Unexpected error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
