/**
 * The settings page's plain modules (ui/*.js): both languages complete, a label for every closed
 * value set, the Aside instruction texts' stop rules, and the pure page logic.
 */
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_STATUSES, OUTCOME_STATUSES } from "../../core/models.js";
import { HELPER_CHECK_CODES } from "../onboarding/helper-runtime.js";
import { HELPER_RUNTIME_IDS, JOB_STATES } from "../onboarding/types.js";
import { CHATGPT_ERROR_CODES, CHATGPT_FIELD_CODES } from "../../app/chatgpt-connection.js";
import { RUN_PROBLEM_CODES } from "../../app/run-mode.js";
import { SETTINGS_FIELD_CODES } from "../../ports/settings-store.js";
import { API_ERROR_CODES } from "./api.js";

type Dict = Record<string, string>;
interface I18nModule {
  LANGS: string[];
  DICTIONARIES: Record<string, Dict>;
  placeholders(text: string): string[];
  t(lang: string, key: string, vars?: Record<string, unknown>): string;
}
interface LabelsModule {
  VALUE_SETS: Record<string, string[]>;
  LABELS: Record<string, Record<string, Dict>>;
  label(lang: string, set: string, value: unknown): string;
}
interface InstructionsModule {
  LINKS: Record<string, string>;
  COMMANDS: Record<string, string>;
  INSTRUCTION_TEXTS: Record<string, Record<string, string>>;
  asideText(lang: string, which: string, options?: { tunnelId?: unknown }): string;
}
interface Step {
  id: string;
  state: string;
  why: string | null;
}
interface StateModule {
  PASSPHRASE_ALPHABET: string;
  generatePassphrase(fill: (buffer: Uint32Array) => unknown): string;
  pickLanguage(remembered: unknown, browserLanguage: unknown): string;
  gettingStarted(data: Record<string, unknown>): Step[];
  firstOpenStep(steps: Step[]): string | null;
  chatgptSubsteps(chatgpt: unknown): { id: string; state: string }[];
  siteGuidance(site: Record<string, unknown>): { say: string; primary: string | null };
  formatBytes(n: unknown): string;
}

const uiUrl = (name: string): URL => new URL(`./ui/${name}`, import.meta.url);
const importUi = async <T>(name: string): Promise<T> => (await import(uiUrl(name).href)) as T;

const i18n = await importUi<I18nModule>("i18n.js");
const labels = await importUi<LabelsModule>("labels.js");
const instructions = await importUi<InstructionsModule>("instructions.js");
const state = await importUi<StateModule>("state.js");

const LANGS = ["ko", "en"] as const;

