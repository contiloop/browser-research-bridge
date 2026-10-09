/** Dashboard routes and listener: token/cookie exchange, Host/Origin guard, API → service calls, SSE. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryLogger } from "../../../test/support/oauth-harness.js";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import { OnboardingRequestError } from "../onboarding/index.js";
import type { HelperCheckResult, JobEvent, JobLogLine, OnboardingJob } from "../onboarding/index.js";
import type { RegistrySite } from "../registry/index.js";
import type {
  ChatgptAccepted,
  ChatgptDisconnectResult,
  ChatgptFailure,
  ChatgptRetryResult,
  ChatgptSetupResult,
  ChatgptStatus,
} from "../../app/chatgpt-connection.js";
import type { RestartOptions, RestartResult, RunStatus } from "../../app/run-mode.js";
import type {
  SettingsChange,
  SettingsField,
  SettingsView,
  SettingsWriteResult,
} from "../../ports/settings-store.js";
import type { HelperRuntimeId, HelperStatus } from "../onboarding/index.js";
import type {
  DashboardDeps,
  DashboardSource,
  HelperCheckLog,
  PageSettingsChange,
  PassphraseClipboardResult,
  SettingsInfo,
  SettingsPreview,
} from "./deps.js";
import { adminCookieName, assertLoopbackBind } from "./security.js";
import { UI_PATHS, createAdminApp, createAdminListener, defaultUiDir } from "./server.js";
import type { Listen } from "./server.js";

const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;
const TOKEN = "test-admin-token-value-0123456789abcdef";
const COOKIE = `${adminCookieName(PORT)}=${TOKEN}`;

function site(key: string, patch: Partial<RegistrySite> = {}): RegistrySite {
  return {
    key,
    name: key,
    status: "active",
    hostnames: [`${key}.example.com`],
    loginUrl: null,
    lastFailure: null,
    capabilities: { search: true, read: true, dateFilter: false, pagination: true },
    requiresLogin: false,
    lastCheckedAt: null,
    loadable: true,
    lastLoginConfirmedAt: null,
    provisionalHostnames: [],
    consecutiveAdapterErrors: 0,
    folderProblem: null,
    hasStaging: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  };
}

function job(patch: Partial<OnboardingJob> = {}): OnboardingJob {
  return {
    version: 1,
    id: "job-1",
    kind: "add",
    key: "reuters",
    input: "https://www.reuters.com",
    note: null,
    hostnames: ["reuters.com"],
    state: "running",
    reason: null,
    requestedAction: null,
    summary: null,
    validation: null,
    lastFailure: null,
    sessionId: "secret-session",
    attempts: 1,
    approvedHosts: [],
    pendingHosts: [],
    lang: "en",
    runtime: "claude",
    commit: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

function logLine(seq: number): JobLogLine {
  return { seq, at: "2026-10-01T00:00:00.000Z", level: "info", source: "job", message: `line ${seq}` };
}

function fakeDeps(dataDir = "/tmp/brb-dashboard-unused") {
  const listeners = new Map<string, Set<(e: JobEvent) => void>>();
  const lines = [logLine(1), logLine(2), logLine(3)];
  const deps = {
    config: {
      publicUrl: "https://bridge.example.net",
      publicUrlConfigured: true,
      adminPort: PORT,
      asideAccount: "u0",
      dataDir,
    },
    logger: new MemoryLogger(),
    registry: { list: () => [site("example-news")] },
    jobs: {
      add: vi.fn(async (input: { input: string; note?: string | null }) =>
        job({ input: input.input, note: input.note ?? null, state: "queued" }),
      ),
      retry: vi.fn(async (key: string) => job({ key, state: "queued" })),
      retryJob: vi.fn(async (id: string) => job({ id, state: "queued" })),
      repair: vi.fn(async (key: string) => job({ key, kind: "repair", state: "queued" })),
      cancelJob: vi.fn(async () => true),
      remove: vi.fn(async (key: string) =>
        key === "example-news"
          ? { ok: true as const, key, commit: { committed: false, reason: "disabled" } }
          : { ok: false as const, key, reason: `site not registered: ${key}` },
      ),
      list: vi.fn(() => [job()]),
      get: vi.fn(() => undefined),
      getJob: vi.fn((id: string) => (id === "job-1" ? job() : undefined)),
      log: vi.fn(async (_id: string, options: { after?: number | undefined } = {}) =>
        lines.filter((l) => l.seq > (options.after ?? 0)),
      ),
      subscribe: vi.fn((id: string, cb: (e: JobEvent) => void) => {
        const set = listeners.get(id) ?? new Set();
        set.add(cb);
        listeners.set(id, set);
        return () => set.delete(cb);
      }),
      helperStatus: vi.fn(async (lastCheck: HelperCheckResult | null = null) => ({
        configured: "auto" as const,
        supported: ["claude" as const, "codex" as const],
        runtimes: {
          claude: { installed: true, signedIn: null },
          codex: { installed: false, signedIn: null },
        },
        wouldUse: "claude" as const,
        lastCheck,
      })),
      helperCheck: vi.fn(async (): Promise<HelperCheckResult> => ({
        at: "2026-10-01T00:00:00.000Z",
        runtime: "claude",
        ok: true,
        code: "ok",
        message: null,
      })),
    },
    health: {
      runNow: vi.fn(async (key: string) => ({ site: key, ran: true, status: "active" as const })),
      isChecking: () => false,
    },
    oauth: {
      resource: "https://bridge.example.net/mcp",
      listClients: vi.fn(async () => [
        {
          clientId: "client-1",
          clientName: "Claude",
          source: "dcr" as const,
          redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
          createdAt: "2026-10-01T00:00:00.000Z",
          lastTokenIssuedAt: "2026-10-01T00:00:00.000Z",
          activeTokens: 1,
          tokens: [
            {
              tokenId: "hash-1",
              kind: "refresh" as const,
              familyId: "fam-1",
              createdAt: "2026-10-01T00:00:00.000Z",
              expiresAt: "2999-01-01T00:00:00.000Z",
              revokedAt: null,
            },
          ],
        },
      ]),
      revoke: vi.fn(async () => true),
    },
    fileCache: {
      stats: vi.fn(async () => ({ entries: 2, bytes: 2048 })),
      statsBySite: vi.fn(async () => ({ "example-news": { entries: 2, bytes: 2048 } })),
    },
    cache: { clearSite: vi.fn(async () => undefined), clearAll: vi.fn(async () => undefined) },
    browser: { status: vi.fn(async () => ({ reachable: false, account: "u0", message: "aside not found" })) },
  };
  const emit = (id: string, event: JobEvent): void => {
    for (const cb of listeners.get(id) ?? []) cb(event);
  };
  return { deps: deps satisfies DashboardDeps, emit, listeners };
}

function makeApp(deps: DashboardDeps | DashboardSource) {
  return createAdminApp(deps, {
    token: TOKEN,
    port: () => PORT,
    uiDir: defaultUiDir(),
    tokenFile: "/data/admin-token",
    ssePingMs: 50,
  });
}

type App = ReturnType<typeof makeApp>;

function get(app: App, path: string, headers: Record<string, string> = {}) {
  return app.request(`${BASE}${path}`, { headers: { host: `127.0.0.1:${PORT}`, ...headers } });
}

function send(app: App, method: string, path: string, body: unknown, headers: Record<string, string>) {
  return app.request(`${BASE}${path}`, {
    method,
    headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json", ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

const authed = { cookie: COOKIE, origin: ORIGIN };

describe("dashboard authentication", () => {
  it("exchanges the printed token for an HttpOnly SameSite=Strict cookie and redirects to /", async () => {
    const app = makeApp(fakeDeps().deps);
    const res = await get(app, `/?token=${TOKEN}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${adminCookieName(PORT)}=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it("refuses a wrong token and reads without the cookie (401)", async () => {
    const app = makeApp(fakeDeps().deps);
    const wrong = await get(app, "/?token=nope");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect((await get(app, "/")).status).toBe(401);
    expect((await get(app, "/api/sites")).status).toBe(401);
    expect((await get(app, "/api/sites", { cookie: `${adminCookieName(PORT)}=wrong` })).status).toBe(401);
  });

  it("serves the UI and the API with the cookie", async () => {
    const app = makeApp(fakeDeps().deps);
    const page = await get(app, "/", { cookie: COOKIE });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain('<script type="module" src="/app.js"></script>');
    const sites = await get(app, "/api/sites", { cookie: COOKIE });
    expect(sites.status).toBe(200);
    const body = (await sites.json()) as { sites: { key: string; actions: string[] }[] };
    expect(body.sites.map((s) => s.key)).toEqual(["example-news"]);
    expect(body.sites[0]?.actions).toEqual(["repair", "check", "remove"]);
  });

  it("answers 403 for a foreign Host even with the cookie (DNS rebinding, accidental tunnel)", async () => {
    const app = makeApp(fakeDeps().deps);
    expect((await get(app, "/api/sites", { cookie: COOKIE, host: `evil.example:${PORT}` })).status).toBe(403);
    expect((await get(app, `/?token=${TOKEN}`, { host: "bridge.example.net" })).status).toBe(403);
  });

  it("requires the cookie and the own Origin for state-changing routes (403 otherwise)", async () => {
    const { deps } = fakeDeps();
    const app = makeApp(deps);
    const body = { input: "https://www.reuters.com" };
    expect((await send(app, "POST", "/api/sites", body, { cookie: COOKIE })).status).toBe(403);
    expect(
      (await send(app, "POST", "/api/sites", body, { cookie: COOKIE, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect((await send(app, "POST", "/api/sites", body, { cookie: COOKIE, origin: "null" })).status).toBe(
      403,
    );
    expect((await send(app, "POST", "/api/sites", body, { origin: ORIGIN })).status).toBe(403);
    expect((await send(app, "DELETE", "/api/sites/example-news", undefined, { cookie: COOKIE })).status).toBe(
      403,
    );
    expect(deps.jobs.add).not.toHaveBeenCalled();
    expect(deps.jobs.remove).not.toHaveBeenCalled();

    const ok = await send(app, "POST", "/api/sites", { ...body, note: "subscriber articles" }, authed);
    expect(ok.status).toBe(202);
    expect(deps.jobs.add).toHaveBeenCalledWith({
      input: "https://www.reuters.com",
      note: "subscriber articles",
      lang: "en",
    });
    const viaLocalhost = await send(app, "POST", "/api/sites", body, {
      cookie: COOKIE,
      origin: `http://localhost:${PORT}`,
      host: `localhost:${PORT}`,
    });
    expect(viaLocalhost.status).toBe(202);
  });

  it("never puts the admin token into pages or API responses", async () => {
    const app = makeApp(fakeDeps().deps);
    for (const path of [
      ...UI_PATHS,
      "/api/overview",
      "/api/sites",
      "/api/jobs",
      "/api/oauth/clients",
      "/api/cache",
      "/api/browser",
    ]) {
      const res = await get(app, path, { cookie: COOKIE });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(TOKEN);
    }
    for (const path of ["/", "/?token=wrong", "/api/sites"]) {
      expect(await (await get(app, path)).text(), path).not.toContain(TOKEN);
    }
  });
});

describe("dashboard static UI files", () => {
  it("serves exactly the fixed list with its content type and nothing else from the UI folder", async () => {
    const app = makeApp(fakeDeps().deps);
    expect([...UI_PATHS].sort()).toEqual(
      ["/", "/app.css", "/app.js", "/i18n.js", "/instructions.js", "/labels.js", "/state.js"].sort(),
    );
    for (const path of UI_PATHS) {
      const res = await get(app, path, { cookie: COOKIE });
      expect(res.status, path).toBe(200);
      const type = res.headers.get("content-type") ?? "";
      if (path === "/") expect(type).toContain("text/html");
      else if (path.endsWith(".css")) expect(type).toContain("text/css");
      else expect(type).toContain("text/javascript");
      expect(res.headers.get("content-security-policy"), path).toContain("script-src 'self'");
    }
    for (const path of ["/index.html", "/app.ts", "/ui/app.js", "/../server.ts", "/%2e%2e/server.ts"]) {
      expect((await get(app, path, { cookie: COOKIE })).status, path).toBe(404);
    }
  });

  it("loads the page script as a same-origin module", async () => {
    const app = makeApp(fakeDeps().deps);
    const html = await (await get(app, "/", { cookie: COOKIE })).text();
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*src="\/app\.js")/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe("dashboard actions", () => {
  it("Add of an already registered hostname → 409 with the registry message", async () => {
    const { deps } = fakeDeps();
    deps.jobs.add.mockRejectedValueOnce(
      new OnboardingRequestError("already registered as example-news; use Repair or Remove", "conflict"),
    );
    const app = makeApp(deps);
    const res = await send(app, "POST", "/api/sites", { input: "example-news.example.com" }, authed);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "conflict",
      message: "already registered as example-news; use Repair or Remove",
    });
    const empty = await send(app, "POST", "/api/sites", {}, authed);
    expect(empty.status).toBe(400);
  });

  it("Remove calls jobs.remove (which cancels the job first) and maps unknown sites to 404", async () => {
    const { deps } = fakeDeps();
    const app = makeApp(deps);
    const res = await send(app, "DELETE", "/api/sites/example-news", undefined, authed);
    expect(res.status).toBe(200);
    expect(deps.jobs.remove).toHaveBeenCalledWith("example-news");
    expect((await send(app, "DELETE", "/api/sites/nope", undefined, authed)).status).toBe(404);
  });

  it("Retry, Repair, Check now, job retry/cancel call the services", async () => {
    const { deps } = fakeDeps();
    const app = makeApp(deps);
    expect((await send(app, "POST", "/api/sites/example-news/retry", undefined, authed)).status).toBe(202);
    expect(deps.jobs.retry).toHaveBeenCalledWith("example-news", { lang: "en" });
    expect(
      (await send(app, "POST", "/api/sites/example-news/repair", { note: "fix dates" }, authed)).status,
    ).toBe(202);
    expect(deps.jobs.repair).toHaveBeenCalledWith("example-news", "fix dates", { lang: "en" });
    const check = await send(app, "POST", "/api/sites/example-news/check", undefined, authed);
    expect(check.status).toBe(200);
    expect(deps.health.runNow).toHaveBeenCalledWith("example-news");
    expect((await send(app, "POST", "/api/sites/unknown/check", undefined, authed)).status).toBe(404);
    expect((await send(app, "POST", "/api/jobs/job-1/retry", undefined, authed)).status).toBe(202);
    expect(deps.jobs.retryJob).toHaveBeenCalledWith("job-1", { lang: "en" });
    expect((await send(app, "POST", "/api/jobs/job-1/cancel", undefined, authed)).status).toBe(200);
    expect(deps.jobs.cancelJob).toHaveBeenCalledWith("job-1");
    deps.jobs.retry.mockRejectedValueOnce(new OnboardingRequestError("site not registered: x", "not_found"));
    expect((await send(app, "POST", "/api/sites/x/retry", undefined, authed)).status).toBe(404);
  });

  it("Revoke calls oauth.revoke; the client list shows names and token ids only", async () => {
    const { deps } = fakeDeps();
    const app = makeApp(deps);
    const list = (await (await get(app, "/api/oauth/clients", { cookie: COOKIE })).json()) as {
      clients: { clientName: string; connections: { tokenId: string }[] }[];
    };
    expect(list.clients[0]?.clientName).toBe("Claude");
    expect(list.clients[0]?.connections.map((c) => c.tokenId)).toEqual(["hash-1"]);
    expect((await send(app, "POST", "/api/oauth/revoke", { tokenId: "hash-1" }, authed)).status).toBe(200);
    expect(deps.oauth.revoke).toHaveBeenCalledWith({ tokenId: "hash-1" });
    expect((await send(app, "POST", "/api/oauth/revoke", { clientId: "client-1" }, authed)).status).toBe(200);
    expect(deps.oauth.revoke).toHaveBeenCalledWith({ clientId: "client-1" });
    expect((await send(app, "POST", "/api/oauth/revoke", {}, authed)).status).toBe(400);
    deps.oauth.revoke.mockResolvedValueOnce(false);
    expect((await send(app, "POST", "/api/oauth/revoke", { clientId: "gone" }, authed)).status).toBe(404);
  });

  it("Clear calls the cache clear for one site or all", async () => {
    const { deps } = fakeDeps();
    const app = makeApp(deps);
    expect((await send(app, "POST", "/api/cache/clear", { site: "example-news" }, authed)).status).toBe(200);
    expect(deps.cache.clearSite).toHaveBeenCalledWith("example-news");
    expect((await send(app, "POST", "/api/cache/clear", {}, authed)).status).toBe(200);
    expect(deps.cache.clearAll).toHaveBeenCalledTimes(1);
    const cache = (await (await get(app, "/api/cache", { cookie: COOKIE })).json()) as {
      total: { bytes: number };
    };
    expect(cache.total.bytes).toBe(2048);
  });

  it("overview shows the MCP URL and PUBLIC_URL state, never secrets", async () => {
    const app = makeApp(fakeDeps().deps);
    const overview = (await (await get(app, "/api/overview", { cookie: COOKIE })).json()) as Record<
      string,
      unknown
    >;
    expect(overview).toMatchObject({
      mcpUrl: "https://bridge.example.net/mcp",
      publicUrlConfigured: true,
      dashboardUrl: BASE,
      asideAccount: "u0",
    });
  });
});

describe("dashboard without a running core", () => {
  const sourceOf = (current: () => DashboardDeps | null): DashboardSource => ({
    logger: new MemoryLogger(),
    location: { adminPort: PORT, dataDir: "/tmp/brb-dashboard-unused" },
    core: current,
  });

  it("answers 503 not_running on every route that needs the core, and serves the page", async () => {
    const app = makeApp(sourceOf(() => null));
    expect((await get(app, "/", { cookie: COOKIE })).status).toBe(200);
    for (const path of [
      "/api/overview",
      "/api/browser",
      "/api/sites",
      "/api/jobs",
      "/api/jobs/job-1",
      "/api/oauth/clients",
      "/api/cache",
    ]) {
      const res = await get(app, path, { cookie: COOKIE });
      expect(res.status, path).toBe(503);
      expect(((await res.json()) as { error: string }).error, path).toBe("not_running");
    }
    const post = await send(app, "POST", "/api/sites", { input: "x" }, authed);
    expect(post.status).toBe(503);
    // The guards still come first.
    expect((await get(app, "/api/sites")).status).toBe(401);
    expect((await send(app, "POST", "/api/sites", { input: "x" }, { cookie: COOKIE })).status).toBe(403);
    expect((await get(app, "/api/nope", { cookie: COOKIE })).status).toBe(404);
  });

  it("resolves the services on every request, so a restarted core is picked up", async () => {
    let current: DashboardDeps | null = null;
    const app = makeApp(sourceOf(() => current));
    expect((await get(app, "/api/sites", { cookie: COOKIE })).status).toBe(503);
    const first = fakeDeps().deps;
    current = first;
    expect((await get(app, "/api/sites", { cookie: COOKIE })).status).toBe(200);
    const second = fakeDeps().deps;
    current = second;
    await send(app, "POST", "/api/sites", { input: "https://www.reuters.com" }, authed);
    expect(second.jobs.add).toHaveBeenCalledTimes(1);
    expect(first.jobs.add).not.toHaveBeenCalled();
  });
});

describe("job log SSE", () => {
  it("replays the lines after Last-Event-ID, then forwards live events without duplicates", async () => {
    const { deps, emit, listeners } = fakeDeps();
    const app = makeApp(deps);
    const res = await get(app, "/api/jobs/job-1/events", { cookie: COOKIE, "last-event-id": "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil("event: job");
    expect(text).not.toContain('"line 1"');
    expect(text.indexOf("id: 2")).toBeLessThan(text.indexOf("id: 3"));
    emit("job-1", { type: "log", jobId: "job-1", line: logLine(3) }); // already replayed
    emit("job-1", { type: "log", jobId: "job-1", line: logLine(4) });
    await readUntil('"line 4"');
    expect(text.match(/id: 3\n/g)).toHaveLength(1);
    await readUntil(": ping");
    await reader.cancel();
    await vi.waitFor(() => expect(listeners.get("job-1")?.size ?? 0).toBe(0));
  });

  it("ends the stream when the core it started on stops (restart), and unsubscribes", async () => {
    const first = fakeDeps();
    let current: DashboardDeps | null = first.deps;
    const app = makeApp({
      logger: new MemoryLogger(),
      location: { adminPort: PORT, dataDir: "/tmp/brb-dashboard-unused" },
      core: () => current,
    });
    const res = await get(app, "/api/jobs/job-1/events", { cookie: COOKIE });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: job")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before the job event");
      text += decoder.decode(value, { stream: true });
    }
    // The core restarts: a new core replaces the one the stream was bound to.
    current = fakeDeps().deps;
    const ended = await (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return true;
      }
    })();
    expect(ended).toBe(true);
    await vi.waitFor(() => expect(first.listeners.get("job-1")?.size ?? 0).toBe(0));
  });

  it("404 for an unknown job", async () => {
    const app = makeApp(fakeDeps().deps);
    expect((await get(app, "/api/jobs/nope/events", { cookie: COOKIE })).status).toBe(404);
  });
});

describe("admin listener", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("refuses to bind anything but 127.0.0.1", () => {
    const { deps } = fakeDeps();
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "localhost", "::1"]) {
      expect(() => assertLoopbackBind(host)).toThrow(/127\.0\.0\.1 only/);
      expect(() => createAdminListener(deps, { hostname: host })).toThrow(/127\.0\.0\.1 only/);
    }
  });

  it("binds 127.0.0.1:<adminPort>, writes a fresh 0600 token per launch, prints the one-time URL", async () => {
    const tmp = await makeTempDir("brb-dash-");
    cleanup = tmp.cleanup;
    const { deps } = fakeDeps(join(tmp.dir, "data"));
    const calls: { port: number; hostname?: string | undefined }[] = [];
    const listen: Listen = async (_app, options) => {
      calls.push(options);
      return {
        hostname: "127.0.0.1",
        port: options.port,
        url: `http://127.0.0.1:${options.port}`,
        close: async () => undefined,
      };
    };
    const printed: string[] = [];
    const listener = createAdminListener(deps, { listen, print: (t) => printed.push(t) });
    await listener.start();
    expect(calls).toEqual([{ port: PORT, hostname: "127.0.0.1" }]);
    const file = join(tmp.dir, "data", "admin-token");
    const first = (await readFile(file, "utf8")).trim();
    expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(printed.join("\n")).toContain(`http://127.0.0.1:${PORT}/?token=${first}`);
    expect(listener.openUrl()).toBe(`http://127.0.0.1:${PORT}/?token=${first}`);
    expect(deps.logger.lines.join("\n")).not.toContain(first);
    await listener.stop();
    await expect(stat(file)).rejects.toThrow();

    await listener.start();
    const second = (await readFile(file, "utf8")).trim();
    expect(second).not.toBe(first);
    await listener.stop();
  });

  it("serves on a real loopback socket", async () => {
    const tmp = await makeTempDir("brb-dash-");
    cleanup = tmp.cleanup;
    const { deps } = fakeDeps(join(tmp.dir, "data"));
    const listener = createAdminListener(deps, { port: 0, print: () => undefined });
    const running = await listener.start();
    try {
      expect(running?.hostname).toBe("127.0.0.1");
      const url = listener.openUrl()!;
      const exchange = await fetch(url, { redirect: "manual" });
      expect(exchange.status).toBe(303);
      const cookie = (exchange.headers.get("set-cookie") ?? "").split(";")[0]!;
      const sites = await fetch(`${running!.url}/api/sites`, { headers: { cookie } });
      expect(sites.status).toBe(200);
      const add = await fetch(`${running!.url}/api/sites`, {
        method: "POST",
        headers: { cookie, origin: running!.url, "content-type": "application/json" },
        body: JSON.stringify({ input: "https://www.reuters.com" }),
      });
      expect(add.status).toBe(202);
    } finally {
      await listener.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Settings-page API: fakes for the run-mode control, the settings store, the settings
// support, and the ChatGPT connection service.
// ---------------------------------------------------------------------------------------------

const SECRET_PASSPHRASE = "correct horse battery staple 'quoted' #x";
const SECRET_KEY = "sk-runtime-key-SECRET-0123456789";
const TUNNEL_ID = `tunnel_${"0123456789abcdef".repeat(2)}`;

function settingsView(patch: Partial<SettingsView> = {}): SettingsView {
  return {
    passphrase: { set: true, valid: true, locked: false },
    anthropicApiKey: { set: false, locked: false },
    helperRuntime: { value: "auto" },
    captchaAuto: { value: true },
    assistantAuto: { value: true },
    asideAccount: { value: "u0", locked: false, source: "default" },
    chatgpt: null,
    oauthExtraResources: [],
    publicUrl: { set: false, source: null },
    files: {
      envFile: { path: "/project/.env", exists: true, readable: true, problem: null },
      configFile: { path: "/project/config/bridge.json", exists: true, readable: true, problem: null },
    },
    ...patch,
  };
}

const INFO: SettingsInfo = {
  mcpUrl: "http://localhost:8787/mcp",
  publicUrl: "http://localhost:8787",
  publicUrlConfigured: false,
  publicPort: 8787,
  adminPort: PORT,
  dataDir: "/project/data",
  sitesDir: "/project/sites",
  configFile: "/project/config/bridge.json",
  envFile: "/project/.env",
};

const CHATGPT_STATE: ChatgptStatus = {
  tool: { installed: true, version: "0.0.14" },
  state: "ready",
  managedBy: "bridge",
  tunnelId: TUNNEL_ID,
  profile: "browser-research-bridge",
  keyStored: true,
  message: null,
  connectedApps: 1,
};

function busyError(): Error {
  return Object.assign(new Error("a restart is already in progress; try again when it has finished"), {
    code: "busy",
  });
}

function fakeSource() {
  const { deps } = fakeDeps();
  // No job is running unless a test says so.
  deps.jobs.list.mockReturnValue([job({ state: "succeeded" })]);
  let core: DashboardDeps | null = deps;
  let busy = false;
  let status: RunStatus = { mode: "running", problem: null, restartedAt: "2026-10-01T00:00:00.000Z" };
  const order: string[] = [];
  /** When set, a restart call parks here after `prepare` until released. */
  let hold: Promise<void> | null = null;
  const runMode = {
    status: () => structuredClone(status),
    isBusy: () => busy,
    restart: vi.fn(async (options: RestartOptions = {}): Promise<RestartResult> => {
      if (busy) throw busyError();
      busy = true;
      try {
        if (options.prepare) {
          const proceed = await options.prepare(null);
          if (proceed === false) return { restarted: false, status };
        }
        order.push("restart");
        if (hold) await hold;
        return { restarted: true, status };
      } finally {
        busy = false;
      }
    }),
  };
  let view = settingsView();
  const settings = {
    read: vi.fn(() => view),
    write: vi.fn(async (change: SettingsChange): Promise<SettingsWriteResult> => {
      order.push("write");
      return { ok: true, changed: Object.keys(change) as SettingsField[] };
    }),
    pageLocation: () => ({ adminPort: PORT, dataDir: "/project/data" }),
  };
  const settingsPage = {
    info: vi.fn(() => INFO),
    preview: vi.fn((change: PageSettingsChange): SettingsPreview => ({
      ok: true,
      changed: Object.keys(change) as SettingsField[],
    })),
    supportedRuntimes: vi.fn((): HelperRuntimeId[] => ["claude", "codex"]),
    revokeAllAppsOffline: vi.fn(async () => {
      order.push("revokeOffline");
    }),
  };
  const accepted = (): ChatgptAccepted => ({ ok: true, done: Promise.resolve({ status }) });
  const chatgpt = {
    state: vi.fn(async (): Promise<ChatgptStatus> => ({ ...CHATGPT_STATE })),
    setup: vi.fn(async (): Promise<ChatgptSetupResult> => accepted()),
    retry: vi.fn(async (): Promise<ChatgptRetryResult> => ({ ok: true, started: true, state: "starting" })),
    disconnect: vi.fn(async (): Promise<ChatgptDisconnectResult> => accepted()),
  };
  const logger = new MemoryLogger();
  const copyPassphrase = vi.fn(async (): Promise<PassphraseClipboardResult> => "ok");
  const source: DashboardSource = {
    logger,
    location: { adminPort: PORT, dataDir: "/project/data" },
    core: () => core,
    runMode,
    settings,
    settingsPage,
    chatgpt,
    copyPassphrase,
  };
  return {
    source,
    deps,
    runMode,
    settings,
    settingsPage,
    chatgpt,
    copyPassphrase,
    logger,
    order,
    setCore: (next: DashboardDeps | null) => (core = next),
    setBusy: (next: boolean) => (busy = next),
    setStatus: (next: RunStatus) => (status = next),
    setView: (next: SettingsView) => (view = next),
    holdRestart: () => {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

const SETUP_STATUS: RunStatus = {
  mode: "setup",
  problem: { code: "passphrase_missing", message: "BRIDGE_PASSPHRASE is not set" },
  restartedAt: null,
};
const RESTARTING_STATUS: RunStatus = { mode: "restarting", problem: null, restartedAt: null };

/** Every new state-changing route with a body that would otherwise be accepted. */
const NEW_WRITES: [string, string, unknown][] = [
  ["PUT", "/api/settings", { helperRuntime: "claude" }],
  ["POST", "/api/restart", {}],
  ["POST", "/api/chatgpt/setup", { tunnelId: TUNNEL_ID, runtimeKey: SECRET_KEY }],
  ["POST", "/api/chatgpt/retry", undefined],
  ["DELETE", "/api/chatgpt", {}],
  ["POST", "/api/helper/check", undefined],
  ["POST", "/api/settings/passphrase/clipboard", undefined],
];

describe("settings-page API: guards", () => {
  it("refuses every new state-changing route without the cookie and with a foreign Origin", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    for (const [method, path, body] of NEW_WRITES) {
      const noCookie = await send(app, method, path, body, { origin: ORIGIN });
      expect(noCookie.status, `${method} ${path} without cookie`).toBe(403);
      const foreign = await send(app, method, path, body, { cookie: COOKIE, origin: "https://evil.example" });
      expect(foreign.status, `${method} ${path} foreign Origin`).toBe(403);
      const noOrigin = await send(app, method, path, body, { cookie: COOKIE });
      expect(noOrigin.status, `${method} ${path} no Origin`).toBe(403);
    }
    expect(f.settings.write).not.toHaveBeenCalled();
    expect(f.runMode.restart).not.toHaveBeenCalled();
    expect(f.chatgpt.setup).not.toHaveBeenCalled();
    expect(f.chatgpt.retry).not.toHaveBeenCalled();
    expect(f.chatgpt.disconnect).not.toHaveBeenCalled();
    expect(f.deps.jobs.helperCheck).not.toHaveBeenCalled();
    expect(f.copyPassphrase).not.toHaveBeenCalled();
    // The new reads need the cookie too.
    for (const path of ["/api/status", "/api/settings", "/api/chatgpt", "/api/helper"]) {
      expect((await get(app, path)).status, path).toBe(401);
    }
  });
});

describe("settings-page API: reads", () => {
  it("GET status answers the run status in every mode", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    expect(await (await get(app, "/api/status", { cookie: COOKIE })).json()).toEqual({
      mode: "running",
      problem: null,
      restartedAt: "2026-10-01T00:00:00.000Z",
    });
    f.setCore(null);
    for (const status of [SETUP_STATUS, RESTARTING_STATUS]) {
      f.setStatus(status);
      const res = await get(app, "/api/status", { cookie: COOKIE });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(status);
    }
  });

  it("GET settings: flags, values, supported runtimes, information; no secret; in every mode", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const expected = {
      passphrase: { set: true, valid: true, locked: false },
      helperRuntime: { value: "auto", supported: ["claude", "codex"] },
      asideAccount: { value: "u0", locked: false },
      captchaAuto: true,
      assistantAuto: true,
      info: INFO,
    };
    expect(await (await get(app, "/api/settings", { cookie: COOKIE })).json()).toEqual(expected);
    f.setCore(null);
    for (const status of [SETUP_STATUS, RESTARTING_STATUS]) {
      f.setStatus(status);
      const res = await get(app, "/api/settings", { cookie: COOKIE });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expected);
    }
    // Unreadable values are null.
    f.setView(
      settingsView({
        helperRuntime: { value: null },
        captchaAuto: { value: null },
        assistantAuto: { value: null },
        asideAccount: { value: null, locked: false, source: "config_file" },
      }),
    );
    const nulls = (await (await get(app, "/api/settings", { cookie: COOKIE })).json()) as {
      helperRuntime: { value: unknown };
      asideAccount: { value: unknown };
      captchaAuto: unknown;
      assistantAuto: unknown;
    };
    expect(nulls.helperRuntime.value).toBeNull();
    expect(nulls.asideAccount.value).toBeNull();
    expect(nulls.captchaAuto).toBeNull();
    expect(nulls.assistantAuto).toBeNull();
    f.setView(settingsView({ captchaAuto: { value: false }, assistantAuto: { value: false } }));
    expect(await (await get(app, "/api/settings", { cookie: COOKIE })).json()).toMatchObject({
      captchaAuto: false,
      assistantAuto: false,
    });
  });

  it("GET chatgpt answers in every mode", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    expect(await (await get(app, "/api/chatgpt", { cookie: COOKIE })).json()).toEqual(CHATGPT_STATE);
    f.setCore(null);
    for (const status of [SETUP_STATUS, RESTARTING_STATUS]) {
      f.setStatus(status);
      f.chatgpt.state.mockResolvedValueOnce({ ...CHATGPT_STATE, state: "stopped", connectedApps: null });
      const res = await get(app, "/api/chatgpt", { cookie: COOKIE });
      expect(res.status).toBe(200);
      expect(((await res.json()) as ChatgptStatus).state).toBe("stopped");
    }
  });

  it("GET helper and POST helper/check: the check result is kept and handed to the status", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const before = (await (await get(app, "/api/helper", { cookie: COOKIE })).json()) as HelperStatus;
    expect(before).toMatchObject({ configured: "auto", supported: ["claude", "codex"], lastCheck: null });
    const check = await send(app, "POST", "/api/helper/check", undefined, authed);
    expect(check.status).toBe(200);
    const result: unknown = await check.json();
    expect(result).toEqual({
      at: "2026-10-01T00:00:00.000Z",
      runtime: "claude",
      ok: true,
      code: "ok",
      message: null,
    });
    // A new core (a restart) still sees the last check: it is kept outside the core.
    const next = fakeDeps().deps;
    next.jobs.helperStatus = f.deps.jobs.helperStatus;
    f.setCore(next);
    const after = (await (await get(app, "/api/helper", { cookie: COOKIE })).json()) as HelperStatus;
    expect(after.lastCheck).toEqual(result);
  });

  it("helper, helper/check, and chatgpt/retry answer 503 not_running when the core is off", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    f.setCore(null);
    for (const status of [SETUP_STATUS, RESTARTING_STATUS]) {
      f.setStatus(status);
      for (const [method, path] of [
        ["GET", "/api/helper"],
        ["POST", "/api/helper/check"],
        ["POST", "/api/chatgpt/retry"],
      ] as const) {
        const res =
          method === "GET"
            ? await get(app, path, { cookie: COOKIE })
            : await send(app, method, path, undefined, authed);
        expect(res.status, `${status.mode} ${path}`).toBe(503);
        expect(((await res.json()) as { error: string }).error).toBe("not_running");
      }
    }
    expect(f.chatgpt.retry).not.toHaveBeenCalled();
  });
});

