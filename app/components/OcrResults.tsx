"use client";

interface OcrPageData {
  pageIndex: number;
  width: number;
  height: number;
  dpi: number;
  fullText: string;
  tileCount?: number;
  rawItemCount?: number;
  mergedItemCount?: number;
  items?: Array<{ text: string; type: string; confidence: string }>;
}

interface OcrResultData {
  pages: OcrPageData[];
  fullText: string;
  pdfBase64?: string | null;
}

interface OcrProgressData {
  phase: string;
  pageIndex: number;
  totalPages: number;
  tileIndex?: number;
  totalTiles?: number;
  percent: number;
  message: string;
}

interface OcrResultsProps {
  result: OcrResultData | null;
  loading: boolean;
  progress: OcrProgressData | null;
  error: string | null;
  jsonFilename?: string;
  pdfFilename?: string;
}

export default function OcrResults({
  result,
  loading,
  progress,
  error,
  jsonFilename = "ocr-result.json",
  pdfFilename = "searchable-map.pdf",
}: OcrResultsProps) {
  if (!loading && !result && !error) return null;

  return (
    <div className="w-full max-w-xl">
      {/* Progress */}
      {loading && progress && (
        <div className="rounded-xl border border-zinc-200 bg-white/80 p-4 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/80">
          <div className="mb-3 flex items-center gap-3 text-sm">
            <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            <span className="text-zinc-700 dark:text-zinc-200">
              {progress.message}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-300"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            {progress.totalPages > 0 && `Page ${progress.pageIndex + 1} of ${progress.totalPages}`}
            {progress.totalTiles != null && progress.totalTiles > 0 &&
              ` · Tile ${(progress.tileIndex ?? 0) + 1} of ${progress.totalTiles}`}
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-400">
          OCR failed: {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="rounded-xl border border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/80">
          {/* Header */}
          <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              OCR Complete
            </h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {result.pages.length} page{result.pages.length !== 1 ? "s" : ""}
              {result.pages[0]?.rawItemCount != null &&
                ` · ${result.pages.reduce((sum, p) => sum + (p.rawItemCount ?? 0), 0)} raw → ${result.pages.reduce((sum, p) => sum + (p.mergedItemCount ?? 0), 0)} verified`}
              {result.pages[0]?.tileCount != null &&
                ` · ${result.pages.reduce((sum, p) => sum + (p.tileCount ?? 0), 0)} tiles`}
              {` · ${result.pages[0]?.dpi} DPI`}
            </p>
          </div>

          {/* Download buttons */}
          <div className="flex flex-col gap-2 p-4">
            {/* Primary: Searchable PDF */}
            {result.pdfBase64 && (
              <button
                onClick={() => {
                  const bytes = Uint8Array.from(atob(result.pdfBase64!), (c) => c.charCodeAt(0));
                  const blob = new Blob([bytes], { type: "application/pdf" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = pdfFilename;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download Searchable PDF
              </button>
            )}

            {/* Secondary: JSON + Copy */}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const { pdfBase64: _, ...jsonData } = result;
                  const json = JSON.stringify(jsonData, null, 2);
                  const blob = new Blob([json], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = jsonFilename;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Download JSON
              </button>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(result.fullText);
                }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Copy Text
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
