/* Settings page UI: plain DOM + fetch against /api (no build step, no external resources).
 * All server data is inserted as text (textContent / text nodes), never as HTML: job logs may quote
 * web page text. Secrets typed into fields (the access passphrase, the runtime key) are sent once
 * to the local API, cleared from the field after the program accepted them, and never put in
 * browser storage; only the page language is remembered (localStorage). "Copy passphrase" asks the
 * program to put the stored passphrase on this Mac's clipboard; the value never reaches the page.
 *
 * Layout rules: Getting started is the home and starts with one "what to do next" sentence and its
 * one action; each explanation is at most two sentences, with longer background behind "More";
 * developer detail is behind "Details"; statuses are plain words on a coloured badge. */
/* global document, window, fetch, EventSource, navigator, localStorage, crypto, setTimeout, clearTimeout, setInterval */
import { DICTIONARIES, t } from "./i18n.js";
import { label } from "./labels.js";
import { COMMANDS, LINKS, asideText, loginTarget, loginText } from "./instructions.js";
import {
  blockKind,
  chatgptSubsteps,
  firstOpenStep,
  formatBytes,
  generatePassphrase,
  gettingStarted,
  helperNeedsPoll,
  helperReady,
  jobPausedForLogin,
  nextStep,
  offersLoginHelp,
  pickLanguage,
  siteGuidance,
} from "./state.js";

const LANG_KEY = "browser-research-bridge.lang";
const TABS = ["start", "sites", "connection", "settings"];
const POLL_MS = 5000;
const BROWSER_POLL_MS = 60_000;
const RESTART_POLL_MS = 1000;
const RESTART_SLOW_MS = 20_000;

// ------------------------------------------------------------------ language

function storedLang() {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

let lang = pickLanguage(storedLang(), (navigator.languages && navigator.languages[0]) || navigator.language);
const tx = (key, vars) => t(lang, key, vars);
const lb = (set, value) => label(lang, set, value);

// ------------------------------------------------------------------ DOM helpers

const $ = (id) => document.getElementById(id);

/** `h("p", { class: "x", onclick: fn }, "text", node, [more])`; strings become text nodes. */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") node.className = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (name in node && typeof value !== "string") node[name] = value;
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof window.Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** A dictionary text whose {placeholders} may be nodes (links, code). */
function rich(key, vars = {}) {
  const text = DICTIONARIES[lang][key] ?? key;
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    out.push(text.slice(last, m.index));
    const value = vars[m[1]];
    out.push(value === undefined ? m[0] : value);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function link(url, text) {
  return h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text ?? url);
}

function fill(container, ...children) {
  const open = new Set(
    [...container.querySelectorAll("details[data-id]")].filter((d) => d.open).map((d) => d.dataset.id),
  );
  container.replaceChildren();
  append(container, children);
  for (const d of container.querySelectorAll("details[data-id]")) if (open.has(d.dataset.id)) d.open = true;
}

const signatures = new WeakMap();
/** Re-renders `container` only when `input` changed (keeps focus, scroll, and open disclosures). */
function renderIf(container, input, build) {
  const sig = JSON.stringify([lang, input]);
  if (signatures.get(container) === sig) return;
  signatures.set(container, sig);
  fill(container, build());
}

function button(text, onClick, className) {
  const b = h("button", { type: "button", class: className ?? "" }, text);
  b.addEventListener("click", () => {
    b.disabled = true;
    Promise.resolve()
      .then(onClick)
      .catch((error) => notify("error", errorText(error), errorDetails(error)))
      .finally(() => {
        b.disabled = false;
      });
  });
  return b;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { class: "offscreen", readonly: true });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    let ok;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function copyButton(getText, text) {
  const b = h("button", { type: "button", class: "secondary" }, text ?? tx("common.copy"));
  const original = b.textContent;
  b.addEventListener("click", async () => {
    const ok = await copyText(typeof getText === "function" ? getText() : getText);
    b.textContent = ok ? tx("common.copied") : tx("common.copyFailed");
    setTimeout(() => {
      b.textContent = original;
    }, 2000);
  });
  return b;
}

function codeLine(command) {
  return h("div", { class: "code-line" }, h("code", {}, command), copyButton(command));
}

function disclosure(id, summary, ...children) {
  return h("details", { class: "details", "data-id": id }, h("summary", {}, summary), ...children);
}

/** Background that is not needed to act, behind "More". */
function moreBox(id, ...children) {
  const box = disclosure(`more:${id}`, tx("common.more"), ...children);
  box.classList.add("more");
  return box;
}

/** A longer explanation behind "More" (dictionary keys ending in `.more`). */
function more(id, key) {
  return moreBox(id, h("p", { class: "muted small" }, tx(key)));
}

/** Developer detail behind "Details": a definition list of [label, value] pairs (nulls left out). */
function detailList(id, pairs) {
  const rows = pairs.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (rows.length === 0) return null;
  return disclosure(
    id,
    tx("common.details"),
    h(
      "dl",
      { class: "facts" },
      ...rows.flatMap(([name, value]) => [h("dt", {}, name), h("dd", {}, String(value))]),
    ),
  );
}

function when(iso) {
  if (!iso) return tx("common.never");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString(lang === "ko" ? "ko-KR" : "en-US");
}

function badge(state, text) {
  return h("span", { class: `badge badge-${state}` }, text);
}

// ------------------------------------------------------------------ API

class ApiError extends Error {
  constructor(status, body) {
    super(typeof body?.message === "string" ? body.message : `${status}`);
    this.status = status;
    this.code =
      typeof body?.error === "string" ? body.error : status === 401 ? "unauthorized" : "server_error";
    this.fields = body?.fields && typeof body.fields === "object" ? body.fields : {};
  }
}

let signedOut = false;

async function api(path, options = {}) {
  const init = { method: options.method ?? "GET", credentials: "same-origin", headers: {} };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (error) {
    throw new ApiError(0, { error: "server_error", message: error.message });
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    signedOut = true;
    renderBanner();
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return { status: res.status, body };
}

/** A GET whose failure is reported as null (the page shows "cannot check yet" for it). */
async function load(path) {
  try {
    return (await api(path)).body;
  } catch {
    return null;
  }
}

function errorText(error) {
  if (!(error instanceof ApiError)) return String(error?.message ?? error);
  const parts = [lb("errorCode", error.code)];
  const fieldTexts = Object.values(error.fields).map((code) => lb("fieldCode", code));
  if (fieldTexts.length > 0) parts.push(fieldTexts.join(" "));
  if (error.code === "not_running") parts.push(pointerText());
  return parts.join(" ");
}

function errorDetails(error) {
  return error instanceof ApiError ? error.message : null;
}

function pointerText() {
  const code = data.status?.problem?.code;
  if (code === "passphrase_missing" || code === "passphrase_too_short") return tx("error.pointer.passphrase");
  if (data.status?.mode === "restarting") return tx("step.why.restarting");
  return tx("error.pointer.restart");
}

function pointerLink() {
  const code = data.status?.problem?.code;
  if (code === "passphrase_missing" || code === "passphrase_too_short") {
    return h("a", { href: "#start" }, tx("error.pointer.passphrase"));
  }
  if (data.status?.mode === "restarting") return tx("step.why.restarting");
  return h("a", { href: "#settings" }, tx("error.pointer.restart"));
}

// ------------------------------------------------------------------ messages

function notify(kind, text, details) {
  const box = $("notice");
  if (!text) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.className = `notice notice-${kind}`;
  fill(
    box,
    h("p", {}, text),
    details ? disclosure("notice", tx("common.details"), h("pre", { class: "plain" }, details)) : null,
    button(tx("common.close"), () => notify(null), "link"),
  );
  box.hidden = false;
}

/** A message under a form: kind `ok` | `error` | `info`. */
function formMessage(el, kind, text, details) {
  if (!text) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.className = `form-msg form-msg-${kind}`;
  fill(
    el,
    h("p", {}, text),
    details ? disclosure("form", tx("common.details"), h("pre", { class: "plain" }, details)) : null,
  );
  el.hidden = false;
}

function showFieldErrors(fieldEls, fields) {
  for (const [name, el] of Object.entries(fieldEls)) {
    const code = fields?.[name];
    el.textContent = code ? lb("fieldCode", code) : "";
    el.hidden = !code;
  }
}

// ------------------------------------------------------------------ state and loading

const data = {
  status: null,
  settings: null,
  chatgpt: null,
  browser: null,
  helper: null,
  sites: null,
  jobs: null,
  clients: null,
  cache: null,
};
let loadedOnce = false;
let browserLoading = false;

const coreRunning = () => data.status?.mode === "running";

async function loadBrowser() {
  if (!coreRunning()) {
    data.browser = null;
    render();
    return;
  }
  browserLoading = true;
  render();
  data.browser = await load("/browser");
  browserLoading = false;
  render();
}

async function loadHelper() {
  data.helper = coreRunning() ? await load("/helper") : null;
}

async function loadCache() {
  data.cache = coreRunning() ? await load("/cache") : null;
}

/** Reads the mode, settings, connection, and (when the core runs) the lists. */
async function refresh() {
  const [status, settings, chatgpt] = await Promise.all([
    load("/status"),
    load("/settings"),
    load("/chatgpt"),
  ]);
  data.status = status;
  data.settings = settings;
  data.chatgpt = chatgpt;
  if (coreRunning()) {
    const [sites, jobs, clients] = await Promise.all([load("/sites"), load("/jobs"), load("/oauth/clients")]);
    data.sites = sites?.sites ?? null;
    data.jobs = jobs?.jobs ?? null;
    data.clients = clients?.clients ?? null;
  } else {
    data.sites = null;
    data.jobs = null;
    data.clients = null;
    data.helper = null;
    data.cache = null;
    data.browser = null;
  }
  render();
  if (data.status?.mode === "restarting") void waitForRestart();
}

async function loadAll() {
  await refresh();
  await Promise.all([loadHelper(), loadCache()]);
  render();
  void loadBrowser();
}

/** One regular poll: the mode and lists, plus the helper state while its check result may still change. */
let helperPollTick = 0;
async function poll() {
  await refresh();
  // The helper state is re-read every sixth poll (about 30 s): its probe runs local commands.
  helperPollTick = (helperPollTick + 1) % 6;
  if (helperPollTick === 0 && helperNeedsPoll(data.status, data.helper)) {
    await loadHelper();
    render();
  }
}

let restartWaiter = null;
let restartNotice = null;

/** Waits while the mode is `restarting`, then reads everything again (no page reload, no new link). */
function waitForRestart() {
  restartWaiter ??= (async () => {
    const started = Date.now();
    restartNotice = "restarting";
    renderBanner();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
      const status = await load("/status");
      if (signedOut) break;
      if (status === null) continue;
      data.status = status;
      if (status.mode !== "restarting") break;
      if (Date.now() - started > RESTART_SLOW_MS) restartNotice = "slow";
      render();
    }
    restartNotice = null;
    await loadAll();
    // The open log was bound to the core that stopped: reconnect it to the core running now
    // (log.last keeps the lines already shown from repeating).
    if (log.jobId && !signedOut) {
      closeLog();
      connectLog();
    }
    if (data.status?.mode === "running") notify("ok", tx("banner.restartDone"));
    else if (data.status?.mode === "setup") {
      notify(
        "error",
        tx("banner.restartSetup", { reason: lb("problemCode", data.status.problem?.code) }),
        data.status.problem?.message ?? null,
      );
    }
  })().finally(() => {
    restartWaiter = null;
  });
  return restartWaiter;
}

// ------------------------------------------------------------------ actions

/** Runs a state-changing call; on 409 job_running asks once and resends with confirmInterrupt. */
async function send(path, method, body) {
  try {
    return await api(path, { method, body });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === "job_running" &&
      window.confirm(tx("confirm.interrupt"))
    ) {
      return api(path, { method, body: { ...(body ?? {}), confirmInterrupt: true } });
    }
    throw error;
  }
}

