/**
 * redirect_uri allowlist. Entries are exact URLs or trailing-`*` prefix patterns.
 * Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) match on any port, per RFC 8252 §7.3, when the
 * entry has no explicit port: `http://localhost/*` admits `http://localhost:53682/callback`.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface AllowEntry {
  readonly url: URL;
  readonly prefix: boolean;
  readonly anyPort: boolean;
}

/** Parses a redirect URI; null when it is not an absolute http(s) URL without fragment or credentials. */
export function parseRedirectUri(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hash !== "" || value.includes("#") || url.username !== "" || url.password !== "") return null;
  return url;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export class RedirectAllowlist {
  private readonly entries: AllowEntry[];

  /** Throws on a malformed entry so a bad config fails at startup. */
  constructor(patterns: readonly string[]) {
    this.entries = patterns.map((pattern) => {
      const prefix = pattern.endsWith("*");
      const body = prefix ? pattern.slice(0, -1) : pattern;
      if (body.includes("*"))
        throw new Error(`redirect allowlist entry "${pattern}": "*" is only allowed at the end`);
      const url = parseRedirectUri(body);
      if (!url) throw new Error(`redirect allowlist entry "${pattern}" is not an absolute http(s) URL`);
      if (url.search !== "" && prefix)
        throw new Error(`redirect allowlist pattern "${pattern}" must not contain a query`);
      return { url, prefix, anyPort: isLoopbackHost(url.hostname) && url.port === "" };
    });
  }

  allows(redirectUri: string): boolean {
    const candidate = parseRedirectUri(redirectUri);
    if (!candidate) return false;
    return this.entries.some((entry) => entryMatches(entry, candidate));
  }
}

function entryMatches(entry: AllowEntry, candidate: URL): boolean {
  const { url } = entry;
  if (candidate.protocol !== url.protocol || candidate.hostname !== url.hostname) return false;
  if (!entry.anyPort && candidate.port !== url.port) return false;
  if (entry.prefix) return candidate.pathname.startsWith(url.pathname);
  return candidate.pathname === url.pathname && candidate.search === url.search;
}

/**
 * Whether a requested redirect_uri matches one registered by the client: exact match, or for loopback
 * URIs the same scheme, host, path, and query on any port (RFC 8252 §7.3).
 */
export function redirectUriMatchesRegistered(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  const req = parseRedirectUri(requested);
  const reg = parseRedirectUri(registered);
  if (!req || !reg) return false;
  if (!isLoopbackHost(req.hostname) || !isLoopbackHost(reg.hostname)) return false;
  return (
    req.protocol === reg.protocol &&
    req.hostname === reg.hostname &&
    req.pathname === reg.pathname &&
    req.search === reg.search
  );
}
