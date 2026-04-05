/** Identifies the recorded subdivision map that created a parcel. */
export interface TractInfo {
  book: string;
  /** First page of the map. */
  page: string;
  /** Last page if the map spans multiple pages (e.g., "22" for pages 20-22). */
  endPage?: string;
  tractNumber?: string;
  mapType?: string;
  /** The raw text snippet the LLM found the reference in. */
  rawText?: string;
}
