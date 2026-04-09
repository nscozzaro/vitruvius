/**
 * Anchor Registration — find the precise pixel position of the lot's POB
 * using ruler-marked crops and visual validation.
 *
 * Strategy:
 * 1. VLM locates the lot (coarse bounding box)
 * 2. Crop tightly, add pixel rulers along edges
 * 3. VLM reads ruler marks to estimate the POB monument position
 * 4. Draw crosshair at estimated position, ask VLM to validate
 * 5. Iterate until validated or max attempts reached
 *
 * This approach gives the VLM explicit spatial reference (rulers)
 * and a feedback loop (visual validation) to converge on the right spot.
 */

import { registerCoordSystem, type CoordSystem } from "./coord-system";
import { nimVision, parseJsonResponse } from "./nim-client";
import { overviewTile, type CropRegion } from "./tile-cropper";
import type { PageInfo } from "./reconstruction-agent";

export interface RegistrationResult {
  coordSystem: CoordSystem;
  anchorPixel: { px: number; py: number };
  matchConfidence: number;
  cropRegion: CropRegion;
  validated: boolean;
  matches: Array<Record<string, unknown>>;
}

const MAX_VALIDATION_ROUNDS = 3;

export async function registerAnchor(
  page: PageInfo,
  targetLot: string,
  scaleInfo: { feetPerInch: number; dpi: number; scaleText: string },
  northAngleDeg: number,
  onProgress: (msg: string) => void,
): Promise<RegistrationResult> {
  const sharpMod = (await import("sharp")).default;

  // ─── Step 1: Locate lot area ─────────────────────────────
  onProgress("Locating lot area on map…");
  const overview = await overviewTile(page.pngBase64, page.width, page.height);

  const lotLocResponse = await nimVision(
    overview.base64,
    `Find Lot ${targetLot} on this subdivision/tract map.
Return the bounding box of the lot as percentages of the image:
{ "x_pct": 30, "y_pct": 40, "width_pct": 15, "height_pct": 20 }

x_pct/y_pct = top-left corner. width_pct/height_pct = size.
Include some padding around the lot boundaries.`,
    { maxTokens: 256, temperature: 0.1 },
  );

  let cropRegion: CropRegion;
  try {
    const loc = parseJsonResponse<{
      x_pct: number; y_pct: number; width_pct: number; height_pct: number;
    }>(lotLocResponse);
    const padPct = 8;
    cropRegion = {
      x: Math.max(0, Math.round(((loc.x_pct - padPct) / 100) * page.width)),
      y: Math.max(0, Math.round(((loc.y_pct - padPct) / 100) * page.height)),
      width: Math.min(page.width, Math.round(((loc.width_pct + padPct * 2) / 100) * page.width)),
      height: Math.min(page.height, Math.round(((loc.height_pct + padPct * 2) / 100) * page.height)),
      label: `lot-${targetLot}-reg`,
    };
  } catch {
    cropRegion = {
      x: Math.round(page.width * 0.15),
      y: Math.round(page.height * 0.15),
      width: Math.round(page.width * 0.5),
      height: Math.round(page.height * 0.5),
      label: `lot-${targetLot}-reg-fallback`,
    };
  }
  // Clamp
  if (cropRegion.x + cropRegion.width > page.width) cropRegion.width = page.width - cropRegion.x;
  if (cropRegion.y + cropRegion.height > page.height) cropRegion.height = page.height - cropRegion.y;
  onProgress(`Lot crop: (${cropRegion.x}, ${cropRegion.y}) ${cropRegion.width}x${cropRegion.height}px`);

  // ─── Step 2: Crop and add rulers ─────────────────────────
  const meta = await sharpMod(Buffer.from(page.pngBase64, "base64")).metadata();
  const imgW = meta.width ?? page.width;
  const imgH = meta.height ?? page.height;

  let left = Math.max(0, cropRegion.x);
  let top = Math.max(0, cropRegion.y);
  let cw = Math.min(cropRegion.width, imgW - left);
  let ch = Math.min(cropRegion.height, imgH - top);
  cw = Math.max(1, cw);
  ch = Math.max(1, ch);

  const cropBuf = await sharpMod(Buffer.from(page.pngBase64, "base64"))
    .extract({ left, top, width: cw, height: ch })
    .toColourspace("srgb")
    .toBuffer();

  // Resize for VLM (max 2048) while tracking scale
  const vlmScale = Math.min(2048 / cw, 2048 / ch, 1);
  const vlmW = Math.round(cw * vlmScale);
  const vlmH = Math.round(ch * vlmScale);

  // ─── Step 3: Iterative anchor finding with validation ────
  let anchorCropX = cw / 2; // initial estimate: center of crop
  let anchorCropY = ch / 2;
  let validated = false;

  for (let round = 0; round < MAX_VALIDATION_ROUNDS; round++) {
    // Create ruler-marked image
    const rulerSpacing = 200; // pixels in crop space
    const rulerSvgParts: string[] = [];

    // Top ruler (X axis)
    for (let x = 0; x <= cw; x += rulerSpacing) {
      const sx = Math.round(x * vlmScale);
      rulerSvgParts.push(`<line x1="${sx}" y1="0" x2="${sx}" y2="15" stroke="red" stroke-width="2"/>`);
      rulerSvgParts.push(`<text x="${sx + 2}" y="13" fill="red" font-size="11" font-family="sans-serif">${x}</text>`);
    }
    // Left ruler (Y axis)
    for (let y = 0; y <= ch; y += rulerSpacing) {
      const sy = Math.round(y * vlmScale);
      rulerSvgParts.push(`<line x1="0" y1="${sy}" x2="15" y2="${sy}" stroke="red" stroke-width="2"/>`);
      rulerSvgParts.push(`<text x="2" y="${sy + 12}" fill="red" font-size="11" font-family="sans-serif">${y}</text>`);
    }

    // If not first round, draw crosshair at current estimate for validation
    if (round > 0) {
      const cx = Math.round(anchorCropX * vlmScale);
      const cy = Math.round(anchorCropY * vlmScale);
      rulerSvgParts.push(`<circle cx="${cx}" cy="${cy}" r="15" fill="none" stroke="red" stroke-width="3"/>`);
      rulerSvgParts.push(`<line x1="${cx - 25}" y1="${cy}" x2="${cx + 25}" y2="${cy}" stroke="red" stroke-width="2"/>`);
      rulerSvgParts.push(`<line x1="${cx}" y1="${cy - 25}" x2="${cx}" y2="${cy + 25}" stroke="red" stroke-width="2"/>`);
    }

    const rulerSvg = `<svg width="${vlmW}" height="${vlmH}">${rulerSvgParts.join("")}</svg>`;

    const markedBuf = await sharpMod(cropBuf)
      .resize(vlmW, vlmH)
      .composite([{ input: Buffer.from(rulerSvg), top: 0, left: 0 }])
      .jpeg({ quality: 90 })
      .toBuffer();

    if (round === 0) {
      // First round: ask for the POB location
      onProgress(`Round ${round + 1}: Finding POB monument with rulers…`);
      const response = await nimVision(
        markedBuf.toString("base64"),
        `This crop shows Lot ${targetLot} from a tract map. Red tick marks along the top and left edges show PIXEL COORDINATES within this crop (every ${rulerSpacing} pixels).

Find the SOUTHEAST (bottom-right) corner of Lot ${targetLot}'s boundary. This corner should have a small filled circle (●) or open circle (○) — a survey monument marker where two boundary lines meet.

Using the red ruler ticks, estimate the pixel coordinates of this monument's CENTER within the crop.

Return valid JSON:
{ "x": 850, "y": 1200, "description": "SE corner monument of Lot ${targetLot}" }

Look carefully at the ruler numbers. Interpolate between ticks for precision.`,
        { maxTokens: 256, temperature: 0.1 },
      );

      try {
        const data = parseJsonResponse<{ x: number; y: number; description: string }>(response);
        anchorCropX = Math.max(0, Math.min(cw, data.x));
        anchorCropY = Math.max(0, Math.min(ch, data.y));
        onProgress(`Round ${round + 1}: estimate at crop (${Math.round(anchorCropX)}, ${Math.round(anchorCropY)}): ${data.description}`);
      } catch {
        onProgress(`Round ${round + 1}: failed to parse, using crop center`);
      }
    } else {
      // Validation round: crosshair is drawn, ask if it's correct
      onProgress(`Round ${round + 1}: Validating anchor position…`);
      const response = await nimVision(
        markedBuf.toString("base64"),
        `I've placed a RED CROSSHAIR (+) on this tract map crop. The crosshair should be exactly centered on the southeast corner monument of Lot ${targetLot} — a small filled or open circle where two lot boundary lines meet.

Is the crosshair directly on a survey monument marker?

If YES (crosshair is on or within a few pixels of a monument dot):
{ "valid": true }

If NO (crosshair is NOT on a monument):
{ "valid": false, "correction_x": -50, "correction_y": 30, "reason": "The crosshair is 50 pixels too far right and 30 pixels too far up from the nearest monument" }

correction_x/y are in CROP PIXEL COORDINATES (using the ruler ticks as reference).
Negative x = move left, positive x = move right.
Negative y = move up, positive y = move down.`,
        { maxTokens: 256, temperature: 0.1 },
      );

      try {
        const data = parseJsonResponse<{
          valid: boolean;
          correction_x?: number;
          correction_y?: number;
          reason?: string;
        }>(response);

        if (data.valid) {
          validated = true;
          onProgress(`Round ${round + 1}: VALIDATED — anchor confirmed on monument`);
          break;
        }

        // Apply correction
        const cx = data.correction_x ?? 0;
        const cy = data.correction_y ?? 0;
        anchorCropX = Math.max(0, Math.min(cw, anchorCropX + cx));
        anchorCropY = Math.max(0, Math.min(ch, anchorCropY + cy));
        onProgress(`Round ${round + 1}: NOT on monument. Adjusting by (${cx}, ${cy}). ${data.reason ?? ""}`);
      } catch {
        onProgress(`Round ${round + 1}: failed to parse validation response`);
        break;
      }
    }
  }

  // Convert crop-local anchor to full-image coordinates
  const anchorPx = {
    px: Math.round(left + anchorCropX),
    py: Math.round(top + anchorCropY),
  };
  onProgress(`Final anchor: (${anchorPx.px}, ${anchorPx.py}) in full image${validated ? " [VALIDATED]" : " [unvalidated]"}`);

  const coordSystem = registerCoordSystem({
    feetPerInch: scaleInfo.feetPerInch,
    dpi: scaleInfo.dpi,
    northAngleDeg,
    anchorPixel: anchorPx,
    scaleText: scaleInfo.scaleText,
  });

  return {
    coordSystem,
    anchorPixel: anchorPx,
    matchConfidence: validated ? 0.9 : 0.3,
    cropRegion,
    validated,
    matches: [],
  };
}