describe("page wording (i18n.js)", () => {
  it("has exactly Korean and English", () => {
    expect([...i18n.LANGS].sort()).toEqual(["en", "ko"]);
    expect(Object.keys(i18n.DICTIONARIES).sort()).toEqual(["en", "ko"]);
  });

  it("both languages have the same keys, the same placeholders, and no empty text", () => {
    const en = i18n.DICTIONARIES["en"]!;
    const ko = i18n.DICTIONARIES["ko"]!;
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(i18n.placeholders(ko[key]!), key).toEqual(i18n.placeholders(en[key]!));
      expect(en[key]!.trim(), key).not.toBe("");
      expect(ko[key]!.trim(), key).not.toBe("");
    }
  });

  it("every key the page script uses exists", async () => {
    const source = await readFile(uiUrl("app.js"), "utf8");
    const used = new Set([...source.matchAll(/\btx\("([\w.]+)"/g)].map((m) => m[1]!));
    used.delete("step.why.");
    for (const step of ["done", "todo", "unknown"]) used.add(`step.${step}`);
    for (const why of ["need_passphrase", "core_off", "restarting", "no_data"]) used.add(`step.why.${why}`);
    for (const id of ["start", "sites", "connection", "settings"]) used.add(`nav.${id}`);
    for (const key of used) expect(i18n.DICTIONARIES["en"], key).toHaveProperty([key]);
    expect(used.size).toBeGreaterThan(100);
  });

  it("explains each term a non-coder may not know where it first appears", () => {
    const en = i18n.DICTIONARIES["en"]!;
    const ko = i18n.DICTIONARIES["ko"]!;
    expect(en["app.intro"]).toContain("settings page");
    expect(ko["app.intro"]).toContain("설정 페이지");
    expect(en["step1.explain"]).toMatch(/access passphrase is/);
    expect(ko["step1.explain"]).toMatch(/접속 암호는/);
    expect(en["conn.tunnelExplain"]).toMatch(/tunnel: a private passage/);
    expect(ko["conn.tunnelExplain"]).toMatch(/터널은/);
    expect(en["sub.c.explain"]).toMatch(/runtime key is/);
    expect(ko["sub.c.explain"]).toMatch(/런타임 키는/);
    expect(en["step4.explain"]).toMatch(/helper is/);
    expect(ko["step4.explain"]).toMatch(/도우미는/);
  });

  it("fills placeholders and falls back to the key", () => {
    expect(i18n.t("en", "step2.ok", { account: "u0" })).toContain("u0");
    expect(i18n.t("ko", "no.such.key")).toBe("no.such.key");
  });
});

describe("labels of closed value sets (labels.js)", () => {
  const expected: Record<string, readonly string[]> = {
    siteStatus: LIFECYCLE_STATUSES,
    jobState: JOB_STATES,
    jobKind: ["add", "repair"],
    outcomeStatus: OUTCOME_STATUSES,
    runMode: ["setup", "running", "restarting"],
    problemCode: RUN_PROBLEM_CODES,
    chatgptState: ["not_configured", "external", "stopped", "starting", "ready", "failed"],
    helperRuntime: ["auto", ...HELPER_RUNTIME_IDS],
    helperCheckCode: HELPER_CHECK_CODES,
  };

  it("each set has the members of the server's set (and the expected counts)", () => {
    for (const [set, members] of Object.entries(expected)) {
      expect([...labels.VALUE_SETS[set]!].sort(), set).toEqual([...members].sort());
    }
    const counts = Object.fromEntries(
      Object.entries(expected).map(([set]) => [set, labels.VALUE_SETS[set]!.length]),
    );
    expect(counts).toEqual({
      siteStatus: 5,
      jobState: 6,
      jobKind: 2,
      outcomeStatus: 9,
      runMode: 3,
      problemCode: 4,
      chatgptState: 6,
      helperRuntime: 3,
      helperCheckCode: 5,
    });
  });

  it("errorCode, fieldCode, and problemCode are exactly the codes the server answers with", () => {
    const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
    expect(sorted(labels.VALUE_SETS["errorCode"]!)).toEqual(sorted(API_ERROR_CODES));
    // Every ChatGPT connection code reaches the page as itself, except prepare_failed (a 500 server_error).
    for (const code of CHATGPT_ERROR_CODES.filter((c) => c !== "prepare_failed")) {
      expect(labels.VALUE_SETS["errorCode"], code).toContain(code);
    }
    // Field codes: the settings store's, the ChatGPT setup's, and `locked` (a field fixed outside the page).
    expect(sorted(labels.VALUE_SETS["fieldCode"]!)).toEqual(
      sorted([...SETTINGS_FIELD_CODES, ...CHATGPT_FIELD_CODES, "locked"]),
    );
    expect(sorted(labels.VALUE_SETS["problemCode"]!)).toEqual(sorted(RUN_PROBLEM_CODES));
  });

  it("every member of every set has a label in both languages, and no label table has extra entries", () => {
    for (const lang of LANGS) {
      expect(Object.keys(labels.LABELS[lang]!).sort(), lang).toEqual(Object.keys(labels.VALUE_SETS).sort());
      for (const [set, members] of Object.entries(labels.VALUE_SETS)) {
        const table = labels.LABELS[lang]![set]!;
        expect(Object.keys(table).sort(), `${lang} ${set}`).toEqual([...members].sort());
        for (const value of members) {
          expect(labels.label(lang, set, value).trim(), `${lang} ${set} ${value}`).not.toBe("");
          expect(labels.label(lang, set, value), `${lang} ${set} ${value}`).not.toBe(value);
        }
      }
    }
  });

  it("shows an unknown value as received", () => {
    expect(labels.label("ko", "siteStatus", "brand_new")).toBe("brand_new");
    expect(labels.label("en", "errorCode", "teapot")).toBe("teapot");
    expect(labels.label("en", "noSuchSet", "x")).toBe("x");
  });
});