async function act(path, method, body, doneText) {
  try {
    await api(path, { method, body });
    notify("ok", doneText ?? tx("action.done"));
  } catch (error) {
    notify("error", errorText(error), errorDetails(error));
  }
  await refresh();
}

async function checkNow(site) {
  notify("info", `${site.name || site.key}: ${tx("site.checking")}`);
  try {
    const { body } = await api(`/sites/${encodeURIComponent(site.key)}/check`, { method: "POST" });
    const result = body.result ?? {};
    const name = site.name || site.key;
    if (result.ran) {
      notify(
        result.outcome?.status === "ok" ? "ok" : "error",
        tx("check.result", {
          site: name,
          outcome: lb("outcomeStatus", result.outcome?.status),
          status: lb("siteStatus", result.status),
        }),
        result.outcome?.message ?? null,
      );
    } else {
      notify("info", tx("check.skipped", { site: name, reason: "" }), result.skipped ?? null);
    }
  } catch (error) {
    notify("error", errorText(error), errorDetails(error));
  }
  await refresh();
}

function siteAction(site, action, primary) {
  const key = encodeURIComponent(site.key);
  const name = site.name || site.key;
  const cls = primary ? "primary" : "secondary";
  switch (action) {
    case "retry":
      return button(tx("action.retry"), () => act(`/sites/${key}/retry`, "POST", { lang }), cls);
    case "repair":
      return button(
        tx("action.repair"),
        () => {
          const note = window.prompt(tx("prompt.repair", { site: name }), "");
          if (note === null) return undefined;
          return act(`/sites/${key}/repair`, "POST", { note, lang });
        },
        cls,
      );
    case "check":
      return button(tx("action.check"), () => checkNow(site), cls);
    case "cancel":
      return site.job
        ? button(
            tx("action.cancel"),
            () => act(`/jobs/${encodeURIComponent(site.job.id)}/cancel`, "POST"),
            cls,
          )
        : null;
    case "remove":
      return button(
        tx("action.remove"),
        () => {
          if (!window.confirm(tx("confirm.remove", { site: name }))) return undefined;
          return act(`/sites/${key}`, "DELETE");
        },
        primary ? "primary danger" : "secondary danger",
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ job log (SSE)

const log = { jobId: null, source: null, last: 0, timer: null };

function closeLog() {
  log.source?.close();
  log.source = null;
  if (log.timer) clearTimeout(log.timer);
  log.timer = null;
}

function openLog(jobId, scroll = true) {
  closeLog();
  log.jobId = jobId;
  log.last = 0;
  ui.logLines.replaceChildren();
  ui.logTitle.textContent = tx("jobs.logFor", { job: jobId });
  ui.jobsDetails.open = true;
  connectLog();
  if (scroll) ui.logBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Opens the stream after the last line seen; a closed stream (for example during a restart) is reopened. */
function connectLog() {
  const id = log.jobId;
  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events?after=${log.last}`);
  log.source = source;
  source.addEventListener("open", () => {
    ui.logState.textContent = "";
  });
  source.addEventListener("log", (event) => {
    const line = JSON.parse(event.data);
    if (line.seq <= log.last) return;
    log.last = line.seq;
    const pre = ui.logLines;
    const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    const time = new Date(line.at).toLocaleTimeString(lang === "ko" ? "ko-KR" : "en-US");
    pre.appendChild(h("div", { class: `log-${line.level}` }, `${time} [${line.source}] ${line.message}`));
    if (stick) pre.scrollTop = pre.scrollHeight;
  });
  source.addEventListener("job", (event) => {
    const job = JSON.parse(event.data);
    ui.logTitle.textContent = `${tx("jobs.logFor", { job: job.key || job.input })} · ${lb("jobKind", job.kind)} · ${lb("jobState", job.state)}`;
  });
  source.addEventListener("error", () => {
    if (source.readyState !== EventSource.CLOSED || log.source !== source || log.jobId !== id) return;
    ui.logState.textContent = tx("jobs.logReconnecting");
    log.timer = setTimeout(() => {
      if (log.jobId === id) connectLog();
    }, 3000);
  });
}

// ------------------------------------------------------------------ components built once per language

let ui = {};

function passphraseForm() {
  const state = h("p", { class: "muted" });
  const input = h("input", {
    type: "password",
    id: "pp-input",
    // A secret the page only sets: no browser offer to save or fill it ("off" alone is ignored on password fields).
    autocomplete: "one-time-code",
    spellcheck: "false",
    autocapitalize: "off",
    maxlength: "1000",
  });
  const toggle = h("button", { type: "button", class: "secondary" }, tx("common.show"));
  toggle.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    toggle.textContent = hidden ? tx("common.hide") : tx("common.show");
  });
  const created = h("p", { class: "callout", hidden: true }, tx("pp.created"));
  const copy = copyButton(() => input.value);
  const create = button(
    tx("pp.create"),
    () => {
      input.value = generatePassphrase((buffer) => crypto.getRandomValues(buffer));
      input.type = "text";
      toggle.textContent = tx("common.hide");
      created.hidden = false;
      markDirty();
    },
    "secondary",
  );
  const fieldError = h("p", { class: "field-error", hidden: true });
  const disconnect = h("input", { type: "checkbox", id: "pp-disconnect" });
  const disconnectRow = h(
    "div",
    { class: "check-row" },
    disconnect,
    h("label", { for: "pp-disconnect" }, tx("pp.disconnect")),
  );
  const disconnectNote = h("p", { class: "muted small" }, tx("pp.disconnectNote"));
  const forgot = h("p", { class: "muted small" }, tx("pp.forgot"));
  const msg = h("div", { hidden: true });
  const fields = h(
    "div",
    { class: "stack" },
    h("label", { for: "pp-input" }, tx("pp.field")),
    h("div", { class: "input-row" }, input, toggle),
    fieldError,
    h("div", { class: "row" }, create, copy),
    created,
    disconnectRow,
    disconnectNote,
    forgot,
  );
  const save = button(
    tx("pp.save"),
    async () => {
      formMessage(msg, null);
      showFieldErrors({ passphrase: fieldError }, {});
      if (input.value === "") return formMessage(msg, "error", tx("pp.empty"));
      const body = { passphrase: input.value };
      if (!disconnectRow.hidden && disconnect.checked) body.disconnectApps = true;
      await saveSettings(body, {
        msg,
        fieldEls: { passphrase: fieldError },
        onAccepted: () => {
          input.value = "";
          input.type = "password";
          toggle.textContent = tx("common.show");
          created.hidden = true;
          disconnect.checked = false;
          markDirty();
        },
      });
    },
    "secondary",
  );
  // The Save button stands out once there is something to save.
  function markDirty() {
    save.className = input.value === "" ? "secondary" : "primary";
  }
  input.addEventListener("input", markDirty);
  // A form, so the browser treats the password field as part of one (no submit by Enter: Save does it).
  const form = h(
    "form",
    { autocomplete: "off", onsubmit: (event) => event.preventDefault() },
    fields,
    h("div", { class: "row" }, save),
  );
  const root = h("div", { class: "component" }, state, form, msg);
  return {
    root,
    focus() {
      if (!fields.hidden) input.focus();
    },
    update(settings) {
      const pass = settings?.passphrase;
      if (!pass) {
        state.textContent = "";
        return;
      }
      state.textContent = pass.locked
        ? tx("pp.locked")
        : !pass.set
          ? tx("pp.notSet")
          : !pass.valid
            ? tx("pp.invalid")
            : tx("pp.isSet");
      fields.hidden = pass.locked;
      save.hidden = pass.locked;
      disconnectRow.hidden = !pass.set;
      disconnectNote.hidden = !pass.set;
      forgot.hidden = !pass.set;
    },
  };
}

/** PUT settings: 202 → wait for the restart; 200 → nothing changed; errors next to the form. */
async function saveSettings(body, ctx) {
  try {
    const res = await send("/settings", "PUT", body);
    ctx.onAccepted?.();
    if (res.status === 200 || res.body.restarting !== true) {
      formMessage(ctx.msg, "info", tx("save.noChange"));
      return;
    }
    const apps = res.body.appsDisconnected;
    const extra =
      apps === true ? tx("save.appsDisconnected") : apps === false ? tx("save.appsNotDisconnected") : "";
    formMessage(ctx.msg, apps === false ? "error" : "ok", `${tx("save.restarting")} ${extra}`.trim());
    await waitForRestart();
  } catch (error) {
    if (error instanceof ApiError) showFieldErrors(ctx.fieldEls ?? {}, error.fields);
    formMessage(ctx.msg, "error", errorText(error), errorDetails(error));
  }
}

/** A Save button that stands out only while its setting has an unsaved change. */
function markSave(save, dirty) {
  save.className = dirty ? "primary" : "secondary";
}

function runtimeForm() {
  const select = h("select", { id: "rt-select" });
  let dirty = false;
  select.addEventListener("change", () => {
    dirty = true;
    markSave(save, true);
  });
  const note = h("p", { class: "muted small", hidden: true }, tx("rt.onlyClaude"));
  const msg = h("div", { hidden: true });
  const save = button(
    tx("common.save"),
    () =>
      saveSettings(
        { helperRuntime: select.value },
        {
          msg,
          onAccepted: () => {
            dirty = false;
            markSave(save, false);
          },
        },
      ),
    "secondary",
  );
  const root = h(
    "div",
    { class: "component" },
    h("p", { class: "muted" }, tx("rt.explain")),
    h("label", { for: "rt-select", class: "visually-hidden" }, tx("rt.title")),
    h("div", { class: "input-row" }, select, save),
    note,
    msg,
  );
  return {
    root,
    update(settings) {
      const rt = settings?.helperRuntime;
      if (!rt) return;
      const options = ["auto", ...(rt.supported ?? [])];
      // A stored value the page does not offer (for example a runtime this Mac no longer supports)
      // is shown as received rather than leaving the list blank.
      if (rt.value && !options.includes(rt.value)) options.push(rt.value);
      const sig = options.join(",");
      if (select.dataset.sig !== sig) {
        select.dataset.sig = sig;
        select.replaceChildren(...options.map((value) => h("option", { value }, lb("helperRuntime", value))));
        dirty = false;
        markSave(save, false);
      }
      if (!dirty && rt.value) select.value = rt.value;
      note.hidden = !(rt.supported?.length === 1 && rt.supported[0] === "claude");
    },
  };
}

function accountForm() {
  const input = h("input", {
    id: "acct-input",
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: "200",
  });
  let dirty = false;
  input.addEventListener("input", () => {
    dirty = true;
    markSave(save, true);
  });
  const fieldError = h("p", { class: "field-error", hidden: true });
  const locked = h("p", { class: "muted small", hidden: true }, tx("acct.locked"));
  const msg = h("div", { hidden: true });
  const save = button(
    tx("common.save"),
    () =>
      saveSettings(
        { asideAccount: input.value.trim() },
        {
          msg,
          fieldEls: { asideAccount: fieldError },
          onAccepted: () => {
            dirty = false;
            markSave(save, false);
          },
        },
      ),
    "secondary",
  );
  const root = h(
    "div",
    { class: "component" },
    h("p", { class: "muted" }, tx("acct.explain")),
    h("label", { for: "acct-input", class: "visually-hidden" }, tx("acct.title")),
    h("div", { class: "input-row" }, input, save),
    fieldError,
    locked,
    msg,
  );
  return {
    root,
    update(settings) {
      const acct = settings?.asideAccount;
      if (!acct) return;
      if (!dirty && document.activeElement !== input) input.value = acct.value ?? "";
      input.disabled = acct.locked === true;
      save.hidden = acct.locked === true;
      locked.hidden = acct.locked !== true;
    },
  };
}

/** Settings → "Solve captchas automatically" (`captchaAuto`), saved with a restart like the others. */
function captchaForm() {
  const box = h("input", { type: "checkbox", id: "cap-auto", role: "switch" });
  let dirty = false;
  box.addEventListener("change", () => {
    dirty = true;
    markSave(save, true);
  });
  const unknown = h("p", { class: "muted small", hidden: true }, tx("cap.unknown"));
  const fieldError = h("p", { class: "field-error", hidden: true });
  const msg = h("div", { hidden: true });
  const save = button(
    tx("common.save"),
    () =>
      saveSettings(
        { captchaAuto: box.checked },
        {
          msg,
          fieldEls: { captchaAuto: fieldError },
          onAccepted: () => {
            dirty = false;
            markSave(save, false);
          },
        },
      ),
    "secondary",
  );
  const root = h(
    "div",
    { class: "component" },
    h("p", { class: "muted" }, tx("cap.explain")),
    h("div", { class: "check-row switch-row" }, box, h("label", { for: "cap-auto" }, tx("cap.switch")), save),
    h("p", { class: "note small" }, tx("cap.note")),
    unknown,
    fieldError,
    msg,
  );
  return {
    root,
    update(settings) {
      // An older program without the setting: the switch stays hidden.
      root.hidden = !settings || !Object.prototype.hasOwnProperty.call(settings, "captchaAuto");
      if (root.hidden) return;
      const value = settings.captchaAuto;
      if (!dirty) {
        box.checked = value === true;
        box.indeterminate = value !== true && value !== false;
      }
      unknown.hidden = value === true || value === false;
    },
  };
}

function addSiteForm() {
  const input = h("input", {
    id: "add-input",
    type: "text",
    required: true,
    maxlength: "500",
    placeholder: tx("sites.inputPlaceholder"),
    autocomplete: "off",
    spellcheck: "false",
  });
  const note = h("input", {
    id: "add-note",
    type: "text",
    maxlength: "2000",
    placeholder: tx("sites.notePlaceholder"),
  });
  const msg = h("div", { hidden: true });
  const submit = h("button", { type: "submit", class: "primary" }, tx("sites.add"));
  const form = h(
    "form",
    { class: "stack", autocomplete: "off" },
    h("p", {}, tx("sites.addExplain")),
    h("label", { for: "add-input" }, tx("sites.input")),
    h("div", { class: "input-row" }, input, submit),
    disclosure("add-note", tx("sites.noteToggle"), h("label", { for: "add-note" }, tx("sites.note")), note),
    msg,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (value === "") return;
    submit.disabled = true;
    formMessage(msg, null);
    try {
      const { body } = await api("/sites", {
        method: "POST",
        body: { input: value, note: note.value.trim(), lang },
      });
      input.value = "";
      note.value = "";
      formMessage(msg, "ok", tx("sites.added"));
      if (body.job?.id) openLog(body.job.id);
    } catch (error) {
      formMessage(msg, "error", errorText(error), errorDetails(error));
    } finally {
      submit.disabled = false;
    }
    await refresh();
  });
  return {
    root: h("div", { class: "component" }, h("h3", {}, tx("sites.addTitle")), form),
    update() {
      submit.disabled = !coreRunning();
    },
  };
}

/** The helper's state: the last check (automatic or the Check button) first, then what it would use. */
function helperBox() {
  const body = h("div", { class: "stack" });
  const msg = h("div", { hidden: true });
  let checking = false;
  const check = async () => {
    if (checking || !coreRunning()) return;
    checking = true;
    render();
    formMessage(msg, "info", tx("step4.checking"));
    try {
      await api("/helper/check", { method: "POST" });
      formMessage(msg, null);
    } catch (error) {
      formMessage(msg, "error", errorText(error), errorDetails(error));
    } finally {
      checking = false;
    }
    await loadHelper();
    render();
  };
  const checkButton = button(tx("step4.check"), check, "secondary");
  const root = h("div", { class: "component" }, body, h("div", { class: "row" }, checkButton), msg);
  return {
    root,
    check,
    update(helper) {
      checkButton.hidden = !coreRunning();
      checkButton.disabled = checking || !coreRunning();
      renderIf(body, [helper, coreRunning()], () => {
        if (!coreRunning() || !helper) return [h("p", { class: "muted" }, tx("helper.off"))];
        const names = { claude: "Claude Code", codex: "Codex" };
        const rows = Object.entries(names).map(([id, name]) => {
          const probe = helper.runtimes?.[id];
          let key = "helper.runtime.notShipped";
          if (probe) {
            if (!probe.installed) key = "helper.runtime.missing";
            else if (probe.signedIn === true) key = "helper.runtime.ready";
            else if (probe.signedIn === false) key = "helper.runtime.notSignedIn";
            else key = "helper.runtime.unknownSignIn";
          }
          return h("li", {}, tx(key, { name }));
        });
        const last = helper.lastCheck;
        const ready = helperReady(helper);
        // An `ok` on another runtime than the one a job would use now does not count.
        const otherRuntime = last?.ok === true && !ready && Boolean(helper.wouldUse);
        const lastLine = last
          ? h(
              "p",
              { class: "status-row" },
              ready
                ? badge("done", tx("helper.works"))
                : otherRuntime
                  ? badge("todo", tx("helper.recheck"))
                  : badge("bad", tx("helper.notWorking")),
              " ",
              tx("helper.lastCheck", { time: when(last.at), result: lb("helperCheckCode", last.code) }),
            )
          : h("p", { class: "muted" }, tx("helper.noCheck"));
        return [
          lastLine,
          otherRuntime
            ? h(
                "p",
                { class: "warn" },
                tx("helper.otherRuntime", {
                  checked: lb("helperRuntime", last.runtime),
                  runtime: lb("helperRuntime", helper.wouldUse),
                }),
              )
            : null,
          helper.wouldUse
            ? h("p", {}, tx("helper.wouldUse", { runtime: lb("helperRuntime", helper.wouldUse) }))
            : h("p", { class: "warn" }, tx("helper.noneAvailable")),
          helper.wouldUse === "claude" ? h("p", { class: "muted small" }, tx("helper.dataClaude")) : null,
          helper.wouldUse === "codex" ? h("p", { class: "muted small" }, tx("helper.dataCodex")) : null,
          moreBox("helper-runtimes", h("ul", { class: "plain-list" }, rows)),
          last
            ? detailList("helper-check", [
                [tx("site.d.runtime"), lb("helperRuntime", last.runtime)],
                [tx("conn.details.message"), last.message],
              ])
            : null,
        ];
      });
    },
  };
}

function substep(id, title, who) {
  const mark = h("span", { class: "mark" });
  const body = h("div", { class: "substep-body" });
  const li = h(
    "li",
    { class: "substep" },
    h(
      "div",
      { class: "substep-head" },
      h("span", { class: "letter" }, id),
      h("strong", {}, title),
      h("span", { class: "who" }, who),
      mark,
    ),
    body,
  );
  return { li, body, mark };
}

function asideHelper(id, getText) {
  const pre = h("pre", { class: "instruction" });
  const box = disclosure(
    id,
    tx("aside.title"),
    h("p", { class: "muted small" }, tx("aside.explain")),
    more(id, "aside.more"),
    pre,
    copyButton(() => pre.textContent, tx("aside.copy")),
  );
  box.classList.add("aside-helper");
  return {
    root: box,
    update() {
      const text = getText();
      if (pre.textContent !== text) pre.textContent = text;
    },
  };
}

/** The Aside AI login text for one site (a `needs_login` card or a job paused for a login), or null. */
function loginHelper(id, target) {
  const text = loginText(lang, target);
  if (text === null) return null;
  const box = disclosure(
    id,
    tx("login.title"),
    h("p", { class: "muted small" }, tx("login.explain")),
    h("pre", { class: "instruction" }, text),
    copyButton(text, tx("aside.copy")),
  );
  box.classList.add("aside-helper");
  return box;
}

/** Where the login text sends the Aside AI for a site: its login address, else its first hostname. */
function siteLoginTarget(site) {
  const hostnames =
    Array.isArray(site.hostnames) && site.hostnames.length > 0 ? site.hostnames : site.job?.hostnames;
  return loginTarget({ loginUrl: site.loginUrl, hostnames, input: site.job?.input });
}

/** The same for a job, through its site when the site is registered. */
function jobLoginTarget(job) {
  const site = Array.isArray(data.sites) ? data.sites.find((s) => s.key === job.key) : undefined;
  if (site) return siteLoginTarget({ ...site, job });
  return loginTarget({ loginUrl: null, hostnames: job.hostnames, input: job.input });
}

/** "Copy passphrase" in ChatGPT step f: the program puts the passphrase on this Mac's clipboard. */
function copyPassphraseBox() {
  const msg = h("div", { hidden: true });
  const copy = button(
    tx("sub.f.copy"),
    async () => {
      formMessage(msg, null);
      try {
        await api("/settings/passphrase/clipboard", { method: "POST" });
        formMessage(msg, "ok", tx("sub.f.copied"));
      } catch (error) {
        // Only the code's own wording (the `locked` field text would repeat it).
        const text = error instanceof ApiError ? lb("errorCode", error.code) : errorText(error);
        formMessage(msg, "error", text, errorDetails(error));
      }
    },
    "secondary",
  );
  const root = h(
    "div",
    { class: "stack" },
    h("div", { class: "row" }, copy),
    h("p", { class: "muted small" }, tx("sub.f.copyNote")),
    msg,
  );
  return {
    root,
    update(current) {
      copy.className = current ? "primary" : "secondary";
    },
  };
}

/** Badge colour of a ChatGPT connection state. */
function chatgptTone(state) {
  if (state === "ready") return "done";
  if (state === "failed") return "bad";
  if (state === "not_configured") return "todo";
  return "unknown";
}

function chatgptGuide() {
  const head = h("div", { class: "stack" });
  const steps = {
    a: substep("a", tx("sub.a.title"), tx("conn.who.page")),
    b: substep("b", tx("sub.b.title"), tx("conn.who.youOrAside")),
    c: substep("c", tx("sub.c.title"), tx("conn.who.you")),
    d: substep("d", tx("sub.d.title"), tx("conn.who.page")),
    e: substep("e", tx("sub.e.title"), tx("conn.who.youOrAside")),
    f: substep("f", tx("sub.f.title"), tx("conn.who.you")),
    g: substep("g", tx("sub.g.title"), tx("conn.who.page")),
  };
  const aDyn = h("div", { class: "stack" });
  steps.a.body.appendChild(aDyn);

  const asideB = asideHelper("aside-tunnel", () => asideText(lang, "tunnel"));
  append(steps.b.body, [
    h(
      "ol",
      { class: "how" },
      h("li", {}, tx("sub.b.s1"), " ", link(LINKS.tunnels)),
      h("li", {}, tx("sub.b.s2")),
      h("li", {}, tx("sub.b.s3")),
      h("li", {}, tx("sub.b.s4"), " ", link(LINKS.apiKeys)),
    ),
    h("p", { class: "muted small" }, tx("conn.labelsDiffer")),
    asideB.root,
  ]);

  // Step c: the setup form (tunnel id, runtime key, Advanced profile name).
  const tunnelInput = h("input", {
    id: "c-tunnel",
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "tunnel_…",
    maxlength: "100",
  });
  const keyInput = h("input", {
    id: "c-key",
    type: "password",
    autocomplete: "one-time-code",
    spellcheck: "false",
    maxlength: "4000",
  });
  const keyToggle = h("button", { type: "button", class: "secondary" }, tx("common.show"));
  keyToggle.addEventListener("click", () => {
    const hidden = keyInput.type === "password";
    keyInput.type = hidden ? "text" : "password";
    keyToggle.textContent = hidden ? tx("common.hide") : tx("common.show");
  });
  const profileInput = h("input", {
    id: "c-profile",
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    value: "browser-research-bridge",
    maxlength: "64",
  });
  const errs = {
    tunnelId: h("p", { class: "field-error", hidden: true }),
    runtimeKey: h("p", { class: "field-error", hidden: true }),
    profile: h("p", { class: "field-error", hidden: true }),
  };
  const cMsg = h("div", { hidden: true });
  const submit = h("button", { type: "submit", class: "primary" }, tx("sub.c.submit"));
  const form = h(
    "form",
    { class: "stack", autocomplete: "off" },
    h("label", { for: "c-tunnel" }, tx("sub.c.tunnelId")),
    tunnelInput,
    errs.tunnelId,
    h("label", { for: "c-key" }, tx("sub.c.runtimeKey")),
    h("div", { class: "input-row" }, keyInput, keyToggle),
    errs.runtimeKey,
    disclosure(
      "c-advanced",
      tx("sub.c.advanced"),
      h("label", { for: "c-profile" }, tx("sub.c.profile")),
      profileInput,
      h("p", { class: "muted small" }, tx("sub.c.profileHelp")),
      errs.profile,
    ),
    h("div", { class: "row" }, submit),
    cMsg,
  );
  const runSetup = async (replace, confirmInterrupt) => {
    const body = {
      tunnelId: tunnelInput.value.trim(),
      runtimeKey: keyInput.value,
      profile: profileInput.value.trim() || undefined,
    };
    if (replace) body.replace = true;
    if (confirmInterrupt) body.confirmInterrupt = true;
    try {
      await api("/chatgpt/setup", { method: "POST", body });
      keyInput.value = "";
      keyInput.type = "password";
      keyToggle.textContent = tx("common.show");
      formMessage(cMsg, "ok", tx("sub.c.sent"));
      await waitForRestart();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "exists" && !replace && window.confirm(tx("sub.c.replace")))
        return runSetup(true, confirmInterrupt);
      if (error.code === "job_running" && !confirmInterrupt && window.confirm(tx("confirm.interrupt"))) {
        return runSetup(replace, true);
      }
      showFieldErrors(errs, error.fields);
      if (error.fields?.tunnelId === "bad_format") errs.tunnelId.textContent = tx("sub.c.tunnelFormat");
      formMessage(cMsg, "error", errorText(error), errorDetails(error));
    }
    return undefined;
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    showFieldErrors(errs, {});
    formMessage(cMsg, null);
    try {
      await runSetup(false, false);
    } catch (error) {
      formMessage(cMsg, "error", errorText(error));
    } finally {
      submit.disabled = false;
    }
  });
  append(steps.c.body, [
    h("p", {}, tx("sub.c.explain")),
    more("sub-c", "sub.c.more"),
    h("ol", { class: "how" }, h("li", {}, tx("sub.c.s1")), h("li", {}, tx("sub.c.s2"))),
    form,
  ]);

  const dDyn = h("div", { class: "stack" });
  append(steps.d.body, [h("p", { class: "muted small" }, tx("sub.d.explain")), dDyn]);

  const eTunnel = h("span", {});
  const eThisMac = h("p", { class: "callout", hidden: true }, tx("conn.thisMac"));
  const asideE = asideHelper("aside-connector", () =>
    asideText(lang, "connector", { tunnelId: data.chatgpt?.tunnelId }),
  );
  append(steps.e.body, [
    h("p", { class: "muted small" }, tx("sub.e.explain")),
    eThisMac,
    h(
      "ol",
      { class: "how" },
      h("li", {}, tx("sub.e.s1"), " ", link(LINKS.connectors)),
      h("li", {}, tx("sub.e.s2")),
      h("li", {}, rich("sub.e.s3", { tunnel: eTunnel })),
    ),
    h("p", { class: "muted small" }, tx("conn.labelsDiffer")),
    asideE.root,
  ]);
  const copyPassphrase = copyPassphraseBox();
  append(steps.f.body, [h("p", {}, tx("sub.f.s1")), copyPassphrase.root]);
  const gDyn = h("div", {});
  steps.g.body.appendChild(gDyn);

  const disconnectBox = h("div", { class: "stack" });
  const root = h(
    "div",
    { class: "component" },
    h("p", { class: "muted" }, tx("conn.explain")),
    more("conn", "conn.more"),
    head,
    h(
      "ol",
      { class: "substeps" },
      Object.values(steps).map((s) => s.li),
    ),
    disconnectBox,
  );

  return {
    root,
    update(chatgpt, settings) {
      const state = chatgpt?.state ?? null;
      const subs = chatgptSubsteps(chatgpt);
      for (const s of subs) {
        const step = steps[s.id];
        step.li.className = `substep substep-${s.state}`;
        step.mark.replaceChildren(
          s.state === "done"
            ? badge("done", tx("common.done"))
            : s.state === "current"
              ? badge("todo", tx("step.todo"))
              : "",
        );
      }
      const toolMissing = chatgpt !== null && chatgpt.tool?.installed !== true && state !== "external";
      for (const id of ["b", "c", "d", "e", "f", "g"]) steps[id].li.hidden = toolMissing;
      copyPassphrase.update(subs.some((s) => s.id === "f" && s.state === "current"));

      renderIf(head, [chatgpt], () => {
        if (!chatgpt) return [h("p", { class: "muted" }, tx("step.why.no_data"))];
        return [
          h(
            "p",
            { class: "status-row" },
            h("span", { class: "muted" }, `${tx("conn.stateLabel")}: `),
            badge(chatgptTone(state), lb("chatgptState", state)),
          ),
          state === "external" ? h("p", { class: "callout" }, tx("conn.external")) : null,
          detailList("chatgpt-details", [
            [tx("conn.details.tunnel"), chatgpt.tunnelId],
            [tx("conn.details.profile"), chatgpt.profile],
            [
              tx("conn.details.keyStored"),
              chatgpt.managedBy === "bridge" ? tx(chatgpt.keyStored ? "common.yes" : "common.no") : null,
            ],
            [tx("conn.details.tool"), chatgpt.tool?.version],
            [tx("conn.details.message"), chatgpt.message],
          ]),
        ];
      });
      renderIf(aDyn, [chatgpt?.tool], () => {
        if (!chatgpt) return [];
        if (chatgpt.tool?.installed)
          return [h("p", { class: "good" }, tx("sub.a.installed", { version: chatgpt.tool.version ?? "?" }))];
        return [
          h("p", { class: "warn" }, tx("sub.a.missing")),
          h("p", { class: "muted small" }, tx("sub.a.never")),
          h("p", {}, link(LINKS.installGuide, tx("sub.a.link"))),
          h("p", {}, tx("sub.a.brew")),
          codeLine(COMMANDS.installTunnelClient),
          h(
            "div",
            { class: "row" },
            button(tx("common.checkAgain"), () => refresh(), "secondary"),
          ),
        ];
      });
      renderIf(dDyn, [state, chatgpt?.message], () => {
        if (!chatgpt || state === "not_configured") return [h("p", { class: "muted" }, tx("sub.d.waiting"))];
        return [
          h(
            "p",
            { class: "status-row" },
            h("span", { class: "muted" }, `${tx("conn.stateLabel")}: `),
            badge(chatgptTone(state), lb("chatgptState", state)),
          ),
          state === "failed"
            ? h(
                "div",
                { class: "row" },
                button(
                  tx("sub.d.retry"),
                  async () => {
                    await send("/chatgpt/retry", "POST");
                    await refresh();
                  },
                  "primary",
                ),
              )
            : null,
          chatgpt.message
            ? disclosure("d-message", tx("common.details"), h("pre", { class: "plain" }, chatgpt.message))
            : null,
        ];
      });
      eTunnel.textContent = chatgpt?.tunnelId ?? tx("sub.e.anyTunnel");
      eThisMac.hidden = settings?.info?.publicUrlConfigured === true;
      asideB.update();
      asideE.update();
      renderIf(gDyn, [chatgpt?.connectedApps], () => {
        const n = chatgpt?.connectedApps;
        if (typeof n !== "number") return [h("p", { class: "muted" }, tx("sub.g.off"))];
        return [
          n >= 1
            ? h("p", { class: "good" }, tx("sub.g.done", { count: n }))
            : h("p", { class: "muted" }, tx("sub.g.waiting")),
        ];
      });
      renderIf(disconnectBox, [chatgpt?.managedBy, state], () => {
        if (chatgpt?.managedBy !== "bridge" || state === "not_configured" || state === "external") return [];
        return [
          h("p", { class: "muted small" }, tx("conn.disconnectExplain")),
          h(
            "div",
            { class: "row" },
            button(
              tx("conn.disconnect"),
              async () => {
                if (!window.confirm(tx("confirm.disconnect"))) return;
                await send("/chatgpt", "DELETE", {});
                await waitForRestart();
              },
              "secondary danger",
            ),
          ),
        ];
      });
    },
  };
}

// ------------------------------------------------------------------ shell

function buildShell() {
  document.documentElement.lang = lang;
  document.title = tx("app.title");
  const langSelect = (id) => {
    const select = h(
      "select",
      { id, onchange: (event) => setLang(event.target.value) },
      h("option", { value: "ko" }, "한국어"),
      h("option", { value: "en" }, "English"),
    );
    select.value = lang;
    return select;
  };

  ui = {
    passphrase: passphraseForm(),
    runtime: runtimeForm(),
    captcha: captchaForm(),
    account: accountForm(),
    addSite: addSiteForm(),
    helper: helperBox(),
    guide: chatgptGuide(),
    statusLine: h("div", { class: "status-line", role: "status" }),
    banner: h("div", { class: "banner", hidden: true }),
    nextBox: h("div", { class: "next", "aria-live": "polite" }),
    steps: {},
    sitesList: h("div", { class: "cards" }),
    jobsList: h("div", { class: "jobs" }),
    logTitle: h("strong", {}, tx("jobs.logNone")),
    logState: h("span", { class: "muted small" }),
    logLines: h("pre", { class: "log" }),
    appsList: h("div", { class: "cards" }),
    addressBox: h("div", { class: "stack" }),
    cacheBox: h("div", { class: "stack" }),
    infoBox: h("div", {}),
    slots: {},
  };
  ui.logBox = h(
    "div",
    { class: "log-box" },
    h("div", { class: "row" }, ui.logTitle, ui.logState),
    ui.logLines,
  );
  ui.jobsDetails = disclosure(
    "jobs",
    tx("jobs.title"),
    h("p", { class: "muted small" }, tx("jobs.explain")),
    ui.jobsList,
    ui.logBox,
  );

  // Getting started: five steps, each a disclosure with a live state; the first one not done is open.
  // Each shows a short explanation, the longer background behind "More", then its live part.
  const stepDefs = [
    ["passphrase", tx("step1.title"), tx("step1.explain"), more("step1", "step1.more")],
    ["aside", tx("step2.title"), tx("step2.explain"), null],
    ["chatgpt", tx("step3.title"), tx("step3.explain"), null],
    ["helper", tx("step4.title"), tx("step4.explain"), more("step4", "step4.more")],
    ["sites", tx("step5.title"), tx("step5.explain"), null],
  ];
  const stepNodes = stepDefs.map(([id, title, explain, background], index) => {
    const state = h("span", { class: "step-state" });
    const dyn = h("div", { class: "stack" });
    const slot = h("div", { class: "slot" });
    const node = h(
      "details",
      { class: "step", id: `step-${id}` },
      h(
        "summary",
        {},
        h("span", { class: "step-num" }, String(index + 1)),
        h("span", { class: "step-title" }, title),
        state,
      ),
      h("div", { class: "step-body" }, h("p", {}, explain), background, dyn, slot),
    );
    ui.steps[id] = { node, state, dyn, slot };
    return node;
  });

  const tabButton = (id) => h("a", { href: `#${id}`, class: "tab", "data-tab": id }, tx(`nav.${id}`));

  ui.slots = {
    settingsPassphrase: h("div", { class: "slot" }),
    connectionGuide: h("div", { class: "slot" }),
    sitesAdd: h("div", { class: "slot" }),
    settingsHelper: h("div", { class: "slot" }),
  };

  const restartBox = h(
    "div",
    { class: "component" },
    h("p", { class: "muted" }, tx("restart.explain")),
    h(
      "div",
      { class: "row" },
      button(
        tx("restart.button"),
        async () => {
          await send("/restart", "POST", {});
          await waitForRestart();
        },
        "secondary",
      ),
    ),
  );

  const sections = {
    // The home: what to do next comes first, then the five steps.
    start: h(
      "section",
      { id: "area-start", class: "area" },
      ui.nextBox,
      h("p", { class: "muted" }, tx("start.intro")),
      h("div", { class: "steps" }, stepNodes),
    ),
    sites: h(
      "section",
      { id: "area-sites", class: "area" },
      h("h2", {}, tx("sites.title")),
      h("p", { class: "muted" }, tx("sites.explain")),
      ui.slots.sitesAdd,
      h("h3", {}, tx("sites.listTitle")),
      ui.sitesList,
      ui.jobsDetails,
    ),
    connection: h(
      "section",
      { id: "area-connection", class: "area" },
      h("h2", {}, tx("conn.title")),
      h("p", { class: "muted" }, tx("conn.intro")),
      ui.slots.connectionGuide,
      h("h3", {}, tx("apps.title")),
      h("p", { class: "muted small" }, tx("apps.explain")),
      ui.appsList,
      disclosure("address", tx("conn.address"), ui.addressBox),
    ),
    settings: h(
      "section",
      { id: "area-settings", class: "area" },
      h("h2", {}, tx("set.title")),
      h("p", { class: "muted" }, tx("set.intro")),
      h("h3", {}, tx("pp.title")),
      ui.slots.settingsPassphrase,
      h("h3", {}, tx("rt.title")),
      ui.runtime.root,
      ui.slots.settingsHelper,
      h("h3", {}, tx("cap.title")),
      ui.captcha.root,
      h("h3", {}, tx("lang.title")),
      h(
        "div",
        { class: "component" },
        h("p", { class: "muted" }, tx("lang.explain")),
        h("label", { for: "lang-settings", class: "visually-hidden" }, tx("lang.title")),
        langSelect("lang-settings"),
      ),
      disclosure(
        "advanced",
        tx("adv.title"),
        h("h3", {}, tx("acct.title")),
        ui.account.root,
        h("h3", {}, tx("cache.title")),
        h("p", { class: "muted small" }, tx("cache.explain")),
        ui.cacheBox,
        h("h3", {}, tx("info.title")),
        ui.infoBox,
        h("h3", {}, tx("restart.title")),
        restartBox,
      ),
    ),
  };
  ui.sections = sections;
  ui.tabs = TABS.map(tabButton);

  const app = $("app");
  app.replaceChildren(
    h(
      "header",
      { class: "top" },
      h(
        "div",
        { class: "title-row" },
        h("h1", {}, tx("app.heading")),
        h(
          "label",
          { class: "lang-switch" },
          h("span", { class: "muted small" }, tx("lang.label")),
          langSelect("lang-top"),
        ),
      ),
      h("p", { class: "muted intro" }, tx("app.intro")),
      more("app", "app.more"),
      ui.statusLine,
      ui.banner,
      h("div", { id: "notice", class: "notice", hidden: true }),
      h("nav", { class: "tabs" }, ui.tabs),
    ),
    h("main", {}, Object.values(sections)),
  );
  if (log.jobId) openLog(log.jobId, false);
}

function setLang(next) {
  if (next !== "ko" && next !== "en") return;
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // Remembering the language is a convenience; without storage the page still works.
  }
  lastFirstOpen = undefined;
  buildShell();
  showTab(currentTab());
  render();
}

// ------------------------------------------------------------------ tabs

let chosenTab = null;

function currentTab() {
  const fromHash = window.location.hash.replace(/^#/, "");
  if (TABS.includes(fromHash)) return fromHash;
  return chosenTab ?? "start";
}

/** The shared forms live in one place at a time: inside Getting started, or in their own area. */
function placeMovables(tab) {
  const s = ui.steps;
  if (tab === "start") {
    s.passphrase.slot.appendChild(ui.passphrase.root);
    s.chatgpt.slot.appendChild(ui.guide.root);
    s.helper.slot.appendChild(ui.helper.root);
    s.sites.slot.appendChild(ui.addSite.root);
  } else {
    ui.slots.settingsPassphrase.appendChild(ui.passphrase.root);
    ui.slots.connectionGuide.appendChild(ui.guide.root);
    ui.slots.settingsHelper.appendChild(ui.helper.root);
    ui.slots.sitesAdd.appendChild(ui.addSite.root);
  }
}

function showTab(tab) {
  for (const [id, section] of Object.entries(ui.sections)) section.hidden = id !== tab;
  for (const a of ui.tabs) a.classList.toggle("active", a.dataset.tab === tab);
  placeMovables(tab);
}

window.addEventListener("hashchange", () => {
  chosenTab = currentTab();
  showTab(chosenTab);
});

// ------------------------------------------------------------------ rendering

let lastFirstOpen;

function render() {
  renderStatusLine();
  renderBanner();
  renderStart();
  renderSites();
  renderConnection();
  renderSettings();
}

function renderStatusLine() {
  const mode = data.status?.mode;
  let aside;
  if (!coreRunning()) aside = badge("unknown", tx("status.unknown"));
  else if (browserLoading && !data.browser) aside = badge("unknown", tx("common.working"));
  else if (data.browser?.reachable) aside = badge("done", tx("status.asideReady"));
  else if (data.browser) aside = badge("todo", tx("status.asideNotReady"));
  else aside = badge("unknown", tx("status.unknown"));
  const apps = data.chatgpt?.connectedApps;
  const chatgpt =
    typeof apps === "number" && apps >= 1
      ? badge("done", tx("status.connected"))
      : data.chatgpt
        ? badge(
            data.chatgpt.state === "failed" ? "todo" : "unknown",
            data.chatgpt.state === "not_configured"
              ? tx("status.notConnected")
              : `${lb("chatgptState", data.chatgpt.state)} · ${tx("status.notConnected")}`,
          )
        : badge("unknown", tx("status.unknown"));
  renderIf(
    ui.statusLine,
    [mode, aside.textContent, aside.className, chatgpt.textContent, chatgpt.className],
    () => [
      h(
        "span",
        { class: "status-item" },
        h("span", { class: "muted" }, `${tx("status.program")}: `),
        badge(
          mode === "running" ? "done" : mode === "restarting" ? "unknown" : "todo",
          mode ? lb("runMode", mode) : tx("status.unknown"),
        ),
      ),
      h("span", { class: "status-item" }, h("span", { class: "muted" }, `${tx("status.aside")}: `), aside),
      h(
        "span",
        { class: "status-item" },
        h("span", { class: "muted" }, `${tx("status.chatgpt")}: `),
        chatgpt,
      ),
    ],
  );
}

function renderBanner() {
  if (!ui.banner) return;
  const status = data.status;
  let content = null;
  let kind = "info";
  if (signedOut) {
    kind = "error";
    content = [h("p", {}, tx("banner.signedOut"))];
  } else if (restartNotice || status?.mode === "restarting") {
    content = [h("p", {}, tx(restartNotice === "slow" ? "banner.restartSlow" : "banner.restarting"))];
  } else if (status?.mode === "setup") {
    kind = "warn";
    const code = status.problem?.code;
    const passphrase = code === "passphrase_missing" || code === "passphrase_too_short";
    content = [
      h(
        "p",
        {},
        h("strong", {}, lb("problemCode", code)),
        " ",
        tx(
          passphrase
            ? "banner.setupPassphrase"
            : code === "config_invalid"
              ? "banner.setupConfig"
              : "banner.setupStart",
        ),
      ),
      passphrase
        ? h("p", {}, h("a", { href: "#start" }, tx("error.pointer.passphrase")))
        : h(
            "div",
            { class: "row" },
            button(
              tx("restart.button"),
              async () => {
                await send("/restart", "POST", {});
                await waitForRestart();
              },
              "primary",
            ),
          ),
      status.problem?.message
        ? disclosure(
            "banner-problem",
            tx("common.details"),
            h("pre", { class: "plain" }, status.problem.message),
          )
        : null,
    ];
  }
  ui.banner.hidden = content === null;
  ui.banner.className = `banner banner-${kind}`;
  renderIf(ui.banner, [signedOut, restartNotice, status], () => content ?? []);
}

function stepWhy(step) {
  return step.why ? h("p", { class: "muted" }, tx(`step.why.${step.why}`)) : null;
}

/** Opens a Getting started step and brings `selector` inside it (or the step) into view. */
function goToStep(id, selector) {
  const view = ui.steps[id];
  if (!view) return;
  view.node.open = true;
  const target = (selector && view.node.querySelector(selector)) || view.node;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

const reutersSite = () =>
  Array.isArray(data.sites) ? data.sites.find((s) => s.key === "reuters") : undefined;

/** The one action of the "what to do next" line, as the page's prominent button. */
function nextAction(next) {
  switch (next.action) {
    case "passphrase":
      return button(
        tx("next.passphraseAction"),
        () => {
          goToStep("passphrase", "form");
          ui.passphrase.focus();
        },
        "primary",
      );
    case "checkBrowser":
      return button(
        tx("common.checkAgain"),
        () => {
          goToStep("aside");
          return loadBrowser();
        },
        "primary",
      );
    case "showChatgpt":
      return button(tx("next.chatgptAction"), () => goToStep("chatgpt", ".substep-current"), "primary");
    case "checkHelper":
      return button(
        tx("next.helperAction"),
        () => {
          goToStep("helper");
          return ui.helper.check();
        },
        "primary",
      );
    case "checkReuters":
      return button(
        tx("next.sitesAction"),
        () => {
          const reuters = reutersSite();
          return reuters ? checkNow(reuters) : undefined;
        },
        "primary",
      );
    case "openSites":
      return button(
        tx("next.openSites"),
        () => {
          window.location.hash = "#sites";
        },
        "primary",
      );
    case "reload":
      return button(tx("common.checkAgain"), () => loadAll(), "primary");
    default:
      return null;
  }
}

function renderNext(steps) {
  const next = nextStep(steps, data);
  const part = chatgptSubsteps(data.chatgpt).find((s) => s.state === "current")?.id ?? "";
  renderIf(ui.nextBox, [loadedOnce, next, part], () => {
    if (!loadedOnce) return [h("p", { class: "muted" }, tx("app.loading"))];
    if (next.id === null) return [h("p", { class: "next-text good" }, tx("start.allDone"))];
    return [
      h(
        "p",
        { class: "next-text" },
        h("strong", { class: "next-label" }, `${tx("next.label")}: `),
        tx(next.say, { part }),
      ),
      nextAction(next),
    ];
  });
  ui.nextBox.classList.toggle("is-done", loadedOnce && next.id === null);
}

function renderStart() {
  const steps = gettingStarted(data);
  const first = firstOpenStep(steps);
  if (loadedOnce && first !== lastFirstOpen) {
    lastFirstOpen = first;
    for (const s of steps) ui.steps[s.id].node.open = s.id === first;
  }
  renderNext(steps);
  for (const step of steps) {
    const view = ui.steps[step.id];
    view.state.replaceChildren(badge(step.state, tx(`step.${step.state}`)));
    view.node.classList.toggle("is-done", step.state === "done");
    view.slot.hidden = step.why === "need_passphrase" && step.id !== "passphrase";
  }
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));

  renderIf(ui.steps.passphrase.dyn, [byId.passphrase], () => [
    byId.passphrase.state === "done" ? h("p", { class: "good" }, tx("step1.done")) : stepWhy(byId.passphrase),
  ]);

  const aside = byId.aside;
  renderIf(ui.steps.aside.dyn, [aside, data.browser, browserLoading], () => {
    if (aside.why && aside.why !== "no_data") return [stepWhy(aside)];
    const again = h(
      "div",
      { class: "row" },
      button(tx("common.checkAgain"), () => loadBrowser(), "secondary"),
    );
    if (browserLoading && !data.browser) return [h("p", { class: "muted" }, tx("common.working"))];
    if (!data.browser) return [stepWhy(aside), again];
    if (data.browser.reachable)
      return [h("p", { class: "good" }, tx("step2.ok", { account: data.browser.account })), again];
    return [
      h("p", { class: "warn" }, tx("step2.notOk")),
      h(
        "ol",
        { class: "how" },
        h("li", {}, tx("step2.howto1")),
        h("li", {}, tx("step2.howto2"), codeLine(COMMANDS.asideLogin)),
        h("li", {}, tx("step2.howto3")),
      ),
      again,
      detailList("aside-details", [
        [tx("conn.details.message"), data.browser.message],
        [tx("acct.title"), data.browser.account],
        [tx("step2.d.action"), data.browser.action],
      ]),
    ];
  });

  renderIf(ui.steps.chatgpt.dyn, [byId.chatgpt], () => [
    byId.chatgpt.state === "done" ? h("p", { class: "good" }, tx("step3.done")) : stepWhy(byId.chatgpt),
  ]);
  renderIf(ui.steps.helper.dyn, [byId.helper], () => [stepWhy(byId.helper)]);

  const sitesStep = byId.sites;
  const reuters = reutersSite() ?? null;
  renderIf(ui.steps.sites.dyn, [sitesStep, reuters, data.jobs], () => {
    if (sitesStep.why && sitesStep.why !== "no_data") return [stepWhy(sitesStep)];
    if (!Array.isArray(data.sites)) return [stepWhy(sitesStep)];
    return [
      reuters ? siteCard(reuters, true) : h("p", { class: "muted" }, tx("step5.noReuters")),
      h(
        "p",
        { class: "muted small" },
        tx("step5.addMore"),
        " ",
        h("a", { href: "#sites" }, tx("step5.goSites")),
      ),
    ];
  });
  ui.helper.update(data.helper);
  ui.passphrase.update(data.settings);
  ui.guide.update(data.chatgpt, data.settings);
  ui.addSite.update();
}

/** Badge colour of a site status. */
function siteTone(status) {
  if (status === "active") return "done";
  if (status === "failed") return "bad";
  if (status === "onboarding") return "unknown";
  return "todo";
}

function siteCard(site, compact) {
  const guide = siteGuidance(site);
  const name = site.name || site.key;
  const status = site.checking
    ? `${lb("siteStatus", site.status)} · ${tx("site.checking")}`
    : lb("siteStatus", site.status);
  const say =
    guide.say === "site.do.login"
      ? h("p", { class: "todo-line" }, rich("site.do.login", { url: link(site.loginUrl) }))
      : h("p", { class: "todo-line" }, tx(guide.say));
  const requested =
    site.job?.state === "awaiting_user" && site.job.requestedAction
      ? [
          h("blockquote", { class: "requested" }, site.job.requestedAction),
          h("p", { class: "muted small" }, tx("site.do.awaitingThen")),
        ]
      : null;
  const actions = Array.isArray(site.actions) ? site.actions : [];
  const primary = guide.primary ? siteAction(site, guide.primary, true) : null;
  const others = actions
    .filter((a) => a !== guide.primary && (!compact || a === "check"))
    .map((a) => siteAction(site, a, false));
  if (site.job && !compact)
    others.push(button(tx("action.showLog"), () => openLogFromAnywhere(site.job.id), "secondary"));
  const job = site.job;
  const loginHelp = offersLoginHelp(site) ? loginHelper(`login:${site.key}`, siteLoginTarget(site)) : null;
  return h(
    "article",
    { class: "card" },
    h("div", { class: "card-head" }, h("strong", {}, name), badge(siteTone(site.status), status)),
    say,
    requested,
    h("div", { class: "row actions" }, primary, others),
    loginHelp,
    detailList(`site:${site.key}`, [
      [tx("site.d.key"), site.key],
      [tx("site.d.addresses"), (site.hostnames ?? []).join(", ")],
      [
        tx("site.d.capabilities"),
        Object.entries(site.capabilities ?? {})
          .filter(([, on]) => on)
          .map(([n]) => n)
          .join(", ") || tx("common.none"),
      ],
      [tx("site.d.lastChecked"), when(site.lastCheckedAt)],
      [tx("site.d.lastFailure"), site.lastFailure],
      [tx("site.d.folderProblem"), site.folderProblem],
      [
        tx("site.d.job"),
        job ? `${lb("jobKind", job.kind)} · ${lb("jobState", job.state)} · ${job.id}` : null,
      ],
      [tx("job.d.blockKind"), job?.state === "awaiting_user" ? lb("blockKind", blockKind(job)) : null],
      [tx("conn.details.message"), job?.lastFailure ?? job?.reason ?? null],
      [tx("site.d.runtime"), job?.runtime ? lb("helperRuntime", job.runtime) : null],
      [tx("site.d.cache"), site.cache ? `${site.cache.entries} · ${formatBytes(site.cache.bytes)}` : null],
    ]),
  );
}

function openLogFromAnywhere(jobId) {
  if (currentTab() !== "sites") window.location.hash = "#sites";
  openLog(jobId);
}

function offNotice(key) {
  return h(
    "p",
    { class: "muted" },
    tx(data.status?.mode === "restarting" ? "sites.offRestarting" : key),
    " ",
    pointerLink(),
  );
}

function renderSites() {
  renderIf(ui.sitesList, [data.sites, data.status?.mode], () => {
    if (!coreRunning() || !Array.isArray(data.sites)) return [offNotice("sites.off")];
    if (data.sites.length === 0) return [h("p", { class: "muted" }, tx("sites.empty"))];
    return data.sites.map((s) => siteCard(s, false));
  });
  renderIf(ui.jobsList, [data.jobs, data.sites], () => {
    if (!Array.isArray(data.jobs)) return [];
    if (data.jobs.length === 0) return [h("p", { class: "muted" }, tx("jobs.empty"))];
    return data.jobs.map((job) => {
      const id = encodeURIComponent(job.id);
      const buttons = [button(tx("action.showLog"), () => openLog(job.id), "secondary")];
      if (job.state === "awaiting_user" || job.state === "failed") {
        buttons.push(
          button(tx("action.retry"), () => act(`/jobs/${id}/retry`, "POST", { lang }), "secondary"),
        );
      }
      if (job.state === "queued" || job.state === "running" || job.state === "awaiting_user") {
        buttons.push(button(tx("action.cancel"), () => act(`/jobs/${id}/cancel`, "POST"), "secondary"));
      }
      return h(
        "div",
        { class: "job" },
        h(
          "div",
          { class: "card-head" },
          h("strong", {}, job.key || job.input),
          h("span", { class: "muted small" }, `${lb("jobKind", job.kind)} · ${when(job.updatedAt)}`),
          badge(
            job.state === "succeeded" ? "done" : job.state === "failed" ? "bad" : "todo",
            lb("jobState", job.state),
          ),
        ),
        job.state === "awaiting_user" && job.requestedAction
          ? h(
              "div",
              {},
              h("span", { class: "muted small" }, tx("jobs.requested")),
              h("blockquote", { class: "requested" }, job.requestedAction),
            )
          : null,
        h("div", { class: "row actions" }, buttons),
        jobPausedForLogin(job) ? loginHelper(`login-job:${job.id}`, jobLoginTarget(job)) : null,
        detailList(`job:${job.id}`, [
          [tx("job.d.id"), job.id],
          [tx("job.d.blockKind"), job.state === "awaiting_user" ? lb("blockKind", blockKind(job)) : null],
          [tx("conn.details.message"), job.lastFailure ?? job.reason],
          [tx("site.d.runtime"), job.runtime ? lb("helperRuntime", job.runtime) : null],
          [tx("job.d.attempts"), job.attempts],
          [tx("job.d.commit"), job.commit],
          [tx("job.d.lang"), job.lang],
        ]),
      );
    });
  });
}

function renderConnection() {
  renderIf(ui.appsList, [data.clients, data.status?.mode], () => {
    if (!coreRunning() || !Array.isArray(data.clients)) return [offNotice("apps.off")];
    if (data.clients.length === 0) return [h("p", { class: "muted" }, tx("apps.empty"))];
    return data.clients.map((c) => {
      const name = c.clientName || tx("apps.unnamed");
      return h(
        "article",
        { class: "card" },
        h("div", { class: "card-head" }, h("strong", {}, name)),
        ...(c.connections ?? []).map((conn) =>
          h(
            "div",
            { class: "row" },
            h("span", { class: "small" }, tx("apps.connection", { time: when(conn.expiresAt) })),
            button(
              tx("apps.disconnectOne"),
              () => {
                if (!window.confirm(tx("confirm.disconnectOne", { name }))) return undefined;
                return act("/oauth/revoke", "POST", { tokenId: conn.tokenId });
              },
              "secondary",
            ),
          ),
        ),
        h(
          "div",
          { class: "row actions" },
          button(
            tx("apps.disconnectApp"),
            () => {
              if (!window.confirm(tx("confirm.disconnectApp", { name }))) return undefined;
              return act("/oauth/revoke", "POST", { clientId: c.clientId });
            },
            "secondary danger",
          ),
        ),
        detailList(`client:${c.clientId}`, [
          [tx("apps.d.id"), c.clientId],
          [tx("apps.d.source"), c.source],
          [tx("apps.d.hosts"), (c.redirectHosts ?? []).join(", ")],
          [tx("apps.d.lastToken"), when(c.lastTokenIssuedAt)],
          ...(c.connections ?? []).map((conn) => [conn.kinds.join("+"), conn.tokenId]),
        ]),
      );
    });
  });
  const mcpUrl = data.settings?.info?.mcpUrl ?? null;
  renderIf(ui.addressBox, [mcpUrl], () => [
    h("p", { class: "muted small" }, tx("conn.addressExplain")),
    mcpUrl ? codeLine(mcpUrl) : h("p", { class: "muted" }, "—"),
  ]);
}

function renderSettings() {
  ui.runtime.update(data.settings);
  ui.captcha.update(data.settings);
  ui.account.update(data.settings);
  renderIf(ui.cacheBox, [data.cache, data.status?.mode], () => {
    if (!coreRunning() || !data.cache) return [h("p", { class: "muted" }, tx("cache.off"))];
    const { total, bySite } = data.cache;
    const clear = async (body) => {
      await act("/cache/clear", "POST", body);
      await loadCache();
      render();
    };
    return [
      h(
        "div",
        { class: "row" },
        h("span", {}, tx("cache.total", { entries: total.entries, size: formatBytes(total.bytes) })),
        button(tx("cache.clearAll"), () => clear({}), "secondary"),
      ),
      ...Object.entries(bySite ?? {}).map(([site, s]) =>
        h(
          "div",
          { class: "row" },
          h(
            "span",
            { class: "small" },
            tx("cache.site", { site, entries: s.entries, size: formatBytes(s.bytes) }),
          ),
          button(tx("cache.clear"), () => clear({ site }), "secondary"),
        ),
      ),
    ];
  });
  const info = data.settings?.info;
  renderIf(ui.infoBox, [info], () => {
    if (!info) return [];
    const show = (v) =>
      v === null || v === undefined
        ? "—"
        : typeof v === "boolean"
          ? tx(v ? "common.yes" : "common.no")
          : String(v);
    const rows = [
      ["info.mcpUrl", info.mcpUrl],
      ["info.publicUrl", info.publicUrl],
      ["info.publicUrlConfigured", info.publicUrlConfigured],
      ["info.publicPort", info.publicPort],
      ["info.adminPort", info.adminPort],
      ["info.dataDir", info.dataDir],
      ["info.sitesDir", info.sitesDir],
      ["info.configFile", info.configFile],
      ["info.envFile", info.envFile],
    ];
    return [
      h(
        "dl",
        { class: "facts" },
        rows.flatMap(([key, value]) => [h("dt", {}, tx(key)), h("dd", {}, show(value))]),
      ),
    ];
  });
}

// ------------------------------------------------------------------ start

async function start() {
  buildShell();
  showTab(currentTab());
  await loadAll();
  loadedOnce = true;
  // Getting started is the home: without a tab in the address, the page stays there.
  render();
  setInterval(() => {
    if (!restartWaiter && !signedOut) void poll();
  }, POLL_MS);
  setInterval(() => {
    if (!restartWaiter && !signedOut && coreRunning()) void loadBrowser();
  }, BROWSER_POLL_MS);
}

void start();
