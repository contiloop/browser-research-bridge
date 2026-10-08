/**
 * Challenge attempts: the bridge's own captcha solver on top of Aside's REPL `captcha` global.
 *
 * Aside's `CaptchaSolver` (REPL global `captcha`, methods not enumerable) offers exactly three actions on
 * an Aside tab object: `click(page, bounds)` (mouse click at 15 % of the width and 50 % of the height of
 * `bounds`, then a 3 s wait), `drag(page, from, to, { steps })` (then a 2 s wait), and
 * `readText(page, bounds?)` (a screenshot cropped to `bounds`, read by the vision model configured in
 * Aside's own settings; throws "No visual model configured…" when there is none). It does not detect
 * anything, so detection is the bridge's: a fixed table (`CAPTCHA_WIDGETS`) applied to the main frame of
 * the bridge's tab from an isolated world (the page's own scripts cannot see or spoof it), giving
 * viewport bounding boxes of main-frame elements only. For a vendor widget that is the box of the iframe
 * element whose `src` names the vendor; nothing ever reaches inside a cross-origin frame.
 *
 * An attempt is privileged bridge code, not an adapter script: it skips the page-script scan but keeps
 * the session's scope, tab filter, guards, post-step drain, and popup sweep, with one widening. While it
 * runs, the tab's request filter and guard CSP also allow `CAPTCHA_VENDOR_HOSTS` (fixed here, never from
 * a manifest, page, or tool): the port re-issues the blocked-URL list, replaces the tab's init scripts
 * with a widened guard, and reloads the challenge URL (a fresh tab is first opened normally, then widened
 * and reloaded the same way), detects, acts at most `MAX_CAPTCHA_ROUNDS` times, and finally restores the
 * normal list and guard, or closes the tab when that cannot be done safely. Only the
 * cropped captcha image of the text kind leaves the machine, to Aside's configured vision model; the
 * typed answer stays inside the REPL call and is never returned or logged.
 *
 * `solved` is deliberately weak: an action was performed and the page no longer shows a recognized
 * widget or block marker. Callers confirm with the adapter's own re-run.
 */
import { DEFAULT_CAPTCHA_ATTEMPT_BUDGET_MS } from "../../core/defaults.js";
import { OutcomeError } from "../../core/outcome.js";
import type { ChallengeAttempt, ChallengeKind } from "../../ports/browser.js";
import type { ExtraHost } from "./hosts.js";

/** One attempt's default time budget (`captchaAttemptBudgetMs`; defined in src/core/defaults.ts). */
export const DEFAULT_CAPTCHA_BUDGET_MS = DEFAULT_CAPTCHA_ATTEMPT_BUDGET_MS;

/** Action rounds per attempt (detection itself is not a round). */
export const MAX_CAPTCHA_ROUNDS = 2;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Hosts that serve challenge widgets. A bridge tab may reach them only while a challenge attempt runs on
 * it; extended only here, in code. reCAPTCHA's Google hosts are limited to its `/recaptcha/` paths.
 */
export const CAPTCHA_VENDOR_HOSTS: readonly ExtraHost[] = deepFreeze([
  { host: "captcha-delivery.com" },
  { host: "google.com", pathPrefix: "/recaptcha/" },
  { host: "gstatic.com", pathPrefix: "/recaptcha/" },
  { host: "hcaptcha.com" },
  { host: "challenges.cloudflare.com" },
  { host: "geetest.com" },
]);

export interface CaptchaFrameRule {
  vendor: string;
  /** `checkbox`: click it; `challenge`: a follow-up or frame-internal challenge (no action); `interstitial`: an automatic check that resolves itself. */
  role: "checkbox" | "challenge" | "interstitial";
  /** The iframe's `src` host or a subdomain of it. */
  host: string;
  /** Regex (source) the `src` path + query + hash must match; empty matches all. */
  match: string;
  /** Regex (source) that excludes a frame, e.g. invisible reCAPTCHA badges. */
  exclude?: string;
  /** Main-frame field that holds the widget's token once it is done. */
  doneField?: string;
}

