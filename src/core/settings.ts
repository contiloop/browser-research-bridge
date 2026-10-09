/**
 * Rules for the settings the user can change (access passphrase, helper runtime, automatic captcha
 * handling, the Aside AI assistant, ChatGPT tunnel id). Shared by the configuration loader and the
 * settings store so startup and saving apply the same checks.
 */

/** Minimum passphrase length, counted in characters (code points) as startup counts them. */
export const MIN_PASSPHRASE_LENGTH = 12;

export const HELPER_RUNTIME_SETTINGS = ["auto", "claude", "codex"] as const;
export type HelperRuntimeSetting = (typeof HELPER_RUNTIME_SETTINGS)[number];
export const DEFAULT_HELPER_RUNTIME: HelperRuntimeSetting = "auto";

export const DEFAULT_ASIDE_ACCOUNT = "u0";

/** `config/bridge.json` → `captcha.auto` (no environment override); on unless set to false. */
export const DEFAULT_CAPTCHA_AUTO = true;

/**
 * `config/bridge.json` → `assistant.auto` (no environment override): whether the bridge may ask the
 * Aside AI to pass a human check or log in again for a site; on unless set to false.
 */
export const DEFAULT_ASSISTANT_AUTO = true;

/** The effort names `aside exec --effort` accepts (`config/bridge.json` → `assistant.effort`). */
export const ASSISTANT_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrabrowse",
] as const;
export type AssistantEffort = (typeof ASSISTANT_EFFORTS)[number];
export const DEFAULT_ASSISTANT_EFFORT: AssistantEffort = "low";

/** Why the configuration cannot start the core. */
export const CONFIG_PROBLEM_CODES = ["passphrase_missing", "passphrase_too_short", "config_invalid"] as const;
export type ConfigProblemCode = (typeof CONFIG_PROBLEM_CODES)[number];

/** `tunnel_` followed by 32 hexadecimal characters. */
export const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-fA-F]{32}$/;

export function isHelperRuntimeSetting(value: unknown): value is HelperRuntimeSetting {
  return typeof value === "string" && (HELPER_RUNTIME_SETTINGS as readonly string[]).includes(value);
}

/** `captcha.auto` is a boolean; anything else (including the strings "true"/"false") is refused. */
export function isCaptchaAutoSetting(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** `assistant.auto` is a boolean; anything else (including the strings "true"/"false") is refused. */
export function isAssistantAutoSetting(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** `assistant.effort` is exactly one of {@link ASSISTANT_EFFORTS} (case and spaces matter). */
export function isAssistantEffort(value: unknown): value is AssistantEffort {
  return typeof value === "string" && (ASSISTANT_EFFORTS as readonly string[]).includes(value);
}

export function isTunnelId(value: unknown): value is string {
  return typeof value === "string" && TUNNEL_ID_PATTERN.test(value);
}

/** `empty` when blank, `too_short` under {@link MIN_PASSPHRASE_LENGTH} characters, else null. */
export function passphraseProblem(value: string): "empty" | "too_short" | null {
  if (value.trim().length === 0) return "empty";
  if ([...value].length < MIN_PASSPHRASE_LENGTH) return "too_short";
  return null;
}

/** `config/bridge.json` → `chatgpt`: the marker of a program-managed ChatGPT connection. */
export interface ChatgptConnectionSetting {
  managed: boolean;
  /** `tunnel_` + 32 hex characters. */
  tunnelId: string;
  profile: string;
}

/**
 * Checks a `chatgpt` value: `undefined`/`null` mean no program-managed connection. Field codes:
 * `bad_value` (not an object, `managed` not a boolean), `bad_format` (tunnel id), `empty` (profile).
 */
export function checkChatgptSetting(
  value: unknown,
):
  | { ok: true; value: ChatgptConnectionSetting | null }
  | { ok: false; code: "bad_value" | "bad_format" | "empty" } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "bad_value" };
  const { managed, tunnelId, profile } = value as Record<string, unknown>;
  if (typeof managed !== "boolean") return { ok: false, code: "bad_value" };
  if (!isTunnelId(tunnelId)) return { ok: false, code: "bad_format" };
  if (typeof profile !== "string" || profile.trim() === "") return { ok: false, code: "empty" };
  return { ok: true, value: { managed, tunnelId, profile } };
}
