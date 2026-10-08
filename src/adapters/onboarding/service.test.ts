import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAdapterFolder } from "../../../test/support/site-fixtures.js";
import { InMemoryScheduler } from "../aside/scheduler.js";
import { MemoryJobStore } from "./job-store.js";
import type { OnboardingJobService } from "./service.js";
import { addInputHostname, checkPublicHostname, redactSecrets } from "./service.js";
import { adapterSource, makeHarness, untilAborted, writeAndValidate } from "./test-fixtures.js";
import type { Harness } from "./test-fixtures.js";
import type { JobEvent, OnboardingJob } from "./types.js";
import { OnboardingRequestError } from "./types.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const KEY = "demo-example";
const HOST = "demo.example.com";

describe("OnboardingJobService", () => {
  let h: Harness;
  let svc: OnboardingJobService;

  beforeEach(async () => {
    h = await makeHarness();
    svc = h.makeService();
  });
  afterEach(async () => {
    await svc.stop();
    await h.cleanup();
  });

  it("Add: registers the site as onboarding, runs the agent, validates itself, promotes, commits", async () => {
    h.runner.push(async (ctx) => {
      await writeAndValidate(ctx, KEY, HOST);
      const r = await ctx.call("finish", { summary: "search + read via the site's pages" });
      expect(r.isError).toBeUndefined();
    });
    const job = await svc.add({ input: `https://${HOST}/news`, note: "only the news section" });
    expect(job.key).toBe(KEY);
    expect(job.state).toBe("queued");
    expect(h.registry.get(KEY)?.status).toBe("onboarding");

    await svc.start();
    await svc.whenIdle();

    const done = svc.get(KEY) as OnboardingJob;
    expect(done.state).toBe("succeeded");
    expect(done.summary).toContain("search");
    expect(done.commit).toBe("c0ffee");
    expect(h.registry.get(KEY)?.status).toBe("active");
    expect(h.commits).toEqual([[KEY, "add"]]);
    // The service ran its own validation after the agent's.
    expect(h.validations).toEqual(["agent", "service"]);
    expect(await readFile(join(h.sitesDir, KEY, "adapter.ts"), "utf8")).toContain('"v1"');
    expect(await exists(join(h.sitesDir, KEY, ".staging"))).toBe(false);
    // The agent got the user's note and the path rules in its instructions.
    const req = h.runner.requests[0];
    expect(req?.systemPrompt).toContain("only the news section");
    expect(req?.systemPrompt).toContain(`sites/${KEY}/.staging/`);
    expect(req?.systemPrompt).toContain("UNTRUSTED");
    expect(req?.resumeSessionId).toBeNull();
  });

  it("the agent's validation honors the site's cool-down; the service's promotion gate does not", async () => {
    h.runner.push(async (ctx) => {
      await writeAndValidate(ctx, KEY, HOST);
      await ctx.call("finish", { summary: "done" });
    });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    expect(svc.get(KEY)?.state).toBe("succeeded");
    expect(h.validations).toEqual(["agent", "service"]);
    expect(h.validationIgnoresCooldown).toEqual([false, true]);
  });

  it("rejects an Add whose hostname is already registered", async () => {
    await svc.add({ input: `https://${HOST}` });
    await expect(svc.add({ input: `${HOST}/other` })).rejects.toThrow(
      `already registered as ${KEY}; use Repair or Remove`,
    );
    await expect(svc.add({ input: "https://127.0.0.1:8788/" })).rejects.toBeInstanceOf(
      OnboardingRequestError,
    );
    await expect(svc.add({ input: "   " })).rejects.toThrow("enter a URL or a site name");
  });

  it("runs one job at a time, in FIFO order", async () => {
    const order: string[] = [];
    const script =
      (key: string, host: string) => async (ctx: Parameters<Parameters<typeof h.runner.push>[0]>[0]) => {
        order.push(`start ${key}`);
        await new Promise((r) => setTimeout(r, 20));
        await writeAndValidate(ctx, key, host);
        await ctx.call("finish", { summary: "done" });
        order.push(`end ${key}`);
      };
    h.runner.push(script("alpha-example", "alpha.example.com"), script("beta-example", "beta.example.com"));
    await svc.add({ input: "https://alpha.example.com" });
    await svc.add({ input: "https://beta.example.com" });
    await svc.start();
    await svc.whenIdle();
    expect(h.runner.maxActive).toBe(1);
    expect(order).toEqual([
      "start alpha-example",
      "end alpha-example",
      "start beta-example",
      "end beta-example",
    ]);
    expect(svc.list().map((j) => j.state)).toEqual(["succeeded", "succeeded"]);
  });

  it("blocked onboarding pauses as awaiting_user; Retry continues the same job and agent session", async () => {
    h.runner.push(
      async (ctx) => {
        const r = await ctx.call("report_blocked", {
          reason: "login wall on articles",
          requestedAction: "Log in to demo.example.com in Aside (account u0), then click Retry",
        });
        expect(r.isError).toBeUndefined();
        // Tools refuse further work once the job has ended.
        const after = await ctx.call("read_reference", { path: "docs/ADAPTERS.md" });
        expect(after.isError).toBe(true);
      },
      async (ctx) => {
        await writeAndValidate(ctx, KEY, HOST);
        await ctx.call("finish", { summary: "done after login" });
      },
    );
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    const paused = svc.get(KEY) as OnboardingJob;
    expect(paused.state).toBe("awaiting_user");
    expect(paused.reason).toBe("login wall on articles");
    expect(paused.requestedAction).toContain("then click Retry");
    expect(h.registry.get(KEY)?.status).toBe("onboarding");

    const retried = await svc.retry(KEY);
    expect(retried.id).toBe(paused.id);
    await svc.whenIdle();
    const done = svc.get(KEY) as OnboardingJob;
    expect(done.id).toBe(paused.id);
    expect(done.state).toBe("succeeded");
    expect(done.attempts).toBe(2);
    expect(h.runner.requests[1]?.resumeSessionId).toBe("session-1");
    expect(h.runner.requests[1]?.prompt).toContain("Log in to demo.example.com");
  });

  it("a resume that fails starts a new session with a summary of the job log", async () => {
    h.runner.push(
      async (ctx) => {
        await ctx.call("report_blocked", {
          reason: "captcha",
          requestedAction: "Solve the captcha, then click Retry",
        });
      },
      async () => ({ outcome: "error", resumeFailed: true, message: "No conversation found" }),
      async (ctx) => {
        expect(ctx.req.resumeSessionId).toBeNull();
        expect(ctx.req.prompt).toContain("earlier session could not be continued");
        await writeAndValidate(ctx, KEY, HOST);
        await ctx.call("finish", { summary: "all done" });
      },
    );
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    await svc.retry(KEY);
    await svc.whenIdle();
    expect(svc.get(KEY)?.state).toBe("succeeded");
  });

  it("finish is refused until a full validation passed for the current files; ending without finish fails the Add", async () => {
    h.runner.push(async (ctx) => {
      const early = await ctx.call("finish", { summary: "too early" });
      expect(early.isError).toBe(true);
      expect(JSON.stringify(early.content)).toContain("not been validated");
      await writeAndValidate(ctx, KEY, HOST);
      // A change after validation invalidates it.
      await ctx.call("write_staging_file", { path: "adapter.ts", content: adapterSource("v2") });
      const stale = await ctx.call("finish", { summary: "stale" });
      expect(stale.isError).toBe(true);
      expect(JSON.stringify(stale.content)).toContain("changed after the last validation");
    });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    const job = svc.get(KEY) as OnboardingJob;
    expect(job.state).toBe("failed");
    expect(job.reason).toBe("the agent ended without calling finish");
    expect(h.registry.get(KEY)?.status).toBe("failed");
    expect(h.commits).toEqual([]);
  });

  it("does not trust the agent: a failing service-run validation fails the Add without promotion", async () => {
    h.serviceVerdicts.push(false);
    h.runner.push(async (ctx) => {
      await writeAndValidate(ctx, KEY, HOST);
      await ctx.call("finish", { summary: "claims success" });
    });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    const job = svc.get(KEY) as OnboardingJob;
    expect(job.state).toBe("failed");
    expect(job.reason).toContain("validation failed at read");
    expect(h.registry.get(KEY)?.status).toBe("failed");
    expect(h.registry.get(KEY)?.lastFailure).toContain("validation failed");
    expect(await exists(join(h.sitesDir, KEY, "adapter.ts"))).toBe(false);
    expect(h.commits).toEqual([]);

    // Retry (failed → onboarding) reuses the job and promotes on a pass.
    h.runner.push(async (ctx) => {
      await writeAndValidate(ctx, KEY, HOST, "v3");
      await ctx.call("finish", { summary: "fixed" });
    });
    const again = await svc.retry(KEY);
    expect(again.id).toBe(job.id);
    expect(h.registry.get(KEY)?.status).toBe("onboarding");
    await svc.whenIdle();
    expect(svc.get(KEY)?.state).toBe("succeeded");
    expect(h.registry.get(KEY)?.status).toBe("active");
  });

  it("fails with a reason when the agent runs out of turns or errors", async () => {
    h.runner.push(async () => ({ outcome: "max_turns", turns: 80 }));
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    expect(svc.get(KEY)?.reason).toBe("the agent used all its turns (80) without finishing");
    expect(h.registry.get(KEY)?.status).toBe("failed");
  });

  describe("Repair", () => {
    beforeEach(async () => {
      await writeAdapterFolder(join(h.sitesDir, KEY), KEY, {
        manifest: {
          key: KEY,
          name: "Demo",
          hostnames: [HOST],
          timezone: "UTC",
          capabilities: { search: true, read: true },
          sampleQuery: "q",
          createdBy: "agent",
        },
        adapter: adapterSource("live"),
      });
      await h.registry.init();
      await h.registry.recordHealthCheck(KEY, {
        status: "adapter_error",
        message: "selector .story is gone",
      });
      expect(h.registry.get(KEY)?.status).toBe("degraded");
    });

    it("starts from a copy of the live files, keeps the site's status, and promotes on a pass (with .previous)", async () => {
      h.runner.push(async (ctx) => {
        expect(ctx.req.systemPrompt).toContain("selector .story is gone");
        const copy = await ctx.call("read_staging_file", { path: "adapter.ts" });
        expect(JSON.stringify(copy.content)).toContain("live");
        const live = await ctx.call("read_reference", { path: `sites/${KEY}/adapter.ts` });
        expect(live.isError).toBeUndefined();
        expect(h.registry.get(KEY)?.status).toBe("degraded");
        await writeAndValidate(ctx, KEY, HOST, "repaired");
        await ctx.call("finish", { summary: "new selectors" });
      });
      const job = await svc.repair(KEY);
      expect(job.kind).toBe("repair");
      expect(job.lastFailure).toBe("selector .story is gone");
      await svc.start();
      await svc.whenIdle();
      expect(svc.get(KEY)?.state).toBe("succeeded");
      expect(h.registry.get(KEY)?.status).toBe("active");
      expect(await readFile(join(h.sitesDir, KEY, "adapter.ts"), "utf8")).toContain('"repaired"');
      expect(await readFile(join(h.sitesDir, KEY, ".previous", "adapter.ts"), "utf8")).toContain('"live"');
      expect(h.commits).toEqual([[KEY, "repair"]]);
    });

    it("a failed repair leaves the live adapter and the status untouched", async () => {
      h.serviceVerdicts.push(false);
      h.runner.push(async (ctx) => {
        await writeAndValidate(ctx, KEY, HOST, "broken");
        await ctx.call("finish", { summary: "should not go live" });
      });
      await svc.repair(KEY);
      await svc.start();
      await svc.whenIdle();
      expect(svc.get(KEY)?.state).toBe("failed");
      expect(h.registry.get(KEY)?.status).toBe("degraded");
      expect(await readFile(join(h.sitesDir, KEY, "adapter.ts"), "utf8")).toContain('"live"');
      expect(h.commits).toEqual([]);
    });

    it("is refused while a job runs and for sites without an adapter", async () => {
      await svc.repair(KEY);
      await expect(svc.repair(KEY)).rejects.toThrow("already queued");
      await h.registry.registerOnboarding({ hostnames: ["fresh.example.com"] });
      await expect(svc.repair("fresh-example")).rejects.toThrow("Repair is available for");
    });
  });

  it("Remove cancels the running job, then deletes the folder and the registration", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    h.runner.push(async (ctx) => {
      await ctx.call("write_staging_file", { path: "NOTES.md", content: "# notes\n" });
      started();
      return untilAborted(ctx.req.signal);
    });
    await svc.add({ input: HOST });
    await svc.start();
    await running;
    expect(svc.get(KEY)?.state).toBe("running");
    const result = await svc.remove(KEY);
    expect(result.ok).toBe(true);
    const job = svc.list()[0] as OnboardingJob;
    expect(job.state).toBe("cancelled");
    expect(job.reason).toBe("site removed");
    expect(h.registry.get(KEY)).toBeUndefined();
    expect(await exists(join(h.sitesDir, KEY))).toBe(false);
    expect(h.commits).toEqual([[KEY, "remove"]]);
  });

  it("an agent that keeps going after Cancel cannot write staged files any more", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let late: { isError?: boolean | undefined } | null = null;
    h.runner.push(async (ctx) => {
      await ctx.call("write_staging_file", { path: "NOTES.md", content: "# before\n" });
      started();
      await untilAborted(ctx.req.signal);
      late = await ctx.call("write_staging_file", { path: "NOTES.md", content: "# after cancel\n" });
    });
    await svc.add({ input: HOST });
    await svc.start();
    await running;
    expect(await svc.cancel(KEY)).toBe(true);
    await svc.whenIdle();
    expect(svc.get(KEY)?.state).toBe("cancelled");
    expect(late).toMatchObject({ isError: true });
    expect(await readFile(join(h.registry.stagingDir(KEY), "NOTES.md"), "utf8")).toBe("# before\n");
  });

  it("cancels queued and paused jobs without running them", async () => {
    h.runner.push(async (ctx) => untilAborted(ctx.req.signal));
    await svc.add({ input: "https://one.example.com" });
    await svc.add({ input: "https://two.example.com" });
    await svc.start();
    expect(await svc.cancel("two-example")).toBe(true);
    expect(svc.get("two-example")?.state).toBe("cancelled");
    expect(h.registry.get("two-example")?.status).toBe("failed");
    expect(await svc.cancel("one-example")).toBe(true);
    await svc.whenIdle();
    expect(h.runner.requests).toHaveLength(1);
    expect(await svc.cancel("one-example")).toBe(false);
  });

  it("restart: a job left running fails as interrupted, its site becomes failed, Retry is available", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    h.runner.push(async (ctx) => {
      started();
      return untilAborted(ctx.req.signal); // still running when the second process starts
    });
    await svc.add({ input: HOST });
    await svc.start();
    await running;
    // A second process starts on the same data while the first one never finished.
    const store2 = new MemoryJobStore();
    for (const job of await h.store.loadAll()) await store2.save(job);
    expect((await store2.loadAll())[0]?.state).toBe("running");
    const svc2 = h.makeService({ store: store2 });
    await svc2.start();
    const job = svc2.get(KEY) as OnboardingJob;
    expect(job.state).toBe("failed");
    expect(job.reason).toContain("interrupted by restart");
    expect(h.registry.get(KEY)?.status).toBe("failed");

    h.runner.push(async (ctx) => {
      await writeAndValidate(ctx, KEY, HOST);
      await ctx.call("finish", { summary: "all done" });
    });
    const retried = await svc2.retry(KEY);
    expect(retried.id).toBe(job.id);
    await svc2.whenIdle();
    expect(svc2.get(KEY)?.state).toBe("succeeded");
    await svc2.stop();
  });

  it("restart: an onboarding site with no job is marked failed; queued jobs run again", async () => {
    await h.registry.registerOnboarding({ hostnames: ["orphan.example.com"] });
    await svc.add({ input: HOST }); // queued, never started in this process
    h.runner.push(async (ctx) => {
      await writeAndValidate(ctx, KEY, HOST);
      await ctx.call("finish", { summary: "all done" });
    });
    await svc.start();
    expect(h.registry.get("orphan-example")?.status).toBe("failed");
    await svc.whenIdle();
    expect(svc.get(KEY)?.state).toBe("succeeded");
  });

  it("bare-name Add: the agent resolves the homepage, then the hostname check and registration happen", async () => {
    h.runner.push(async (ctx) => {
      expect(ctx.req.tools.map((t) => t.name)).toContain("resolve_site");
      const before = await ctx.call("write_staging_file", { path: "NOTES.md", content: "x" });
      expect(before.isError).toBe(true);
      const r = await ctx.call("resolve_site", { homepageUrl: `https://${HOST}/` });
      expect(JSON.stringify(r.content)).toContain(KEY);
      await writeAndValidate(ctx, KEY, HOST);
      await ctx.call("finish", { summary: "all done" });
    });
    const job = await svc.add({ input: "Demo Example News", note: "only headlines" });
    expect(job.key).toBeNull();
    await svc.start();
    await svc.whenIdle();
    const done = svc.getJob(job.id) as OnboardingJob;
    expect(done.key).toBe(KEY);
    expect(done.state).toBe("succeeded");
    expect(h.registry.get(KEY)?.status).toBe("active");
  });

  it("bare-name Add whose homepage is already registered fails with the duplicate message", async () => {
    await h.registry.registerOnboarding({ hostnames: [HOST] });
    h.runner.push(async (ctx) => {
      const r = await ctx.call("resolve_site", { homepageUrl: `https://${HOST}` });
      expect(r.isError).toBe(true);
    });
    const job = await svc.add({ input: "Demo" });
    await svc.start();
    await svc.whenIdle();
    const done = svc.getJob(job.id) as OnboardingJob;
    expect(done.state).toBe("failed");
    expect(done.reason).toBe(`already registered as ${KEY}; use Repair or Remove`);
  });

  it("streams log lines and record changes to subscribers; log() replays them", async () => {
    h.runner.push(async (ctx) => {
      ctx.req.onEvent({ type: "text", text: "Looking at the search page" });
      await ctx.call("report_failure", { reason: "the site has no articles" });
    });
    const job = await svc.add({ input: HOST });
    const events: JobEvent[] = [];
    const all: JobEvent[] = [];
    const off = svc.subscribe(job.id, (e) => events.push(e));
    svc.subscribeAll((e) => all.push(e));
    await svc.start();
    await svc.whenIdle();
    off();
    const lines = await svc.log(job.id);
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
    expect(lines.some((l) => l.source === "agent" && l.message === "Looking at the search page")).toBe(true);
    expect(lines.some((l) => l.source === "tool" && l.message.startsWith("→ report_failure"))).toBe(true);
    expect(lines.at(-1)?.message).toBe("Failed: the site has no articles");
    // Log lines are emitted once written, so even the "queued" line reached the subscriber.
    expect(events.filter((e) => e.type === "log").map((e) => (e.type === "log" ? e.line.seq : 0))).toEqual(
      lines.map((l) => l.seq),
    );
    expect(events.some((e) => e.type === "job" && e.job.state === "failed")).toBe(true);
    expect(all.length).toBeGreaterThan(0);
    expect((await svc.log(job.id, { after: lines.length - 1 })).map((l) => l.seq)).toEqual([lines.length]);
  });

  it("stop() aborts a running agent and fails the job as interrupted", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    h.runner.push(async (ctx) => {
      started();
      return untilAborted(ctx.req.signal);
    });
    await svc.add({ input: HOST });
    await svc.start();
    await running;
    await svc.stop();
    expect(svc.get(KEY)?.state).toBe("failed");
    expect(svc.get(KEY)?.reason).toContain("interrupted by shutdown");
    expect(h.registry.get(KEY)?.status).toBe("failed");
  });

  it("browser tools: scope = provisional ∪ staged manifest hosts, other sites' hosts excluded, lock per step", async () => {
    await writeAdapterFolder(join(h.sitesDir, "other"), "other", {
      manifest: {
        key: "other",
        name: "Other",
        hostnames: ["cdn.example.com"],
        timezone: "UTC",
        capabilities: { search: true, read: true },
        sampleQuery: "q",
        createdBy: "human",
      },
    });
    await h.registry.init();
    h.runner.push(async (ctx) => {
      const open = await ctx.call("browser_open", { url: `https://${HOST}/` });
      expect(JSON.stringify(open.content)).toContain("t1");
      const outside = await ctx.call("browser_open", { url: "https://api.example.com/" });
      expect(outside.isError).toBe(true);
      await ctx.call("write_staging_file", {
        path: "manifest.json",
        content: JSON.stringify({
          key: KEY,
          hostnames: [HOST],
          extraAllowedHosts: ["api.example.com", "cdn.example.com"],
        }),
      });
      const api = await ctx.call("browser_open", { url: "https://api.example.com/v1" });
      expect(api.isError).toBeUndefined();
      const cookie = await ctx.call("browser_run_script", {
        tabId: "t2",
        title: "x",
        code: "return document.cookie",
      });
      expect(cookie.isError).toBe(true);
      const ok = await ctx.call("browser_run_script", { tabId: "t2", title: "x", code: "return 1" });
      expect(JSON.stringify(ok.content)).toContain("UNTRUSTED");
      const shot = await ctx.call("browser_screenshot", { tabId: "t2" });
      expect(shot.content.some((c) => c.type === "image")).toBe(true);
      await ctx.call("report_failure", { reason: "test over" });
    });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    expect(h.browser.scopes.map((s) => [...s.hostnames])).toEqual([[HOST], [HOST, "api.example.com"]]);
    expect(h.browser.disposed).toBe(2);
    const lines = await svc.log(svc.get(KEY)?.id as string);
    expect(
      lines.some((l) =>
        l.message.includes('cdn.example.com (overlaps the hostnames of the registered site "other")'),
      ),
    ).toBe(true);
    // Page script bodies are wrapped in their own IIFE.
    expect(h.browser.scripts[0]).toContain("return await (async () => {");
  });

  it("each helper browser step holds the site alone (exclusive) as 'onboarding running'", async () => {
    const steps: { site: string; holder: string; exclusive: boolean }[] = [];
    const scheduler = new InMemoryScheduler();
    const run = scheduler.runForSite.bind(scheduler);
    scheduler.runForSite = (options, task) => {
      steps.push({ site: options.site, holder: options.holder, exclusive: options.exclusive === true });
      return run(options, task);
    };
    await svc.stop();
    svc = h.makeService({ scheduler });
    h.runner.push(async (ctx) => {
      await ctx.call("browser_open", { url: `https://${HOST}/` });
      await ctx.call("browser_run_script", { tabId: "t1", title: "x", code: "return 1" });
      await ctx.call("report_failure", { reason: "test over" });
    });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.every((s) => s.site === KEY && s.holder === "onboarding running" && s.exclusive)).toBe(true);
  });

  describe("hosts outside the site's domain need the user's approval", () => {
    const REASON = "the adapter needs access to hosts outside example.com: api.foreign.net, img.cdn-host.org";
    const ACTION = "Approve these hosts by clicking Retry (or remove them from the manifest and Retry)";
    const stageManifest = (
      ctx: { call: (n: string, a: Record<string, unknown>) => Promise<unknown> },
      extra: string[],
    ) =>
      ctx.call("write_staging_file", {
        path: "manifest.json",
        content: JSON.stringify({ key: KEY, hostnames: [HOST], extraAllowedHosts: extra }),
      });

    it("a host on the site's registrable domain is in scope without asking", async () => {
      h.runner.push(async (ctx) => {
        await stageManifest(ctx, ["static.example.com"]);
        const r = await ctx.call("browser_open", { url: "https://static.example.com/x.js" });
        expect(r.isError).toBeUndefined();
        await ctx.call("report_failure", { reason: "test over" });
      });
      await svc.add({ input: HOST });
      await svc.start();
      await svc.whenIdle();
      expect(h.browser.scopes.map((s) => [...s.hostnames])).toEqual([[HOST, "static.example.com"]]);
      expect(svc.get(KEY)?.state).toBe("failed");
    });

    it("a foreign host pauses the job; Retry approves exactly the listed hosts; a new foreign host pauses again", async () => {
      h.runner.push(
        async (ctx) => {
          await stageManifest(ctx, ["api.foreign.net", "img.cdn-host.org", "static.example.com"]);
          const r = await ctx.call("browser_open", { url: `https://${HOST}/` });
          expect(r.isError).toBe(true);
          expect(JSON.stringify(r.content)).toContain("paused");
          const after = await ctx.call("browser_open", { url: `https://${HOST}/` });
          expect(after.isError).toBe(true);
        },
        async (ctx) => {
          const r = await ctx.call("browser_open", { url: "https://api.foreign.net/v1" });
          expect(r.isError).toBeUndefined();
          await stageManifest(ctx, ["api.foreign.net", "img.cdn-host.org", "evil.attacker.io"]);
          const again = await ctx.call("browser_open", { url: `https://${HOST}/` });
          expect(again.isError).toBe(true);
        },
      );
      await svc.add({ input: HOST });
      await svc.start();
      await svc.whenIdle();
      const paused = svc.get(KEY) as OnboardingJob;
      expect(paused.state).toBe("awaiting_user");
      expect(paused.reason).toBe(REASON);
      expect(paused.requestedAction).toBe(ACTION);
      expect(paused.pendingHosts).toEqual(["api.foreign.net", "img.cdn-host.org"]);
      expect(paused.approvedHosts).toEqual([]);
      // The foreign hosts never reached the browser scope.
      expect(h.browser.scopes).toEqual([]);

      await svc.retry(KEY);
      await svc.whenIdle();
      const second = svc.get(KEY) as OnboardingJob;
      expect(h.store.jobs.get(second.id)?.approvedHosts).toEqual(["api.foreign.net", "img.cdn-host.org"]);
      expect(h.browser.scopes.map((s) => [...s.hostnames])).toEqual([
        [HOST, "api.foreign.net", "img.cdn-host.org", "static.example.com"],
      ]);
      expect(second.state).toBe("awaiting_user");
      expect(second.reason).toBe("the adapter needs access to hosts outside example.com: evil.attacker.io");
      expect(second.pendingHosts).toEqual(["evil.attacker.io"]);
    });

    it("full validation does not run on a staged manifest with unapproved hosts (repair)", async () => {
      h.runner.push(async (ctx) => {
        await writeAndValidate(ctx, KEY, HOST);
        await ctx.call("finish", { summary: "done" });
      });
      await svc.add({ input: HOST });
      await svc.start();
      await svc.whenIdle();
      expect(svc.get(KEY)?.state).toBe("succeeded");

      h.runner.push(async (ctx) => {
        await stageManifest(ctx, ["api.foreign.net"]);
        const r = await ctx.call("run_validation", {});
        expect(r.isError).toBe(true);
      });
      await svc.repair(KEY);
      await svc.whenIdle();
      const job = svc.get(KEY) as OnboardingJob;
      expect(job.kind).toBe("repair");
      expect(job.state).toBe("awaiting_user");
      expect(job.reason).toBe("the adapter needs access to hosts outside example.com: api.foreign.net");
      expect(h.validations).toEqual(["agent", "service"]);
    });
  });
});

