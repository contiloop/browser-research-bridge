/**
 * Real-environment check of the challenge solver:
 * `npm run browser:captcha-check -- <url> [--account <id>]`.
 *
 * Requires the Aside app running and the Aside CLI signed in. Opens <url> in a bridge tab scoped to the
 * URL's host (the captcha vendor hosts are allowed only during the attempt, exactly as in the bridge),
 * runs one challenge attempt, and prints one JSON line to stdout: host, kind, result (`solved`,
 * `unsolved`, `unavailable`), rounds, durationMs, available, message. Page content is never printed;
 * diagnostics go to stderr. Exit 0 when the attempt completed (solved or not), 2 on a setup error
 * (bad arguments, Aside unreachable, the attempt could not start).
 *
 * Like `browser:check`, the account comes from `--account`, then `ASIDE_ACCOUNT`, then `u0`.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { errorToOutcome } from "../../core/outcome.js";
import type { Logger } from "../../ports/logger.js";
import { DEFAULT_CAPTCHA_BUDGET_MS } from "./captcha.js";
import { DEFAULT_ASIDE_ACCOUNT } from "./defaults.js";
import { normalizeHostname } from "./hosts.js";
import { McpReplClient, stdioTransportFactory } from "./mcp-repl-client.js";
import { AsideBrowserPort } from "./port.js";

const USAGE = "usage: npm run browser:captcha-check -- <url> [--account <id>]";

export interface CaptchaCheckArgs {
  url: string;
  host: string;
  account: string;
}

/** Parses `<url> [--account <id>]`; returns an error message instead of throwing. */
export function parseCaptchaCheckArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CaptchaCheckArgs | { error: string } {
  let url: string | undefined;
  let account: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (a === "--account") {
      account = argv[i + 1];
      i += 1;
      if (account === undefined || account === "") return { error: `--account needs a value. ${USAGE}` };
    } else if (a.startsWith("--")) {
      return { error: `unknown option ${a}. ${USAGE}` };
    } else if (url === undefined) {
      url = a;
    } else {
      return { error: `one URL only. ${USAGE}` };
    }
  }
  if (url === undefined) return { error: USAGE };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `not a valid URL. ${USAGE}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { error: "the URL must be http(s)" };
  const host = normalizeHostname(parsed.hostname);
  if (host === null) return { error: "the URL has no usable host" };
  const fromEnv = env["ASIDE_ACCOUNT"];
  return {
    url: parsed.href,
    host,
    account: account ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_ASIDE_ACCOUNT),
  };
}

function stderrLogger(): Logger {
  const line = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    process.stderr.write(`  [log ${level}] ${message} ${JSON.stringify(fields ?? {})}\n`);
  };
  return { debug() {}, info: line("info"), warn: line("warn"), error: line("error") };
}

async function main(): Promise<number> {
  const args = parseCaptchaCheckArgs(process.argv.slice(2), process.env);
  if ("error" in args) {
    process.stderr.write(`browser:captcha-check: ${args.error}\n`);
    return 2;
  }
  process.stderr.write(`browser:captcha-check — Aside account ${args.account}, site ${args.host}\n`);
  const command = process.env["ASIDE_CLI"];
  const logger = stderrLogger();
  const repl = new McpReplClient({
    account: args.account,
    transportFactory: stdioTransportFactory(command ? { command } : {}),
    logger,
  });
  const port = new AsideBrowserPort({ repl, logger, warmTabTtlMs: 0 });
  try {
    const status = await port.status();
    if (!status.reachable) {
      process.stderr.write(
        `browser:captcha-check: Aside is not reachable: ${status.message ?? "unknown"}${status.action ? ` (${status.action})` : ""}\n`,
      );
      return 2;
    }
    const started = Date.now();
    const attempt = await port.solveChallenge({
      scope: { siteKey: "captcha-check", hostnames: [args.host] },
      url: args.url,
      budgetMs: DEFAULT_CAPTCHA_BUDGET_MS,
    });
    const result = !attempt.available ? "unavailable" : attempt.solved ? "solved" : "unsolved";
    process.stdout.write(
      `${JSON.stringify({
        host: args.host,
        kind: attempt.kind,
        result,
        rounds: attempt.rounds,
        durationMs: Date.now() - started,
        available: attempt.available,
        message: attempt.message,
      })}\n`,
    );
    return 0;
  } catch (err) {
    const o = errorToOutcome(err);
    process.stderr.write(
      `browser:captcha-check: the attempt could not run: ${o.status}: ${o.message}${o.action ? ` (${o.action})` : ""}\n`,
    );
    return 2;
  } finally {
    await port.shutdown().catch(() => undefined);
  }
}

// Run only as the CLI entry point (the argument parser is unit-tested on import).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