describe("settings-page API: PUT settings", () => {
  it("a change: preview → write → restart; 202 with the changed fields", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const res = await send(
      app,
      "PUT",
      "/api/settings",
      { helperRuntime: "claude", asideAccount: "u1" },
      authed,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      changed: ["helperRuntime", "asideAccount"],
      restarting: true,
      appsDisconnected: null,
    });
    expect(f.settings.write).toHaveBeenCalledWith({ helperRuntime: "claude", asideAccount: "u1" });
    expect(f.order).toEqual(["write", "restart"]);
  });

  it("no change: 200 and nothing written, no restart", async () => {
    const f = fakeSource();
    f.settingsPage.preview.mockReturnValue({ ok: true, changed: [] });
    const app = makeApp(f.source);
    for (const body of [{}, { helperRuntime: "auto" }]) {
      const res = await send(app, "PUT", "/api/settings", body, authed);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ changed: [], restarting: false, appsDisconnected: null });
    }
    expect(f.settings.write).not.toHaveBeenCalled();
    expect(f.runMode.restart).not.toHaveBeenCalled();
  });

  it("the store finding nothing to change also ends without a restart", async () => {
    const f = fakeSource();
    f.settings.write.mockImplementationOnce(async () => {
      f.order.push("write");
      return { ok: true, changed: [] };
    });
    const app = makeApp(f.source);
    const res = await send(app, "PUT", "/api/settings", { passphrase: SECRET_PASSPHRASE }, authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: [], restarting: false, appsDisconnected: null });
    expect(f.order).toEqual(["write"]);
  });

  it("invalid input: 400 invalid with fields (types, unsupported runtime, preview codes)", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const cases: [unknown, Record<string, string>][] = [
      [{ passphrase: 42 }, { passphrase: "bad_value" }],
      [{ helperRuntime: "gpt" }, { helperRuntime: "bad_value" }],
      [{ asideAccount: ["u1"] }, { asideAccount: "bad_value" }],
      [{ passphrase: SECRET_PASSPHRASE, disconnectApps: "yes" }, { disconnectApps: "bad_value" }],
      [{ captchaAuto: "false" }, { captchaAuto: "bad_value" }],
      [{ captchaAuto: 0 }, { captchaAuto: "bad_value" }],
      [{ captchaAuto: null }, { captchaAuto: "bad_value" }],
      [{ assistantAuto: "true" }, { assistantAuto: "bad_value" }],
      [{ assistantAuto: 1 }, { assistantAuto: "bad_value" }],
      [{ assistantAuto: null }, { assistantAuto: "bad_value" }],
    ];
    for (const [body, fields] of cases) {
      const res = await send(app, "PUT", "/api/settings", body, authed);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid", fields });
    }
    // A runtime this build does not ship (stop rule) is bad_value too.
    f.settingsPage.supportedRuntimes.mockReturnValue(["claude"]);
    const codex = await send(app, "PUT", "/api/settings", { helperRuntime: "codex" }, authed);
    expect(codex.status).toBe(400);
    expect(await codex.json()).toMatchObject({ error: "invalid", fields: { helperRuntime: "bad_value" } });
    // The preview's validation (the store's rules): too_short, empty, unsupported_characters.
    for (const code of ["too_short", "empty", "unsupported_characters"] as const) {
      f.settingsPage.preview.mockReturnValueOnce({
        ok: false,
        error: "invalid",
        fields: { passphrase: code },
        message: `passphrase: ${code}`,
      });
      const res = await send(app, "PUT", "/api/settings", { passphrase: "x" }, authed);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "invalid",
        message: `passphrase: ${code}`,
        fields: { passphrase: code },
      });
    }
    const bad = await send(app, "PUT", "/api/settings", "not an object", authed);
    expect(bad.status).toBe(400);
    expect(f.settings.write).not.toHaveBeenCalled();
    expect(f.runMode.restart).not.toHaveBeenCalled();
  });

  it("locked and file_unreadable: 409 (with fields for locked)", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    f.settingsPage.preview.mockReturnValueOnce({
      ok: false,
      error: "locked",
      fields: { passphrase: "locked" },
      message: "passphrase is set outside the settings files",
    });
    const locked = await send(app, "PUT", "/api/settings", { passphrase: SECRET_PASSPHRASE }, authed);
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ error: "locked", fields: { passphrase: "locked" } });
    f.settingsPage.preview.mockReturnValueOnce({
      ok: false,
      error: "file_unreadable",
      message: "/project/config/bridge.json is not valid JSON",
    });
    const unreadable = await send(app, "PUT", "/api/settings", { helperRuntime: "claude" }, authed);
    expect(unreadable.status).toBe(409);
    expect(await unreadable.json()).toEqual({
      error: "file_unreadable",
      message: "/project/config/bridge.json is not valid JSON",
    });
    // The store's own refusal at write time maps the same way, and nothing restarts.
    f.settings.write.mockImplementationOnce(async () => {
      f.order.push("write");
      return {
        ok: false,
        error: "file_unreadable",
        file: "/project/config/bridge.json",
        message: "/project/config/bridge.json cannot be read",
      };
    });
    const late = await send(app, "PUT", "/api/settings", { helperRuntime: "claude" }, authed);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: "file_unreadable" });
    expect(f.order).toEqual(["write"]);
  });

  it("job_running: refused while a job is running unless confirmInterrupt is true", async () => {
    const f = fakeSource();
    f.deps.jobs.list.mockReturnValue([job({ state: "running" })]);
    const app = makeApp(f.source);
    const refused = await send(app, "PUT", "/api/settings", { helperRuntime: "claude" }, authed);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "job_running" });
    expect(f.settings.write).not.toHaveBeenCalled();
    const confirmed = await send(
      app,
      "PUT",
      "/api/settings",
      { helperRuntime: "claude", confirmInterrupt: true },
      authed,
    );
    expect(confirmed.status).toBe(202);
    // A paused (awaiting_user) or queued job does not count.
    f.deps.jobs.list.mockReturnValue([job({ state: "awaiting_user" }), job({ id: "j2", state: "queued" })]);
    expect((await send(app, "PUT", "/api/settings", { helperRuntime: "claude" }, authed)).status).toBe(202);
    // No change answers 200 even while a job runs.
    f.deps.jobs.list.mockReturnValue([job({ state: "running" })]);
    f.settingsPage.preview.mockReturnValueOnce({ ok: true, changed: [] });
    expect((await send(app, "PUT", "/api/settings", { helperRuntime: "auto" }, authed)).status).toBe(200);
  });

  it("busy: 409 during a restart, and for a second save while one is in progress", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    f.setBusy(true);
    f.setCore(null);
    f.setStatus(RESTARTING_STATUS);
    for (const [method, path, body] of [
      ["PUT", "/api/settings", { helperRuntime: "claude" }],
      ["POST", "/api/restart", {}],
      ["POST", "/api/chatgpt/setup", { tunnelId: TUNNEL_ID, runtimeKey: SECRET_KEY }],
      ["DELETE", "/api/chatgpt", {}],
    ] as const) {
      const res = await send(app, method, path, body, authed);
      expect(res.status, path).toBe(409);
      expect(((await res.json()) as { error: string }).error, path).toBe("busy");
    }
    expect(f.settings.write).not.toHaveBeenCalled();
    expect(f.chatgpt.setup).not.toHaveBeenCalled();
    expect(f.chatgpt.disconnect).not.toHaveBeenCalled();

    // A restart already running in the controller (the busy check races): mapped to busy as well.
    f.setBusy(false);
    f.runMode.restart.mockRejectedValueOnce(busyError());
    const raced = await send(app, "PUT", "/api/settings", { helperRuntime: "claude" }, authed);
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ error: "busy" });
  });

  it("answers 202 when the files are written, before the restart has finished", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const release = f.holdRestart();
    const res = await send(app, "PUT", "/api/settings", { helperRuntime: "codex" }, authed);
    expect(res.status).toBe(202);
    expect(f.order).toEqual(["write", "restart"]);
    release();
  });

  it("in setup mode a save is accepted (files written, a start attempted)", async () => {
    const f = fakeSource();
    f.setCore(null);
    f.setStatus(SETUP_STATUS);
    const app = makeApp(f.source);
    const res = await send(app, "PUT", "/api/settings", { passphrase: SECRET_PASSPHRASE }, authed);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ changed: ["passphrase"], restarting: true, appsDisconnected: null });
    expect(f.settings.write).toHaveBeenCalledWith({ passphrase: SECRET_PASSPHRASE });
  });

  it("disconnectApps with a new passphrase revokes every connected app (running core)", async () => {
    const f = fakeSource();
    f.deps.oauth.listClients.mockResolvedValue([
      ...(await f.deps.oauth.listClients()),
      { ...(await f.deps.oauth.listClients())[0]!, clientId: "client-2", activeTokens: 0 },
    ]);
    const app = makeApp(f.source);
    const res = await send(
      app,
      "PUT",
      "/api/settings",
      { passphrase: SECRET_PASSPHRASE, disconnectApps: true },
      authed,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ changed: ["passphrase"], restarting: true, appsDisconnected: true });
    expect(f.deps.oauth.revoke).toHaveBeenCalledWith({ clientId: "client-1" });
    expect(f.deps.oauth.revoke).toHaveBeenCalledWith({ clientId: "client-2" });
    expect(f.settingsPage.revokeAllAppsOffline).not.toHaveBeenCalled();
  });

  it("disconnectApps with the core off goes to the token file directly", async () => {
    const f = fakeSource();
    f.setCore(null);
    f.setStatus(SETUP_STATUS);
    const app = makeApp(f.source);
    const res = await send(
      app,
      "PUT",
      "/api/settings",
      { passphrase: SECRET_PASSPHRASE, disconnectApps: true },
      authed,
    );
    expect(await res.json()).toEqual({ changed: ["passphrase"], restarting: true, appsDisconnected: true });
    expect(f.order).toEqual(["write", "revokeOffline", "restart"]);
  });

  it("disconnectApps that cannot be carried out: the passphrase is changed, appsDisconnected false", async () => {
    const f = fakeSource();
    f.deps.oauth.revoke.mockRejectedValueOnce(new Error("token store is broken"));
    const app = makeApp(f.source);
    const res = await send(
      app,
      "PUT",
      "/api/settings",
      { passphrase: SECRET_PASSPHRASE, disconnectApps: true },
      authed,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ changed: ["passphrase"], restarting: true, appsDisconnected: false });
    expect(f.order).toEqual(["write", "restart"]);
  });

  it("disconnectApps is honoured only together with a passphrase change", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const res = await send(
      app,
      "PUT",
      "/api/settings",
      { helperRuntime: "claude", disconnectApps: true },
      authed,
    );
    expect(await res.json()).toEqual({
      changed: ["helperRuntime"],
      restarting: true,
      appsDisconnected: null,
    });
    expect(f.deps.oauth.revoke).not.toHaveBeenCalled();
    expect(f.settingsPage.revokeAllAppsOffline).not.toHaveBeenCalled();
    const noTick = await send(
      app,
      "PUT",
      "/api/settings",
      { passphrase: SECRET_PASSPHRASE, disconnectApps: false },
      authed,
    );
    expect(await noTick.json()).toEqual({
      changed: ["passphrase"],
      restarting: true,
      appsDisconnected: null,
    });
    expect(f.deps.oauth.revoke).not.toHaveBeenCalled();
  });
});