describe("Add input helpers", () => {
  it("tells URLs and hostnames from site names", () => {
    expect(addInputHostname("https://www.reuters.com/world/")).toBe("www.reuters.com");
    expect(addInputHostname("blog.naver.com")).toBe("blog.naver.com");
    expect(addInputHostname("blog.naver.com/neighbors")).toBe("blog.naver.com");
    expect(addInputHostname("Naver Blog")).toBeNull();
    expect(addInputHostname("reuters")).toBeNull();
  });

  it("refuses local and IP hosts", () => {
    expect(checkPublicHostname("127.0.0.1")).toContain("IP");
    expect(checkPublicHostname("localhost")).toContain("local");
    expect(checkPublicHostname("printer.local")).toContain("local");
    expect(checkPublicHostname("reuters.com")).toBeNull();
  });

  it("redacts credentials from log text", () => {
    expect(redactSecrets("key sk-ant-api03-abcdefghijkl and Bearer abcdefghijklmnopqrstuvwxyz")).toBe(
      "key sk-ant-… and Bearer …",
    );
  });
});

describe("FileJobStore in the service", () => {
  it("persists jobs and logs under data/jobs", async () => {
    const h = await makeHarness();
    try {
      const { FileJobStore, jobsDir } = await import("./job-store.js");
      const store = new FileJobStore(jobsDir(join(h.dir, "data")));
      const svc = h.makeService({ store });
      h.runner.push(async (ctx) => {
        await ctx.call("report_blocked", { reason: "login", requestedAction: "Log in, then click Retry" });
      });
      const job = await svc.add({ input: HOST });
      await svc.start();
      await svc.whenIdle();
      await svc.stop();
      const again = h.makeService({ store: new FileJobStore(jobsDir(join(h.dir, "data"))) });
      await again.start();
      expect(again.get(KEY)?.state).toBe("awaiting_user");
      expect((await again.log(job.id)).length).toBeGreaterThan(3);
      await mkdir(join(h.dir, "data", "jobs"), { recursive: true });
      await writeFile(join(h.dir, "data", "jobs", "garbage.json"), "{not json");
      expect((await store.loadAll()).map((j) => j.id)).toEqual([job.id]);
      await again.stop();
    } finally {
      await h.cleanup();
    }
  });
});
