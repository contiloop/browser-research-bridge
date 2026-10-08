/**
 * Runs one adapter call in the browser (builds the adapter's `ctx`): gets a place on the site through
 * the scheduler (a pool place, or the whole site when `exclusive`), opens a browser session scoped to
 * the site's hosts (manifest `hostnames` ∪
 * `extraAllowedHosts`) under the lease (politeness interval, budget), builds the adapter context,
 * and always disposes the session. Used by validation, health checks, and live search/read.
 */
import type { AdapterContext, AdapterHelpers } from "../../ports/adapter.js";
import type { BrowserPort } from "../../ports/browser.js";
import type { Clock } from "../../ports/clock.js";
import { systemClock } from "../../ports/clock.js";
import type { LogFields, Logger } from "../../ports/logger.js";
import type { SiteManifest } from "../../ports/manifest.js";
import type { Scheduler } from "../../ports/scheduler.js";

export interface AdapterRuntime {
  browser: BrowserPort;
  scheduler: Scheduler;
  helpers: AdapterHelpers;
  logger: Logger;
  clock?: Clock | undefined;
}

export interface AdapterTaskOptions {
  /** Names the lock holder, e.g. "search", "read", "health check", "validation". */
  holder: string;
  /** Total budget (lock wait + task). */
  budgetMs: number;
  /** Lock wait limit; defaults to the budget. */
  acquireTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Run even while the site cools down (user-initiated checks). */
  ignoreCooldown?: boolean | undefined;
  /** Hold the site alone (validation, health checks); default: share the site's pool (tool calls). */
  exclusive?: boolean | undefined;
}

/** Browser scope of a site: ownership hostnames plus the navigation/request-only extra hosts. */
export function browserHostnames(manifest: Pick<SiteManifest, "hostnames" | "extraAllowedHosts">): string[] {
  return [...new Set([...manifest.hostnames, ...(manifest.extraAllowedHosts ?? [])])];
}

/** A logger that adds `site` to every entry. */
export function siteLogger(logger: Logger, site: string): Logger {
  const withSite = (fields?: LogFields): LogFields => ({ site, ...(fields ?? {}) });
  return {
    debug: (m, f) => logger.debug(m, withSite(f)),
    info: (m, f) => logger.info(m, withSite(f)),
    warn: (m, f) => logger.warn(m, withSite(f)),
    error: (m, f) => logger.error(m, withSite(f)),
  };
}

export async function runAdapterTask<T>(
  runtime: AdapterRuntime,
  site: { key: string; manifest: SiteManifest },
  options: AdapterTaskOptions,
  task: (ctx: AdapterContext) => Promise<T>,
): Promise<T> {
  const clock = runtime.clock ?? systemClock;
  const { key, manifest } = site;
  return runtime.scheduler.runForSite(
    {
      site: key,
      holder: options.holder,
      acquireTimeoutMs: options.acquireTimeoutMs ?? options.budgetMs,
      minIntervalMs: manifest.minIntervalMs,
      signal: options.signal,
      budgetMs: options.budgetMs,
      ignoreCooldown: options.ignoreCooldown,
      exclusive: options.exclusive,
    },
    async (lease) => {
      const session = await runtime.browser.openSession({
        siteKey: key,
        hostnames: browserHostnames(manifest),
        signal: lease.signal,
        lease,
      });
      try {
        const ctx: AdapterContext = {
          browser: session,
          helpers: runtime.helpers,
          manifest,
          logger: siteLogger(runtime.logger, key),
          signal: lease.signal,
          now: () => clock.now(),
        };
        return await task(ctx);
      } finally {
        await session.dispose().catch((error: unknown) => {
          runtime.logger.warn("browser session dispose failed", {
            site: key,
            error: (error as Error).message,
          });
        });
      }
    },
  );
}