describe("settings-page API: captchaAuto", () => {
  it("PUT settings passes captchaAuto through the preview and the store and restarts the core", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const res = await send(app, "PUT", "/api/settings", { captchaAuto: false }, authed);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ changed: ["captchaAuto"], restarting: true, appsDisconnected: null });
    expect(f.settingsPage.preview).toHaveBeenCalledWith({ captchaAuto: false });
    expect(f.settings.write).toHaveBeenCalledWith({ captchaAuto: false });
    expect(f.order).toEqual(["write", "restart"]);
    // Together with other fields; `true` is sent as a boolean as well.
    await send(app, "PUT", "/api/settings", { captchaAuto: true, helperRuntime: "codex" }, authed);
    expect(f.settings.write).toHaveBeenLastCalledWith({ helperRuntime: "codex", captchaAuto: true });
  });

  it("no change and file_unreadable follow the preview", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    f.settingsPage.preview.mockReturnValueOnce({ ok: true, changed: [] });
    const same = await send(app, "PUT", "/api/settings", { captchaAuto: true }, authed);
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ changed: [], restarting: false, appsDisconnected: null });
    f.settingsPage.preview.mockReturnValueOnce({
      ok: false,
      error: "file_unreadable",
      message: "/project/config/bridge.json is not valid JSON",
    });
    const unreadable = await send(app, "PUT", "/api/settings", { captchaAuto: false }, authed);
    expect(unreadable.status).toBe(409);
    expect(await unreadable.json()).toMatchObject({ error: "file_unreadable" });
    expect(f.settings.write).not.toHaveBeenCalled();
  });
});

