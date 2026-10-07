/**
 * Test fixtures for the onboarding tests: a miniature repository in a temp directory with a real
 * registry, a scripted agent runner (the agent runtime port), a validator stand-in that records a
 * report for the staged files (validation of real sites is never faked outside unit tests), and a
 * browser port whose sessions only record what they were asked to do.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  adapterSource,
  makeTempDir,
  manifestFor,
  passedReport,
  silentLogger,
} from "../../../test/support/site-fixtures.js";
import type { BrowserPort, BrowserScope, BrowserSession, TabHandle } from "../../ports/browser.js";
import type { SiteCommitAction } from "../../ports/site-store.js";
import { InMemoryScheduler } from "../aside/scheduler.js";
import { promoteStaging, removeSite } from "../registry/operations.js";
import type { SiteOperationsDeps } from "../registry/operations.js";
import { ModuleAdapterLoader } from "../registry/loader.js";
import { SiteRegistryService } from "../registry/registry.js";
import { FileCache } from "../storage/cache-store.js";
import { FileSiteStateStore } from "../storage/site-state-store.js";
import { computeAdapterHash, writeValidationReport } from "../validation/report.js";
import type { ValidationReport } from "../validation/report.js";
import { MemoryJobStore } from "./job-store.js";
import { OnboardingJobService } from "./service.js";
import type { OnboardingJobServiceOptions } from "./service.js";
import { SiteStagingValidation } from "./staging-validation.js";
import type { AgentRunRequest, AgentRunResult, AgentRunner, AgentToolResult } from "./types.js";

export { adapterSource, manifestFor };

export interface RunScriptContext {
  req: AgentRunRequest;
  call(name: string, args: Record<string, unknown>): Promise<AgentToolResult>;
}
export type RunScript = (ctx: RunScriptContext) => Promise<Partial<AgentRunResult> | void>;

/** Agent runner port driven by scripts (one per run, in order). */
export class ScriptedRunner implements AgentRunner {
  readonly requests: AgentRunRequest[] = [];
  active = 0;
  maxActive = 0;
  private runs = 0;

  constructor(private readonly scripts: RunScript[] = []) {}

  push(...scripts: RunScript[]): void {
    this.scripts.push(...scripts);
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(req);
    this.runs += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const sessionId = req.resumeSessionId ?? `session-${this.runs}`;
    req.onEvent({ type: "session", sessionId, model: "fake", authSource: "none", tools: [] });
    try {
      const script = this.scripts.shift();
      const call = async (name: string, args: Record<string, unknown>): Promise<AgentToolResult> => {
        const t = req.tools.find((x) => x.name === name);
        if (!t) throw new Error(`no tool ${name}`);
        return t.call(args);
      };
      const r = script ? await script({ req, call }) : undefined;
      return { sessionId, outcome: "completed", message: null, turns: 2, costUsd: null, ...(r ?? {}) };
    } finally {
      this.active -= 1;
    }
  }
}

/** Resolves once `signal` aborts (an agent that keeps working until cancelled). */
export function untilAborted(signal: AbortSignal): Promise<Partial<AgentRunResult>> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve({ outcome: "aborted" });
    signal.addEventListener("abort", () => resolve({ outcome: "aborted" }), { once: true });
  });
}

/** Script steps that write a minimal adapter into staging and validate it. */
export async function writeAndValidate(
  ctx: RunScriptContext,
  key: string,
  host: string,
  tag = "v1",
): Promise<void> {
  await ctx.call("write_staging_file", {
    path: "manifest.json",
    content: JSON.stringify(manifestFor(key, { hostnames: [host], createdBy: "agent" })),
  });
  await ctx.call("write_staging_file", { path: "adapter.ts", content: adapterSource(tag) });
  await ctx.call("write_staging_file", { path: "NOTES.md", content: `# ${key}\n` });
  await ctx.call("run_validation", {});
}

export interface FakeTab {
  handle: TabHandle;
  scopeHosts: readonly string[];
}

export interface RecordingBrowser extends BrowserPort {
  scopes: BrowserScope[];
  opened: { url: string; hosts: readonly string[] }[];
  scripts: string[];
  disposed: number;
}

