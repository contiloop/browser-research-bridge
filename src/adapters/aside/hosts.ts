/**
 * Hostname scoping for browser sessions.
 *
 * A URL is in scope when it is http(s) and its hostname equals one of the scope's hostnames or is a
 * subdomain of one (`reuters.com` covers `www.reuters.com`; `blog.naver.com` does not cover
 * `naver.com`). Declare every host the site legitimately loads pages or data from.
 */

export function normalizeHostname(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/\.$/, "");
  if (raw === "" || /[\s/:?#@\\]/.test(raw)) return null;
  try {
    const host = new URL(`http://${raw}/`).hostname;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** Normalizes and de-duplicates; throws when the list is empty or holds an invalid hostname. */
export function normalizeHostnames(hostnames: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of hostnames) {
    const n = normalizeHostname(h);
    if (n === null) throw new Error(`invalid hostname in browser scope: ${JSON.stringify(h)}`);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length === 0) throw new Error("a browser scope needs at least one hostname");
  return out;
}

export function hostInScope(host: string, hostnames: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return hostnames.some((a) => h === a || h.endsWith(`.${a}`));
}

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; host: string; reason: string };

/** Resolves `url` (against `base` when relative) and checks it is http(s) on the scope's hostnames. */
export function checkUrlInScope(url: string, hostnames: readonly string[], base?: string): UrlCheck {
  let parsed: URL;
  try {
    parsed = base === undefined ? new URL(url) : new URL(url, base);
  } catch {
    return { ok: false, host: "", reason: "not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, host: parsed.hostname, reason: `scheme ${parsed.protocol} is not allowed` };
  }
  if (!hostInScope(parsed.hostname, hostnames)) {
    return { ok: false, host: parsed.hostname, reason: `${parsed.hostname} is outside the site's hostnames` };
  }
  return { ok: true, url: parsed.href, host: parsed.hostname };
}

export interface BlockPattern {
  urlPattern: string;
  block: boolean;
}

/**
 * A host a bridge tab may additionally load from while the bridge itself widens the tab (only a
 * challenge attempt does, with the fixed `CAPTCHA_VENDOR_HOSTS` of captcha.ts): the host or a
 * subdomain, optionally only under `pathPrefix` (which starts and ends with "/").
 */
export interface ExtraHost {
  readonly host: string;
  readonly pathPrefix?: string | undefined;
}

/**
 * Per-tab request filter for CDP `Network.setBlockedURLs` (first matching rule wins): requests to
 * the scope's hostnames and their subdomains pass, everything else is blocked. `extra` (bridge code
 * only) lets a widened tab also reach those hosts, limited to their path prefix.
 */
export function blockedUrlPatterns(
  hostnames: readonly string[],
  extra: readonly ExtraHost[] = [],
): BlockPattern[] {
  const allow = hostnames.flatMap((h) => [
    { urlPattern: `*://${h}/*`, block: false },
    { urlPattern: `*://*.${h}/*`, block: false },
  ]);
  const widened = extra.flatMap((e) => {
    const path = e.pathPrefix ?? "/";
    return [
      { urlPattern: `*://${e.host}${path}*`, block: false },
      { urlPattern: `*://*.${e.host}${path}*`, block: false },
    ];
  });
  return [
    ...allow,
    ...widened,
    { urlPattern: "*://*/*", block: true },
    { urlPattern: "*://*:*/*", block: true },
  ];
}
