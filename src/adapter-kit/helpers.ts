/**
 * The helper object injected into adapters as `ctx.helpers`. The bridge's composition
 * root and the validation CLI call `createAdapterHelpers()` once and share it across sites; the
 * functions are pure, so adapters pass the site time zone (`ctx.manifest.timezone`) and the request
 * time (`ctx.now()`) to `parseDate` themselves.
 */
import type { AdapterHelpers, ExtractTextOptions } from "../ports/adapter.js";
import type { JsonValue } from "../ports/json.js";
import { decodeSiteCursor, encodeSiteCursor } from "./cursor.js";
import { parseDate } from "./dates.js";
import { extractText, snapshotToText } from "./text.js";

/** `AdapterHelpers` with every optional member present. */
export type KitAdapterHelpers = Required<AdapterHelpers>;

export function createAdapterHelpers(): KitAdapterHelpers {
  return {
    parseDate: (input: string, options?: { timezone?: string; now?: Date }) => parseDate(input, options),
    extractText: (html: string, options?: ExtractTextOptions) => extractText(html, options),
    snapshotToText: (snapshot: string) => snapshotToText(snapshot),
    encodeCursor: (state: JsonValue) => encodeSiteCursor(state),
    decodeCursor: (cursor: string | null) => decodeSiteCursor(cursor),
  };
}
