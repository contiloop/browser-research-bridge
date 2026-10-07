/** Turns adapter output into core contracts, enforcing the result id rule and the text cap. */
import { DEFAULT_DOCUMENT_MAX_CHARS } from "./defaults.js";
import { makeResultId } from "./ids.js";
import type { Document, SearchResult } from "./models.js";
import { truncateText } from "./text.js";

export type SearchItemInput = Omit<SearchResult, "id" | "site"> & { localId?: string | null | undefined };

export type DocumentInput = Omit<Document, "id" | "site" | "truncated" | "fetchedAt"> & {
  localId?: string | null | undefined;
};

export function toSearchResult(
  site: string,
  item: SearchItemInput,
  canonicalize?: (url: string) => string,
): SearchResult {
  return {
    id: makeResultId(site, { localId: item.localId, url: item.url }, canonicalize),
    site,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    datePrecision: item.datePrecision,
    excerpt: item.excerpt,
    author: item.author,
  };
}

export interface FinalizeDocumentOptions {
  fetchedAt: string;
  /** Text cap (default 100,000); longer text is cut at a paragraph boundary. */
  maxChars?: number | undefined;
  canonicalize?: ((url: string) => string) | undefined;
}

export function finalizeDocument(
  site: string,
  doc: DocumentInput,
  options: FinalizeDocumentOptions,
): Document {
  const { text, truncated } = truncateText(doc.text, options.maxChars ?? DEFAULT_DOCUMENT_MAX_CHARS);
  return {
    id: makeResultId(site, { localId: doc.localId, url: doc.url }, options.canonicalize),
    site,
    title: doc.title,
    url: doc.url,
    publishedAt: doc.publishedAt,
    datePrecision: doc.datePrecision,
    author: doc.author,
    text,
    truncated,
    accessLevel: doc.accessLevel,
    fetchedAt: options.fetchedAt,
    metadata: { ...doc.metadata },
  };
}
