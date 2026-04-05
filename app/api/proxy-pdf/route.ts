import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/proxy-pdf?url=<encoded-url>
 *
 * Proxies a PDF from an external URL to avoid CORS restrictions.
 * Only proxies from allowed domains (sbcrecorder.com, smartviewonline.net, sbcvote.com).
 */

const ALLOWED_HOSTS = [
  "records.sbcrecorder.com",
  "www.smartviewonline.net",
  "smartviewonline.net",
  "sbcvote.com",
  "www.sbcvote.com",
  "sbcassessor.com",
  "www.sbcassessor.com",
  "surveyor.countyofsb.org",
];

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
    return NextResponse.json(
      { error: `Host ${parsedUrl.hostname} is not allowed` },
      { status: 403 }
    );
  }

  try {
    const resp = await fetch(rawUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      return NextResponse.json({ error: `Upstream returned ${resp.status}` }, { status: resp.status });
    }

    const contentType = resp.headers.get("content-type") || "application/pdf";
    const body = await resp.arrayBuffer();

    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": 'inline; filename="tract-map.pdf"',
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch document" },
      { status: 500 }
    );
  }
}