export interface CaptchaElementRule {
  vendor: string;
  selector: string;
  /** Only used when no iframe of the vendor is visible to the page (e.g. Turnstile in a closed shadow root). */
  fallback: boolean;
  /** The widget is the selected element's parent (e.g. the shadow host around Turnstile's hidden field). */
  parent?: boolean;
  skip?: string;
  doneField?: string;
}

export interface CaptchaSliderRule {
  vendor: string;
  handle: string;
  track: string;
  container: string;
}

export interface CaptchaMarkerRule {
  id: string;
  vendor?: string;
  selector?: string;
  title?: string;
  text?: string;
  /** An automatic check that may resolve itself: wait for it before giving up. */
  pending?: boolean;
}

export interface CaptchaWidgetTable {
  frames: CaptchaFrameRule[];
  elements: CaptchaElementRule[];
  sliders: CaptchaSliderRule[];
  text: {
    /** Elements that can show the captcha picture. */
    image: string;
    /** Regex (source, case-insensitive) over the image's id, class, src, alt, name, title, aria-label. */
    label: string;
    /** Regex (source, case-insensitive) that marks the preferred answer field. */
    inputLabel: string;
    submit: string;
    minWidth: number;
    minHeight: number;
    maxWidth: number;
    maxHeight: number;
    /** Ancestor levels searched for the answer field and submit control when there is no form. */
    levels: number;
  };
  markers: CaptchaMarkerRule[];
  /** Size range of a clickable widget element (never a page-sized container). */
  minWidget: { width: number; height: number };
  maxWidget: { width: number; height: number };
  /** `type` values of an answer field. */
  textInputTypes: string[];
  /** Characters of body text the markers look at. */
  textLimit: number;
}

const RECAPTCHA_DONE = 'textarea[name="g-recaptcha-response"]';
const HCAPTCHA_DONE = 'textarea[name="h-captcha-response"]';
const TURNSTILE_DONE = 'input[name="cf-turnstile-response"]';

/**
 * The detection table. Order of precedence in the page: a visible follow-up/frame challenge (unknown),
 * an interstitial (pending), a slider, a checkbox frame, a checkbox element, a text captcha, a block
 * marker (pending or unknown), else none.
 */
