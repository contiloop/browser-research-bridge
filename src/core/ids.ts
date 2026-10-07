/** Result ids (`<siteKey>:<localId>`, URL-based fallback ids) and read refs (ids or URLs). */
import type { DocumentRef } from "./models.js";
import { isValidSiteKey } from "./site-key.js";
import { hostnameKey, parseHttpUrl } from "./url.js";

/** Prefix of the URL-based fallback local id. Native local ids never start with it. */
export const URL_LOCAL_ID_PREFIX = "u_";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeUrlLocalId(url: string): string {
  return `${URL_LOCAL_ID_PREFIX}${Buffer.from(url, "utf8").toString("base64url")}`;
}

/** Decodes a `u_…` local id back to its http(s) URL; null when it is not a well-formed fallback id. */
export function decodeUrlLocalId(localId: string): string | null {
  if (!localId.startsWith(URL_LOCAL_ID_PREFIX)) return null;
  const payload = localId.slice(URL_LOCAL_ID_PREFIX.length);
  if (!BASE64URL.test(payload)) return null;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== payload) return null;
  return parseHttpUrl(decoded) ? decoded : null;
}

/** A native local id is usable when it is non-empty, has no whitespace, and cannot be mistaken for a fallback id. */
function isUsableNativeLocalId(localId: string | null | undefined): localId is string {
  return typeof localId === "string" && /^\S+$/.test(localId) && !localId.startsWith(URL_LOCAL_ID_PREFIX);
}

export interface ResultIdInput {
  /** The site's own stable article id, when the adapter can extract one. */
  localId?: string | null | undefined;
  /** The article URL as the adapter found it (before any dedup normalization). */
  url: string;
}

/**
 * `<siteKey>:<localId>`; without a usable native id, `<siteKey>:u_<base64url(canonicalize(url))>`.
 * Uses the adapter canonicalizer only, never the dedup-normalized URL.
 */
export function makeResultId(
  siteKey: string,
  input: ResultIdInput,
  canonicalize?: (url: string) => string,
): string {
  if (!isValidSiteKey(siteKey)) throw new TypeError(`invalid site key: ${JSON.stringify(siteKey)}`);
  if (isUsableNativeLocalId(input.localId)) return `${siteKey}:${input.localId}`;
  const url = input.url.trim();
  const canonical = canonicalize ? canonicalize(url).trim() : url;
  return `${siteKey}:${encodeUrlLocalId(canonical)}`;
}

export type ParsedRef =
  | { kind: "url"; url: string; hostname: string }
  | { kind: "id"; siteKey: string; localId: string; url: string | null }
  | { kind: "invalid"; reason: string };

export type ValidRef = Exclude<ParsedRef, { kind: "invalid" }>;

/** `http://`/`https://` → URL; otherwise `<siteKey>:<localId>` split at the first colon. */
export function parseRef(ref: string): ParsedRef {
  const s = ref.trim();
  if (s === "") return { kind: "invalid", reason: "empty ref" };
  if (/^https?:\/\//i.test(s)) {
    const u = parseHttpUrl(s);
    if (!u) return { kind: "invalid", reason: "malformed URL" };
    return { kind: "url", url: s, hostname: u.hostname };
  }
  const colon = s.indexOf(":");
  if (colon <= 0) return { kind: "invalid", reason: "expected <siteKey>:<localId> or an http(s) URL" };
  const siteKey = s.slice(0, colon);
  const localId = s.slice(colon + 1);
  if (!isValidSiteKey(siteKey)) return { kind: "invalid", reason: `invalid site key: ${siteKey}` };
  if (localId === "" || /\s/.test(localId)) return { kind: "invalid", reason: "invalid local id" };
  if (localId.startsWith(URL_LOCAL_ID_PREFIX)) {
    const url = decodeUrlLocalId(localId);
    if (url === null) return { kind: "invalid", reason: "malformed URL id" };
    return { kind: "id", siteKey, localId, url };
  }
  return { kind: "id", siteKey, localId, url: null };
}

/** The ref an adapter's `read` receives: the URL for URL refs and fallback ids, else the native local id. */
export function toAdapterRef(ref: ValidRef): DocumentRef {
  if (ref.kind === "url") return { url: ref.url };
  return ref.url !== null ? { url: ref.url } : { localId: ref.localId };
}

export interface SiteHostnames {
  key: string;
  hostnames: readonly string[];
}

/** Resolves a hostname to the site that declares it (case-insensitive, `www.`-insensitive). No network. */
export function resolveSiteByHostname(hostname: string, sites: readonly SiteHostnames[]): string | null {
  const wanted = hostnameKey(hostname);
  if (wanted === "") return null;
  for (const site of sites) {
    if (site.hostnames.some((h) => hostnameKey(h) === wanted)) return site.key;
  }
  return null;
}

/** Resolves a `site:` value given as a key, a hostname, or a URL. */
export function resolveSiteQualifier(value: string, sites: readonly SiteHostnames[]): string | null {
  const v = value.trim().toLowerCase();
  if (v === "") return null;
  const byKey = sites.find((s) => s.key === v);
  if (byKey) return byKey.key;
  const u = parseHttpUrl(v);
  const host = u ? u.hostname : (v.split("/")[0] ?? "");
  return resolveSiteByHostname(host, sites);
}
