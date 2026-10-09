/* Pure page logic of the settings page: the Getting started checklist and its "what to do next"
 * line, the helper's readiness, ChatGPT sub-step states, the "what to do now" choice per site (and when
 * its button reads "Logged in? Check now"), a site's last Aside AI task (its sentence while it runs or
 * waits for the user, and its Details line), when a site or a paused job offers the Aside AI login text,
 * the Aside browser account the page names, the passphrase generator, and the language choice. No DOM
 * and no network, so the unit tests import it directly. */

/** Characters of a generated passphrase: letters and digits without look-alikes (0/O, 1/l/I). */
export const PASSPHRASE_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 4 groups of 6 characters joined by "-": 27 characters, about 139 bits. */
const GROUPS = 4;
const GROUP_LENGTH = 6;

/**
 * A strong random passphrase. `fill` is `crypto.getRandomValues` (passed in so tests can use
 * Node's). Rejection sampling keeps every character equally likely.
 */
export function generatePassphrase(fill) {
  const n = PASSPHRASE_ALPHABET.length;
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const chars = [];
  const buffer = new Uint32Array(GROUPS * GROUP_LENGTH * 2);
  while (chars.length < GROUPS * GROUP_LENGTH) {
    fill(buffer);
    for (const value of buffer) {
      if (value >= limit) continue;
      chars.push(PASSPHRASE_ALPHABET[value % n]);
      if (chars.length === GROUPS * GROUP_LENGTH) break;
    }
  }
  const groups = [];
  for (let i = 0; i < GROUPS; i += 1)
    groups.push(chars.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH).join(""));
  return groups.join("-");
}

/** `ko` when the remembered choice is `ko`, or none is remembered and the browser language is Korean; else `en`. */
export function pickLanguage(remembered, browserLanguage) {
  if (remembered === "ko" || remembered === "en") return remembered;
  return typeof browserLanguage === "string" && browserLanguage.toLowerCase().startsWith("ko") ? "ko" : "en";
}

/**
 * Getting started. `data` holds the latest answers; a route that failed or answered 503
 * is `null`. Each step is `{ id, state, why }` with state `done` | `todo` | `unknown` ("cannot check
 * yet") and, for `unknown`, why: `need_passphrase` | `core_off` | `restarting` | `no_data`.
 */
export function gettingStarted(data) {
  const status = data.status;
  const passphraseDone = data.settings?.passphrase?.valid === true;
  const steps = [];
  steps.push({
    id: "passphrase",
    state: passphraseDone ? "done" : data.settings ? "todo" : "unknown",
    why: data.settings ? null : "no_data",
  });
  const blocked = (id) => {
    if (!passphraseDone) return { id, state: "unknown", why: "need_passphrase" };
    if (status?.mode === "restarting") return { id, state: "unknown", why: "restarting" };
    if (status?.mode === "setup") return { id, state: "unknown", why: "core_off" };
    return null;
  };
  steps.push(
    blocked("aside") ??
      (data.browser
        ? { id: "aside", state: data.browser.reachable ? "done" : "todo", why: null }
        : { id: "aside", state: "unknown", why: "no_data" }),
  );
  const apps = data.chatgpt?.connectedApps;
  steps.push(
    blocked("chatgpt") ??
      (typeof apps === "number"
        ? { id: "chatgpt", state: apps >= 1 ? "done" : "todo", why: null }
        : { id: "chatgpt", state: "unknown", why: "no_data" }),
  );
  steps.push(
    blocked("helper") ??
      (data.helper
        ? { id: "helper", state: helperReady(data.helper) ? "done" : "todo", why: null }
        : { id: "helper", state: "unknown", why: "no_data" }),
  );
  steps.push(
    blocked("sites") ??
      (Array.isArray(data.sites)
        ? {
            id: "sites",
            state: data.sites.some((s) => s.status === "active" && s.lastCheckedAt) ? "done" : "todo",
            why: null,
          }
        : { id: "sites", state: "unknown", why: "no_data" }),
  );
  return steps;
}

