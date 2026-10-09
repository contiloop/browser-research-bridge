import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_REDIRECT_URI_ALLOWLIST,
  DEFAULT_TUNABLES,
  loadConfig,
  loadConfigResult,
  resolveSettingsPageLocation,
} from "./config.js";

const GOOD = "correct horse battery";

describe("loadConfig", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bridge-config-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeJson = (value: unknown) => {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "bridge.json"), JSON.stringify(value));
  };

  it("throws when the passphrase is missing or empty", () => {
    expect(() => loadConfig({ rootDir: root, env: {} })).toThrow(ConfigError);
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: "" } })).toThrow(/BRIDGE_PASSPHRASE/);
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: "            " } })).toThrow(
      ConfigError,
    );
  });

  it("throws when the passphrase is shorter than 12 characters", () => {
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: "elevenchars" } })).toThrow(
      /at least 12/,
    );
    expect(loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: "twelve_chars" } }).secrets.passphrase).toBe(
      "twelve_chars",
    );
  });

  it("uses built-in defaults without a config file", () => {
    const config = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(config.configFile).toBeNull();
    expect(config.publicPort).toBe(8787);
    expect(config.adminPort).toBe(8788);
    expect(config.dataDir).toBe(join(root, "data"));
    expect(config.trustedProxyHeader).toBeNull();
    expect(config.redirectUriAllowlist).toContain("https://claude.ai/api/mcp/auth_callback");
    expect(config.tunables).toEqual(DEFAULT_TUNABLES);
    expect(config.publicUrl).toBe("http://localhost:8787");
    expect(config.publicUrlConfigured).toBe(false);
  });

  it("applies env over config file over defaults", () => {
    writeJson({
      publicPort: 9000,
      adminPort: 9001,
      dataDir: "store",
      trustedProxyHeader: "CF-Connecting-IP",
      redirectUriAllowlist: ["https://example.com/cb"],
      tunables: { accessTokenTtlSeconds: 120, bogus: 1 },
    });
    const config = loadConfig({
      rootDir: root,
      env: { BRIDGE_PASSPHRASE: GOOD, BRIDGE_PUBLIC_PORT: "9100", PUBLIC_URL: "https://bridge.example.com/" },
    });
    expect(config.publicPort).toBe(9100);
    expect(config.adminPort).toBe(9001);
    expect(config.dataDir).toBe(join(root, "store"));
    expect(config.trustedProxyHeader).toBe("CF-Connecting-IP");
    expect(config.redirectUriAllowlist).toEqual(["https://example.com/cb"]);
    expect(config.tunables.accessTokenTtlSeconds).toBe(120);
    expect(config.tunables.refreshTokenTtlSeconds).toBe(DEFAULT_TUNABLES.refreshTokenTtlSeconds);
    expect(config.warnings).toEqual(['unknown tunable "bogus" ignored']);
    expect(config.publicUrl).toBe("https://bridge.example.com");
    expect(config.configFile).toBe(join(root, "config", "bridge.json"));
  });

  it("rejects invalid values", () => {
    writeJson({ publicPort: "abc" });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(/publicPort/);
    writeJson({ tunables: { accessTokenTtlSeconds: -1 } });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(
      /accessTokenTtlSeconds/,
    );
    writeJson({});
    expect(() =>
      loadConfig({
        rootDir: root,
        env: { BRIDGE_PASSPHRASE: GOOD, PUBLIC_URL: "https://x.example.com/mcp" },
      }),
    ).toThrow(/origin only/);
    writeFileSync(join(root, "config", "bridge.json"), "{ not json");
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(/not valid JSON/);
  });

  it("loads oauth.extraResources (default empty) and validates it", () => {
    expect(loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }).oauth.extraResources).toEqual([]);
    const extra = "https://tunnel-service.example.org/v1/mcp/tunnel_abc";
    writeJson({ oauth: { extraResources: [extra] } });
    expect(loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }).oauth.extraResources).toEqual([
      extra,
    ]);
    writeJson({ oauth: { extraResources: ["not a url"] } });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(/extraResources/);
    writeJson({ oauth: { extraResources: "https://x.example/mcp" } });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(/extraResources/);
  });

  it("matches config/bridge.example.json with the built-in defaults", () => {
    mkdirSync(join(root, "config"), { recursive: true });
    copyFileSync(
      join(import.meta.dirname, "../../config/bridge.example.json"),
      join(root, "config", "bridge.json"),
    );
    const fromExample = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(fromExample.warnings).toEqual([]);
    expect(fromExample.redirectUriAllowlist).toEqual([...DEFAULT_REDIRECT_URI_ALLOWLIST]);
    expect(fromExample.redirectUriAllowlist).toContain("https://chatgpt.com/connector/oauth/*");
    expect(fromExample.redirectUriAllowlist).toContain(
      "https://chatgpt.com/connector_platform_oauth_redirect",
    );
    expect(fromExample.oauth.extraResources).toEqual([]);
    expect(fromExample.tunables).toEqual(DEFAULT_TUNABLES);
    expect(fromExample.chatgpt).toBeNull();
    expect(fromExample.onboarding).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      runtime: "auto",
      codexModel: null,
    });
    expect(fromExample.captcha).toEqual({ auto: true });
    expect(fromExample.assistant).toEqual({ auto: true, effort: "low" });
  });

  it("loads assistant.auto (default true) and assistant.effort (default low) from the config file only", () => {
    const defaults = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(defaults.assistant).toEqual({ auto: true, effort: "low" });
    expect(defaults.warnings).toEqual([]);
    writeJson({ assistant: { auto: false, effort: "medium" } });
    // No environment override: variables with those names change nothing.
    const off = loadConfig({
      rootDir: root,
      env: {
        BRIDGE_PASSPHRASE: GOOD,
        BRIDGE_ASSISTANT_AUTO: "true",
        BRIDGE_ASSISTANT_EFFORT: "max",
        ASSISTANT_EFFORT: "max",
      },
    });
    expect(off.assistant).toEqual({ auto: false, effort: "medium" });
    expect(off.warnings).toEqual([]);
    writeJson({ assistant: {} });
    expect(loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }).assistant).toEqual({
      auto: true,
      effort: "low",
    });
    for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultrabrowse"]) {
      writeJson({ assistant: { effort } });
      expect(loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }).assistant.effort).toBe(effort);
    }
  });

  it("refuses an assistant setting of the wrong type or an unknown effort as config_invalid", () => {
    for (const bad of [{ auto: "yes" }, { auto: null }, { auto: 1 }]) {
      writeJson({ assistant: bad });
      expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(
        /assistant\.auto/,
      );
      const result = loadConfigResult({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
      expect(result.ok ? null : result.problem.code).toBe("config_invalid");
    }
    for (const bad of ["LOW", "extreme", "", " low", null, 3, ["low"]]) {
      writeJson({ assistant: { effort: bad } });
      expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }), String(bad)).toThrow(
        /assistant\.effort/,
      );
      const result = loadConfigResult({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
      expect(result.ok ? null : result.problem.code).toBe("config_invalid");
    }
    for (const bad of [true, "on", ["auto"], null]) {
      writeJson({ assistant: bad });
      expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }), String(bad)).toThrow(
        /assistant/,
      );
    }
  });

  it("has the assistant tunables with their defaults, overridable and positive", () => {
    expect(DEFAULT_TUNABLES).toMatchObject({
      assistantTaskBudgetMs: 120_000,
      assistantFailureWindowMs: 600_000,
      assistantPauseMs: 600_000,
    });
    writeJson({
      tunables: {
        assistantTaskBudgetMs: 90_000,
        assistantFailureWindowMs: 300_000,
        assistantPauseMs: 60_000,
      },
    });
    const tuned = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(tuned.tunables).toMatchObject({
      assistantTaskBudgetMs: 90_000,
      assistantFailureWindowMs: 300_000,
      assistantPauseMs: 60_000,
    });
    expect(tuned.warnings).toEqual([]);
    for (const key of ["assistantTaskBudgetMs", "assistantFailureWindowMs", "assistantPauseMs"]) {
      writeJson({ tunables: { [key]: 0 } });
      expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }), key).toThrow(
        new RegExp(`${key} must be a positive number`),
      );
    }
  });

  it("has the browser pool and captcha tunables with their defaults, and no maxConcurrentSites", () => {
    expect(DEFAULT_TUNABLES).toMatchObject({
      maxConcurrentPerSite: 3,
      maxConcurrentTasks: 8,
      concurrentStaggerMs: 500,
      captchaAttemptBudgetMs: 45_000,
      captchaDetectBudgetMs: 20_000,
      captchaRerunReserveMs: 15_000,
      coolDownSeconds: 600,
      warmTabTtlSeconds: 300,
    });
    expect(Object.keys(DEFAULT_TUNABLES)).not.toContain("maxConcurrentSites");
    writeJson({ tunables: { maxConcurrentPerSite: 2, maxConcurrentTasks: 5, concurrentStaggerMs: 250 } });
    const config = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(config.tunables).toMatchObject({
      maxConcurrentPerSite: 2,
      maxConcurrentTasks: 5,
      concurrentStaggerMs: 250,
    });
    expect(config.warnings).toEqual([]);
    writeJson({ tunables: { maxConcurrentPerSite: 0 } });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(
      /maxConcurrentPerSite must be a positive number/,
    );
  });

  it("allows concurrentStaggerMs: 0 (no stagger) but no negative value; every other tunable stays positive", () => {
    writeJson({ tunables: { concurrentStaggerMs: 0 } });
    const config = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(config.tunables.concurrentStaggerMs).toBe(0);
    expect(config.warnings).toEqual([]);
    writeJson({ tunables: { concurrentStaggerMs: -1 } });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(
      /concurrentStaggerMs must be a non-negative number/,
    );
    for (const key of Object.keys(DEFAULT_TUNABLES).filter((k) => k !== "concurrentStaggerMs")) {
      writeJson({ tunables: { [key]: 0 } });
      expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }), key).toThrow(
        new RegExp(`${key} must be a positive number`),
      );
    }
  });

  it("captchaDetectBudgetMs: default 20000, overridable, positive; captchaInlineMinRemainingMs is retired", () => {
    expect(DEFAULT_TUNABLES.captchaDetectBudgetMs).toBe(20_000);
    expect(Object.keys(DEFAULT_TUNABLES)).not.toContain("captchaInlineMinRemainingMs");
    writeJson({ tunables: { captchaDetectBudgetMs: 12_000 } });
    const tuned = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(tuned.tunables.captchaDetectBudgetMs).toBe(12_000);
    expect(tuned.warnings).toEqual([]);
    writeJson({ tunables: { captchaDetectBudgetMs: -5 } });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(
      /captchaDetectBudgetMs must be a positive number/,
    );
    // An existing value of the retired tunable is warned about and ignored like any unknown key.
    writeJson({ tunables: { captchaInlineMinRemainingMs: 40_000, captchaRerunReserveMs: 10_000 } });
    const old = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(old.warnings).toEqual(['unknown tunable "captchaInlineMinRemainingMs" ignored']);
    expect(old.tunables).toEqual({ ...DEFAULT_TUNABLES, captchaRerunReserveMs: 10_000 });
    expect(Object.keys(old.tunables)).not.toContain("captchaInlineMinRemainingMs");
  });

  it("warns about and ignores an existing maxConcurrentSites value", () => {
    writeJson({ tunables: { maxConcurrentSites: 4 } });
    const config = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(config.warnings).toEqual(['unknown tunable "maxConcurrentSites" ignored']);
    expect(config.tunables).toEqual(DEFAULT_TUNABLES);
    expect(Object.keys(config.tunables)).not.toContain("maxConcurrentSites");
  });

  it("loads captcha.auto (default true) from the config file only and validates it", () => {
    expect(loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }).captcha).toEqual({ auto: true });
    writeJson({ captcha: { auto: false } });
    const off = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD, BRIDGE_CAPTCHA_AUTO: "true" } });
    expect(off.captcha).toEqual({ auto: false });
    expect(off.warnings).toEqual([]);
    writeJson({ captcha: {} });
    expect(loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }).captcha).toEqual({ auto: true });
    for (const bad of [{ auto: "yes" }, { auto: null }, { auto: 1 }]) {
      writeJson({ captcha: bad });
      expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(/captcha\.auto/);
    }
    writeJson({ captcha: true });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(/captcha/);
  });

  it("loads the helper runtime, Codex model, and tool locations with defaults", () => {
    const defaults = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(defaults.onboarding.runtime).toBe("auto");
    expect(defaults.onboarding.codexModel).toBeNull();
    expect(defaults.chatgpt).toBeNull();
    expect(defaults.executables).toEqual({ tunnelClient: "tunnel-client", codex: "codex" });
    expect(Object.keys(defaults)).toContain("onboarding");

    writeJson({ onboarding: { runtime: "codex", codexModel: "gpt-5.5-codex" } });
    const set = loadConfig({
      rootDir: root,
      env: { BRIDGE_PASSPHRASE: GOOD, TUNNEL_CLIENT_BIN: "/opt/tc/tunnel-client", CODEX_BIN: " " },
    });
    expect(set.onboarding.runtime).toBe("codex");
    expect(set.onboarding.codexModel).toBe("gpt-5.5-codex");
    expect(set.executables).toEqual({ tunnelClient: "/opt/tc/tunnel-client", codex: "codex" });
    expect(set.warnings).toEqual([]);
    expect((JSON.parse(JSON.stringify(set)) as { onboarding: { runtime: string } }).onboarding.runtime).toBe(
      "codex",
    );

    writeJson({ onboarding: { runtime: "gpt" } });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(
      /onboarding.runtime/,
    );
    writeJson({ onboarding: { codexModel: "" } });
    expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(/codexModel/);
  });

  it("loads the ChatGPT connection marker and validates it", () => {
    const tunnelId = `tunnel_${"ab".repeat(16)}`;
    writeJson({ chatgpt: { managed: true, tunnelId, profile: "browser-research-bridge" } });
    const config = loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(config.chatgpt).toEqual({ managed: true, tunnelId, profile: "browser-research-bridge" });
    expect(config.warnings).toEqual([]);
    writeJson({ chatgpt: null });
    expect(loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } }).chatgpt).toBeNull();
    for (const bad of [
      "x",
      { managed: "yes", tunnelId, profile: "p" },
      { managed: true, tunnelId: "tunnel_123", profile: "p" },
      { managed: true, tunnelId, profile: "" },
      { managed: true, tunnelId },
    ]) {
      writeJson({ chatgpt: bad });
      expect(() => loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } })).toThrow(/chatgpt/);
    }
  });

  it("keeps secrets out of serialization", () => {
    const config = loadConfig({
      rootDir: root,
      env: { BRIDGE_PASSPHRASE: GOOD, ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(config.secrets.anthropicApiKey).toBe("sk-test");
    const text = JSON.stringify(config);
    expect(text).not.toContain(GOOD);
    expect(text).not.toContain("sk-test");
  });
});

describe("loadConfigResult", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bridge-config-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the config when it is valid", () => {
    const result = loadConfigResult({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.secrets.passphrase).toBe(GOOD);
  });

  it("classifies the three configuration problems", () => {
    expect(loadConfigResult({ rootDir: root, env: {} })).toEqual({
      ok: false,
      problem: {
        code: "passphrase_missing",
        message: expect.stringContaining("BRIDGE_PASSPHRASE") as string,
      },
    });
    expect(loadConfigResult({ rootDir: root, env: { BRIDGE_PASSPHRASE: "   " } })).toMatchObject({
      ok: false,
      problem: { code: "passphrase_missing" },
    });
    expect(loadConfigResult({ rootDir: root, env: { BRIDGE_PASSPHRASE: "short" } })).toMatchObject({
      ok: false,
      problem: { code: "passphrase_too_short", message: expect.stringContaining("12") as string },
    });
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "bridge.json"), "{ broken");
    const broken = loadConfigResult({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD } });
    expect(broken).toMatchObject({ ok: false, problem: { code: "config_invalid" } });
    if (!broken.ok) expect(broken.problem.message).toContain(join(root, "config", "bridge.json"));
    expect(
      loadConfigResult({ rootDir: root, env: { BRIDGE_PASSPHRASE: GOOD, BRIDGE_ADMIN_PORT: "99999" } }),
    ).toMatchObject({ ok: false, problem: { code: "config_invalid" } });
  });

  it("keeps ConfigError codes on the thrown errors", () => {
    try {
      loadConfig({ rootDir: root, env: { BRIDGE_PASSPHRASE: "short" } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("passphrase_too_short");
    }
  });

  it("never puts the passphrase into a problem message", () => {
    const secret = "tiny-secret";
    const result = loadConfigResult({ rootDir: root, env: { BRIDGE_PASSPHRASE: secret } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("resolveSettingsPageLocation", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bridge-config-"));
    mkdirSync(join(root, "config"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const file = (text: string) => writeFileSync(join(root, "config", "bridge.json"), text);

  it("uses the defaults without a file or environment", () => {
    expect(resolveSettingsPageLocation({ rootDir: root, env: {} })).toEqual({
      adminPort: 8788,
      dataDir: join(root, "data"),
    });
  });

  it("uses a readable file's valid values and falls back per value", () => {
    file(JSON.stringify({ adminPort: 9100, dataDir: "/var/bridge-data" }));
    expect(resolveSettingsPageLocation({ rootDir: root, env: {} })).toEqual({
      adminPort: 9100,
      dataDir: "/var/bridge-data",
    });
    file(JSON.stringify({ adminPort: "nope", dataDir: "store", publicPort: -1 }));
    expect(resolveSettingsPageLocation({ rootDir: root, env: {} })).toEqual({
      adminPort: 8788,
      dataDir: join(root, "store"),
    });
  });

  it("still yields a port and data folder when the file is malformed", () => {
    file("{ this is not json");
    expect(resolveSettingsPageLocation({ rootDir: root, env: {} })).toEqual({
      adminPort: 8788,
      dataDir: join(root, "data"),
    });
    expect(
      resolveSettingsPageLocation({
        rootDir: root,
        env: { BRIDGE_ADMIN_PORT: "9200", BRIDGE_DATA_DIR: "d2" },
      }),
    ).toEqual({ adminPort: 9200, dataDir: join(root, "d2") });
    file("[1, 2]");
    expect(resolveSettingsPageLocation({ rootDir: root, env: {} }).adminPort).toBe(8788);
  });

  it("prefers a valid environment override and ignores an invalid one", () => {
    file(JSON.stringify({ adminPort: 9100 }));
    expect(resolveSettingsPageLocation({ rootDir: root, env: { BRIDGE_ADMIN_PORT: "9300" } }).adminPort).toBe(
      9300,
    );
    expect(
      resolveSettingsPageLocation({ rootDir: root, env: { BRIDGE_ADMIN_PORT: "70000" } }).adminPort,
    ).toBe(9100);
    expect(resolveSettingsPageLocation({ rootDir: root, env: { BRIDGE_ADMIN_PORT: "" } }).adminPort).toBe(
      9100,
    );
  });
});
