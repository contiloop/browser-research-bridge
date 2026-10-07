/**
 * Search cursor codec: an opaque, self-contained base64url JSON token holding each
 * site's `(adapterCursor, offset)`, the page number it fetches, and a bounded list of seen URL hashes.
 */
import { z } from "zod";
import { DEFAULT_CURSOR_MAX_LENGTH, DEFAULT_SEEN_HASH_LIMIT } from "./defaults.js";

export interface SiteCursorState {
  /** The adapter cursor that produced the site's current adapter page (null = first page). */
  adapterCursor: string | null;
  /** Index of the first unconsumed result in that adapter page. */
  offset: number;
}

export interface SearchCursor {
  /** The page number this cursor fetches (≥ 2 in practice). */
  page: number;
  /** Sites still being paginated. A site absent here is not searched on later pages. */
  sites: Record<string, SiteCursorState>;
  /** Hashes of normalized URLs already returned, most recent last. */
  seen: string[];
}

const CURSOR_VERSION = 1;

const wireSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  p: z.int().min(1),
  s: z.record(z.string().min(1), z.tuple([z.string().nullable(), z.int().min(0)])),
  h: z.array(z.string().min(1).max(64)),
});

type WireCursor = z.infer<typeof wireSchema>;

export interface EncodeCursorOptions {
  seenLimit?: number;
}

export function encodeCursor(cursor: SearchCursor, options: EncodeCursorOptions = {}): string {
  const seenLimit = options.seenLimit ?? DEFAULT_SEEN_HASH_LIMIT;
  const wire: WireCursor = {
    v: CURSOR_VERSION,
    p: cursor.page,
    s: Object.fromEntries(
      Object.entries(cursor.sites).map(([site, st]) => [site, [st.adapterCursor, st.offset]] as const),
    ),
    h: cursor.seen.slice(-seenLimit),
  };
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
}

export interface DecodeCursorOptions {
  /** Whether a site key is still registered; unknown sites are dropped. */
  isKnownSite: (key: string) => boolean;
  seenLimit?: number;
  maxLength?: number;
}

export type DecodeCursorResult =
  { ok: true; cursor: SearchCursor; droppedSites: string[] } | { ok: false; error: string };

export function decodeCursor(token: string, options: DecodeCursorOptions): DecodeCursorResult {
  const maxLength = options.maxLength ?? DEFAULT_CURSOR_MAX_LENGTH;
  const seenLimit = options.seenLimit ?? DEFAULT_SEEN_HASH_LIMIT;
  if (token.length === 0) return { ok: false, error: "empty cursor" };
  if (token.length > maxLength) return { ok: false, error: "cursor too long" };
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return { ok: false, error: "cursor is not base64url" };

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "cursor is not valid JSON" };
  }
  const parsed = wireSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: "cursor has an invalid shape" };

  const sites: Record<string, SiteCursorState> = {};
  const droppedSites: string[] = [];
  for (const [site, [adapterCursor, offset]] of Object.entries(parsed.data.s)) {
    if (options.isKnownSite(site)) sites[site] = { adapterCursor, offset };
    else droppedSites.push(site);
  }
  return {
    ok: true,
    cursor: { page: parsed.data.p, sites, seen: parsed.data.h.slice(-seenLimit) },
    droppedSites,
  };
}
