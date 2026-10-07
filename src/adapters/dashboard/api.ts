/**
 * Dashboard JSON API. Mounted under `/api` behind the guards of ./security.ts.
 *
 * Reads: overview (public URL, MCP URL), browser status, sites, jobs, job log, job events (SSE),
 * OAuth clients, cache sizes. Writes: Add / Retry / Repair / Check now / Remove, job retry/cancel,
 * OAuth revoke, cache clear. Responses never carry the admin token, the passphrase, or OAuth token
 * values (only token ids, which are storage hashes).
 *
 * Settings page: `status`, `settings` (GET/PUT), `restart`, `chatgpt` (GET/DELETE,
 * `setup`, `retry`), `helper` (GET, `check`). Secrets (the passphrase, the tunnel runtime key) are
 * received and handed on, never returned or logged. The last helper check is kept here, outside the
 * core, so it survives core restarts.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import type { ClientSummary } from "../oauth/index.js";
import {
  OnboardingRequestError,
  isActiveJobState,
  isHelperRuntimeId,
  jobLang,
  jobRuntime,
  parseHelperLang,
} from "../onboarding/index.js";
import type { HelperCheckResult, JobEvent, JobLogLine, OnboardingJob } from "../onboarding/index.js";
import type { ChatgptFailure } from "../../app/chatgpt-connection.js";
import { validateSetupInput } from "../../app/chatgpt-connection.js";
import type { SettingsWriteResult } from "../../ports/settings-store.js";
import type { RegistrySite } from "../registry/index.js";
import type { BrowserStatus } from "../../ports/browser.js";
import { CoreNotRunningError, lazyDashboardDeps, toDashboardSource } from "./deps.js";
import type { DashboardDeps, DashboardSource, PageSettingsChange, SettingsPreview } from "./deps.js";

const SERVING = new Set(["active", "needs_login", "degraded"]);
const REPAIRABLE = new Set(["active", "degraded", "failed"]);
const MAX_JOBS = 50;
const SSE_PING_MS = 15_000;

export type SiteAction = "retry" | "repair" | "check" | "remove" | "cancel";

export interface ApiOptions {
  /** `http://127.0.0.1:<port>` (shown in the overview). */
  adminOrigin: () => string;
  /** Path of the admin token file (shown, never its content). */
  tokenFile: string;
  /** Keep-alive interval of the SSE stream (tests shorten it). */
  ssePingMs?: number | undefined;
  /** The port the settings page actually listens on (shown in `GET settings` → `info.adminPort`). */
  adminPort?: (() => number) | undefined;
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** The buttons a site row offers (Add/Retry/Repair/Check now/Remove; Cancel for a running job). */
export function siteActions(
  site: RegistrySite,
  job: OnboardingJob | undefined,
  checking: boolean,
): SiteAction[] {
  const actions: SiteAction[] = [];
  const jobActive = job !== undefined && isActiveJobState(job.state);
  if (job !== undefined && (job.state === "awaiting_user" || job.state === "failed")) actions.push("retry");
  else if (!jobActive && site.status === "failed" && !site.loadable) actions.push("retry");
  if (!jobActive && REPAIRABLE.has(site.status) && (site.loadable || site.folderProblem !== null)) {
    actions.push("repair");
  }
  if (site.loadable && SERVING.has(site.status) && !checking) actions.push("check");
  if (jobActive) actions.push("cancel");
  actions.push("remove");
  return actions;
}

function jobSummary(job: OnboardingJob): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    key: job.key,
    input: job.input,
    note: job.note,
    hostnames: job.hostnames,
    state: job.state,
    reason: job.reason,
    requestedAction: job.requestedAction,
    summary: job.summary,
    validation: job.validation,
    lastFailure: job.lastFailure,
    attempts: job.attempts,
    commit: job.commit,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lang: jobLang(job),
    runtime: jobRuntime(job),
  };
}