export const CAPTCHA_WIDGETS: CaptchaWidgetTable = deepFreeze({
  frames: [
    {
      vendor: "recaptcha",
      role: "checkbox",
      host: "google.com",
      match: "^/recaptcha/(api2|enterprise)/anchor",
      exclude: "[?&#]size=invisible",
      doneField: RECAPTCHA_DONE,
    },
    {
      vendor: "recaptcha",
      role: "challenge",
      host: "google.com",
      match: "^/recaptcha/(api2|enterprise)/bframe",
    },
    {
      vendor: "hcaptcha",
      role: "checkbox",
      host: "hcaptcha.com",
      match: "frame=checkbox",
      exclude: "[?&#]size=invisible",
      doneField: HCAPTCHA_DONE,
    },
    { vendor: "hcaptcha", role: "challenge", host: "hcaptcha.com", match: "frame=challenge" },
    {
      vendor: "turnstile",
      role: "checkbox",
      host: "challenges.cloudflare.com",
      match: "",
      doneField: TURNSTILE_DONE,
    },
    { vendor: "datadome", role: "interstitial", host: "captcha-delivery.com", match: "^/interstitial" },
    // DataDome's slider lives inside this cross-origin frame, where the bridge never reaches.
    { vendor: "datadome", role: "challenge", host: "captcha-delivery.com", match: "^/captcha" },
  ],
  elements: [
    { vendor: "geetest", selector: ".geetest_radar_tip", fallback: false },
    { vendor: "geetest", selector: ".geetest_btn_click", fallback: false },
    {
      vendor: "recaptcha",
      selector: ".g-recaptcha",
      fallback: true,
      skip: '[data-size="invisible"]',
      doneField: RECAPTCHA_DONE,
    },
    {
      vendor: "hcaptcha",
      selector: ".h-captcha",
      fallback: true,
      skip: '[data-size="invisible"]',
      doneField: HCAPTCHA_DONE,
    },
    {
      vendor: "turnstile",
      selector: ".cf-turnstile",
      fallback: true,
      skip: '[data-size="invisible"]',
      doneField: TURNSTILE_DONE,
    },
    // Cloudflare's own challenge page: no widget class, only the hidden field inside the shadow host.
    {
      vendor: "turnstile",
      selector: TURNSTILE_DONE,
      parent: true,
      fallback: true,
      doneField: TURNSTILE_DONE,
    },
  ],
  sliders: [
    {
      vendor: "geetest",
      handle: ".geetest_btn",
      track: ".geetest_track",
      container: ".geetest_box,.geetest_captcha",
    },
    {
      vendor: "geetest",
      handle: ".geetest_slider_button",
      track: ".geetest_slider_track,.geetest_slider",
      container: ".geetest_panel,.geetest_holder,.geetest_widget",
    },
    // DataDome, when its slider is part of the main frame (not inside its own iframe).
    {
      vendor: "datadome",
      handle: ".sliderIcon,.slider",
      track: ".sliderContainer",
      container: "#captcha-container,#ddv1-captcha-container,.captcha__human",
    },
  ],
  text: {
    image: "img,canvas",
    label: "captcha",
    inputLabel: "captcha|code|characters|answer|verif",
    submit: "button,input",
    minWidth: 40,
    minHeight: 15,
    maxWidth: 600,
    maxHeight: 300,
    levels: 4,
  },
  markers: [
    {
      id: "cloudflare-check",
      vendor: "cloudflare",
      selector: "#challenge-running,#challenge-form,#cf-challenge-running,#challenge-stage,#cf-please-wait",
      pending: true,
    },
    { id: "cloudflare-title", vendor: "cloudflare", title: "^\\s*just a moment", pending: true },
    { id: "checking-text", text: "checking (if the site connection is secure|your browser)", pending: true },
    { id: "perimeterx", vendor: "perimeterx", selector: "#px-captcha" },
    {
      id: "block-title",
      title:
        "access denied|attention required|are you a robot|verify you are human|security check|captcha|robot check|access to this page has been blocked|request blocked|pardon our interruption",
    },
    {
      id: "block-text",
      text: "verify (that )?you are (a )?human|are you a robot|enable js and disable any ad ?blocker|complete the security check|press (&|and) hold|unusual traffic from your",
    },
  ],
  minWidget: { width: 30, height: 30 },
  maxWidget: { width: 600, height: 200 },
  textInputTypes: ["text", "tel", "number"],
  textLimit: 3000,
});

/**
 * Runs in an isolated world of the tab's main frame (CDP `Runtime.evaluate`), as
 * `(<source>)({ mode, table, text? })`. `detect` returns `{ kind, vendor, reason, box | from,to | image }`
 * with viewport coordinates; `type` fills the text captcha's answer field and submits it. It returns
 * no page content.
 */
