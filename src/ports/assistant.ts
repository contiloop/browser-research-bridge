/**
 * Site assistant port: asks the AI built into the Aside browser (the "Aside AI", `aside exec`) to do
 * one bounded task for a registered site in the user's own browser: pass a human check on a page
 * (`captcha`), or log in again with the account already saved in Aside's password manager (`login`).
 *
 * The task is described by fixed instruction texts (the implementation's own; never caller text), so
 * a caller passes only facts about the site. The AI's reply is never returned: only the verdict, a
 * reason code from a closed set, the Aside session id, and the duration. A verdict is the AI's own
 * claim; a caller confirms success with its own check (for example by re-running the adapter).
 */

/** What the Aside AI is asked to do. */
export const ASSISTANT_PURPOSES = ["captcha", "login"] as const;
export type AssistantPurpose = (typeof ASSISTANT_PURPOSES)[number];

/**
 * `done`: the AI reports the task finished. `failed`: it could not finish, or the run failed, timed
 * out, or was stopped. `needs_user`: only the user can continue (for example a verification code).
 */
export const ASSISTANT_VERDICTS = ["done", "failed", "needs_user"] as const;
export type AssistantVerdict = (typeof ASSISTANT_VERDICTS)[number];

/**
 * Why a task did not end `done` (closed set):
 * - `no_saved_password`: Aside's password manager holds no password for the site (login);
 * - `verification_code`: the site asks for a code sent to the user or from an authenticator app;
 * - `question`: the site asks something only the user can answer;
 * - `check_not_passed`: the human check could not be passed;
 * - `timed_out`: the budget ran out or the caller's signal stopped the task;
 * - `other`: anything else (no or malformed result line, an unknown code, a CLI failure, a refused task).
 */
export const ASSISTANT_REASON_CODES = [
  "no_saved_password",
  "verification_code",
  "question",
  "check_not_passed",
  "timed_out",
  "other",
] as const;
export type ReasonCode = (typeof ASSISTANT_REASON_CODES)[number];
/** Alias of {@link ReasonCode} under the port's naming. */
export type AssistantReasonCode = ReasonCode;

export interface AssistantTask {
  /** The registered site's key (for logs; never put into the instruction). */
  site: string;
  purpose: AssistantPurpose;
  /**
   * The page where the problem showed (a read or fetch URL). It never reaches the instruction, not
   * even its path: the task is refused unless it is an http(s) address on `hostnames` or
   * `extraAllowedHosts`, which catches a task aimed at the wrong site.
   */
  url: string;
  /**
   * `manifest.hostnames`: the websites the AI may visit (public DNS names; subdomains included). The
   * instruction opens `https://<first hostname>/` for a captcha, and for a login without a usable
   * `loginUrl`.
   */
  hostnames: readonly string[];
  /** `manifest.extraAllowedHosts`; a login's `loginUrl` may be on one of them (an SSO host). */
  extraAllowedHosts?: readonly string[] | undefined;
  /**
   * `manifest.loginUrl` (login tasks; ignored for captcha). Its scheme, host, and path reach the
   * instruction (query and fragment dropped) when its host is on `hostnames` or `extraAllowedHosts`.
   */
  loginUrl?: string | null | undefined;
  /** The Aside account (`aside exec --account`), the one the bridge's browser port uses. */
  account: string;
  /** Time the task may take; when it runs out the Aside session is stopped (`timed_out`). */
  budgetMs: number;
  /** Stops the task early, like a spent budget (`timed_out`). */
  signal?: AbortSignal | undefined;
}

export interface AssistantResult {
  verdict: AssistantVerdict;
  /** Null exactly when `verdict` is `done`. */
  reason: ReasonCode | null;
  /** The Aside session the task ran in, when the CLI reported one. */
  sessionId: string | null;
  durationMs: number;
}

export interface AssistantAvailabilityOptions {
  /** Probe the CLI again instead of answering from the result cached for this process. */
  reprobe?: boolean | undefined;
}

export interface SiteAssistant {
  /**
   * Runs one task to its end and never throws: every failure is a `failed` result. The AI's text is
   * never returned, logged, or stored.
   */
  run(task: AssistantTask): Promise<AssistantResult>;
  /** Whether the Aside CLI answers (cached for the process unless `reprobe`). Never throws. */
  available(options?: AssistantAvailabilityOptions): Promise<boolean>;
}
