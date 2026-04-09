import { NextRequest } from "next/server";
import { initSession } from "@/app/lib/reconstruction-agent";

/**
 * POST /api/reconstruct/init
 *
 * Initialize a reconstruction session: render pages, discover scale/north/legend,
 * build extraction plan. Streams SSE progress events, then sends the final result.
 */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const { book, page, endPage, targetLot } = await request.json();

  if (!book || !page || !targetLot) {
    return Response.json(
      { error: "Missing required fields: book, page, targetLot" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const result = await initSession(
          book,
          page,
          endPage,
          targetLot,
          (msg) => send({ type: "step", message: msg }),
        );

        send({ type: "result", ...result });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Init failed",
        });
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