function clientView(client: ClientSummary, now: number): Record<string, unknown> {
  const live = client.tokens.filter((t) => t.revokedAt === null && Date.parse(t.expiresAt) > now);
  const families = new Map<string, typeof live>();
  for (const t of live) families.set(t.familyId, [...(families.get(t.familyId) ?? []), t]);
  const redirectHosts = [
    ...new Set(
      client.redirectUris.map((u) => {
        try {
          return new URL(u).host;
        } catch {
          return u;
        }
      }),
    ),
  ];
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    source: client.source,
    redirectHosts,
    createdAt: client.createdAt,
    lastTokenIssuedAt: client.lastTokenIssuedAt,
    activeTokens: client.activeTokens,
    // One entry per connection (token family); `tokenId` revokes the whole family.
    connections: [...families.values()].map((tokens) => ({
      tokenId: tokens[0]!.tokenId,
      kinds: tokens.map((t) => t.kind).sort(),
      createdAt: tokens.map((t) => t.createdAt).sort()[0],
      expiresAt: tokens
        .map((t) => t.expiresAt)
        .sort()
        .at(-1),
    })),
  };
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "the request body must be JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "the request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string`);
  return value;
}

function parseSeq(value: string | undefined): number {
  if (value === undefined) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Routes that need the running core; they answer 503 `not_running` while it is off. */
const CORE_ROUTES = /^(?:\/api)?\/(?:overview|browser|sites|jobs|oauth|cache|helper|chatgpt\/retry)(?:\/|$)/;

/** A JSON answer of the settings-page routes. */
interface Answer {
  status: 200 | 202 | 400 | 404 | 409 | 500 | 503;
  body: Record<string, unknown>;
}

const PAGE_FIELDS = ["passphrase", "helperRuntime", "asideAccount"] as const;

/**
 * Every `error` code the settings-page API answers with (this module, the guards in security.ts,
 * and the fallbacks in server.ts). The page labels exactly this set; a ChatGPT connection code the
 * page passes through must be listed here or `chatgptAnswer` does not compile.
 */
export const API_ERROR_CODES = [
  "invalid",
  "busy",
  "job_running",
  "locked",
  "file_unreadable",
  "tool_missing",
  "exists",
  "external",
  "not_configured",
  "config_invalid",
  "not_running",
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "too_large",
  "server_error",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

function failure(
  status: Answer["status"],
  error: ApiErrorCode,
  message: string,
  fields?: Partial<Record<string, string>>,
): Answer {
  return { status, body: fields === undefined ? { error, message } : { error, message, fields } };
}

function busyAnswer(message = "a restart is already in progress; try again when it has finished"): Answer {
  return failure(409, "busy", message);
}

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "busy" || code === "stopped";
}

/** ChatGPT connection service failures → HTTP (`invalid` 400, `not_running` 503, `prepare_failed` a 500 `server_error`, the rest 409). */
function chatgptAnswer(result: ChatgptFailure): Answer {
  const fields = result.fields;
  switch (result.error) {
    case "invalid":
      return failure(400, "invalid", result.message, fields ?? {});
    case "not_running":
      return failure(503, "not_running", result.message);
    case "prepare_failed":
      return failure(500, "server_error", result.message);
    default:
      return failure(409, result.error, result.message, fields);
  }
}

function previewAnswer(result: Exclude<SettingsPreview, { ok: true }>): Answer {
  switch (result.error) {
    case "invalid":
      return failure(400, "invalid", result.message, result.fields);
    case "locked":
      return failure(409, "locked", result.message, result.fields);
    case "file_unreadable":
      return failure(409, "file_unreadable", result.message);
  }
}

function writeAnswer(result: Extract<SettingsWriteResult, { ok: false }>): Answer {
  switch (result.error) {
    case "invalid":
      return failure(400, "invalid", result.message, result.fields);
    case "locked":
      return failure(409, "locked", result.message, result.fields);
    case "file_unreadable":
      return failure(409, "file_unreadable", result.message);
  }
}

const JOB_RUNNING_MESSAGE =
  "a site-add or repair job is running; it will be interrupted (send confirmInterrupt: true to continue)";

export function createApi(input: DashboardDeps | DashboardSource, options: ApiOptions): Hono {
  const source = toDashboardSource(input);
  const { logger } = source;
  const notRunningMessage = (): string => {
    const status = source.runMode?.status();
    if (status?.mode === "restarting") return "the bridge is restarting; try again in a moment";
    if (status?.problem) return `the bridge is not running: ${status.problem.message}`;
    return "the bridge is not running";
  };
  const requireCore = (): DashboardDeps => {
    const current = source.core();
    if (current === null) throw new CoreNotRunningError(notRunningMessage());
    return current;
  };
  // Every field is resolved on access, so each request uses the core that is running now.
  const deps = lazyDashboardDeps(requireCore);
  const api = new Hono();
  const ssePingMs = options.ssePingMs ?? SSE_PING_MS;

  // One browser probe at a time (the Aside probe can take seconds).
  let probe: Promise<BrowserStatus> | null = null;
  const browserStatus = (): Promise<BrowserStatus> => {
    const current = requireCore();
    return (probe ??= current.browser
      .status()
      .catch((error: unknown): BrowserStatus => ({
        reachable: false,
        account: current.config.asideAccount,
        message: (error as Error).message,
      }))
      .finally(() => {
        probe = null;
      }));
  };

  // ------------------------------------------------------------------ settings page helpers

  /** The last helper check of this process (outlives core restarts). */
  let lastCheck: HelperCheckResult | null = null;

  const respond = (c: Context, answer: Answer): Response => c.json(answer.body, answer.status);

  /** A save or restart interrupts a job only when one is in state `running`; queued jobs do not count. */
  const jobRunning = (): boolean =>
    source
      .core()
      ?.jobs.list()
      .some((j) => j.state === "running") ?? false;

  /**
   * Runs `step` inside the run-mode control's exclusive section and restarts the core when it
   * proceeds. Answers with the step's refusal (no restart), or 202 as soon as the step proceeded
   * (the restart continues; the page follows it through `GET status`).
   */
  const restartWith = (
    reason: string,
    step: () => Promise<{ proceed: boolean; answer: Answer }>,
  ): Promise<Answer> => {
    const runMode = source.runMode;
    if (!runMode) return Promise.resolve(failure(404, "not_found", "run-mode control is not available"));
    return new Promise<Answer>((resolve) => {
      let held: Answer | null = null;
      let answered = false;
      const answer = (value: Answer): void => {
        if (answered) return;
        answered = true;
        resolve(value);
      };
      runMode
        .restart({
          reason,
          prepare: async () => {
            const outcome = await step();
            if (!outcome.proceed) {
              held = outcome.answer;
              return false;
            }
            answer(outcome.answer);
            return true;
          },
        })
        .then(
          () => {
            if (held) answer(held);
          },
          (error: unknown) => {
            if (isBusyError(error)) return answer(busyAnswer((error as Error).message));
            logger.error("settings page restart failed", { reason, error: (error as Error).message });
            answer(failure(500, "server_error", "internal error; see the bridge log"));
          },
        );
    });
  };

  /** Removes every connected app (OAuth client with its tokens); false when it could not be done. */
  const disconnectAllApps = async (): Promise<boolean> => {
    try {
      const current = source.core();
      if (current !== null) {
        for (const client of await current.oauth.listClients()) {
          await current.oauth.revoke({ clientId: client.clientId });
        }
        return true;
      }
      if (!source.settingsPage) return false;
      await source.settingsPage.revokeAllAppsOffline();
      return true;
    } catch (error) {
      logger.warn("disconnecting all connected apps failed", { error: (error as Error).message });
      return false;
    }
  };

  const supportedRuntimes = () => source.settingsPage?.supportedRuntimes() ?? ["claude"];

  /** Body field types of `PUT settings`; field codes `bad_value` (wrong type or unsupported runtime). */
  const parseSettingsBody = (
    body: Record<string, unknown>,
  ): { ok: true; change: PageSettingsChange; disconnectApps: boolean } | { ok: false; answer: Answer } => {
    const fields: Record<string, string> = {};
    const change: PageSettingsChange = {};
    for (const name of PAGE_FIELDS) {
      const value = body[name];
      if (value === undefined) continue;
      if (typeof value !== "string") fields[name] = "bad_value";
      else change[name] = value;
    }
    if (change.helperRuntime !== undefined) {
      const runtime = change.helperRuntime;
      const known = runtime === "auto" || isHelperRuntimeId(runtime);
      if (!known || (runtime !== "auto" && !supportedRuntimes().includes(runtime))) {
        fields["helperRuntime"] = "bad_value";
      }
    }
    const disconnect = body["disconnectApps"];
    if (disconnect !== undefined && typeof disconnect !== "boolean") fields["disconnectApps"] = "bad_value";
    if (Object.keys(fields).length > 0) {
      const message = `invalid: ${Object.entries(fields)
        .map(([f, code]) => `${f} ${code}`)
        .join(", ")}`;
      return { ok: false, answer: failure(400, "invalid", message, fields) };
    }
    return { ok: true, change, disconnectApps: disconnect === true };
  };

  api.use("*", async (c, next) => {
    if (CORE_ROUTES.test(c.req.path) && source.core() === null) {
      return c.json({ error: "not_running", message: notRunningMessage() }, 503);
    }
    await next();
  });

  api.onError((error, c) => {
    if (error instanceof CoreNotRunningError)
      return c.json({ error: "not_running", message: error.message }, 503);
    if (error instanceof HttpError)
      return c.json({ error: "bad_request", message: error.message }, error.status);
    if (error instanceof OnboardingRequestError) {
      const status = error.code === "conflict" ? 409 : error.code === "not_found" ? 404 : 400;
      return c.json({ error: error.code, message: error.message }, status);
    }
    logger.error("dashboard request failed", { path: c.req.path, error: error.message });
    return c.json({ error: "server_error", message: "internal error; see the bridge log" }, 500);
  });

  api.get("/overview", (c) =>
    c.json({
      publicUrl: deps.config.publicUrl,
      publicUrlConfigured: deps.config.publicUrlConfigured,
      mcpUrl: deps.oauth.resource,
      dashboardUrl: options.adminOrigin(),
      asideAccount: deps.config.asideAccount,
      adminTokenFile: options.tokenFile,
    }),
  );

  api.get("/browser", async (c) => c.json(await browserStatus()));

  api.get("/sites", async (c) => {
    const bySite = await deps.fileCache.statsBySite();
    const sites = deps.registry.list().map((site) => {
      const job = deps.jobs.get(site.key);
      const checking = deps.health.isChecking(site.key);
      return {
        key: site.key,
        name: site.name,
        status: site.status,
        hostnames: site.hostnames,
        capabilities: site.capabilities,
        requiresLogin: site.requiresLogin,
        loginUrl: site.loginUrl,
        loadable: site.loadable,
        lastCheckedAt: site.lastCheckedAt,
        lastFailure: site.lastFailure,
        lastLoginConfirmedAt: site.lastLoginConfirmedAt,
        folderProblem: site.folderProblem,
        checking,
        cache: bySite[site.key] ?? { entries: 0, bytes: 0 },
        job: job ? jobSummary(job) : null,
        actions: siteActions(site, job, checking),
      };
    });
    return c.json({ sites });
  });

  // Add: URL or site name + optional note. Duplicate hostname → 409 with the message.
  api.post("/sites", async (c) => {
    const body = await readBody(c);
    const input = optionalString(body, "input");
    if (input === undefined) throw new HttpError(400, "enter a URL or a site name");
    const note = optionalString(body, "note");
    const job = await deps.jobs.add({ input, note: note ?? null, lang: parseHelperLang(body["lang"]) });
    return c.json({ job: jobSummary(job) }, 202);
  });

  api.post("/sites/:key/retry", async (c) => {
    const body = await readBody(c);
    const job = await deps.jobs.retry(c.req.param("key"), { lang: parseHelperLang(body["lang"]) });
    return c.json({ job: jobSummary(job) }, 202);
  });

  api.post("/sites/:key/repair", async (c) => {
    const body = await readBody(c);
    const job = await deps.jobs.repair(c.req.param("key"), optionalString(body, "note") ?? null, {
      lang: parseHelperLang(body["lang"]),
    });
    return c.json({ job: jobSummary(job) }, 202);
  });

  // Check now: runs the light check; a pass from needs_login clears the site's cache (registry).
  api.post("/sites/:key/check", async (c) => {
    const key = c.req.param("key");
    if (!deps.registry.list().some((s) => s.key === key))
      throw new HttpError(404, `site not registered: ${key}`);
    const result = await deps.health.runNow(key);
    return c.json({ result });
  });

  api.delete("/sites/:key", async (c) => {
    const key = c.req.param("key");
    const result = await deps.jobs.remove(key);
    if (!result.ok) {
      const status = result.reason.startsWith("site not registered") ? 404 : 409;
      return c.json({ error: status === 404 ? "not_found" : "conflict", message: result.reason }, status);
    }
    return c.json({ removed: key, commit: result.commit });
  });

  api.get("/jobs", (c) => c.json({ jobs: deps.jobs.list().slice(0, MAX_JOBS).map(jobSummary) }));

  api.get("/jobs/:id", (c) => {
    const job = deps.jobs.getJob(c.req.param("id"));
    if (!job) throw new HttpError(404, "unknown job");
    return c.json({ job: jobSummary(job) });
  });

  api.get("/jobs/:id/log", async (c) => {
    const id = c.req.param("id");
    if (!deps.jobs.getJob(id)) throw new HttpError(404, "unknown job");
    return c.json({ lines: await deps.jobs.log(id, { after: parseSeq(c.req.query("after")) }) });
  });

  api.post("/jobs/:id/retry", async (c) => {
    const body = await readBody(c);
    const job = await deps.jobs.retryJob(c.req.param("id"), { lang: parseHelperLang(body["lang"]) });
    return c.json({ job: jobSummary(job) }, 202);
  });

  api.post("/jobs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!deps.jobs.getJob(id)) throw new HttpError(404, "unknown job");
    return c.json({ cancelled: await deps.jobs.cancelJob(id) });
  });

  // Live job log: replays the lines after Last-Event-ID (or ?after=), then forwards live events.
  api.get("/jobs/:id/events", (c) => {
    const id = c.req.param("id");
    if (!deps.jobs.getJob(id)) throw new HttpError(404, "unknown job");
    const after = parseSeq(c.req.header("last-event-id") ?? c.req.query("after"));
    return streamSSE(c, (stream) => streamJob(stream, id, after));
  });

  async function streamJob(stream: SSEStreamingApi, id: string, after: number): Promise<void> {
    // Bound to the core that was running when the stream opened. When that core stops (a restart
    // or setup-only mode), the stream ends so the page reconnects to the core running then; the
    // check runs on every event and at least once per ping interval.
    const startedOn = source.core();
    const coreGone = (): boolean => source.core() !== startedOn;
    const jobs = deps.jobs;
    const pending: JobEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const unsubscribe = jobs.subscribe(id, (event) => {
      pending.push(event);
      wake?.();
    });
    stream.onAbort(() => {
      closed = true;
      wake?.();
    });
    let last = after;
    const writeLine = async (line: JobLogLine): Promise<void> => {
      if (line.seq <= last) return;
      last = line.seq;
      await stream.writeSSE({ event: "log", id: String(line.seq), data: JSON.stringify(line) });
    };
    try {
      for (const line of await jobs.log(id, { after })) await writeLine(line);
      const job = jobs.getJob(id);
      if (job) await stream.writeSSE({ event: "job", data: JSON.stringify(jobSummary(job)) });
      while (!closed && !coreGone()) {
        while (pending.length > 0 && !closed) {
          const event = pending.shift()!;
          if (event.type === "log") await writeLine(event.line);
          else await stream.writeSSE({ event: "job", data: JSON.stringify(jobSummary(event.job)) });
        }
        if (closed || coreGone()) break;
        const timedOut = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), ssePingMs);
          wake = () => {
            clearTimeout(timer);
            resolve(false);
          };
        });
        wake = null;
        if (timedOut && !closed && !coreGone()) await stream.write(": ping\n\n");
      }
    } finally {
      unsubscribe();
    }
  }

  api.get("/oauth/clients", async (c) => {
    const now = Date.now();
    return c.json({ clients: (await deps.oauth.listClients()).map((client) => clientView(client, now)) });
  });

  // Revoke: `{clientId}` deletes the client and its tokens; `{tokenId}` revokes one connection.
  api.post("/oauth/revoke", async (c) => {
    const body = await readBody(c);
    const clientId = optionalString(body, "clientId");
    const tokenId = optionalString(body, "tokenId");
    if ((clientId === undefined) === (tokenId === undefined)) {
      throw new HttpError(400, "pass exactly one of clientId or tokenId");
    }
    const ok = await deps.oauth.revoke(clientId !== undefined ? { clientId } : { tokenId: tokenId! });
    if (!ok) throw new HttpError(404, "nothing matched");
    return c.json({ revoked: true });
  });

  api.get("/cache", async (c) => {
    const [total, bySite] = await Promise.all([deps.fileCache.stats(), deps.fileCache.statsBySite()]);
    return c.json({ total, bySite });
  });

  // Clear: `{site}` clears one site's entries, `{}` clears everything.
  api.post("/cache/clear", async (c) => {
    const site = optionalString(await readBody(c), "site");
    if (site !== undefined) await deps.cache.clearSite(site);
    else await deps.cache.clearAll();
    logger.info("dashboard cache clear", { site: site ?? "all" });
    return c.json({ cleared: site ?? "all" });
  });

  // ------------------------------------------------------------------ settings page

  api.get("/status", (c) =>
    c.json(source.runMode?.status() ?? { mode: "running", problem: null, restartedAt: null }),
  );

  api.get("/settings", (c) => {
    const settings = source.settings;
    const page = source.settingsPage;
    if (!settings || !page) return respond(c, failure(404, "not_found", "settings are not available"));
    const view = settings.read();
    return c.json({
      passphrase: { ...view.passphrase },
      helperRuntime: { value: view.helperRuntime.value, supported: supportedRuntimes() },
      asideAccount: { value: view.asideAccount.value, locked: view.asideAccount.locked },
      info: { ...page.info(), ...(options.adminPort ? { adminPort: options.adminPort() } : {}) },
    });
  });

  // What saving does: validate → busy → no change → job_running → write → disconnect
  // apps (when asked, with a passphrase change) → restart.
  api.put("/settings", async (c) => {
    const settings = source.settings;
    const page = source.settingsPage;
    if (!settings || !page || !source.runMode) {
      return respond(c, failure(404, "not_found", "settings are not available"));
    }
    const body = await readBody(c);
    const parsed = parseSettingsBody(body);
    if (!parsed.ok) return respond(c, parsed.answer);
    const { change, disconnectApps } = parsed;
    const preview = page.preview(change);
    if (!preview.ok) return respond(c, previewAnswer(preview));
    if (source.runMode.isBusy()) return respond(c, busyAnswer());
    const noChange: Answer = {
      status: 200,
      body: { changed: [], restarting: false, appsDisconnected: null },
    };
    if (preview.changed.length === 0) return respond(c, noChange);
    const confirmed = body["confirmInterrupt"] === true;

    const answer = await restartWith("settings saved", async () => {
      if (jobRunning() && !confirmed) {
        return { proceed: false, answer: failure(409, "job_running", JOB_RUNNING_MESSAGE) };
      }
      const written = await settings.write(change);
      if (!written.ok) return { proceed: false, answer: writeAnswer(written) };
      if (written.changed.length === 0) return { proceed: false, answer: noChange };
      let appsDisconnected: boolean | null = null;
      if (disconnectApps && written.changed.includes("passphrase")) {
        appsDisconnected = await disconnectAllApps();
      }
      logger.info("settings saved", { changed: written.changed.join(","), appsDisconnected });
      return {
        proceed: true,
        answer: { status: 202, body: { changed: written.changed, restarting: true, appsDisconnected } },
      };
    });
    return respond(c, answer);
  });

  api.post("/restart", async (c) => {
    if (!source.runMode) return respond(c, failure(404, "not_found", "run-mode control is not available"));
    const body = await readBody(c);
    if (source.runMode.isBusy()) return respond(c, busyAnswer());
    const confirmed = body["confirmInterrupt"] === true;
    const answer = await restartWith("manual restart", async () => {
      if (jobRunning() && !confirmed) {
        return { proceed: false, answer: failure(409, "job_running", JOB_RUNNING_MESSAGE) };
      }
      return { proceed: true, answer: { status: 202, body: { restarting: true } } };
    });
    return respond(c, answer);
  });

  const chatgptService = () => source.chatgpt ?? null;
  const noChatgpt = (c: Context) =>
    respond(c, failure(404, "not_found", "the ChatGPT connection is not available in this process"));

  api.get("/chatgpt", async (c) => {
    const svc = chatgptService();
    if (svc === null) return noChatgpt(c);
    return c.json(await svc.state());
  });

  api.post("/chatgpt/setup", async (c) => {
    const svc = chatgptService();
    if (svc === null) return noChatgpt(c);
    const body = await readBody(c);
    const input = {
      tunnelId: body["tunnelId"],
      runtimeKey: body["runtimeKey"],
      profile: body["profile"],
      replace: body["replace"],
    };
    const checked = validateSetupInput(input);
    if (!checked.ok) return respond(c, chatgptAnswer(checked));
    if (source.runMode?.isBusy()) return respond(c, busyAnswer());
    if (jobRunning() && body["confirmInterrupt"] !== true) {
      return respond(c, failure(409, "job_running", JOB_RUNNING_MESSAGE));
    }
    const result = await svc.setup(input);
    if (!result.ok) return respond(c, chatgptAnswer(result));
    return c.json({ restarting: true }, 202);
  });

  api.post("/chatgpt/retry", async (c) => {
    const svc = chatgptService();
    if (svc === null) return noChatgpt(c);
    const result = await svc.retry();
    if (!result.ok) return respond(c, chatgptAnswer(result));
    return c.json({ state: result.state }, result.started ? 202 : 200);
  });

  api.delete("/chatgpt", async (c) => {
    const svc = chatgptService();
    if (svc === null) return noChatgpt(c);
    const body = await readBody(c);
    if (source.runMode?.isBusy()) return respond(c, busyAnswer());
    if (jobRunning() && body["confirmInterrupt"] !== true) {
      return respond(c, failure(409, "job_running", JOB_RUNNING_MESSAGE));
    }
    const result = await svc.disconnect();
    if (!result.ok) return respond(c, chatgptAnswer(result));
    return c.json({ restarting: true }, 202);
  });

  api.get("/helper", async (c) => c.json(await deps.jobs.helperStatus(lastCheck)));

  api.post("/helper/check", async (c) => {
    const result = await deps.jobs.helperCheck();
    lastCheck = result;
    logger.info("helper check", { runtime: result.runtime, code: result.code });
    return c.json(result);
  });

  api.notFound((c) => c.json({ error: "not_found" }, 404));
  return api;
}