/**
 * Step 4 is done only when the last helper check (persisted, from the automatic check or the Check
 * button) succeeded on the runtime a site added now would use: an `ok` on Claude does not cover Codex.
 */
export function helperReady(helper) {
  const last = helper?.lastCheck;
  return (
    last?.ok === true &&
    typeof helper?.wouldUse === "string" &&
    helper.wouldUse !== "" &&
    last.runtime === helper.wouldUse
  );
}

/**
 * Whether the regular poll should also re-read the helper state: while the core runs and no `ok` check
 * covers the runtime a job would use (no check yet, a failed one, or one on another runtime). The
 * automatic check 30 s after a core start then shows up on a page that is already open.
 */
export function helperNeedsPoll(status, helper) {
  return status?.mode === "running" && !helperReady(helper);
}

/** The id of the first step that is not done, or null when all are done. */
export function firstOpenStep(steps) {
  return steps.find((s) => s.state !== "done")?.id ?? null;
}

/**
 * The one sentence and the one action at the top of Getting started: what to do next.
 * Returns `{ id, say, action }`: `id` the step (null when all are done), `say` a dictionary key,
 * `action` one of `passphrase` (go to the passphrase field), `checkBrowser`, `showChatgpt`,
 * `checkHelper`, `checkReuters`, `openSites`, `reload`, or null (nothing to press here).
 */
export function nextStep(steps, data) {
  const step = steps.find((s) => s.state !== "done");
  if (!step) return { id: null, say: "start.allDone", action: null };
  if (step.state === "unknown") {
    if (step.why === "core_off") return { id: step.id, say: "next.coreOff", action: null };
    if (step.why === "restarting") return { id: step.id, say: "step.why.restarting", action: null };
    if (step.why === "need_passphrase")
      return { id: "passphrase", say: "next.passphrase", action: "passphrase" };
    return { id: step.id, say: "step.why.no_data", action: "reload" };
  }
  switch (step.id) {
    case "passphrase":
      return { id: step.id, say: "next.passphrase", action: "passphrase" };
    case "aside":
      return { id: step.id, say: "next.aside", action: "checkBrowser" };
    case "chatgpt":
      return { id: step.id, say: "next.chatgpt", action: "showChatgpt" };
    case "helper":
      return {
        id: step.id,
        say: data?.helper && !data.helper.wouldUse ? "next.helperInstall" : "next.helper",
        action: "checkHelper",
      };
    case "sites": {
      const reuters = Array.isArray(data?.sites) ? data.sites.find((s) => s.key === "reuters") : undefined;
      if (!reuters) return { id: step.id, say: "next.sitesAdd", action: "openSites" };
      const canCheck = Array.isArray(reuters.actions) && reuters.actions.includes("check");
      if (canCheck && (reuters.status === "needs_login" || reuters.status === "active")) {
        return { id: step.id, say: "next.sites", action: "checkReuters" };
      }
      return { id: step.id, say: "next.sitesFix", action: "openSites" };
    }
    default:
      return { id: step.id, say: "step.why.no_data", action: "reload" };
  }
}

/** The kinds a paused helper job gives for its pause (`blockKind`); a missing value reads as `other`. */
export const BLOCK_KINDS = ["login", "captcha", "consent", "subscription", "other"];

/** A job's `blockKind`: the value as received, or `other` when the field is missing or empty. */
export function blockKind(job) {
  const kind = job?.blockKind;
  return typeof kind === "string" && kind !== "" ? kind : "other";
}

/** A helper job paused because it needs the user to log in to the site. */
export function jobPausedForLogin(job) {
  return job?.state === "awaiting_user" && blockKind(job) === "login";
}

/**
 * Whether a site card offers the Aside AI login text: the site needs a login, or its job is paused for
 * one; not while the Aside AI is already working on the site by itself.
 */
