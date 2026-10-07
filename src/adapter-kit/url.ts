/**
 * URL helpers for adapters: resolving hrefs, host checks, query parameters, and building a
 * site-specific `canonicalize(url)`. A canonicalizer maps the site's URL variants of one
 * article (mobile/desktop, print views, tracking or session parameters) to one URL that still opens
 * the same page; the core's dedup normalization runs after it and result ids are built from it.
 */
import { hostnameKey, parseHttpUrl } from "../core/url.js";

/** Resolves `href` against `base`; null unless the result is an http(s) URL. */
export function absoluteUrl(href: string, base?: string): string | null {
  const h = href.trim();
  if (h === "" || /^(?:javascript|mailto|tel|data):/i.test(h)) return null;
  try {
    const u = base !== undefined ? new URL(h, base) : new URL(h);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** True when `url` is http(s) on one of `hosts` or a subdomain of one (`www.` ignored). */
export function urlOnHosts(url: string, hosts: readonly string[]): boolean {
  const u = parseHttpUrl(url);
  if (!u) return false;
  const host = hostnameKey(u.hostname);
  return hosts.some((h) => {
    const k = hostnameKey(h);
    return host === k || host.endsWith(`.${k}`);
  });
}

/** The first value of query parameter `name`, or null (also null for a malformed URL). */
export function queryParam(url: string, name: string): string | null {
  const u = parseHttpUrl(url);
  return u ? u.searchParams.get(name) : null;
}

export interface CanonicalizeOptions {
  /** Replace the host (e.g. `m.blog.naver.com` → `blog.naver.com`). */
  host?: string | undefined;
  /** Force `https:`. */
  https?: boolean | undefined;
  /** Drop a leading `www.` from the host. */
  stripWww?: boolean | undefined;
  /** Query parameters to keep (all others are dropped); default: keep all except `dropParams`. */
  keepParams?: readonly string[] | undefined;
  /** Query parameters to drop (exact names; `prefix*` drops by prefix). */
  dropParams?: readonly string[] | undefined;
  /** Drop a trailing slash from a non-root path. */
  stripTrailingSlash?: boolean | undefined;
  /** Keep the `#fragment` (dropped by default). */
  keepFragment?: boolean | undefined;
}

/**
 * Applies generic canonicalization steps. Returns the input unchanged when it is not an http(s)
 * URL, so a canonicalizer never throws on odd input.
 */
export function canonicalizeUrl(url: string, options: CanonicalizeOptions = {}): string {
  const u = parseHttpUrl(url);
  if (!u) return url;
  if (options.https) u.protocol = "https:";
  if (options.host !== undefined) u.hostname = options.host;
  if (options.stripWww && u.hostname.toLowerCase().startsWith("www.")) u.hostname = u.hostname.slice(4);
  u.hostname = u.hostname.toLowerCase();
  if (!options.keepFragment) u.hash = "";
  const keep = options.keepParams ? new Set(options.keepParams) : null;
  const drop = options.dropParams ?? [];
  const dropped = (name: string): boolean =>
    drop.some((d) => (d.endsWith("*") ? name.startsWith(d.slice(0, -1)) : name === d));
  const kept = [...u.searchParams].filter(([name]) => (keep ? keep.has(name) : true) && !dropped(name));
  u.search = kept.length > 0 ? new URLSearchParams(kept).toString() : "";
  if (options.stripTrailingSlash && u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  }
  return u.href;
}