export const CAPTCHA_PAGE_SOURCE = String.raw`function (arg) {
  "use strict";
  var T = arg.table;
  var doc = document;
  var win = window;
  var vw = Number(win.innerWidth) || 0, vh = Number(win.innerHeight) || 0;
  var sx = Number(win.scrollX) || 0, sy = Number(win.scrollY) || 0;
  var all = function (sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); };
  var round = function (n) { return Math.round(Number(n) || 0); };
  var box = function (el) { var r = el.getBoundingClientRect(); return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) }; };
  var rendered = function (el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    var r = el.getBoundingClientRect();
    if (!(r.width >= 4 && r.height >= 4)) return false;
    if (r.right + sx <= 0 || r.bottom + sy <= 0) return false; // moved off the page to hide it
    var cs = null;
    try { cs = win.getComputedStyle(el); } catch (e) { cs = null; }
    if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || Number(cs.opacity) === 0)) return false;
    return true;
  };
  var reveal = function (el) {
    var r = el.getBoundingClientRect();
    if (r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh) return;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) { /* keep the position */ }
  };
  var hostMatch = function (h, host) { return h === host || (h.length > host.length && h.slice(-(host.length + 1)) === "." + host); };
  var filled = function (sel) {
    if (!sel) return false;
    var f = all(sel);
    for (var i = 0; i < f.length; i++) if (String(f[i].value || "").length > 0) return true;
    return false;
  };
  var result = function (kind, vendor, reason, extra) {
    var o = { kind: kind, vendor: vendor || null, reason: reason || null };
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  };
  var center = function (b) { return { x: round(b.x + b.width / 2), y: round(b.y + b.height / 2) }; };

  // Vendor frames, by the iframe element's src (never by looking inside the frame).
  var frames = [];
  var seen = {};
  all("iframe").forEach(function (el) {
    var u = null;
    try { u = new URL(el.getAttribute("src") || "", location.href); } catch (e) { u = null; }
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return;
    var h = u.hostname.toLowerCase();
    var rest = u.pathname + u.search + u.hash;
    for (var i = 0; i < T.frames.length; i++) {
      var f = T.frames[i];
      if (!hostMatch(h, f.host) || (f.match && !new RegExp(f.match).test(rest))) continue;
      seen[f.vendor] = true;
      if (f.exclude && new RegExp(f.exclude).test(rest)) break;
      frames.push({ el: el, rule: f, shown: rendered(el) });
      break;
    }
  });
  var shown = frames.filter(function (f) { return f.shown; });

  var findText = function () {
    var label = new RegExp(T.text.label, "i");
    var inputLabel = new RegExp(T.text.inputLabel, "i");
    var attrs = function (el, names) { return names.map(function (n) { return el.getAttribute(n) || ""; }).join(" "); };
    var imgs = all(T.text.image).filter(function (el) {
      if (!rendered(el) || !label.test(attrs(el, ["id", "class", "src", "alt", "name", "title", "aria-label"]))) return false;
      var r = el.getBoundingClientRect();
      return r.width >= T.text.minWidth && r.height >= T.text.minHeight && r.width <= T.text.maxWidth && r.height <= T.text.maxHeight;
    });
    var isTextInput = function (el) { var t = String(el.getAttribute("type") || "text").toLowerCase(); return T.textInputTypes.indexOf(t) >= 0 && rendered(el); };
    var isSubmit = function (el) {
      var tag = String(el.tagName || "").toUpperCase();
      var t = String(el.getAttribute("type") || "").toLowerCase();
      if (tag === "BUTTON") return (t === "" || t === "submit") && rendered(el);
      if (tag === "INPUT") return (t === "submit" || t === "image") && rendered(el);
      return false;
    };
    for (var i = 0; i < imgs.length; i++) {
      var scopes = [];
      var form = imgs[i].closest("form");
      if (form) scopes.push(form);
      var p = imgs[i].parentElement;
      for (var d = 0; p && d < T.text.levels; d++, p = p.parentElement) if (scopes.indexOf(p) < 0) scopes.push(p);
      for (var s = 0; s < scopes.length; s++) {
        var inputs = all("input", scopes[s]).filter(isTextInput);
        var submits = all(T.text.submit, scopes[s]).filter(isSubmit);
        if (!inputs.length || !submits.length) continue;
        var preferred = inputs.filter(function (el) { return inputLabel.test(attrs(el, ["name", "id", "placeholder", "aria-label"])); });
        return { img: imgs[i], input: preferred[0] || inputs[0], submit: submits[0] };
      }
    }
    return null;
  };

  if (arg.mode === "type") {
    var w = findText();
    if (!w) return { ok: false };
    try { w.input.focus(); } catch (e) { /* not focusable */ }
    w.input.value = String(arg.text);
    w.input.dispatchEvent(new Event("input", { bubbles: true }));
    w.input.dispatchEvent(new Event("change", { bubbles: true }));
    w.submit.click();
    return { ok: true };
  }

  // 1. A visible follow-up or frame-internal challenge (e.g. an image grid): nothing the solver can do.
  for (var a = 0; a < shown.length; a++) {
    if (shown[a].rule.role === "challenge") return result("unknown", shown[a].rule.vendor, shown[a].rule.vendor + "-challenge");
  }
  // 2. An automatic check that resolves itself.
  for (var b = 0; b < shown.length; b++) {
    if (shown[b].rule.role === "interstitial") return result("pending", shown[b].rule.vendor, shown[b].rule.vendor + "-interstitial");
  }
  // 3. A slider: drag from the handle's center to the end of its track.
  for (var c = 0; c < T.sliders.length; c++) {
    var sl = T.sliders[c];
    var handles = all(sl.handle).filter(rendered);
    for (var hi = 0; hi < handles.length; hi++) {
      var cont = handles[hi].closest(sl.container);
      if (!cont) continue;
      var track = handles[hi].closest(sl.track);
      if (!track || track === handles[hi] || !rendered(track)) track = all(sl.track, cont).filter(function (t) { return t !== handles[hi] && rendered(t); })[0];
      if (!track) continue;
      reveal(handles[hi]);
      var hb = box(handles[hi]), tb = box(track);
      var from = center(hb);
      return result("slider", sl.vendor, "slider", { from: from, to: { x: round(tb.x + tb.width - hb.width / 2), y: from.y } });
    }
  }
  // 4. A checkbox widget frame that is not done yet.
  for (var e = 0; e < shown.length; e++) {
    var fr = shown[e];
    if (fr.rule.role !== "checkbox" || filled(fr.rule.doneField)) continue;
    reveal(fr.el);
    return result("checkbox", fr.rule.vendor, "frame", { box: box(fr.el) });
  }
  // 5. A checkbox-like widget element (vendor buttons; containers whose iframe the page cannot see).
  for (var g = 0; g < T.elements.length; g++) {
    var er = T.elements[g];
    if ((er.fallback && seen[er.vendor]) || filled(er.doneField)) continue;
    var els = all(er.selector).map(function (x) { return er.parent ? x.parentElement : x; }).filter(function (x) {
      if (!x || !rendered(x) || (er.skip && x.matches(er.skip))) return false;
      var r = x.getBoundingClientRect();
      return r.width >= T.minWidget.width && r.height >= T.minWidget.height && r.width <= T.maxWidget.width && r.height <= T.maxWidget.height;
    });
    if (els.length) { reveal(els[0]); return result("checkbox", er.vendor, "element", { box: box(els[0]) }); }
  }
  // 6. A text captcha: picture, answer field, submit control.
  var tw = findText();
  if (tw) { reveal(tw.img); return result("text", null, "text", { image: box(tw.img) }); }
  // 7. Block-page markers without a widget.
  var title = String(doc.title || "");
  var body = "";
  try { body = String((doc.body && (doc.body.innerText || doc.body.textContent)) || "").slice(0, T.textLimit); } catch (x) { body = ""; }
  for (var m = 0; m < T.markers.length; m++) {
    var mk = T.markers[m];
    var hit = (mk.selector && all(mk.selector).some(rendered)) || (mk.title && new RegExp(mk.title, "i").test(title)) || (mk.text && new RegExp(mk.text, "i").test(body));
    if (hit) return result(mk.pending ? "pending" : "unknown", mk.vendor || null, mk.id);
  }
  return result("none", null, null);
}`;