describe("settings-page API: assistantAuto", () => {
  it("PUT settings passes assistantAuto through the preview and the store and restarts the core", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const res = await send(app, "PUT", "/api/settings", { assistantAuto: false }, authed);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      changed: ["assistantAuto"],
      restarting: true,
      appsDisconnected: null,
    });
    expect(f.settingsPage.preview).toHaveBeenCalledWith({ assistantAuto: false });
    expect(f.settings.write).toHaveBeenCalledWith({ assistantAuto: false });
    expect(f.order).toEqual(["write", "restart"]);
    await send(app, "PUT", "/api/settings", { assistantAuto: true, captchaAuto: false }, authed);
    expect(f.settings.write).toHaveBeenLastCalledWith({ captchaAuto: false, assistantAuto: true });
  });

  it("no change and file_unreadable follow the preview", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    f.settingsPage.preview.mockReturnValueOnce({ ok: true, changed: [] });
    const same = await send(app, "PUT", "/api/settings", { assistantAuto: true }, authed);
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ changed: [], restarting: false, appsDisconnected: null });
    f.settingsPage.preview.mockReturnValueOnce({
      ok: false,
      error: "file_unreadable",
      message: "/project/config/bridge.json is not valid JSON",
    });
    const unreadable = await send(app, "PUT", "/api/settings", { assistantAuto: false }, authed);
    expect(unreadable.status).toBe(409);
    expect(f.settings.write).not.toHaveBeenCalled();
  });
});

