/**
 * `npm run site:validate -- <key> [--staging] [--light]`: validates one adapter
 * against the real site in the user's logged-in Aside browser. No mocks: requires the Aside app
 * running and the Aside CLI signed in (`aside login`).
 *
 * Full form (default) writes `validation.json` into the validated folder; `--light` runs the
 * health-check form and only prints. Exit code 0 when validation passes, 1 when it fails, 2 on a
 * usage or setup error.
 */
import { resolve } from "node:path";
import { ConfigError, loadConfig } from "../../app/config.js";
import type { AdapterHelpers } from "../../ports/adapter.js";
import type { LogFields, Logger } from "../../ports/logger.js";
import { AsideBrowserPort, InMemoryScheduler, McpReplClient, stdioTransportFactory } from "../aside/index.js";
import { scanSiteFolders } from "../registry/folders.js";
import { ModuleAdapterLoader } from "../registry/loader.js";
import { hostnameKey } from "../../core/url.js";
import { FileSiteStateStore, siteStatePath } from "../storage/site-state-store.js";
import { createAnonymousFetcher } from "./anonymous-fetch.js";
import { parseCliArgs } from "./cli-args.js";
import { summarizeReport } from "./report.js";
import type { ValidationReport } from "./report.js";
import { SiteValidator } from "./validator.js";

const USAGE = `Usage: npm run site:validate -- <key> [--staging] [--light] [--account <aside-account>] [--json] [--verbose]

Validates sites/<key>/ (or sites/<key>/.staging/ with --staging) against the real site in the
logged-in Aside browser. Requires the Aside app running and \`aside login\`.

  --staging   validate the staged adapter in sites/<key>/.staging/
  --light     health-check form: sample search (limit 3) and sample read only; prints, writes nothing
  --account   Aside account (default: config asideAccount, usually u0)
  --json      print the full report as JSON
  --verbose   print browser/adapter log lines
  -h, --help  show this help

The full form writes validation.json into the validated folder. Exit code: 0 passed, 1 failed, 2 error.`;

function consoleLogger(verbose: boolean): Logger {
  const line = (level: string, message: string, fields?: LogFields): void => {
    if (!verbose && (level === "debug" || level === "info")) return;
    console.error(`  [${level}] ${message} ${fields ? JSON.stringify(fields) : ""}`);
  };
  return {
    debug: (m, f) => line("debug", m, f),
    info: (m, f) => line("info", m, f),
    warn: (m, f) => line("warn", m, f),
    error: (m, f) => line("error", m, f),
  };
}

/** The adapter helpers come from the adapter helper package (`createAdapterHelpers`, src/adapter-kit). */
async function loadHelpers(): Promise<AdapterHelpers> {
  const kit = (await import("../../adapter-kit/index.js")) as Record<string, unknown>;
  const factory = kit["createAdapterHelpers"];
  if (typeof factory === "function") return (factory as () => AdapterHelpers)();
  const ready = kit["adapterHelpers"];
  if (typeof ready === "object" && ready !== null) return ready as AdapterHelpers;
  throw new Error("src/adapter-kit does not export createAdapterHelpers() (or adapterHelpers)");
}

function printReport(report: ValidationReport): void {
  for (const step of report.steps) {
    console.log(
      `${step.passed ? "PASS" : "FAIL"}  ${step.name}: ${step.message} (${(step.durationMs / 1000).toFixed(1)} s)`,
    );
  }
  console.log(summarizeReport(report));
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseCliArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error !== null || args.key === null) {
    console.error(`site:validate: ${args.error ?? "missing <key>"}\n\n${USAGE}`);
    return 2;
  }
  const key = args.key;

  let config;
  try {
    // The CLI uses no secrets; a placeholder satisfies the loader when .env has no passphrase.
    const env = { ...process.env };
    if ((env["BRIDGE_PASSPHRASE"] ?? "").trim().length < 12)
      env["BRIDGE_PASSPHRASE"] = "site-validate-cli-unused";
    config = loadConfig({ env });
  } catch (error) {
    console.error(`site:validate: ${error instanceof ConfigError ? error.message : String(error)}`);
    return 2;
  }
  const repoRoot = resolve(process.cwd());
  const logger = consoleLogger(args.verbose);

  let helpers: AdapterHelpers;
  try {
    helpers = await loadHelpers();
  } catch (error) {
    console.error(`site:validate: ${(error as Error).message}`);
    return 2;
  }

  // Hostname ownership of the other sites (folder manifests and provisional Add hostnames).
  const owners = new Map<string, string>();
  for (const folder of await scanSiteFolders(config.sitesDir)) {
    for (const h of folder.manifest?.hostnames ?? []) owners.set(hostnameKey(h), folder.key);
  }
  try {
    for (const state of await new FileSiteStateStore(siteStatePath(config.dataDir)).load()) {
      for (const h of state.provisionalHostnames)
        if (!owners.has(hostnameKey(h))) owners.set(hostnameKey(h), state.key);
    }
  } catch (error) {
    logger.warn("cannot read the site state file", { error: (error as Error).message });
  }

  const account = args.account ?? config.asideAccount;
  const command = process.env["ASIDE_CLI"];
  const repl = new McpReplClient({
    account,
    transportFactory: stdioTransportFactory(command ? { command } : {}),
    logger,
  });
  const browser = new AsideBrowserPort({
    repl,
    logger,
    stepTimeoutMs: config.tunables.adapterStepTimeoutMs,
    warmTabTtlMs: 0,
  });
  const scheduler = new InMemoryScheduler({
    maxConcurrentSites: config.tunables.maxConcurrentSites,
    coolDownMs: config.tunables.coolDownSeconds * 1000,
  });
  const validator = new SiteValidator({
    sitesDir: config.sitesDir,
    repoRoot,
    loader: new ModuleAdapterLoader({ repoRoot }),
    runtime: { browser, scheduler, helpers, logger },
    anonymousFetch: createAnonymousFetcher(),
    hostnameOwner: (h) => owners.get(hostnameKey(h)) ?? null,
    stepBudgetMs: config.tunables.toolCallBudgetMs,
    logger,
  });

  const form = args.light ? "light" : "full";
  console.log(
    `site:validate ${key} — ${form} form, ${args.staging ? "staged" : "live"} adapter, Aside account ${account}`,
  );
  try {
    const status = await browser.status();
    if (!status.reachable) {
      console.error(
        `site:validate: Aside is not reachable: ${status.message ?? ""} ${status.action ? `(${status.action})` : ""}`,
      );
      return 2;
    }
    const report = args.light
      ? await validator.light(key, { ignoreCooldown: true })
      : await validator.full(key, { staging: args.staging, ignoreCooldown: true });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    return report.passed ? 0 : 1;
  } finally {
    await browser.shutdown().catch(() => undefined);
  }
}

process.exitCode = await main(process.argv.slice(2));
