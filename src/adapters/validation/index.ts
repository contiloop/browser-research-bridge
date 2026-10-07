/** Validation core: static check, full/light validation, validation.json. */
import type { Outcome } from "../../core/models.js";
import { reportToOutcome } from "./report.js";
import type { LightValidationOptions, SiteValidator } from "./validator.js";

export * from "./report.js";
export * from "./static-check.js";
export * from "./validate.js";
export * from "./validator.js";
export { createAnonymousFetcher } from "./anonymous-fetch.js";
export type { AnonymousFetchOptions } from "./anonymous-fetch.js";

/** Adapts the validator's light form to the health runner's check function (src/app/health.ts). */
export function lightCheck(
  validator: Pick<SiteValidator, "light">,
): (key: string, options: LightValidationOptions) => Promise<Outcome> {
  return async (key, options) => reportToOutcome(await validator.light(key, options));
}