describe("the Aside AI on the API", () => {
  const RECORD = {
    purpose: "login",
    verdict: "needs_user",
    reason: "verification_code",
    at: "2026-10-09T10:00:00.000Z",
    running: false,
  } as const;

  it("GET sites carries each site's last assistant task (null when none ran or no coordinator)", async () => {
    const { deps } = fakeDeps();
    const bare = makeApp(deps);
    const plain = (await (await get(bare, "/api/sites", { cookie: COOKIE })).json()) as {
      sites: { key: string; assistant: unknown }[];
    };
    expect(plain.sites[0]?.assistant).toBeNull();

    const views = new Map<string, typeof RECORD>([["example-news", RECORD]]);
    const app = makeApp({
      ...deps,
      registry: { list: () => [site("example-news"), site("other", { hostnames: ["other.example.org"] })] },
      assistant: { view: (key: string) => views.get(key) ?? null, available: () => true },
    });
    const body = (await (await get(app, "/api/sites", { cookie: COOKIE })).json()) as {
      sites: { key: string; assistant: unknown }[];
    };
    expect(body.sites.map((s) => [s.key, s.assistant])).toEqual([
      ["example-news", RECORD],
      ["other", null],
    ]);
  });

  it("GET overview carries assistantAvailable: the probe's answer, null before it or without a coordinator", async () => {
    const { deps } = fakeDeps();
    const read = async (app: ReturnType<typeof makeApp>) =>
      (
        (await (await get(app, "/api/overview", { cookie: COOKIE })).json()) as {
          assistantAvailable: unknown;
        }
      ).assistantAvailable;
    expect(await read(makeApp(deps))).toBeNull();
    let available: boolean | null = null;
    const app = makeApp({ ...deps, assistant: { view: () => null, available: () => available } });
    expect(await read(app)).toBeNull();
    available = false;
    expect(await read(app)).toBe(false);
    available = true;
    expect(await read(app)).toBe(true);
  });
});