export function offersLoginHelp(site) {
  if (assistantTask(site)?.running) return false;
  return site?.status === "needs_login" || jobPausedForLogin(site?.job);
}

/**
 * ChatGPT sub-steps a–g as `{ id, state }`, state `done` | `current` | `later`.
 * `connectedApps` may be null (core off). The first sub-step that is not done is `current`.
 */
export function chatgptSubsteps(chatgpt) {
  const installed = chatgpt?.tool?.installed === true;
  const state = chatgpt?.state ?? "not_configured";
  const configured = state !== "not_configured";
  const ready = state === "ready" || state === "external";
  const connected = typeof chatgpt?.connectedApps === "number" && chatgpt.connectedApps >= 1;
  const done = {
    a: installed || state === "external",
    b: configured,
    c: configured,
    d: ready,
    e: connected,
    f: connected,
    g: connected,
  };
  let current = null;
  return ["a", "b", "c", "d", "e", "f", "g"].map((id) => {
    if (done[id]) return { id, state: "done" };
    if (current === null) {
      current = id;
      return { id, state: "current" };
    }
    return { id, state: "later" };
  });
}

/** What an Aside AI task is for (`GET /api/sites` `assistant.purpose`; the server's closed set). */
export const ASSISTANT_PURPOSES = ["captcha", "login"];
/** How an Aside AI task ended (`assistant.verdict`; null while it runs). */
export const ASSISTANT_VERDICTS = ["done", "failed", "needs_user"];
/** Why an Aside AI task did not end `done` (`assistant.reason`). */
export const ASSISTANT_REASONS = [
  "no_saved_password",
  "verification_code",
  "question",
  "check_not_passed",
  "timed_out",
  "other",
];

/** The reasons whose sentence asks the user to log in (the card's button then reads "Logged in? Check now"). */
const LOGIN_REASONS = ["no_saved_password", "verification_code", "question"];

/**
 * A site's last (or running) Aside AI task from `GET /api/sites` (`site.assistant`), with its fields
 * checked: `{ purpose, verdict, reason, at, running }`, or null when the site has none. Values are kept
 * as received (an unknown one is shown as received).
 */
export function assistantTask(site) {
  const task = site?.assistant;
  if (!task || typeof task !== "object" || typeof task.purpose !== "string" || task.purpose === "")
    return null;
  const text = (value) => (typeof value === "string" && value !== "" ? value : null);
  return {
    purpose: task.purpose,
    verdict: text(task.verdict),
    reason: text(task.reason),
    at: text(task.at),
    running: task.running === true,
  };
}

/** The card's sentence while the Aside AI works on a site, by the task's purpose. */
export function assistantWorkingSay(purpose) {
  if (purpose === "captcha") return "site.do.aiWorkingCaptcha";
  if (purpose === "login") return "site.do.aiWorkingLogin";
  return "site.do.aiWorking";
}

/** Whether `checkedAt` (the site's last check) is later than `at` (both ISO times). */
function checkedSince(checkedAt, at) {
  const checked = typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
  const ended = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(checked) && Number.isFinite(ended) && checked > ended;
}

/**
 * The reason the card gives when the site's last Aside AI task ended `needs_user` (the program then
 * waits for the user, until Check now): on a `needs_login` site, and on an `active` site until a check
 * ran after the task. An unknown reason reads as `other`. Null otherwise.
 */
export function assistantHeldReason(site) {
  const task = assistantTask(site);
  if (!task || task.running || task.verdict !== "needs_user") return null;
  const waiting =
    site.status === "needs_login" || (site.status === "active" && !checkedSince(site.lastCheckedAt, task.at));
  if (!waiting) return null;
  return ASSISTANT_REASONS.includes(task.reason) ? task.reason : "other";
}

