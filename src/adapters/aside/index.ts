/** Aside browser adapter: BrowserPort + Scheduler implementations. */
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
  blockedUrlPatterns,
  checkUrlInScope,
  hostInScope,
  normalizeHostname,
  normalizeHostnames,
} from "./hosts.js";
export { describeViolations, scanPageScript } from "./script-scan.js";
export type { ScanViolation } from "./script-scan.js";
export { checkPageScript, shadowParams } from "./shim.js";
