/**
 * A fake `codex` executable for the Codex runner tests: answers `--version`, `login status`,
 * `debug models`, and speaks the app-server protocol on stdio, playing one scripted list of actions
 * per run. It records what it was launched with (argv, cwd, environment, the catalog it was given)
 * and every request it received to a JSONL file. Real Codex behavior is proven separately
 * (`codex-runtime.AGENTS-evidence.md`); this only drives the bridge's side of the channel.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type FakeCodexAction =
  | { call: string; args?: Record<string, unknown>; threadId?: string; namespace?: string }
  | { text: string }
  | { item: string }
  | { request: string }
  | { fail: unknown; message: string }
  | { configWarning: true }
  | { hang: true }
  | { exit: number };

export interface FakeCodexScenario {
  /** Actions of run 1, run 2, … (default: call finish, say "done"). */
  runs?: FakeCodexAction[][];
  resumeFails?: boolean;
  signedOut?: boolean;
  /** `environments` the fake reports for a started thread (default `[]`). */
  environments?: unknown[];
  /** `environments` the fake reports for a resumed thread (default `[]`); Codex 0.160.0 reports the
   *  default `local` environment here when the Codex home does not remove it. */
  resumeEnvironments?: unknown[];
  instructionSources?: string[];
  /** Exit at start with this stderr text (e.g. a rejected config key). */
  rejectWith?: string;
}

const FAKE_CODEX_SOURCE = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const rec = process.env.FAKE_CODEX_RECORD;
const scenario = process.env.FAKE_CODEX_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO, "utf8")) : {};
const record = (o) => { if (rec) appendFileSync(rec, JSON.stringify(o) + "\n"); };
if (argv[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
if (argv[0] === "login") {
  if (scenario.signedOut) { console.log("Not logged in"); process.exit(1); }
  console.log("Logged in using ChatGPT"); process.exit(0);
}
if (argv[0] === "debug") {
  process.stdout.write(JSON.stringify({ models: [{ slug: "fake-model", tool_mode: "code_mode_only", shell_type: "unified_exec",
    apply_patch_tool_type: "freeform", multi_agent_version: "v2", experimental_supported_tools: ["clock"], supports_search_tool: true }] }));
  process.exit(0);
}
if (argv[0] !== "app-server") process.exit(2);
const prior = rec && existsSync(rec) ? readFileSync(rec, "utf8").split("\n").filter((l) => l.includes('"kind":"launch"')).length : 0;
const catArg = argv.find((a) => a.startsWith("model_catalog_json="));
const catalog = catArg ? JSON.parse(readFileSync(JSON.parse(catArg.slice("model_catalog_json=".length)), "utf8")) : null;
record({ kind: "launch", argv, cwd: process.cwd(), env: process.env, catalog });
if (scenario.rejectWith) { process.stderr.write(scenario.rejectWith + "\n"); process.exit(1); }
const actions = (scenario.runs ?? [])[prior] ?? [{ call: "finish", args: { summary: "sdk check ok" } }, { text: "done" }];
process.on("SIGTERM", () => { record({ kind: "sigterm" }); process.exit(0); });
let threadId = null; const turnId = "turn-" + (prior + 1); let n = 0; const waiting = new Map();
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ask = (method, params) => new Promise((resolve) => { const id = "s" + (++n); waiting.set(id, resolve); send({ id, method, params }); });
const complete = (status, error = null) => send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], status, error } } });
async function play() {
  for (const a of actions) {
    if (a.call) {
      const reply = await ask("item/tool/call", { threadId: a.threadId ?? threadId, turnId, callId: "c" + n, namespace: a.namespace ?? null, tool: a.call, arguments: a.args ?? {} });
      record({ kind: "tool-result", tool: a.call, reply });
    } else if (a.text !== undefined) {
      send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "m" + n, text: a.text } } });
    } else if (a.item) {
      send({ method: "item/started", params: { threadId, turnId, item: { type: a.item, id: "i" + n } } });
      await new Promise((r) => setTimeout(r, 50));
    } else if (a.request) {
      const reply = await ask(a.request, { threadId, turnId });
      record({ kind: "request-reply", method: a.request, reply });
    } else if (a.fail !== undefined) { complete("failed", { message: a.message, codexErrorInfo: a.fail }); return; }
    else if (a.configWarning) { send({ method: "configWarning", params: { summary: "ignored", details: null } }); await new Promise((r) => setTimeout(r, 50)); }
    else if (a.hang) { return; }
    else if (a.exit !== undefined) { process.exit(a.exit); }
  }
  complete("completed");
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined) { const w = waiting.get(m.id); waiting.delete(m.id); w?.(m); continue; }
    if (m.id === undefined) continue;
    record({ kind: "request", method: m.method, params: m.params });
    if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake/0.160.0 (test)" } });
    else if (m.method === "thread/start") { threadId = "thr-" + (prior + 1); send({ id: m.id, result: { thread: { id: threadId, environments: scenario.environments ?? [] }, model: "fake-model", instructionSources: scenario.instructionSources ?? [] } }); }
    else if (m.method === "thread/resume") {
      if (scenario.resumeFails) send({ id: m.id, error: { code: -32600, message: "no rollout found" } });
      else { threadId = m.params.threadId; send({ id: m.id, result: { thread: { id: threadId, environments: scenario.resumeEnvironments ?? [] }, model: "fake-model", instructionSources: [] } }); }
    }
    else if (m.method === "turn/start") { send({ id: m.id, result: { turn: { id: turnId, status: "inProgress" } } }); void play(); }
    else if (m.method === "turn/interrupt") { send({ id: m.id, result: {} }); complete("interrupted"); }
    else send({ id: m.id, error: { code: -32601, message: "unknown" } });
  }
});
process.stdin.on("end", () => { record({ kind: "stdin-closed" }); process.exit(0); });
`;

export interface FakeCodex {
  bin: string;
  recordFile: string;
  /** Environment entries that point the fake at its scenario and record file (merge into baseEnv). */
  env: Record<string, string>;
  setScenario(s: FakeCodexScenario): Promise<void>;
  records(): Promise<Record<string, unknown>[]>;
}

export async function installFakeCodex(dir: string): Promise<FakeCodex> {
  const bin = join(dir, "fake-codex.mjs");
  const recordFile = join(dir, "fake-codex-record.jsonl");
  const scenarioFile = join(dir, "fake-codex-scenario.json");
  await writeFile(bin, FAKE_CODEX_SOURCE);
  await chmod(bin, 0o755);
  await writeFile(scenarioFile, "{}");
  return {
    bin,
    recordFile,
    env: { FAKE_CODEX_RECORD: recordFile, FAKE_CODEX_SCENARIO: scenarioFile },
    setScenario: (s) => writeFile(scenarioFile, JSON.stringify(s)),
    async records() {
      let text: string;
      try {
        text = await readFile(recordFile, "utf8");
      } catch {
        return [];
      }
      return text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}
