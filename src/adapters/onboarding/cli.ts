/**
 * `npm run site:onboard -- <url|name> [--note "..."]`: runs one onboarding job
 * without the dashboard, against the real site in the logged-in Aside browser, with the same job
 * service the bridge uses (data/jobs/, data/sites.json, sites/<key>/, auto-commit).
 *
 *   npm run site:onboard -- https://www.reuters.com
 *   npm run site:onboard -- blog.naver.com --note "search only my neighbors' blogs"
 *   npm run site:onboard -- --retry reuters          (after a login the agent asked for)
 *   npm run site:onboard -- --repair reuters
 *   npm run site:onboard -- --sdk-check              (auth + tool round-trip of the agent runtime)
 *
 * Stop the bridge first (both would manage the same data); the CLI refuses to run while the public
 * port answers, unless --force. Exit code: 0 succeeded, 1 failed/cancelled, 2 usage or setup error,
 * 3 waiting for the user (the requested action is printed; then use --retry).
 */
import { mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createApp, createConsoleLogger } from "../../app/app.js";
import { ConfigError, loadConfig } from "../../app/config.js";
import type { BridgeConfig } from "../../app/config.js";
import type { AdapterHelpers } from "../../ports/adapter.js";
import { parseOnboardArgs } from "./cli-args.js";
import { classifyRoundTrip, helperRoundTrip } from "./helper-runtime.js";
import { jobsDir } from "./job-store.js";
import { ClaudeAgentRunner } from "./sdk-runner.js";
import type { JobLogLine, OnboardingJob } from "./types.js";

const USAGE = `Usage:
  npm run site:onboard -- <url|name> [--note "text for the agent"]
  npm run site:onboard -- --retry <key>
  npm run site:onboard -- --repair <key> [--note "..."]
  npm run site:onboard -- --sdk-check

Runs an onboarding job (agent: Claude Agent SDK, config.onboarding model/effort; ANTHROPIC_API_KEY
when set, else the local Claude Code login) against the real site in the logged-in Aside browser.
Stop the bridge first. Options: --verbose (bridge log lines), --force (skip the running-bridge check).
Exit code: 0 succeeded, 1 failed, 2 error, 3 waiting for the user.`;

