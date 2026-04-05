/**
 * Supabase Storage for map PDFs.
 *
 * PDFs are uploaded to the public "maps" bucket with deterministic paths:
 *   assessor/{bookPage}.pdf       — e.g., assessor/07320.pdf
 *   surveyor/bk{book}/pg{page}.pdf — e.g., surveyor/bk076/pg020-022.pdf
 *
 * Before downloading, we check if the file already exists in storage.
 * Public URLs are served directly from Supabase CDN.
 */

const BUCKET = "maps";

function supabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
}

function apiKey(): string {
  // Prefer service role key for uploads; fall back to anon key
  return process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || "";
}

function publicUrl(path: string): string {
  return `${supabaseUrl()}/storage/v1/object/public/${BUCKET}/${path}`;
}

async function fileExists(path: string): Promise<boolean> {
  const resp = await fetch(publicUrl(path), {
    method: "HEAD",
    signal: AbortSignal.timeout(5000),
  });
  return resp.ok;
}

async function uploadPdf(path: string, buf: Buffer): Promise<string> {
  const url = `${supabaseUrl()}/storage/v1/object/${BUCKET}/${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      apikey: apiKey(),
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: buf,
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Storage upload failed: ${resp.status} ${err}`);
  }

  return publicUrl(path);
}

/**
 * Ensures a PDF is in storage. If it already exists, returns the public URL
 * immediately. Otherwise calls downloadFn to get the buffer and uploads it.
 */
export async function ensureStored(
  path: string,
  downloadFn: () => Promise<Buffer | null>,
): Promise<string | null> {
  if (!supabaseUrl() || !apiKey()) {
    console.error("[storage] Supabase env vars not set");
    return null;
  }

  // Check if already stored
  try {
    if (await fileExists(path)) {
      return publicUrl(path);
    }
  } catch { /* proceed to download */ }

  // Download and upload
  const buf = await downloadFn();
  if (!buf) return null;

  try {
    return await uploadPdf(path, buf);
  } catch (err) {
    console.error("[storage] Upload error:", err);
    return null;
  }
}

/** Storage path for an assessor map. */
export function assessorStoragePath(apn: string): string {
  const key = apn.replace(/-/g, "").slice(0, 5);
  return `assessor/${key}.pdf`;
}

/** Storage path for a surveyor map. */
export function surveyorStoragePath(
  book: string,
  page: string,
  endPage?: string,
): string {
  const bk = book.padStart(3, "0");
  const pg = page.padStart(3, "0");
  const suffix = endPage ? `-${endPage.padStart(3, "0")}` : "";
  return `surveyor/bk${bk}/pg${pg}${suffix}.pdf`;
}
