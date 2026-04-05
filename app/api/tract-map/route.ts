import { NextRequest } from "next/server";
import { geocode, getAPN, apnToAssessorMapUrl } from "@/app/lib/parcels";
import { fetchPdf, extractTractReference } from "@/app/lib/pdf";
import { searchRecorder } from "@/app/lib/recorder";
import {
  ensureStored,
  assessorStoragePath,
  surveyorStoragePath,
} from "@/app/lib/storage";

/**
 * POST /api/tract-map
 *
 * Pipeline: address → geocode → APN → assessor map PDF → LLM vision →
 *           book/page → download from surveyor → store in Supabase Storage
 *
 * Returns stable Supabase CDN URLs that never expire.
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

        // Step 2: APN
        send({ type: "step", message: "Looking up parcel…" });
        const apn = await getAPN(lat, lon);
        if (!apn) {
          send({ type: "error", message: "Could not find a Santa Barbara County parcel at this address. This tool only works for SB County properties." });
          return;
        }
        send({ type: "step", message: `Found parcel APN: ${apn}` });

        // Step 3: Upload assessor map to storage (or return existing URL)
        send({ type: "step", message: "Downloading assessor parcel map…" });
        const assessorMapUrl = apnToAssessorMapUrl(apn);
        const assessorPath = assessorStoragePath(apn);

        // We need the PDF buffer both for storage and for LLM extraction
        const pdfBuf = await fetchPdf(assessorMapUrl);
        if (!pdfBuf) {
          send({ type: "error", message: `Could not fetch assessor map for APN ${apn}` });
          return;
        }

        // Upload to Supabase (skips if already stored)
        const assessorStorageUrl = await ensureStored(assessorPath, async () => pdfBuf);

        // Step 4: Extract tract reference via LLM
        send({ type: "step", message: "Reading map with AI…" });
        const tractInfo = await extractTractReference(pdfBuf);
        if (!tractInfo) {
          send({
            type: "result",
            tractInfo: null,
            assessorUrl: assessorStorageUrl,
            tractMapUrl: null,
            message: "Could not find a tract map reference. This parcel may predate modern subdivision records. Showing the assessor parcel map.",
          });
          return;
        }
        const pageLabel = tractInfo.endPage
          ? `Pages ${tractInfo.page}–${tractInfo.endPage}`
          : `Page ${tractInfo.page}`;
        send({ type: "step", message: `Found: Book ${tractInfo.book}, ${pageLabel}` });

        // Step 5: Download subdivision map and upload to storage
        send({ type: "step", message: "Downloading subdivision map from county surveyor…" });
        const surveyorPath = surveyorStoragePath(
          tractInfo.book,
          tractInfo.page,
          tractInfo.endPage,
        );
        const tractMapUrl = await ensureStored(surveyorPath, () =>
          searchRecorder(tractInfo.book, tractInfo.page, tractInfo.endPage),
        );

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
            message: "Found the tract reference but could not download the subdivision map from the county surveyor.",
          });
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