/**
 * Runs inside the REPL runtime (repl-runtime.ts, op `captcha`) as `userFn(raw, cap, step, tools)`:
 * `raw` is the bridge's real Aside tab (never the membrane, never the REPL's global page), `cap` the
 * REPL's `captcha` global (or undefined), `tools` the runtime's sleep, politeness gate, the solver's
 * isolated-world name, `CAPTCHA_PAGE_SOURCE`, and `CAPTCHA_WIDGETS`. It returns only metadata: kind,
 * vendor, the table's reason id, whether it acted, and a failure code. The captcha answer never leaves it.
 */
export const CAPTCHA_STEP_SOURCE = String.raw`async function (raw, cap, step, tools) {
  "use strict";
  var available = Boolean(cap) && typeof cap.click === "function" && typeof cap.drag === "function" && typeof cap.readText === "function";
  if (step.action === "probe" || !available) return { available: available };
  if (!raw) throw new Error("a captcha step needs a bridge tab");
  var inPage = async function (arg) {
    var ft = await raw._sendToTarget("Page.getFrameTree", {});
    var frameId = ft && ft.frameTree && ft.frameTree.frame ? ft.frameTree.frame.id : "";
    if (!frameId) throw new Error("the tab has no main frame");
    var world = await raw._sendToTarget("Page.createIsolatedWorld", { frameId: frameId, worldName: tools.worldName });
    var r = await raw._sendToTarget("Runtime.evaluate", {
      expression: "(" + tools.pageSource + ")(" + JSON.stringify(arg) + ")",
      contextId: world.executionContextId, returnByValue: true, awaitPromise: true
    });
    if (!r || r.exceptionDetails) throw new Error("widget detection failed in the document");
    return r.result ? r.result.value : undefined;
  };
  var detectOnce = async function () {
    for (var i = 0; i < 3; i++) {
      try {
        var d = await inPage({ mode: "detect", table: tools.table });
        if (d && typeof d.kind === "string") return d;
      } catch (e) { /* the document is navigating: look again */ }
      await tools.sleep(step.pollMs);
    }
    return { kind: "unknown", vendor: null, reason: "unreadable" };
  };
  // Keeps looking while an automatic check runs, or (before any action) while nothing has rendered yet.
  var settle = async function (d, noneWaitMs) {
    var start = Date.now();
    while ((d.kind === "pending" && Date.now() - start < step.pendingWaitMs) || (d.kind === "none" && Date.now() - start < noneWaitMs)) {
      await tools.sleep(step.pollMs);
      d = await detectOnce();
    }
    return d;
  };
  var view = function (d) {
    return { kind: d.kind, vendor: typeof d.vendor === "string" ? d.vendor.slice(0, 40) : null, reason: typeof d.reason === "string" ? d.reason.slice(0, 40) : null };
  };
  var current = await settle(await detectOnce(), step.action === "detect" ? step.noneWaitMs : 0);
  if (step.action === "detect") return { available: true, detection: view(current) };
  if (current.kind !== step.expect) return { available: true, acted: false, detection: view(current) };
  if (current.kind === "checkbox") {
    await tools.gate();
    await cap.click(raw, current.box);
    await tools.sleep(step.settleMs);
  } else if (current.kind === "slider") {
    await tools.gate();
    await cap.drag(raw, current.from, current.to);
    await tools.sleep(step.settleMs);
  } else if (current.kind === "text") {
    var answer = null;
    try {
      answer = await cap.readText(raw, current.image);
    } catch (e) {
      var msg = e && typeof e.message === "string" ? e.message : String(e);
      return { available: true, acted: false, failure: /no visual model configured/i.test(msg) ? "no_vision_model" : "read_failed", detection: view(current) };
    }
    answer = typeof answer === "string" ? answer.replace(/\s+/g, "").slice(0, 64) : "";
    if (!answer) return { available: true, acted: false, failure: "no_text", detection: view(current) };
    await tools.gate();
    var typed = await inPage({ mode: "type", table: tools.table, text: answer });
    answer = "";
    if (!typed || typed.ok !== true) return { available: true, acted: false, failure: "no_field", detection: view(current) };
    await tools.sleep(step.textSettleMs);
  } else {
    return { available: true, acted: false, detection: view(current) };
  }
  var after = await settle(await detectOnce(), 0);
  return { available: true, acted: true, detection: view(after) };
}`;