/** A browser port that records requests; it never pretends to be a site (no page content). */
export function recordingBrowser(): RecordingBrowser {
  let tabN = 0;
  const port: RecordingBrowser = {
    scopes: [],
    opened: [],
    scripts: [],
    disposed: 0,
    async status() {
      return { reachable: true, account: "u0" };
    },
    async openSession(scope: BrowserScope): Promise<BrowserSession> {
      port.scopes.push(scope);
      return {
        scope,
        async openTab(url: string) {
          const host = new URL(url).hostname;
          if (!scope.hostnames.some((h) => host === h || host.endsWith(`.${h}`))) {
            throw new Error(`blocked by the bridge: openTab to ${host}`);
          }
          await scope.lease?.beforePageLoad();
          port.opened.push({ url, hosts: scope.hostnames });
          tabN += 1;
          return { id: `target-${tabN}`, url };
        },
        async closeTab() {},
        async snapshot() {
          return "snapshot";
        },
        async runScript(script: string) {
          port.scripts.push(script);
          return { ran: true };
        },
        async fetch() {
          throw new Error("not used");
        },
        async screenshot() {
          return { mimeType: "image/png" as const, base64: "iVBORw0KGgo=" };
        },
        async dispose() {
          port.disposed += 1;
        },
      };
    },
    async shutdown() {},
  };
  return port;
}

export interface Harness {
  dir: string;
  sitesDir: string;
  registry: SiteRegistryService;
  store: MemoryJobStore;
  runner: ScriptedRunner;
  browser: RecordingBrowser;
  commits: [string, SiteCommitAction][];
  /** Service-run validation results to return, in order (default: pass). */
  serviceVerdicts: boolean[];
  /** Every `validator.full` call: `agent` while the agent's run is going on, else `service`. */
  validations: string[];
  /** The `ignoreCooldown` option of every `validator.full` call. */
  validationIgnoresCooldown: boolean[];
  makeService(overrides?: Partial<OnboardingJobServiceOptions>): OnboardingJobService;
  cleanup(): Promise<void>;
}

function failedReport(key: string, hash: string | null): ValidationReport {
  return {
    ...passedReport(key, hash, "staging"),
    passed: false,
    failure: { step: "read", status: "adapter_error", message: "read returned no text" },
  };
}

export async function makeHarness(): Promise<Harness> {
  const tmp = await makeTempDir("brb-onb-");
  const dir = tmp.dir;
  const sitesDir = join(dir, "sites");
  await mkdir(join(dir, "src", "adapter-kit"), { recursive: true });
  await writeFile(join(dir, "src", "adapter-kit", "index.ts"), 'export const kitName: string = "kit";\n');
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "ADAPTERS.md"), "# Writing a site adapter\n");
  await writeFile(join(dir, "package.json"), '{"name":"secret"}\n');
  await mkdir(sitesDir, { recursive: true });
  const registry = new SiteRegistryService({
    sitesDir,
    stateStore: new FileSiteStateStore(join(dir, "data", "sites.json")),
    loader: new ModuleAdapterLoader({ repoRoot: dir, preferCompiled: false }),
    cache: new FileCache(join(dir, "data", "cache")),
    logger: silentLogger,
  });
  await registry.init();
  const store = new MemoryJobStore();
  const runner = new ScriptedRunner();
  const browser = recordingBrowser();
  const commits: [string, SiteCommitAction][] = [];
  const serviceVerdicts: boolean[] = [];
  const validations: string[] = [];
  const validationIgnoresCooldown: boolean[] = [];
  const opsDeps: SiteOperationsDeps = {
    registry,
    repoRoot: dir,
    committer: {
      async commitSite(key, action) {
        commits.push([key, action]);
        return { committed: true, commit: "c0ffee" };
      },
    },
    logger: silentLogger,
  };

  const h: Harness = {
    dir,
    sitesDir,
    registry,
    store,
    runner,
    browser,
    commits,
    serviceVerdicts,
    validations,
    validationIgnoresCooldown,
    makeService(overrides = {}) {
      const validation = new SiteStagingValidation({
        validator: {
          async full(key, opts) {
            const staging = registry.stagingDir(key);
            const hash = await computeAdapterHash(staging);
            const agentRun = runner.active > 0;
            validations.push(agentRun ? "agent" : "service");
            validationIgnoresCooldown.push(opts?.ignoreCooldown === true);
            const pass = agentRun ? true : (serviceVerdicts.shift() ?? true);
            const report = pass ? passedReport(key, hash, "staging") : failedReport(key, hash);
            if (opts?.write !== false) await writeValidationReport(staging, report);
            return report;
          },
        },
        sitesDir,
        repoRoot: dir,
        hostnameOwner: (host) => registry.hostnameOwner(host),
        typechecker: async () => [],
      });
      return new OnboardingJobService({
        registry,
        store,
        runner,
        validation,
        operations: {
          promote: (key, action) => promoteStaging(opsDeps, key, { action }),
          remove: (key, options) => removeSite(opsDeps, key, options),
        },
        browser,
        scheduler: new InMemoryScheduler({ maxConcurrentSites: 4, coolDownMs: 600_000 }),
        repoRoot: dir,
        sitesDir,
        workRoot: join(dir, "data", "jobs", "work"),
        cancelWaitMs: 5_000,
        logger: silentLogger,
        ...overrides,
      });
    },
    cleanup: () => tmp.cleanup(),
  };
  return h;
}
