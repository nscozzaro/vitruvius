import { NextRequest } from "next/server";
import { executeStep } from "@/app/lib/reconstruction-agent";
import type { CoordSystem } from "@/app/lib/coord-system";
import type { Point } from "@/app/lib/cogo";
import type {
  ExtractionPlanItem,
  MonumentLegendEntry,
} from "@/app/lib/reconstruction-agent";

/**
 * POST /api/reconstruct/step
 *
 * Execute a single extraction step: crop → NIM vision → COGO → overlap score.
 * Returns the new survey element, SVG fragment, and quality metrics.
 */
export const maxDuration = 60;

interface StepRequest {
  pageKey: string;
  coordSystem: CoordSystem;
  currentPoint: Point;
  currentBearing: number | null;
  planItem: ExtractionPlanItem;
  previousOverlapScore: number | null;
  monumentLegend: MonumentLegendEntry[];
  consecutiveLowCount?: number;
}

export async function POST(request: NextRequest) {
  const body: StepRequest = await request.json();

  const {
    pageKey,
    coordSystem,
    currentPoint,
    currentBearing,
    planItem,
    previousOverlapScore,
    monumentLegend,
    consecutiveLowCount,
  } = body;

  if (!pageKey || !coordSystem || !currentPoint || !planItem) {
    return Response.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }

  try {
    const result = await executeStep(
      pageKey,
      coordSystem,
      currentPoint,
      currentBearing,
      planItem,
      previousOverlapScore,
      monumentLegend,
      consecutiveLowCount ?? 0,
    );

    return Response.json(result);
  } catch (err) {
    console.error("[reconstruct/step] error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Step failed" },
      { status: 500 },
    );
  }
}