/** Isolated world the solver's detection runs in (separate from the guard's world). */
export function solverWorldName(instanceId: string): string {
  return `solver_${instanceId}`;
}

export type ActionKind = "checkbox" | "slider" | "text";
export type DetectedKind = ActionKind | "none" | "unknown" | "pending";
export type CaptchaFailure = "no_vision_model" | "read_failed" | "no_text" | "no_field";

/** What a REPL step tells Node about the page: metadata only. */
export interface CaptchaDetection {
  kind: DetectedKind;
  vendor: string | null;
  /** Id from the detection table (e.g. `frame`, `recaptcha-challenge`, `block-title`); never page text. */
  reason: string | null;
}

export interface CaptchaActResult {
  acted: boolean;
  failure?: CaptchaFailure | undefined;
  detection: CaptchaDetection;
}

/** The step a `captcha` REPL operation runs (wire format). */
export type CaptchaStep =
  | { action: "probe" }
  | { action: "detect"; noneWaitMs: number; pendingWaitMs: number; pollMs: number }
  | {
      action: "act";
      expect: ActionKind;
      settleMs: number;
      textSettleMs: number;
      pendingWaitMs: number;
      pollMs: number;
    };

export interface CaptchaTimings {
  /** After the (re)load, how long to keep looking while nothing is shown yet (widgets render late). */
  noneWaitMs: number;
  /** How long to wait for an automatic check (DataDome device check, Cloudflare "Just a moment"). */
  pendingWaitMs: number;
  pollMs: number;
  /** Extra wait after a click or drag (Aside itself waits 3 s / 2 s). */
  settleMs: number;
  /** Wait after submitting a text answer before looking again. */
  textSettleMs: number;
  /** A round starts only while at least this much of the budget is left. */
  minRoundMs: number;
  /** Time allowed for restoring the tab's filter and guard (outside the budget). */
  restoreTimeoutMs: number;
}