describe("settings-page API: POST settings/passphrase/clipboard", () => {
  const PATH = "/api/settings/passphrase/clipboard";

  it("ok → 200 { ok: true } in every mode (core on, off, or restarting)", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const res = await send(app, "POST", PATH, undefined, authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    f.setCore(null);
    f.setStatus(SETUP_STATUS);
    expect((await send(app, "POST", PATH, undefined, authed)).status).toBe(200);
    f.setStatus(RESTARTING_STATUS);
    f.setBusy(true);
    expect((await send(app, "POST", PATH, {}, authed)).status).toBe(200);
    expect(f.copyPassphrase).toHaveBeenCalledTimes(3);
    expect(f.logger.lines.filter((l) => l.includes("passphrase copied to the clipboard"))).toHaveLength(3);
  });

  it("maps not_set and locked to 409, unavailable to 500, with the error body shape", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    f.copyPassphrase.mockResolvedValueOnce("not_set");
    const notSet = await send(app, "POST", PATH, undefined, authed);
    expect(notSet.status).toBe(409);
    expect(await notSet.json()).toEqual({ error: "not_set", message: expect.any(String) as string });
    f.copyPassphrase.mockResolvedValueOnce("locked");
    const locked = await send(app, "POST", PATH, undefined, authed);
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({
      error: "locked",
      message: expect.stringContaining("set outside the settings files") as string,
      fields: { passphrase: "locked" },
    });
    f.copyPassphrase.mockResolvedValueOnce("unavailable");
    const unavailable = await send(app, "POST", PATH, undefined, authed);
    expect(unavailable.status).toBe(500);
    expect(await unavailable.json()).toEqual({ error: "unavailable", message: expect.any(String) as string });
    f.copyPassphrase.mockRejectedValueOnce(new Error("boom"));
    const thrown = await send(app, "POST", PATH, undefined, authed);
    expect(thrown.status).toBe(500);
    expect(await thrown.json()).toMatchObject({ error: "server_error" });
  });

  it("404 when the process does not provide it; GET is not a route", async () => {
    const f = fakeSource();
    const app = makeApp({ ...f.source, copyPassphrase: undefined });
    expect((await send(app, "POST", PATH, undefined, authed)).status).toBe(404);
    const withIt = makeApp(f.source);
    expect((await get(withIt, PATH, { cookie: COOKIE })).status).toBe(404);
    expect(f.copyPassphrase).not.toHaveBeenCalled();
  });
});