/**
 * The Details line of a site's last Aside AI task, as parts in order: what it was for, how it ended
 * ("in progress" while it runs), why (when a reason is given), and when. A part is `{ set, value }` (a
 * label from labels.js), `{ key }` (a dictionary text), or `{ time }` (an ISO time). Empty without a task.
 */
export function assistantDetailParts(site) {
  const task = assistantTask(site);
  if (!task) return [];
  const parts = [{ set: "assistantPurpose", value: task.purpose }];
  if (task.running) parts.push({ key: "site.d.aiRunning" });
  else if (task.verdict !== null) parts.push({ set: "assistantVerdict", value: task.verdict });
  if (!task.running && task.reason !== null) parts.push({ set: "assistantReason", value: task.reason });
  if (task.at !== null) parts.push({ time: task.at });
  return parts;
}

/**
 * What a site row says and which action it shows prominently (one thing to do at a time).
 * Returns `{ say, primary }`: `say` is a dictionary key (`site.do.*`), `primary` one of the site's
 * `actions` or null. While the Aside AI works on the site the card says so and has nothing prominent;
 * after a task that ended `needs_user` it gives that reason's sentence, led by Check now.
 */
export function siteGuidance(site) {
  const actions = Array.isArray(site.actions) ? site.actions : [];
  const has = (a) => (actions.includes(a) ? a : null);
  const job = site.job ?? null;
  if (job && (job.state === "queued" || job.state === "running"))
    return { say: "site.do.working", primary: null };
  if (job && job.state === "awaiting_user") return { say: "site.do.awaiting", primary: has("retry") };
  if (job && job.state === "failed" && has("retry")) return { say: "site.do.jobFailed", primary: "retry" };
  const task = assistantTask(site);
  if (task?.running) return { say: assistantWorkingSay(task.purpose), primary: null };
  const held = assistantHeldReason(site);
  if (held !== null) return { say: `site.do.aiHeld.${held}`, primary: has("check") };
  switch (site.status) {
    case "needs_login":
      return { say: site.loginUrl ? "site.do.login" : "site.do.loginNoUrl", primary: has("check") };
    case "degraded":
      return { say: "site.do.degraded", primary: has("repair") ?? has("check") };
    case "failed":
      return { say: "site.do.failed", primary: has("repair") ?? has("retry") };
    case "onboarding":
      return { say: "site.do.onboarding", primary: has("retry") };
    case "active":
      return site.lastCheckedAt
        ? { say: "site.do.fine", primary: null }
        : { say: "site.do.checkFirst", primary: has("check") };
    default:
      return { say: "site.do.unknown", primary: null };
  }
}

/** The card sentences that ask the user to log in. */
const LOGIN_SAYS = [
  "site.do.login",
  "site.do.loginNoUrl",
  ...LOGIN_REASONS.map((r) => `site.do.aiHeld.${r}`),
];

/**
 * A site card whose one thing to do is logging in, with Check now as its prominent action (a
 * `needs_login` site without a helper job in the way, or a site whose Aside AI task stopped for a login
 * only the user can do). Its button then reads "Logged in? Check now" and the card says that the status
 * changes only after Check now. A job paused for a login keeps Retry; while the Aside AI works, no button
 * is prominent.
 */
export function loginCheckPrimary(site) {
  const guide = siteGuidance(site);
  return LOGIN_SAYS.includes(guide.say) && guide.primary === "check";
}

/** The program's Aside browser account when none is known yet (the settings not loaded): `u0`. */
export const DEFAULT_ASIDE_ACCOUNT = "u0";

/**
 * The Aside browser account the program uses, from `GET /api/settings` (`asideAccount.value`), as
 * given; {@link DEFAULT_ASIDE_ACCOUNT} while the settings are not loaded.
 */
export function asideAccountOf(settings) {
  const value = settings?.asideAccount?.value;
  return typeof value === "string" && value.trim() !== "" ? value : DEFAULT_ASIDE_ACCOUNT;
}

/** `1.5 KB` style sizes. */
export function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
