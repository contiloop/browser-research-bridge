/* Pure page logic of the settings page: the Getting started checklist and its "what to do next"
 * line, the helper's readiness, ChatGPT sub-step states, the "what to do now" choice per site (and when
 * its button reads "Logged in? Check now"), when a site or a paused job offers the Aside AI login text,
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

/** Whether a site card offers the Aside AI login text: the site needs a login, or its job is paused for one. */
export function offersLoginHelp(site) {
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

/**
 * What a site row says and which action it shows prominently (one thing to do at a time).
 * Returns `{ say, primary }`: `say` is a dictionary key (`site.do.*`), `primary` one of the site's
 * `actions` or null.
 */
export function siteGuidance(site) {
  const actions = Array.isArray(site.actions) ? site.actions : [];
  const has = (a) => (actions.includes(a) ? a : null);
  const job = site.job ?? null;
  if (job && (job.state === "queued" || job.state === "running"))
    return { say: "site.do.working", primary: null };
  if (job && job.state === "awaiting_user") return { say: "site.do.awaiting", primary: has("retry") };
  if (job && job.state === "failed" && has("retry")) return { say: "site.do.jobFailed", primary: "retry" };
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

/**
 * A site card whose one thing to do is logging in, with Check now as its prominent action (a
 * `needs_login` site without a helper job in the way). Its button then reads "Logged in? Check now" and
 * the card says that the status changes only after Check now. A job paused for a login keeps Retry.
 */
export function loginCheckPrimary(site) {
  const guide = siteGuidance(site);
  return (guide.say === "site.do.login" || guide.say === "site.do.loginNoUrl") && guide.primary === "check";
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
