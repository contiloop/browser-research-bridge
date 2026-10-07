/**
 * Opaque per-site pagination cursors. An adapter's `nextCursor` is a
 * string only that adapter understands; the core stores it inside its own search cursor and hands
 * it back unchanged for the next page. Encode whatever the site needs (a page number, an offset, an
 * API continuation token) as JSON; the encoding is URL-safe base64 with a version prefix.
 */
import type { JsonValue } from "../ports/json.js";

const PREFIX = "c1.";
/** Longest cursor accepted by {@link decodeSiteCursor}. */
export const MAX_SITE_CURSOR_LENGTH = 4096;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(payload: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(payload)) return null;
  try {
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Encodes a JSON state as an opaque cursor string. */
export function encodeSiteCursor(state: JsonValue): string {
  return `${PREFIX}${toBase64Url(JSON.stringify(state))}`;
}

/** Decodes a cursor made by {@link encodeSiteCursor}; null for null, empty, foreign, or malformed input. */
export function decodeSiteCursor(cursor: string | null | undefined): JsonValue | null {
  if (typeof cursor !== "string" || !cursor.startsWith(PREFIX) || cursor.length > MAX_SITE_CURSOR_LENGTH) {
    return null;
  }
  const text = fromBase64Url(cursor.slice(PREFIX.length));
  if (text === null) return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

/** The common case: a cursor holding the index of the next result (`{ "o": 20 }`). */
export function encodeOffsetCursor(offset: number): string {
  return encodeSiteCursor({ o: Math.max(0, Math.floor(offset)) });
}

/**
 * Offset stored by {@link encodeOffsetCursor}: 0 for a null cursor (first page), null when the
 * cursor is present but malformed (the adapter should then fail the page, not restart at 0).
 */
export function decodeOffsetCursor(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  const state = decodeSiteCursor(cursor);
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const o = state["o"];
  return typeof o === "number" && Number.isInteger(o) && o >= 0 ? o : null;
}