describe("settings-page API: the persisted helper check", () => {
  it("GET helper reads the last check from the process's log; POST helper/check runs through it", async () => {
    const f = fakeSource();
    const stored: HelperCheckResult = {
      at: "2026-10-07T00:00:00.000Z",
      runtime: "codex",
      ok: false,
      code: "limit_reached",
      message: "usage limit",
    };
    const fresh: HelperCheckResult = { ...stored, runtime: "claude", ok: true, code: "ok", message: null };
    const log = {
      last: vi.fn(async () => stored),
      run: vi.fn(async (jobs: Pick<DashboardDeps["jobs"], "helperCheck">) => {
        expect(jobs.helperCheck).toBe(f.deps.jobs.helperCheck);
        return fresh;
      }),
    } satisfies HelperCheckLog;
    const app = makeApp({ ...f.source, helperChecks: log });
    const status = (await (await get(app, "/api/helper", { cookie: COOKIE })).json()) as HelperStatus;
    expect(status.lastCheck).toEqual(stored);
    expect(f.deps.jobs.helperStatus).toHaveBeenCalledWith(stored);
    const check = await send(app, "POST", "/api/helper/check", undefined, authed);
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual(fresh);
    expect(log.run).toHaveBeenCalledTimes(1);
    // The job service itself is not called directly: the log shares a check already in progress.
    expect(f.deps.jobs.helperCheck).not.toHaveBeenCalled();
  });
});

describe("settings-page API: POST restart", () => {
  it("202 restarting; job_running without confirmation; accepted in setup", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const ok = await send(app, "POST", "/api/restart", {}, authed);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ restarting: true });
    f.deps.jobs.list.mockReturnValue([job({ state: "running" })]);
    const refused = await send(app, "POST", "/api/restart", undefined, authed);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "job_running" });
    expect((await send(app, "POST", "/api/restart", { confirmInterrupt: true }, authed)).status).toBe(202);
    f.setCore(null);
    f.setStatus(SETUP_STATUS);
    expect((await send(app, "POST", "/api/restart", {}, authed)).status).toBe(202);
    // Three restarts happened; the refused request restarted nothing.
    expect(f.order.filter((step) => step === "restart")).toHaveLength(3);
  });
});

