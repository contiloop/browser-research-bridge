import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyPassphraseToClipboard, createSettingsStore, previewCaptchaAuto } from "./settings.js";

const GOOD = "correct horse battery";
const TUNNEL = `tunnel_${"0f".repeat(16)}`;

describe("settings store", () => {
  let root: string;
  let envFile: string;
  let configFile: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bridge-settings-"));
    envFile = join(root, ".env");
    configFile = join(root, "config", "bridge.json");
    mkdirSync(join(root, "config"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeEnv = (text: string) => writeFileSync(envFile, text, { mode: 0o600 });
  const writeConfig = (text: string) => writeFileSync(configFile, text);
  const store = (env: Record<string, string | undefined> = {}) => createSettingsStore({ rootDir: root, env });
  const mode = (path: string) => statSync(path).mode & 0o777;

  describe("read", () => {
    it("reports set/valid/locked flags for secrets and never their values", () => {
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\nANTHROPIC_API_KEY=sk-ant-test-value\n`);
      const view = store().read();
      expect(view.passphrase).toEqual({ set: true, valid: true, locked: false });
      expect(view.anthropicApiKey).toEqual({ set: true, locked: false });
      const text = JSON.stringify(view);
      expect(text).not.toContain(GOOD);
      expect(text).not.toContain("sk-ant-test-value");
    });

    it("does not expose the start environment through serialization or inspection", () => {
      const s = store({ BRIDGE_PASSPHRASE: GOOD, ANTHROPIC_API_KEY: "sk-ant-outside" });
      for (const text of [JSON.stringify(s), inspect(s, { depth: 10, showHidden: true })]) {
        expect(text).not.toContain(GOOD);
        expect(text).not.toContain("sk-ant-outside");
      }
    });

    it("reports a missing or short passphrase", () => {
      expect(store().read().passphrase).toEqual({ set: false, valid: false, locked: false });
      writeEnv("BRIDGE_PASSPHRASE=short\n");
      expect(store().read().passphrase).toEqual({ set: true, valid: false, locked: false });
    });

    it("reads non-secret values with their sources and defaults", () => {
      expect(store().read()).toMatchObject({
        helperRuntime: { value: "auto" },
        asideAccount: { value: "u0", locked: false, source: "default" },
        chatgpt: null,
        oauthExtraResources: [],
        publicUrl: { set: false, source: null },
        files: {
          envFile: { path: envFile, exists: false, readable: true, problem: null },
          configFile: { path: configFile, exists: false, readable: true, problem: null },
        },
      });
      writeConfig(
        JSON.stringify({
          asideAccount: "u2",
          onboarding: { runtime: "codex" },
          chatgpt: { managed: true, tunnelId: TUNNEL, profile: "p1" },
          oauth: { extraResources: ["https://t.example/v1/mcp/x"] },
        }),
      );
      writeEnv("PUBLIC_URL=https://bridge.example.com\n");
      expect(store().read()).toMatchObject({
        helperRuntime: { value: "codex" },
        asideAccount: { value: "u2", source: "config_file" },
        chatgpt: { managed: true, tunnelId: TUNNEL, profile: "p1" },
        oauthExtraResources: ["https://t.example/v1/mcp/x"],
        publicUrl: { set: true, source: "env_file" },
      });
      writeEnv("BRIDGE_ASIDE_ACCOUNT=u7\n");
      expect(store().read().asideAccount).toEqual({ value: "u7", locked: false, source: "env_file" });
    });

    it("answers with nulls for values a malformed config file hides", () => {
      writeConfig("{ broken");
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
      const view = store().read();
      expect(view.passphrase.valid).toBe(true);
      expect(view.helperRuntime.value).toBeNull();
      expect(view.asideAccount.value).toBeNull();
      expect(view.oauthExtraResources).toBeNull();
      expect(view.files.configFile).toMatchObject({ exists: true, readable: false });
      expect(view.files.configFile.problem).toContain("not valid JSON");
    });

    it("shows the files' current content after a hand edit", () => {
      const s = store();
      expect(s.read().helperRuntime.value).toBe("auto");
      writeConfig(JSON.stringify({ onboarding: { runtime: "claude" } }));
      expect(s.read().helperRuntime.value).toBe("claude");
    });

    it("reports captcha.auto as captchaAuto: the default true, the stored boolean, or null", () => {
      const s = store();
      expect(s.read().captchaAuto).toEqual({ value: true });
      writeConfig(JSON.stringify({ captcha: {} }));
      expect(s.read().captchaAuto).toEqual({ value: true });
      writeConfig(JSON.stringify({ captcha: { auto: false } }));
      expect(s.read().captchaAuto).toEqual({ value: false });
      for (const bad of ['{ "captcha": { "auto": "false" } }', '{ "captcha": true }', "{ broken"]) {
        writeConfig(bad);
        expect(s.read().captchaAuto, bad).toEqual({ value: null });
      }
    });
  });

  describe("captchaAuto preview (PUT settings, before anything is written)", () => {
    const base = { ok: true as const, changed: [] };

    it("adds captchaAuto to the changed fields only when the stored value differs", () => {
      const s = store();
      expect(previewCaptchaAuto(s.read(), { captchaAuto: true }, base)).toEqual({ ok: true, changed: [] });
      expect(previewCaptchaAuto(s.read(), { captchaAuto: false }, base)).toEqual({
        ok: true,
        changed: ["captchaAuto"],
      });
      writeConfig(JSON.stringify({ captcha: { auto: false } }));
      expect(previewCaptchaAuto(s.read(), { captchaAuto: false }, base)).toEqual({ ok: true, changed: [] });
      expect(
        previewCaptchaAuto(s.read(), { captchaAuto: true }, { ok: true, changed: ["helperRuntime"] }),
      ).toEqual({ ok: true, changed: ["helperRuntime", "captchaAuto"] });
      // Without captchaAuto in the change, the base preview stands as it is.
      expect(previewCaptchaAuto(s.read(), { helperRuntime: "claude" }, base)).toBe(base);
    });

    it("keeps an earlier refusal, refuses a non-boolean, and an unreadable config file", () => {
      const s = store();
      const locked = {
        ok: false as const,
        error: "locked" as const,
        fields: { passphrase: "locked" as const },
        message: "passphrase is set outside the settings files",
      };
      expect(previewCaptchaAuto(s.read(), { captchaAuto: false }, locked)).toBe(locked);
      expect(previewCaptchaAuto(s.read(), { captchaAuto: "no" as unknown as boolean }, base)).toMatchObject({
        ok: false,
        error: "invalid",
        fields: { captchaAuto: "bad_value" },
      });
      writeConfig("{ broken");
      expect(previewCaptchaAuto(s.read(), { captchaAuto: false }, base)).toMatchObject({
        ok: false,
        error: "file_unreadable",
        message: expect.stringContaining(configFile) as string,
      });
    });
  });

  describe("copyPassphraseToClipboard", () => {
    /** A fake `pbcopy`: records its argument count, environment, and standard input. */
    const fakePbcopy = (exitCode = 0): { command: string; out: string; args: string; env: string } => {
      const dir = join(root, "clip");
      mkdirSync(dir, { recursive: true });
      const paths = {
        command: join(dir, "pbcopy"),
        out: join(dir, "out"),
        args: join(dir, "args"),
        env: join(dir, "env"),
      };
      writeFileSync(
        paths.command,
        [
          "#!/bin/sh",
          `printf '%s' "$#" > '${paths.args}'`,
          `env > '${paths.env}'`,
          `cat > '${paths.out}'`,
          `exit ${exitCode}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return paths;
    };
    const SECRET = `비밀 'quoted' "double" # passphrase ünï`;

    it("pipes the .env passphrase to pbcopy's standard input, never as an argument or in its environment", async () => {
      const writer = store();
      expect(await writer.write({ passphrase: SECRET })).toMatchObject({ ok: true });
      // As if started with --env-file: the process environment holds the file's value.
      const s = store({ BRIDGE_PASSPHRASE: SECRET, ANTHROPIC_API_KEY: "sk-ant-x" });
      const fake = fakePbcopy();
      expect(await copyPassphraseToClipboard({ store: s, command: fake.command })).toBe("ok");
      expect(readFileSync(fake.out, "utf8")).toBe(SECRET);
      expect(readFileSync(fake.args, "utf8")).toBe("0");
      const env = readFileSync(fake.env, "utf8");
      expect(env).not.toContain(SECRET);
      expect(env).not.toContain("BRIDGE_");
      expect(env).not.toContain("sk-ant-x");
      expect(env).toContain("UTF-8");
    });

    it("works in setup mode too (the core is not involved) and copies the value saved since start", async () => {
      const s = store();
      writeEnv("BRIDGE_PASSPHRASE=short\n");
      const fake = fakePbcopy();
      expect(await copyPassphraseToClipboard({ store: s, command: fake.command })).toBe("not_set");
      expect(existsSync(fake.out)).toBe(false);
      expect(await s.write({ passphrase: GOOD })).toMatchObject({ ok: true });
      expect(await copyPassphraseToClipboard({ store: s, command: fake.command })).toBe("ok");
      expect(readFileSync(fake.out, "utf8")).toBe(GOOD);
    });

    it("not_set: no passphrase anywhere", async () => {
      const fake = fakePbcopy();
      expect(await copyPassphraseToClipboard({ store: store(), command: fake.command })).toBe("not_set");
      writeEnv("BRIDGE_PASSPHRASE=\n");
      expect(await copyPassphraseToClipboard({ store: store(), command: fake.command })).toBe("not_set");
      expect(existsSync(fake.out)).toBe(false);
    });

    it("locked: a passphrase set outside .env is refused and pbcopy is not run", async () => {
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
      const fake = fakePbcopy();
      const s = store({ BRIDGE_PASSPHRASE: "set by the service definition" });
      expect(await copyPassphraseToClipboard({ store: s, command: fake.command })).toBe("locked");
      expect(existsSync(fake.out)).toBe(false);
    });

    it("unavailable: pbcopy missing, failing, or hanging", async () => {
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
      const s = store();
      expect(await copyPassphraseToClipboard({ store: s, command: join(root, "no-such-pbcopy") })).toBe(
        "unavailable",
      );
      expect(await copyPassphraseToClipboard({ store: s, command: fakePbcopy(1).command })).toBe(
        "unavailable",
      );
      const hanging = join(root, "hang");
      writeFileSync(hanging, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
      expect(await copyPassphraseToClipboard({ store: s, command: hanging, timeoutMs: 200 })).toBe(
        "unavailable",
      );
    });
  });

  describe("locked detection", () => {
    it("locks a setting forced by an environment variable that did not come from .env", () => {
      writeEnv("BRIDGE_ASIDE_ACCOUNT=u1\n");
      const s = store({ BRIDGE_PASSPHRASE: GOOD, BRIDGE_ASIDE_ACCOUNT: "u9" });
      const view = s.read();
      expect(view.passphrase).toEqual({ set: true, valid: true, locked: true });
      expect(view.asideAccount).toEqual({ value: "u9", locked: true, source: "environment" });
    });

    it("does not lock values the process loaded from .env at start", () => {
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\nBRIDGE_ASIDE_ACCOUNT=u1\n`);
      // As if started with --env-file: process.env holds the file's values.
      const s = store({ BRIDGE_PASSPHRASE: GOOD, BRIDGE_ASIDE_ACCOUNT: "u1" });
      expect(s.read().passphrase.locked).toBe(false);
      expect(s.read().asideAccount).toEqual({ value: "u1", locked: false, source: "env_file" });
    });

    it("counts an empty outside value as unset", () => {
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
      expect(store({ BRIDGE_PASSPHRASE: "" }).read().passphrase).toEqual({
        set: true,
        valid: true,
        locked: false,
      });
    });

    it("refuses to write a locked setting and writes nothing", async () => {
      writeEnv("# keep\n");
      const s = store({ BRIDGE_PASSPHRASE: GOOD, BRIDGE_ASIDE_ACCOUNT: "u9" });
      const result = await s.write({ passphrase: "another good passphrase", asideAccount: "u3" });
      expect(result).toEqual({
        ok: false,
        error: "locked",
        fields: { passphrase: "locked", asideAccount: "locked" },
        message: expect.any(String) as string,
      });
      expect(readFileSync(envFile, "utf8")).toBe("# keep\n");
      expect(existsSync(configFile)).toBe(false);
    });

    it("never locks the helper runtime", async () => {
      const s = store({ BRIDGE_PASSPHRASE: GOOD });
      expect(await s.write({ helperRuntime: "claude" })).toEqual({ ok: true, changed: ["helperRuntime"] });
    });

    it("keeps outside values over the file when building the configuration", () => {
      writeEnv("BRIDGE_PASSPHRASE='file passphrase value'\nBRIDGE_ASIDE_ACCOUNT=u1\n");
      const result = store({ BRIDGE_PASSPHRASE: GOOD, BRIDGE_ASIDE_ACCOUNT: "u9" }).loadConfig();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.secrets.passphrase).toBe(GOOD);
        expect(result.config.asideAccount).toBe("u9");
      }
    });
  });

  describe("write", () => {
    it("writes the passphrase into .env, keeps other lines, and keeps .env owner-only", async () => {
      const original = [
        "# Copy to .env (git-ignored) and fill in.",
        "BRIDGE_PASSPHRASE=",
        "",
        "# Public origin",
        "PUBLIC_URL=https://bridge.example.com",
        "# BRIDGE_ADMIN_PORT=8788",
        "",
      ].join("\n");
      writeEnv(original);
      chmodSync(envFile, 0o644);
      const s = store();
      expect(await s.write({ passphrase: GOOD })).toEqual({ ok: true, changed: ["passphrase"] });
      const text = readFileSync(envFile, "utf8");
      expect(text).toBe(original.replace("BRIDGE_PASSPHRASE=", `BRIDGE_PASSPHRASE='${GOOD}'`));
      expect(mode(envFile)).toBe(0o600);
      expect(s.read().passphrase).toEqual({ set: true, valid: true, locked: false });
      const loaded = s.loadConfig();
      expect(loaded.ok && loaded.config.secrets.passphrase).toBe(GOOD);
    });

    it("creates missing files (.env owner-only)", async () => {
      rmSync(join(root, "config"), { recursive: true });
      const s = store();
      expect(await s.write({ passphrase: GOOD, helperRuntime: "codex" })).toEqual({
        ok: true,
        changed: ["passphrase", "helperRuntime"],
      });
      expect(mode(envFile)).toBe(0o600);
      expect(parseEnv(readFileSync(envFile, "utf8"))["BRIDGE_PASSPHRASE"]).toBe(GOOD);
      expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ onboarding: { runtime: "codex" } });
    });

    it.each([
      `it's a "quoted" passphrase`,
      "hash # inside and #end",
      "  spaces around it  ",
      "비밀번호는 한국어로 된 문장입니다",
      "émoji 😀 and ünïcode!!",
      `all three ' " \` quotes no hash`,
    ])("round-trips the passphrase %j through the store and through node --env-file", async (value) => {
      writeEnv("# header\nOTHER=1\n");
      const s = store();
      expect(await s.write({ passphrase: value })).toEqual({ ok: true, changed: ["passphrase"] });
      const loaded = s.loadConfig();
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.config.secrets.passphrase).toBe(value);
      const child = spawnSync(
        process.execPath,
        [
          `--env-file=${envFile}`,
          "-e",
          "process.stdout.write(JSON.stringify(process.env.BRIDGE_PASSPHRASE ?? null))",
        ],
        { env: { PATH: process.env["PATH"] ?? "" }, encoding: "utf8" },
      );
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toBe(value);
      // Unchanged when the same value is saved again.
      expect(await s.write({ passphrase: value })).toEqual({ ok: true, changed: [] });
    });

    it("refuses invalid values with field codes and writes nothing", async () => {
      writeEnv("# keep\n");
      const s = store();
      expect(
        await s.write({
          passphrase: "two\nlines but long enough",
          helperRuntime: "gpt",
          asideAccount: "   ",
          chatgpt: { managed: true, tunnelId: "tunnel_123", profile: "" },
          oauthExtraResources: { add: ["not a url"] },
        }),
      ).toEqual({
        ok: false,
        error: "invalid",
        fields: {
          passphrase: "unsupported_characters",
          helperRuntime: "bad_value",
          asideAccount: "empty",
          chatgpt: "bad_format",
          oauthExtraResources: "bad_value",
        },
        message: expect.any(String) as string,
      });
      expect(await s.write({ passphrase: "short" })).toMatchObject({ fields: { passphrase: "too_short" } });
      expect(await s.write({ passphrase: "      " })).toMatchObject({ fields: { passphrase: "empty" } });
      expect(await s.write({ passphrase: "carriage\rreturn long" })).toMatchObject({
        fields: { passphrase: "unsupported_characters" },
      });
      expect(await s.write({ asideAccount: "u\n1" })).toMatchObject({
        fields: { asideAccount: "unsupported_characters" },
      });
      expect(readFileSync(envFile, "utf8")).toBe("# keep\n");
      expect(existsSync(configFile)).toBe(false);
    });

    it("does not echo a refused passphrase in the result", async () => {
      const secret = "two\nline secret value";
      const result = await store().write({ passphrase: secret });
      expect(JSON.stringify(result)).not.toContain("line secret");
    });

    it("writes the browser account where the winning value lives", async () => {
      const config = '{\n  "asideAccount": "u0",\n  "publicPort": 8787\n}\n';
      writeConfig(config);
      writeEnv("# accounts\nBRIDGE_ASIDE_ACCOUNT=u1\n");
      const s = store();
      expect(await s.write({ asideAccount: "u5" })).toEqual({ ok: true, changed: ["asideAccount"] });
      expect(readFileSync(envFile, "utf8")).toBe("# accounts\nBRIDGE_ASIDE_ACCOUNT='u5'\n");
      expect(readFileSync(configFile, "utf8")).toBe(config);
      expect(s.read().asideAccount).toEqual({ value: "u5", locked: false, source: "env_file" });

      // With no active .env line (only a comment or an empty value) the config file holds it.
      writeEnv("# BRIDGE_ASIDE_ACCOUNT=u1\nBRIDGE_ASIDE_ACCOUNT=\n");
      expect(await s.write({ asideAccount: "u6" })).toEqual({ ok: true, changed: ["asideAccount"] });
      expect(readFileSync(envFile, "utf8")).toBe("# BRIDGE_ASIDE_ACCOUNT=u1\nBRIDGE_ASIDE_ACCOUNT=\n");
      expect(readFileSync(configFile, "utf8")).toBe(config.replace('"u0"', '"u6"'));
    });

    it("edits bridge.json in place, keeping other keys, order, and formatting", async () => {
      const example = readFileSync(join(import.meta.dirname, "../../config/bridge.example.json"), "utf8");
      writeConfig(example);
      chmodSync(configFile, 0o644);
      const s = store();
      expect(await s.write({ helperRuntime: "claude" })).toEqual({ ok: true, changed: ["helperRuntime"] });
      const after = readFileSync(configFile, "utf8");
      expect(after).toBe(example.replace('"runtime": "auto"', '"runtime": "claude"'));
      expect(mode(configFile)).toBe(0o644);
    });

    it("sets and clears the ChatGPT marker and edits the accepted addresses", async () => {
      writeConfig(
        '{\n  "oauth": { "extraResources": ["https://keep.example/mcp"] },\n  "chatgpt": null\n}\n',
      );
      const s = store();
      const marker = { managed: true, tunnelId: TUNNEL, profile: "browser-research-bridge" };
      const address = `https://tunnel-service.example.org/v1/mcp/${TUNNEL}`;
      expect(await s.write({ chatgpt: marker, oauthExtraResources: { add: [address] } })).toEqual({
        ok: true,
        changed: ["chatgpt", "oauthExtraResources"],
      });
      expect(s.read().chatgpt).toEqual(marker);
      expect(s.read().oauthExtraResources).toEqual(["https://keep.example/mcp", address]);
      expect(await s.write({ oauthExtraResources: { add: [address] } })).toEqual({ ok: true, changed: [] });
      expect(await s.write({ chatgpt: null, oauthExtraResources: { remove: [address] } })).toEqual({
        ok: true,
        changed: ["chatgpt", "oauthExtraResources"],
      });
      expect(readFileSync(configFile, "utf8")).toBe(
        '{\n  "oauth": { "extraResources": ["https://keep.example/mcp"] },\n  "chatgpt": null\n}\n',
      );
    });

    it("writes captchaAuto as a boolean under captcha.auto, in place", async () => {
      const example = readFileSync(join(import.meta.dirname, "../../config/bridge.example.json"), "utf8");
      writeConfig(example);
      const s = store();
      expect(await s.write({ captchaAuto: true })).toEqual({ ok: true, changed: [] });
      expect(await s.write({ captchaAuto: false })).toEqual({ ok: true, changed: ["captchaAuto"] });
      expect(readFileSync(configFile, "utf8")).toBe(
        example.replace('"captcha": { "auto": true }', '"captcha": { "auto": false }'),
      );
      const loaded = s.loadConfig();
      expect(loaded.ok).toBe(false); // no passphrase here; the file itself must still be valid
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
      const withPassphrase = s.loadConfig();
      expect(withPassphrase.ok && withPassphrase.config.captcha).toEqual({ auto: false });
      expect(await s.write({ captchaAuto: false })).toEqual({ ok: true, changed: [] });
    });

    it("adds captcha.auto to a file without it and treats a missing value as the default true", async () => {
      const s = store();
      expect(await s.write({ captchaAuto: true })).toEqual({ ok: true, changed: [] });
      expect(existsSync(configFile)).toBe(false);
      writeConfig('{\n  "asideAccount": "u1"\n}\n');
      expect(await s.write({ captchaAuto: false })).toEqual({ ok: true, changed: ["captchaAuto"] });
      expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({
        asideAccount: "u1",
        captcha: { auto: false },
      });
      expect(readFileSync(configFile, "utf8").startsWith('{\n  "asideAccount": "u1",')).toBe(true);
    });

    it("refuses a captchaAuto that is not a boolean and writes nothing", async () => {
      const s = store();
      for (const bad of ["true", 1, null]) {
        expect(await s.write({ captchaAuto: bad as unknown as boolean })).toMatchObject({
          ok: false,
          error: "invalid",
          fields: { captchaAuto: "bad_value" },
        });
      }
      expect(existsSync(configFile)).toBe(false);
    });

    it("refuses a captchaAuto change to an unreadable config file", async () => {
      writeConfig("{ broken");
      expect(await store().write({ captchaAuto: false })).toMatchObject({
        ok: false,
        error: "file_unreadable",
        file: configFile,
      });
      expect(readFileSync(configFile, "utf8")).toBe("{ broken");
    });

    it("does nothing when no value changes", async () => {
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
      const s = store();
      const before = statSync(envFile).mtimeMs;
      expect(
        await s.write({ passphrase: GOOD, helperRuntime: "auto", asideAccount: "u0", chatgpt: null }),
      ).toEqual({
        ok: true,
        changed: [],
      });
      expect(statSync(envFile).mtimeMs).toBe(before);
      expect(existsSync(configFile)).toBe(false);
    });

    it("refuses a change to an unreadable config file but allows a separate .env change", async () => {
      writeConfig("{ broken");
      const s = store();
      expect(await s.write({ helperRuntime: "codex", passphrase: GOOD })).toEqual({
        ok: false,
        error: "file_unreadable",
        file: configFile,
        message: expect.stringContaining(configFile) as string,
      });
      expect(existsSync(envFile)).toBe(false);
      expect(await s.write({ passphrase: GOOD })).toEqual({ ok: true, changed: ["passphrase"] });
      expect(readFileSync(configFile, "utf8")).toBe("{ broken");
      // Correcting the edited field recovers the file only by hand; the problem stays visible.
      expect(s.loadConfig()).toMatchObject({ ok: false, problem: { code: "config_invalid" } });
    });

    it("serializes concurrent writes", async () => {
      const s = store();
      const results = await Promise.all([
        s.write({ helperRuntime: "claude" }),
        s.write({ asideAccount: "u4" }),
        s.write({ passphrase: GOOD }),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({
        onboarding: { runtime: "claude" },
        asideAccount: "u4",
      });
    });
  });

  describe("loadConfig", () => {
    it("classifies the three configuration problems from the files", async () => {
      const s = store();
      expect(s.loadConfig()).toMatchObject({ ok: false, problem: { code: "passphrase_missing" } });
      writeEnv("BRIDGE_PASSPHRASE=short\n");
      expect(s.loadConfig()).toMatchObject({ ok: false, problem: { code: "passphrase_too_short" } });
      expect(await s.write({ passphrase: GOOD })).toMatchObject({ ok: true });
      expect(s.loadConfig().ok).toBe(true);
      writeConfig('{ "publicPort": "x" }');
      const result = s.loadConfig();
      expect(result).toMatchObject({ ok: false, problem: { code: "config_invalid" } });
      if (!result.ok) expect(result.problem.message).toContain("publicPort");
    });

    it("reads .env again on every call and drops lines removed since start", () => {
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\nPUBLIC_URL=https://a.example.com\n`);
      const s = store({ BRIDGE_PASSPHRASE: GOOD, PUBLIC_URL: "https://a.example.com", HOME: "/home/x" });
      writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
      const result = s.loadConfig();
      expect(result.ok && result.config.publicUrlConfigured).toBe(false);
    });
  });

  describe("pageLocation", () => {
    it("yields the settings page port and data folder even with a malformed config file", () => {
      writeConfig("{ broken");
      writeEnv("BRIDGE_ADMIN_PORT=9400\n");
      expect(store().pageLocation()).toEqual({ adminPort: 9400, dataDir: join(root, "data") });
      writeEnv("");
      writeConfig(JSON.stringify({ adminPort: 9500, dataDir: "d" }));
      expect(store().pageLocation()).toEqual({ adminPort: 9500, dataDir: join(root, "d") });
    });
  });
});