export const DEFAULT_CAPTCHA_TIMINGS: Readonly<CaptchaTimings> = Object.freeze({
  noneWaitMs: 3000,
  pendingWaitMs: 12_000,
  pollMs: 1000,
  settleMs: 1000,
  textSettleMs: 3000,
  minRoundMs: 8000,
  restoreTimeoutMs: 20_000,
});

export const CAPTCHA_MESSAGES = Object.freeze({
  unavailable: "captcha solving is not available in this Aside version",
  noVisionModel: "text captcha: no vision model is configured in Aside",
  readFailed: "text captcha: reading the captcha image failed",
  noText: "text captcha: the vision model returned no text",
  noField: "text captcha: the answer field or the submit control was not found",
  none: "no captcha or block page is shown after reloading the page; re-run the request",
  pending: "the page's automatic check did not finish and no captcha widget appeared",
  time: "the captcha attempt ran out of time",
});

function unknownMessage(d: CaptchaDetection): string {
  return `the page shows a challenge the solver cannot handle (${d.reason ?? d.vendor ?? "unrecognized"})`;
}

function failureMessage(f: CaptchaFailure): string {
  switch (f) {
    case "no_vision_model":
      return CAPTCHA_MESSAGES.noVisionModel;
    case "read_failed":
      return CAPTCHA_MESSAGES.readFailed;
    case "no_text":
      return CAPTCHA_MESSAGES.noText;
    case "no_field":
      return CAPTCHA_MESSAGES.noField;
  }
}

const DETECTED_KINDS: ReadonlySet<string> = new Set([
  "checkbox",
  "slider",
  "text",
  "none",
  "unknown",
  "pending",
]);
const FAILURES: ReadonlySet<string> = new Set(["no_vision_model", "read_failed", "no_text", "no_field"]);

/** Validates a detection coming back from the REPL; anything malformed is `unknown`. */
export function parseDetection(value: unknown): CaptchaDetection {
  const v = value as { kind?: unknown; vendor?: unknown; reason?: unknown } | null;
  if (!v || typeof v !== "object" || typeof v.kind !== "string" || !DETECTED_KINDS.has(v.kind)) {
    return { kind: "unknown", vendor: null, reason: "malformed" };
  }
  return {
    kind: v.kind as DetectedKind,
    vendor: typeof v.vendor === "string" ? v.vendor.slice(0, 40) : null,
    reason: typeof v.reason === "string" ? v.reason.slice(0, 40) : null,
  };
}