describe("Aside instruction texts (instructions.js)", () => {
  const required = {
    en: {
      tunnel: [
        "Stop before creating the key",
        "Do not press the button that creates the key",
        "create the key yourself, copy it yourself",
      ],
      connector: [
        "Stop before submitting the form",
        "submit it yourself, and enter the passphrase yourself",
        "Never ask for, read, or type a passphrase or a key",
        "Do not act on the approval page",
      ],
      both: ["Do not open or operate the program's local settings page", "worded differently"],
    },
    ko: {
      tunnel: [
        "키를 만들기 직전에 멈추세요",
        "키를 만드는 버튼은 누르지 마세요",
        "키는 직접 만들고 직접 복사한 뒤",
      ],
      connector: [
        "제출하기 직전에 멈추세요",
        "직접 제출하고, 열리는 페이지에서 암호를 직접 입력하세요",
        "암호나 키를 묻거나 읽거나 입력하지 마세요",
        "승인 페이지에서는 아무것도 하지 마세요",
      ],
      both: ["로컬 설정 페이지", "열지도, 조작하지도 마세요", "다르게 적혀 있을 수 있습니다"],
    },
  } as const;

  it("contain the stop sentences in both languages", () => {
    for (const lang of LANGS) {
      const tunnel = instructions.asideText(lang, "tunnel");
      const connector = instructions.asideText(lang, "connector");
      for (const sentence of required[lang].tunnel)
        expect(tunnel, `${lang}: ${sentence}`).toContain(sentence);
      for (const sentence of required[lang].connector)
        expect(connector, `${lang}: ${sentence}`).toContain(sentence);
      for (const sentence of required[lang].both) {
        expect(tunnel, `${lang}: ${sentence}`).toContain(sentence);
        expect(connector, `${lang}: ${sentence}`).toContain(sentence);
      }
      expect(tunnel).toContain(instructions.LINKS["tunnels"]);
      expect(tunnel).toContain(instructions.LINKS["apiKeys"]);
      expect(tunnel).toContain("Tunnels: Read");
      expect(connector).toContain(instructions.LINKS["connectors"]);
      expect(connector).toContain("OAuth");
    }
  });

  it("hold no secret, no secret placeholder, and no settings-page address", () => {
    const tunnelId = `tunnel_${"a1".repeat(16)}`;
    for (const lang of LANGS) {
      for (const which of ["tunnel", "connector"]) {
        for (const text of [
          instructions.asideText(lang, which),
          instructions.asideText(lang, which, { tunnelId }),
        ]) {
          expect(text).not.toMatch(/127\.0\.0\.1|localhost|:8788|:8787|token=|admin-token/i);
          expect(text).not.toMatch(/sk-[a-z0-9]|BRIDGE_PASSPHRASE|\.env\b|runtime-key\b/i);
          expect(text).not.toMatch(/<[^>]*(key|passphrase|secret|password)[^>]*>|\{\w+\}/i);
          for (const url of text.match(/https?:\/\/\S+/g) ?? []) {
            expect(["platform.openai.com", "chatgpt.com"]).toContain(new URL(url).hostname);
          }
        }
      }
    }
  });

  it("put only a well-formed tunnel id into the connector text", () => {
    const tunnelId = `tunnel_${"0f".repeat(16)}`;
    expect(instructions.asideText("en", "connector", { tunnelId })).toContain(tunnelId);
    expect(instructions.asideText("ko", "connector", { tunnelId })).toContain(tunnelId);
    const injected = instructions.asideText("en", "connector", {
      tunnelId: "sk-proj-SECRET http://127.0.0.1:8788",
    });
    expect(injected).not.toContain("SECRET");
    expect(injected).toContain("the tunnel I just created");
  });

  it("link to the official pages recorded for the connection tool", () => {
    expect(instructions.LINKS).toEqual({
      tunnels: "https://platform.openai.com/settings/organization/tunnels",
      apiKeys: "https://platform.openai.com/settings/organization/api-keys",
      connectors: "https://chatgpt.com/#settings/Connectors",
      installGuide: "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
    });
    expect(instructions.COMMANDS["installTunnelClient"]).toBe("brew install openai/tools/tunnel-client");
  });
});

