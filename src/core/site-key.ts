/** Site keys: `[a-z0-9-]{2,32}`, derived from a hostname by default. */

export const SITE_KEY_PATTERN = /^[a-z0-9-]{2,32}$/;
export const SITE_KEY_MAX_LENGTH = 32;

export function isValidSiteKey(key: string): boolean {
  return SITE_KEY_PATTERN.test(key);
}

/**
 * Common two-level public suffixes. Any other hostname is treated as having a one-label suffix
 * (`.com`, `.de`, …). Not a full Public Suffix List; covers the frequent ccTLD second levels.
 */
export const TWO_LEVEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // Korea
  "co.kr",
  "or.kr",
  "ne.kr",
  "go.kr",
  "ac.kr",
  "re.kr",
  "pe.kr",
  // United Kingdom
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  // Australia / New Zealand
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "asn.au",
  "id.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "govt.nz",
  // Japan
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "gr.jp",
  "ad.jp",
  // Greater China
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "com.tw",
  "org.tw",
  "net.tw",
  "idv.tw",
  "com.hk",
  "org.hk",
  "net.hk",
  // Others
  "co.in",
  "net.in",
  "org.in",
  "com.br",
  "net.br",
  "org.br",
  "com.mx",
  "org.mx",
  "com.ar",
  "com.sg",
  "org.sg",
  "edu.sg",
  "co.za",
  "org.za",
  "com.tr",
  "org.tr",
  "com.my",
  "com.ph",
  "co.id",
  "or.id",
  "co.il",
  "org.il",
  "com.vn",
  "co.th",
  "com.pk",
  "com.ng",
  "com.eg",
  "com.sa",
  "com.ua",
  "co.ke",
]);

function sanitize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, SITE_KEY_MAX_LENGTH)
    .replace(/-+$/, "");
}

function toHostname(input: string): string {
  const s = input.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`).hostname;
  } catch {
    return s.toLowerCase();
  }
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/** Strips the public suffix (`reuters.com` → `reuters`, `chosun.co.kr` → `chosun`). */
export function stripPublicSuffix(hostname: string): string {
  const labels = hostname.split(".").filter((l) => l !== "");
  if (labels.length < 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const suffixLength = TWO_LEVEL_PUBLIC_SUFFIXES.has(lastTwo) && labels.length > 2 ? 2 : 1;
  return labels.slice(0, -suffixLength).join(".");
}

/**
 * The registrable domain of a hostname: the public suffix plus one label (`dd.reuters.com` →
 * `reuters.com`, `news.chosun.co.kr` → `chosun.co.kr`). A hostname that is itself a suffix or a
 * single label is returned as is. Uses the same suffix table as {@link stripPublicSuffix}.
 */
export function registrableDomain(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  const labels = host.split(".").filter((l) => l !== "");
  if (labels.length < 2 || isIpAddress(host)) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const suffixLength = TWO_LEVEL_PUBLIC_SUFFIXES.has(lastTwo) && labels.length > 2 ? 2 : 1;
  return labels.slice(-(suffixLength + 1)).join(".");
}

/**
 * Default key for a hostname (or URL): without `www.` and the public suffix, dots → hyphens.
 * Falls back to the full hostname when the stripped form is shorter than 2 characters.
 */
export function deriveSiteKey(hostnameOrUrl: string): string {
  let host = toHostname(hostnameOrUrl).toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("www.")) host = host.slice(4);
  const base = isIpAddress(host) ? host : stripPublicSuffix(host);
  let key = sanitize(base.replace(/\./g, "-"));
  if (key.length < 2) key = sanitize(host.replace(/\./g, "-"));
  if (key.length < 2) key = sanitize(`${key}-site`);
  return key;
}

/** Returns `base` when free, else `base-2`, `base-3`, … trimmed to stay within 32 characters. */
export function uniqueSiteKey(base: string, taken: ReadonlySet<string> | ((key: string) => boolean)): string {
  const isTaken = typeof taken === "function" ? taken : (key: string): boolean => taken.has(key);
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const head = base.slice(0, SITE_KEY_MAX_LENGTH - suffix.length).replace(/-+$/, "");
    const candidate = `${head}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
}
