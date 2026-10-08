import { describe, expect, it } from "vitest";
import {
  CONFIG_PROBLEM_CODES,
  DEFAULT_CAPTCHA_AUTO,
  HELPER_RUNTIME_SETTINGS,
  MIN_PASSPHRASE_LENGTH,
  isCaptchaAutoSetting,
  isHelperRuntimeSetting,
  isTunnelId,
  passphraseProblem,
} from "./settings.js";

describe("settings rules", () => {
  it("classifies passphrases as startup counts them (code points, blank is empty)", () => {
    expect(MIN_PASSPHRASE_LENGTH).toBe(12);
    expect(passphraseProblem("")).toBe("empty");
    expect(passphraseProblem("    \t  ")).toBe("empty");
    expect(passphraseProblem("elevenchars")).toBe("too_short");
    expect(passphraseProblem("twelve_chars")).toBeNull();
    // 11 emoji are 22 UTF-16 units but 11 characters.
    expect(passphraseProblem("😀".repeat(11))).toBe("too_short");
    expect(passphraseProblem("😀".repeat(12))).toBeNull();
  });

  it("knows exactly three helper runtime settings", () => {
    expect([...HELPER_RUNTIME_SETTINGS]).toEqual(["auto", "claude", "codex"]);
    expect(isHelperRuntimeSetting("codex")).toBe(true);
    expect(isHelperRuntimeSetting("gpt")).toBe(false);
    expect(isHelperRuntimeSetting(1)).toBe(false);
  });

  it("has captcha.auto on by default and accepts only booleans for it", () => {
    expect(DEFAULT_CAPTCHA_AUTO).toBe(true);
    expect(isCaptchaAutoSetting(true)).toBe(true);
    expect(isCaptchaAutoSetting(false)).toBe(true);
    for (const bad of ["true", 1, 0, null, undefined, {}]) expect(isCaptchaAutoSetting(bad)).toBe(false);
  });

  it("knows exactly three configuration problem codes", () => {
    expect([...CONFIG_PROBLEM_CODES]).toEqual([
      "passphrase_missing",
      "passphrase_too_short",
      "config_invalid",
    ]);
  });

  it("accepts tunnel ids of tunnel_ plus 32 hex characters only", () => {
    expect(isTunnelId(`tunnel_${"a1".repeat(16)}`)).toBe(true);
    expect(isTunnelId(`tunnel_${"A1".repeat(16)}`)).toBe(true);
    expect(isTunnelId(`tunnel_${"a1".repeat(15)}`)).toBe(false);
    expect(isTunnelId(`tunnel_${"g1".repeat(16)}`)).toBe(false);
    expect(isTunnelId(` tunnel_${"a1".repeat(16)}`)).toBe(false);
  });
});
