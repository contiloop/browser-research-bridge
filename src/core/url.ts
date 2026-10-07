/** URL normalization used as the dedup key. Never used to build result ids. */
import { createHash } from "node:crypto";

export const DEFAULT_TRACKING_PARAM_PREFIXES: readonly string[] = ["utm_"];
export const DEFAULT_TRACKING_PARAMS: readonly string[] = ["fbclid", "gclid", "ref", "src"];

export interface NormalizeUrlOptions {
  /** Site-specific canonicalizer; runs first. */
  canonicalize?: ((url: string) => string) | undefined;
  /** Lowercase param-name prefixes to strip. Default `["utm_"]`. */
  trackingParamPrefixes?: readonly string[] | undefined;
  /** Lowercase exact param names to strip. Default `fbclid, gclid, ref, src`. */
  trackingParams?: readonly string[] | undefined;
}

/** Lowercase, drop a trailing dot and a leading `www.`; used for hostname ownership comparison. */
export function hostnameKey(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

/** Parses an absolute http(s) URL; null otherwise. */
export function parseHttpUrl(value: string): URL | null {
  const s = value.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") return null;
    return u;
  } catch {
    return null;
  }
}

export function isHttpUrl(value: string): boolean {
  return parseHttpUrl(value) !== null;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeUrl(input: string, options: NormalizeUrlOptions = {}): string {
  let s = input.trim();
  if (options.canonicalize) s = options.canonicalize(s).trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  const prefixes = options.trackingParamPrefixes ?? DEFAULT_TRACKING_PARAM_PREFIXES;
  const names = new Set(options.trackingParams ?? DEFAULT_TRACKING_PARAMS);
  const isTracking = (name: string): boolean => {
    const n = name.toLowerCase();
    return names.has(n) || prefixes.some((p) => n.startsWith(p));
  };

  u.hash = "";
  u.hostname = hostnameKey(u.hostname);
  const kept = [...u.searchParams].filter(([name]) => !isTracking(name));
  kept.sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  u.search = kept.length > 0 ? new URLSearchParams(kept).toString() : "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  }
  return u.toString();
}

/** Short stable hash of a normalized URL, stored in cursors' seen lists. */
export function hashUrlKey(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl, "utf8").digest("base64url").slice(0, 12);
}
