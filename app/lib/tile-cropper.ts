/**
 * Tile Cropper for VLM Input.
 *
 * Llama 4 Maverick accepts 2048×2048 and performs best at that
 * full resolution. Tract maps at 300 DPI are typically ~3300×2550,
 * and the fine handwritten text (bearings, distances) is too small
 * to read when the entire page is shrunk to 2048×2048.
 *
 * Strategy:
 * 1. Full-page overview at 2048×2048 for legend/layout passes
 * 2. Per-lot crops at native resolution for metes & bounds extraction
 * 3. Overlapping grid tiles for comprehensive text extraction
 */

import sharp from "sharp";

export interface Tile {
  /** Base64 JPEG at ≤2048×2048 */
  base64: string;
  /** Pixel bounds in the original full-resolution image */
  bounds: { x: number; y: number; width: number; height: number };
  /** Label for logging */
  label: string;
}

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

const VLM_SIZE = 2048;

/**
 * Resize the full page to fit within 2048×2048 for overview passes.
 * Maintains aspect ratio, pads with white if needed.
 */
export async function overviewTile(
  pngBase64: string,
  imageWidth: number,
  imageHeight: number,
): Promise<Tile> {
  const buf = Buffer.from(pngBase64, "base64");

  const resized = await sharp(buf)
    .resize(VLM_SIZE, VLM_SIZE, {
      fit: "inside",
      withoutEnlargement: false,
      background: { r: 255, g: 255, b: 255 },
    })
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    base64: resized.toString("base64"),
    bounds: { x: 0, y: 0, width: imageWidth, height: imageHeight },
    label: "full-page-overview",
  };
}

/**
 * Crop a specific region from the full-resolution image
 * and resize to 2048×2048 for maximum detail.
 *
 * The crop is taken at native resolution, then scaled up to
 * fill the 2048×2048 VLM input — giving Maverick the maximum
 * pixels to read fine text.
 */
export async function cropTile(
  pngBase64: string,
  region: CropRegion,
): Promise<Tile> {
  const buf = Buffer.from(pngBase64, "base64");

  const cropped = await sharp(buf)
    .extract({
      left: Math.round(region.x),
      top: Math.round(region.y),
      width: Math.round(region.width),
      height: Math.round(region.height),
    })
    .resize(VLM_SIZE, VLM_SIZE, {
      fit: "inside",
      withoutEnlargement: false,
      background: { r: 255, g: 255, b: 255 },
    })
    .jpeg({ quality: 95 })
    .toBuffer();

  return {
    base64: cropped.toString("base64"),
    bounds: {
      x: Math.round(region.x),
      y: Math.round(region.y),
      width: Math.round(region.width),
      height: Math.round(region.height),
    },
    label: region.label,
  };
}

/**
 * Generate overlapping grid tiles that cover the entire image.
 *
 * Each tile is sized so that when scaled to 2048×2048, the fine
 * text is readable. With 25% overlap, no detail falls on a seam.
 *
 * @param tileNativeSize - Size of each tile in original image pixels.
 *   At 300 DPI, a 1024px tile covers ~3.4 inches — good for detail.
 *   Default 1200px gives ~4 inches of coverage per tile.
 * @param overlap - Fraction of overlap between adjacent tiles (0-0.5)
 */
export async function gridTiles(
  pngBase64: string,
  imageWidth: number,
  imageHeight: number,
  tileNativeSize = 1200,
  overlap = 0.25,
): Promise<Tile[]> {
  const step = Math.round(tileNativeSize * (1 - overlap));
  const tiles: Tile[] = [];

  for (let y = 0; y < imageHeight; y += step) {
    for (let x = 0; x < imageWidth; x += step) {
      const w = Math.min(tileNativeSize, imageWidth - x);
      const h = Math.min(tileNativeSize, imageHeight - y);

      // Skip tiny edge tiles
      if (w < tileNativeSize * 0.3 || h < tileNativeSize * 0.3) continue;

      const tile = await cropTile(pngBase64, {
        x,
        y,
        width: w,
        height: h,
        label: `grid-${Math.floor(y / step)}-${Math.floor(x / step)}`,
      });
      tiles.push(tile);
    }
  }

  return tiles;
}

/**
 * Generate per-lot crop regions based on the agent's feature survey.
 *
 * Given lot positions (as percentage of image dimensions from the
 * feature survey), compute crop regions that give each lot maximum
 * resolution. Adds padding around the lot area for context.
 */
export function lotCropRegions(
  lotPositions: Array<{
    lot: string;
    x_pct: number;
    y_pct: number;
    width_pct: number;
    height_pct: number;
  }>,
  imageWidth: number,
  imageHeight: number,
  paddingPct = 15,
): CropRegion[] {
  return lotPositions.map((lot) => {
    const padX = (paddingPct / 100) * imageWidth;
    const padY = (paddingPct / 100) * imageHeight;

    let x = (lot.x_pct / 100) * imageWidth - padX;
    let y = (lot.y_pct / 100) * imageHeight - padY;
    let w = (lot.width_pct / 100) * imageWidth + 2 * padX;
    let h = (lot.height_pct / 100) * imageHeight + 2 * padY;

    // Clamp to image bounds
    x = Math.max(0, x);
    y = Math.max(0, y);
    w = Math.min(w, imageWidth - x);
    h = Math.min(h, imageHeight - y);

    return { x, y, width: w, height: h, label: `lot-${lot.lot}` };
  });
}

/**
 * Estimate where lots are on the page using a quick VLM call.
 * Returns approximate bounding boxes as percentages.
 */
export async function detectLotRegions(
  overviewBase64: string,
): Promise<
  Array<{
    lot: string;
    x_pct: number;
    y_pct: number;
    width_pct: number;
    height_pct: number;
  }>
> {
  const { nimVision: nv, parseJsonResponse: pj } = await import("./nim-client");

  const response = await nv(
    overviewBase64,
    `Identify ONLY the numbered subdivision lots on this tract map.
Look for lots labeled with numbers (e.g., "LOT 1", "LOT 2", "1", "2").
Do NOT include streets, title blocks, legend areas, easement labels, or other non-lot areas.

For each lot, estimate its bounding box as percentage of image dimensions (0-100).

IMPORTANT: Only include actual subdivision lots with lot numbers. A typical
tract map has 5-30 lots. If you find more than 30, you are likely including
non-lot features.

Respond with valid JSON only:
[
  { "lot": "1", "x_pct": 10, "y_pct": 20, "width_pct": 25, "height_pct": 30 }
]

x_pct and y_pct are the top-left corner. width_pct and height_pct are the size.
Only include lots you can clearly identify by number on the map.`,
    { maxTokens: 2048, temperature: 0.1 },
  );

  return pj(response);
}