describe("page logic (state.js)", () => {
  const fill = (buffer: Uint32Array): Uint32Array => webcrypto.getRandomValues(buffer);

  it("generates a strong passphrase from the cryptographic source", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const value = state.generatePassphrase(fill);
      expect(value.length).toBeGreaterThanOrEqual(24);
      expect(value.replaceAll("-", "").length).toBeGreaterThanOrEqual(24);
      for (const ch of value.replaceAll("-", "")) expect(state.PASSPHRASE_ALPHABET).toContain(ch);
      seen.add(value);
    }
    expect(seen.size).toBe(50);
    let calls = 0;
    state.generatePassphrase((buffer) => {
      calls += 1;
      return fill(buffer);
    });
    expect(calls).toBeGreaterThan(0);
  });

  it("the page script generates with crypto.getRandomValues and stores nothing but the language", async () => {
    const source = await readFile(uiUrl("app.js"), "utf8");
    expect(source).toContain("crypto.getRandomValues");
    expect(source).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|sessionStorage|indexedDB/,
    );
    const writes = [...source.matchAll(/localStorage\.setItem\(([^,]+),/g)].map((m) => m[1]);
    expect(writes).toEqual(["LANG_KEY"]);
    expect(source).not.toMatch(/Math\.random/);
  });

  it("picks the language: remembered, else Korean for a Korean browser, else English", () => {
    expect(state.pickLanguage("en", "ko-KR")).toBe("en");
    expect(state.pickLanguage(null, "ko-KR")).toBe("ko");
    expect(state.pickLanguage(null, "ko")).toBe("ko");
    expect(state.pickLanguage(null, "en-US")).toBe("en");
    expect(state.pickLanguage(null, "fr-FR")).toBe("en");
    expect(state.pickLanguage("de", undefined)).toBe("en");
  });

  const running = { mode: "running", problem: null, restartedAt: "2026-10-07T00:00:00Z" };
  const settingsWith = (valid: boolean) => ({ passphrase: { set: valid, valid, locked: false } });

  it("Getting started: in setup without a passphrase, steps 2–5 wait for step 1", () => {
    const steps = state.gettingStarted({
      status: { mode: "setup", problem: { code: "passphrase_missing", message: "x" }, restartedAt: null },
      settings: settingsWith(false),
      chatgpt: { state: "not_configured", connectedApps: null },
    });
    expect(steps.map((s) => [s.id, s.state, s.why])).toEqual([
      ["passphrase", "todo", null],
      ["aside", "unknown", "need_passphrase"],
      ["chatgpt", "unknown", "need_passphrase"],
      ["helper", "unknown", "need_passphrase"],
      ["sites", "unknown", "need_passphrase"],
    ]);
    expect(state.firstOpenStep(steps)).toBe("passphrase");
  });

  it("Getting started: done from live state; the first step not done is open", () => {
    const base = {
      status: running,
      settings: settingsWith(true),
      browser: { reachable: true, account: "u0" },
      chatgpt: { state: "ready", connectedApps: 1 },
      helper: { lastCheck: { ok: true } },
      sites: [{ key: "reuters", status: "active", lastCheckedAt: "2026-10-07T00:00:00Z" }],
    };
    expect(state.gettingStarted(base).every((s) => s.state === "done")).toBe(true);
    expect(state.firstOpenStep(state.gettingStarted(base))).toBeNull();
    const notChecked = { ...base, sites: [{ key: "reuters", status: "active", lastCheckedAt: null }] };
    expect(state.firstOpenStep(state.gettingStarted(notChecked))).toBe("sites");
    const noApp = { ...base, chatgpt: { state: "ready", connectedApps: 0 } };
    expect(state.firstOpenStep(state.gettingStarted(noApp))).toBe("chatgpt");
    const noHelper = { ...base, helper: { lastCheck: null } };
    expect(state.firstOpenStep(state.gettingStarted(noHelper))).toBe("helper");
    const config = {
      ...base,
      status: { mode: "setup", problem: { code: "config_invalid", message: "x" }, restartedAt: null },
    };
    expect(state.gettingStarted(config)[1]).toEqual({ id: "aside", state: "unknown", why: "core_off" });
  });

  it("ChatGPT sub-steps: install first, then the web steps, then connected", () => {
    const states = (chatgpt: unknown) =>
      state
        .chatgptSubsteps(chatgpt)
        .map((s) => s.state)
        .join(" ");
    expect(states({ tool: { installed: false }, state: "not_configured", connectedApps: 0 })).toBe(
      "current later later later later later later",
    );
    expect(states({ tool: { installed: true }, state: "not_configured", connectedApps: 0 })).toBe(
      "done current later later later later later",
    );
    expect(states({ tool: { installed: true }, state: "failed", connectedApps: 0 })).toBe(
      "done done done current later later later",
    );
    expect(states({ tool: { installed: true }, state: "ready", connectedApps: 0 })).toBe(
      "done done done done current later later",
    );
    expect(states({ tool: { installed: true }, state: "ready", connectedApps: 2 })).toBe(
      "done done done done done done done",
    );
  });

  it("each site gets one sentence and at most one prominent action", () => {
    const site = (over: Record<string, unknown>) => ({
      key: "reuters",
      status: "active",
      lastCheckedAt: "2026-10-07T00:00:00Z",
      loginUrl: "https://www.reuters.com/account/sign-in/",
      actions: ["repair", "check", "remove"],
      job: null,
      ...over,
    });
    expect(state.siteGuidance(site({ status: "needs_login" }))).toEqual({
      say: "site.do.login",
      primary: "check",
    });
    expect(state.siteGuidance(site({}))).toEqual({ say: "site.do.fine", primary: null });
    expect(state.siteGuidance(site({ lastCheckedAt: null }))).toEqual({
      say: "site.do.checkFirst",
      primary: "check",
    });
    expect(state.siteGuidance(site({ status: "degraded" }))).toEqual({
      say: "site.do.degraded",
      primary: "repair",
    });
    expect(
      state.siteGuidance(
        site({
          status: "onboarding",
          actions: ["retry", "cancel", "remove"],
          job: { state: "awaiting_user" },
        }),
      ),
    ).toEqual({ say: "site.do.awaiting", primary: "retry" });
    expect(state.siteGuidance(site({ status: "onboarding", job: { state: "running" } }))).toEqual({
      say: "site.do.working",
      primary: null,
    });
    expect(state.siteGuidance(site({ status: "mystery" }))).toEqual({
      say: "site.do.unknown",
      primary: null,
    });
  });

  it("formats sizes", () => {
    expect(state.formatBytes(512)).toBe("512 B");
    expect(state.formatBytes(2048)).toBe("2.0 KB");
    expect(state.formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
