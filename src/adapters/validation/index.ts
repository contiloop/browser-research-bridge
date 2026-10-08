/** Validation core: static check, full/light validation, validation.json. */
import type { Outcome } from "../../core/models.js";
import { reportToOutcome } from "./report.js";
import type { LightBlock, LightValidationOptions, SiteValidator } from "./validator.js";

export * from "./report.js";
export * from "./static-check.js";
export * from "./validate.js";
export * from "./validator.js";
export { createAnonymousFetcher } from "./anonymous-fetch.js";
export type { AnonymousFetchOptions } from "./anonymous-fetch.js";

/** A light check's outcome; `blocked` when it failed on a block or captcha page ("Check now" attempts it). */
export interface LightCheckOutcome extends Outcome {
  blocked?: LightBlock | undefined;
}

/** Adapts the validator's light form to the health runner's check function (src/app/health.ts). */
export function lightCheck(
  validator: Pick<SiteValidator, "light">,
): (key: string, options: Omit<LightValidationOptions, "onBlocked">) => Promise<LightCheckOutcome> {
  return async (key, options) => {
    let blocked: LightBlock | undefined;
    const report = await validator.light(key, { ...options, onBlocked: (block) => (blocked = block) });
    const outcome = reportToOutcome(report);
    return blocked !== undefined && outcome.status !== "ok" ? { ...outcome, blocked } : outcome;
  };
}
