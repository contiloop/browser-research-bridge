/**
 * Fetches a page without the user's cookies, from the bridge process, to obtain the logged-out form
 * of a gated page for validation step d. Redirects are followed by hand and only within
 * the site's hosts (hostnames ∪ extraAllowedHosts, subdomains included); a redirect elsewhere is
 * returned as-is (status 3xx, `url` = its target), which is itself evidence of a wall.
 */
import type { CompletenessInput } from "../../ports/adapter.js";
import { hostnameKey, parseHttpUrl } from "../../core/url.js";
import type { AnonymousFetcher } from "./validate.js";

const MAX_REDIRECTS = 5;
const MAX_BODY_CHARS = 5_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function inHosts(url: URL, hosts: readonly string[]): boolean {
  const h = hostnameKey(url.hostname);
  return hosts.some((a) => {
    const k = hostnameKey(a);
    return h === k || h.endsWith(`.${k}`);
  });
}

export interface AnonymousFetchOptions {
  timeoutMs?: number | undefined;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch | undefined;
}

export function createAnonymousFetcher(options: AnonymousFetchOptions = {}): AnonymousFetcher {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (url, allowedHosts, signal): Promise<CompletenessInput> => {
    const first = parseHttpUrl(url);
    if (first === null) throw new Error(`not an http(s) URL: ${url}`);
    let current: URL = first;
    if (!inHosts(current, allowedHosts)) throw new Error(`${current.hostname} is outside the site's hosts`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response: Response = await doFetch(current.href, {
        redirect: "manual",
        credentials: "omit",
        signal: combined,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9,ko;q=0.8",
        },
      });
      const location: string | null = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        const next: URL = new URL(location, current);
        if (!inHosts(next, allowedHosts) || (next.protocol !== "http:" && next.protocol !== "https:")) {
          const html = (await response.text()).slice(0, MAX_BODY_CHARS);
          return { url: next.href, httpStatus: response.status, html };
        }
        await response.body?.cancel();
        current = next;
        continue;
      }
      const html = (await response.text()).slice(0, MAX_BODY_CHARS);
      return { url: current.href, httpStatus: response.status, html };
    }
    throw new Error(`more than ${MAX_REDIRECTS} redirects`);
  };
}