export function parseActResult(value: unknown): CaptchaActResult {
  const v = value as { acted?: unknown; failure?: unknown; detection?: unknown } | null;
  const out: CaptchaActResult = { acted: v?.acted === true, detection: parseDetection(v?.detection) };
  if (typeof v?.failure === "string" && FAILURES.has(v.failure)) out.failure = v.failure as CaptchaFailure;
  return out;
}

/** The browser work of one attempt, implemented by the Aside port (or a fake in tests). */
export interface ChallengeDriver {
  /** Whether the REPL offers the `captcha` capability (click, drag, readText). */
  probe(): Promise<boolean>;
  /** Picks the tab, widens its filter and guard to the vendor hosts, and (re)loads the challenge URL. */
  prepare(): Promise<void>;
  detect(): Promise<CaptchaDetection>;
  /** Re-detects, performs the action for `kind` if it is still shown, waits, and detects again. */
  act(kind: ActionKind): Promise<CaptchaActResult>;
  /** Restores the tab's normal filter and guard (never throws). */
  restore(): Promise<void>;
  remainingMs(): number;
}

/**
 * One attempt: probe, prepare, detect, then at most `MAX_CAPTCHA_ROUNDS` action rounds while the budget
 * allows; restore always. `solved` only when an action was performed and the page then showed nothing
 * recognized. A spent budget is an unsolved result; other failures (browser unavailable, a guard
 * violation) are thrown after the restore.
 */
export async function runChallengeAttempt(
  driver: ChallengeDriver,
  timings: Pick<CaptchaTimings, "minRoundMs">,
): Promise<ChallengeAttempt> {
  let rounds = 0;
  let acted: ActionKind | null = null;
  let current: CaptchaDetection | null = null;
  const result = (solved: boolean, kind: ChallengeKind, message: string): ChallengeAttempt => ({
    solved,
    kind,
    rounds,
    message,
    available: true,
  });
  const publicKind = (d: CaptchaDetection | null): ChallengeKind =>
    d === null || d.kind === "pending" ? "unknown" : d.kind;
  try {
    if (!(await driver.probe())) {
      return {
        solved: false,
        kind: "unknown",
        rounds: 0,
        message: CAPTCHA_MESSAGES.unavailable,
        available: false,
      };
    }
    await driver.prepare();
    current = await driver.detect();
    for (let step = 0; step <= MAX_CAPTCHA_ROUNDS + 1; step += 1) {
      const kind: DetectedKind = current.kind;
      if (kind === "none") {
        return acted
          ? result(
              true,
              acted,
              `the ${acted} captcha was answered and the page no longer shows it; re-run the request to confirm`,
            )
          : result(false, "none", CAPTCHA_MESSAGES.none);
      }
      if (kind === "unknown" || kind === "pending") {
        const message = acted
          ? `after the ${acted} action the page shows a challenge the solver cannot handle (for example an image grid)`
          : kind === "pending"
            ? CAPTCHA_MESSAGES.pending
            : unknownMessage(current);
        return result(false, "unknown", message);
      }
      if (rounds >= MAX_CAPTCHA_ROUNDS) {
        return result(false, kind, `the ${kind} captcha is still shown after ${rounds} rounds`);
      }
      if (driver.remainingMs() < timings.minRoundMs) return result(false, kind, CAPTCHA_MESSAGES.time);
      const r = await driver.act(kind);
      if (r.failure !== undefined) return result(false, kind, failureMessage(r.failure));
      if (r.acted) {
        rounds += 1;
        acted = kind;
      }
      current = r.detection;
    }
    return result(false, publicKind(current), `the page kept changing during the attempt`);
  } catch (err) {
    if (err instanceof OutcomeError && err.status === "timeout") {
      return result(false, publicKind(current), CAPTCHA_MESSAGES.time);
    }
    throw err;
  } finally {
    await driver.restore();
  }
}