describe("settings-page API: ChatGPT connection", () => {
  it("POST chatgpt/setup: 202, passes the fields through, refuses during a running job", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const body = { tunnelId: TUNNEL_ID, runtimeKey: SECRET_KEY, profile: "my-profile", replace: true };
    const res = await send(app, "POST", "/api/chatgpt/setup", body, authed);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ restarting: true });
    expect(f.chatgpt.setup).toHaveBeenCalledWith(body);
    f.deps.jobs.list.mockReturnValue([job({ state: "running" })]);
    const refused = await send(app, "POST", "/api/chatgpt/setup", body, authed);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "job_running" });
    expect(f.chatgpt.setup).toHaveBeenCalledTimes(1);
    expect(
      (await send(app, "POST", "/api/chatgpt/setup", { ...body, confirmInterrupt: true }, authed)).status,
    ).toBe(202);
    // Accepted in setup mode.
    f.setCore(null);
    f.setStatus(SETUP_STATUS);
    expect((await send(app, "POST", "/api/chatgpt/setup", body, authed)).status).toBe(202);
  });

  it("POST chatgpt/setup: input errors come first (400 invalid + fields), before busy or job checks", async () => {
    const f = fakeSource();
    f.deps.jobs.list.mockReturnValue([job({ state: "running" })]);
    const app = makeApp(f.source);
    const res = await send(
      app,
      "POST",
      "/api/chatgpt/setup",
      { tunnelId: "tunnel_x", runtimeKey: "" },
      authed,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid",
      fields: { tunnelId: "bad_format", runtimeKey: "empty" },
    });
    expect(f.chatgpt.setup).not.toHaveBeenCalled();
  });

  it("maps every error code of the service to its status", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const body = { tunnelId: TUNNEL_ID, runtimeKey: SECRET_KEY };
    const cases: [ChatgptFailure, number, string][] = [
      [
        { ok: false, error: "invalid", message: "invalid: profile", fields: { profile: "bad_value" } },
        400,
        "invalid",
      ],
      [
        { ok: false, error: "tool_missing", message: "the connection tool is not installed" },
        409,
        "tool_missing",
      ],
      [{ ok: false, error: "exists", message: "a profile or key file already exists" }, 409, "exists"],
      [{ ok: false, error: "busy", message: "busy" }, 409, "busy"],
      [
        { ok: false, error: "file_unreadable", message: "config/bridge.json is not valid JSON" },
        409,
        "file_unreadable",
      ],
      [{ ok: false, error: "locked", message: "locked" }, 409, "locked"],
      [
        { ok: false, error: "config_invalid", message: "the public address cannot be worked out" },
        409,
        "config_invalid",
      ],
      [
        {
          ok: false,
          error: "prepare_failed",
          kind: "key_write_failed",
          message: "cannot write the key file",
        },
        500,
        "server_error",
      ],
      [{ ok: false, error: "not_running", message: "the core is not running" }, 503, "not_running"],
    ];
    for (const [failure, status, error] of cases) {
      f.chatgpt.setup.mockResolvedValueOnce(failure);
      const res = await send(app, "POST", "/api/chatgpt/setup", body, authed);
      expect(res.status, failure.error).toBe(status);
      const json = (await res.json()) as { error: string; message: string; fields?: unknown };
      expect(json.error, failure.error).toBe(error);
      expect(json.message).toBe(failure.message);
      if (failure.fields) expect(json.fields).toEqual(failure.fields);
    }
    for (const [failure, status] of [
      [{ ok: false, error: "external", message: "set up by hand" }, 409],
      [{ ok: false, error: "not_configured", message: "no ChatGPT connection is configured" }, 409],
    ] as [ChatgptFailure, number][]) {
      f.chatgpt.disconnect.mockResolvedValueOnce(failure);
      const del = await send(app, "DELETE", "/api/chatgpt", {}, authed);
      expect(del.status).toBe(status);
      expect(((await del.json()) as { error: string }).error).toBe(failure.error);
      f.chatgpt.retry.mockResolvedValueOnce(failure);
      const retry = await send(app, "POST", "/api/chatgpt/retry", undefined, authed);
      expect(retry.status).toBe(status);
      expect(((await retry.json()) as { error: string }).error).toBe(failure.error);
    }
  });

  it("POST chatgpt/retry: 202 when started again, 200 with nothing done", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const started = await send(app, "POST", "/api/chatgpt/retry", undefined, authed);
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ state: "starting" });
    f.chatgpt.retry.mockResolvedValueOnce({ ok: true, started: false, state: "ready" });
    const nothing = await send(app, "POST", "/api/chatgpt/retry", undefined, authed);
    expect(nothing.status).toBe(200);
    expect(await nothing.json()).toEqual({ state: "ready" });
  });

  it("DELETE chatgpt: 202 restarting; job_running without confirmation; accepted in setup", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const res = await send(app, "DELETE", "/api/chatgpt", {}, authed);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ restarting: true });
    f.deps.jobs.list.mockReturnValue([job({ state: "running" })]);
    const refused = await send(app, "DELETE", "/api/chatgpt", undefined, authed);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "job_running" });
    expect((await send(app, "DELETE", "/api/chatgpt", { confirmInterrupt: true }, authed)).status).toBe(202);
    f.setCore(null);
    f.setStatus(SETUP_STATUS);
    expect((await send(app, "DELETE", "/api/chatgpt", {}, authed)).status).toBe(202);
    expect(f.chatgpt.disconnect).toHaveBeenCalledTimes(3);
  });
});

describe("settings-page API: no secret leaves", () => {
  it("no response body or log line holds the passphrase, the runtime key, or the admin token", async () => {
    const f = fakeSource();
    const app = makeApp(f.source);
    const bodies: string[] = [];
    const collect = async (res: Response) => bodies.push(`${res.status} ${await res.text()}`);
    await collect(
      await send(
        app,
        "PUT",
        "/api/settings",
        { passphrase: SECRET_PASSPHRASE, disconnectApps: true },
        authed,
      ),
    );
    f.settingsPage.preview.mockReturnValueOnce({
      ok: false,
      error: "invalid",
      fields: { passphrase: "too_short" },
      message: "passphrase: too_short",
    });
    await collect(await send(app, "PUT", "/api/settings", { passphrase: SECRET_PASSPHRASE }, authed));
    await collect(
      await send(app, "POST", "/api/chatgpt/setup", { tunnelId: TUNNEL_ID, runtimeKey: SECRET_KEY }, authed),
    );
    await collect(
      await send(app, "POST", "/api/chatgpt/setup", { tunnelId: "x", runtimeKey: SECRET_KEY }, authed),
    );
    f.chatgpt.setup.mockRejectedValueOnce(new Error("unexpected"));
    await collect(
      await send(app, "POST", "/api/chatgpt/setup", { tunnelId: TUNNEL_ID, runtimeKey: SECRET_KEY }, authed),
    );
    for (const path of ["/api/status", "/api/settings", "/api/chatgpt", "/api/helper"]) {
      await collect(await get(app, path, { cookie: COOKIE }));
    }
    await collect(await send(app, "POST", "/api/helper/check", undefined, authed));
    for (const result of ["ok", "not_set", "locked", "unavailable"] as const) {
      f.copyPassphrase.mockResolvedValueOnce(result);
      await collect(await send(app, "POST", "/api/settings/passphrase/clipboard", undefined, authed));
    }
    await collect(await send(app, "POST", "/api/restart", {}, authed));
    await collect(await send(app, "DELETE", "/api/chatgpt", {}, authed));
    const all = [...bodies, ...f.logger.lines].join("\n");
    expect(bodies.length).toBeGreaterThan(10);
    expect(all).toContain("PUT");
    for (const secret of [SECRET_PASSPHRASE, SECRET_KEY, TOKEN]) expect(all).not.toContain(secret);
  });
});

describe("changed routes: lang and the job summary", () => {
  it("passes lang to Add, Retry, Repair, and job Retry; anything else is English", async () => {
    const { deps } = fakeDeps();
    const app = makeApp(deps);
    await send(app, "POST", "/api/sites", { input: "https://www.reuters.com", lang: "ko" }, authed);
    expect(deps.jobs.add).toHaveBeenLastCalledWith({
      input: "https://www.reuters.com",
      note: null,
      lang: "ko",
    });
    await send(app, "POST", "/api/sites", { input: "https://www.reuters.com", lang: "fr" }, authed);
    expect(deps.jobs.add).toHaveBeenLastCalledWith({
      input: "https://www.reuters.com",
      note: null,
      lang: "en",
    });
    await send(app, "POST", "/api/sites/example-news/retry", { lang: "ko" }, authed);
    expect(deps.jobs.retry).toHaveBeenLastCalledWith("example-news", { lang: "ko" });
    await send(app, "POST", "/api/sites/example-news/repair", { lang: "ko" }, authed);
    expect(deps.jobs.repair).toHaveBeenLastCalledWith("example-news", null, { lang: "ko" });
    await send(app, "POST", "/api/jobs/job-1/retry", { lang: "ko" }, authed);
    expect(deps.jobs.retryJob).toHaveBeenLastCalledWith("job-1", { lang: "ko" });
    await send(app, "POST", "/api/jobs/job-1/retry", { lang: 7 }, authed);
    expect(deps.jobs.retryJob).toHaveBeenLastCalledWith("job-1", { lang: "en" });
  });

  it("the job summary carries lang, runtime, and blockKind (old records: en, null, other)", async () => {
    const { deps } = fakeDeps();
    deps.jobs.list.mockReturnValue([
      job({ lang: "ko", runtime: "codex", state: "awaiting_user", blockKind: "login" }),
      job({ id: "old", lang: undefined, runtime: undefined, blockKind: undefined }),
    ]);
    const app = makeApp(deps);
    const body = (await (await get(app, "/api/jobs", { cookie: COOKIE })).json()) as {
      jobs: { id: string; lang: string; runtime: string | null; blockKind: string }[];
    };
    expect(body.jobs.map((j) => [j.id, j.lang, j.runtime, j.blockKind])).toEqual([
      ["job-1", "ko", "codex", "login"],
      ["old", "en", null, "other"],
    ]);
  });
});

describe("not signed in page", () => {
  it("shows Korean and English and points to the opener", async () => {
    const app = makeApp(fakeDeps().deps);
    for (const path of ["/", "/?token=wrong"]) {
      const res = await get(app, path);
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain("Open Settings.command");
      expect(html).toMatch(/[가-힣]/); // Hangul
      expect(html).toMatch(/double-click/i);
      expect(html).not.toContain(TOKEN);
    }
  });
});