async function loadHelpers(): Promise<AdapterHelpers> {
  const kit = (await import("../../adapter-kit/index.js")) as Record<string, unknown>;
  const factory = kit["createAdapterHelpers"];
  if (typeof factory !== "function")
    throw new Error("src/adapter-kit does not export createAdapterHelpers()");
  return (factory as () => AdapterHelpers)();
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      socket.destroy();
      resolvePromise(v);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

function printLine(line: JobLogLine): void {
  const tag = line.source === "agent" ? "agent" : line.source === "tool" ? " tool" : "  job";
  const text = line.source === "agent" ? line.message.replace(/\n/g, "\n        ") : line.message;
  console.log(`${line.at.slice(11, 19)} ${tag}  ${text}`);
}

/** Proves the agent runtime: authentication and one custom-tool round trip, in a few turns. */
async function sdkCheck(config: BridgeConfig): Promise<number> {
  const runner = new ClaudeAgentRunner({
    model: config.onboarding.model,
    effort: config.onboarding.effort,
    maxTurns: 4,
    apiKey: config.secrets.anthropicApiKey,
  });
  const info = runner.describe();
  console.log(
    `sdk-check: model ${info.model}, effort ${info.effort}, auth ${info.auth === "api_key" ? "ANTHROPIC_API_KEY" : "local Claude Code login"}`,
  );
  const workDir = join(jobsDir(config.dataDir), "work", "sdk-check");
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const trip = await helperRoundTrip(runner, {
    workDir,
    signal: new AbortController().signal,
    onEvent: (e) => {
      if (e.type === "session")
        console.log(
          `session ${e.sessionId}: model ${e.model}, apiKeySource ${e.authSource}, tools [${e.tools.join(", ")}]`,
        );
      else if (e.type === "text") console.log(`agent: ${e.text}`);
      else console.log(`warning: ${e.message}`);
    },
  });
  const { result, finished } = trip;
  console.log(
    `result: ${result.outcome} in ${result.turns} turns, ${((Date.now() - started) / 1000).toFixed(1)} s${result.costUsd !== null ? `, ~$${result.costUsd.toFixed(4)}` : ""}${result.message ? ` — ${result.message.slice(0, 300)}` : ""}`,
  );
  console.log(`finish tool called: ${finished === null ? "no" : `yes (${JSON.stringify(finished)})`}`);
  const verdict = classifyRoundTrip(trip);
  console.log(`check: ${verdict.code}`);
  return verdict.code === "ok" ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseOnboardArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error !== null || args.command === null) {
    console.error(`site:onboard: ${args.error ?? "nothing to do"}\n\n${USAGE}`);
    return 2;
  }
  let config: BridgeConfig;
  try {
    const env = { ...process.env };
    // The CLI serves no OAuth clients; a placeholder satisfies the loader when .env has no passphrase.
    if ((env["BRIDGE_PASSPHRASE"] ?? "").trim().length < 12)
      env["BRIDGE_PASSPHRASE"] = "site-onboard-cli-unused";
    config = loadConfig({ env });
  } catch (error) {
    console.error(`site:onboard: ${error instanceof ConfigError ? error.message : String(error)}`);
    return 2;
  }
  const command = args.command;
  if (command.kind === "sdk-check") return sdkCheck(config);

  if (!args.force && (await portAnswers(config.publicPort))) {
    console.error(
      `site:onboard: something listens on 127.0.0.1:${config.publicPort} (the bridge?). Stop it first, or use the dashboard; --force skips this check.`,
    );
    return 2;
  }
  const logger = createConsoleLogger({ level: args.verbose ? "debug" : "warn" });
  let helpers: AdapterHelpers;
  try {
    helpers = await loadHelpers();
  } catch (error) {
    console.error(`site:onboard: ${(error as Error).message}`);
    return 2;
  }
  const bridge = createApp({
    config,
    helpers,
    logger,
    repoRoot: resolve(process.cwd()),
    asideCommand: process.env["ASIDE_CLI"],
  });
  const { registry, jobs, browser } = bridge.services;
  try {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await registry.init();
    const status = await browser.status();
    if (!status.reachable) {
      console.error(
        `site:onboard: Aside is not reachable: ${status.message ?? ""}${status.action ? ` (${status.action})` : ""}`,
      );
      return 2;
    }
    await jobs.start();
    let job: OnboardingJob;
    try {
      job =
        command.kind === "add"
          ? await jobs.add({ input: command.input, note: command.note })
          : command.kind === "retry"
            ? await jobs.retry(command.key)
            : await jobs.repair(command.key, command.note);
    } catch (error) {
      console.error(`site:onboard: ${(error as Error).message}`);
      return 2;
    }
    console.log(
      `job ${job.id} (${job.kind}${job.key ? `, site "${job.key}"` : ""}) — log: data/jobs/${job.id}.log.jsonl`,
    );
    const jobId = job.id;
    const final = await new Promise<OnboardingJob>((resolveJob) => {
      let printed = 0;
      const settle = (j: OnboardingJob) => {
        if (
          j.state === "succeeded" ||
          j.state === "failed" ||
          j.state === "cancelled" ||
          j.state === "awaiting_user"
        ) {
          off();
          resolveJob(j);
        }
      };
      const off = jobs.subscribe(jobId, (event) => {
        if (event.type === "log" && event.line.seq > printed) {
          printed = event.line.seq;
          printLine(event.line);
        } else if (event.type === "job") settle(event.job);
      });
      void jobs.log(jobId).then((lines) => {
        for (const l of lines) {
          if (l.seq > printed) {
            printed = l.seq;
            printLine(l);
          }
        }
      });
      process.once("SIGINT", () => {
        console.error("site:onboard: interrupted; cancelling the job");
        void jobs.cancelJob(jobId, "interrupted from the CLI");
      });
    });
    await jobs.whenIdle().catch(() => undefined);
    console.log(
      `\njob ${final.id}: ${final.state}${final.key ? ` (site "${final.key}": ${registry.get(final.key)?.status ?? "removed"})` : ""}`,
    );
    if (final.reason) console.log(`reason: ${final.reason}`);
    if (final.requestedAction)
      console.log(
        `requested action: ${final.requestedAction}\nthen run: npm run site:onboard -- --retry ${final.key ?? ""}`,
      );
    if (final.validation) console.log(`validation: ${final.validation}`);
    if (final.commit) console.log(`commit: ${final.commit}`);
    return final.state === "succeeded" ? 0 : final.state === "awaiting_user" ? 3 : 1;
  } finally {
    await jobs.stop().catch(() => undefined);
    await browser.shutdown().catch(() => undefined);
  }
}

process.exitCode = await main(process.argv.slice(2));
