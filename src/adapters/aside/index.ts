/** Aside browser adapter: BrowserPort + Scheduler + SiteAssistant implementations. */
export * from "./defaults.js";
export { AsideBrowserPort } from "./port.js";
export type { AsideBrowserPortOptions } from "./port.js";
export {
  ASIDE_LOGIN_ACTION,
  McpReplClient,
  asideUnavailable,
  looksLikeLoginProblem,
  stdioTransportFactory,
} from "./mcp-repl-client.js";
export type {
  McpReplClientOptions,
  SpawnedTransport,
  StdioTransportOptions,
  TransportFactory,
} from "./mcp-repl-client.js";
export type { ReplCallRequest, ReplCallResult, ReplClient } from "./repl-client.js";
export { InMemoryScheduler } from "./scheduler.js";
export type { InMemorySchedulerOptions } from "./scheduler.js";
export {
  CAPTCHA_MESSAGES,
  CAPTCHA_VENDOR_HOSTS,
  DEFAULT_CAPTCHA_BUDGET_MS,
  DEFAULT_CAPTCHA_TIMINGS,
  MAX_CAPTCHA_ROUNDS,
} from "./captcha.js";
export type { CaptchaTimings } from "./captcha.js";
export {
  blockedUrlPatterns,
  checkUrlInScope,
  hostInScope,
  normalizeHostname,
  normalizeHostnames,
} from "./hosts.js";
export type { ExtraHost } from "./hosts.js";
export { describeViolations, scanPageScript } from "./script-scan.js";
export type { ScanViolation } from "./script-scan.js";
export { checkPageScript, shadowParams } from "./shim.js";
export {
  ASSISTANT_WORK_DIR,
  AsideSiteAssistant,
  assistantEnvironment,
  parseAssistantResult,
} from "./assistant.js";
export type { AsideSiteAssistantOptions } from "./assistant.js";
export {
  buildAssistantInstruction,
  captchaInstruction,
  instructionHostnames,
  instructionLoginUrl,
  instructionSiteUrl,
  loginInstruction,
} from "./assistant-prompts.js";
export type { CaptchaInstructionInput, LoginInstructionInput } from "./assistant-prompts.js";
