/**
 * REPL-side half of the page-script shim, as JavaScript source.
 *
 * This code runs inside the Aside REPL (a persistent, shared top-level scope; see docs/BROWSER.md),
 * so it is plain ES2023 kept as a string and exercised by the unit tests in a `node:vm` context with
 * a fake REPL. It is evaluated once per REPL call as `async function (env, userFn)` and returns a
 * JSON envelope:
 *   { ok: true, value, lastLoadAt } |
 *   { ok: false, kind: "violation" | "script" | "timeout" | "tab_gone" | "globals" | "internal", ... }
 *
 * What it enforces on every call:
 * - Hardening: `constructor` on the REPL realm's function prototypes is pinned to `undefined`, so a
 *   key built at runtime cannot reach the Function constructor (and through it the REPL globals).
 * - Tabs: only tabs this bridge opened are touched (by target id via `getTabByTargetId`); new tabs
 *   start at about:blank, get the request filter (CDP `Network.setBlockedURLs`, an allowlist of the
 *   scope's hostnames) and the in-page navigation guard (init script) before the first real load.
 * - Membrane: page objects handed to scripts are proxies that hide Aside internals (`_*`, `cdp`,
 *   `browser`, `frameManager`, `context`, ...), refuse `call`/`apply`/`bind`/`constructor`, check
 *   `goto` URLs against the hostnames, and apply the politeness gate to navigations.
 * - `fetch`/`openTab` wrappers accept only the scope's hostnames; `fetch` follows redirects by hand
 *   and checks every hop; `set-cookie` headers are dropped.
 * - After every call, for each touched tab: the in-page guard stores (isolated world, every frame)
 *   are drained, the main-frame URL is checked (off-scope → about:blank), and popups opened from
 *   bridge tabs are closed. Any attributed violation fails the call, even if the script caught the
 *   error. Blocks caused by the site's own scripts are returned as `pageBlocked` (not a failure).
 */
export const REPL_RUNTIME_SOURCE = String.raw`async function (env, userFn) {
  "use strict";
  var realOpenTab = openTab, realCloseTab = closeTab, realGetTab = getTabByTargetId;
  var realFetch = fetch, realSnapshot = snapshot, realSleep = sleep, realBuffer = typeof Buffer === "function" ? Buffer : undefined;
  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  // 1. Hardening (idempotent; persists for the REPL context).
  var protos = [Function.prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})];
  for (var pi = 0; pi < protos.length; pi++) {
    var d = Object.getOwnPropertyDescriptor(protos[pi], "constructor");
    if (!d || d.configurable) Object.defineProperty(protos[pi], "constructor", { value: undefined, writable: false, enumerable: false, configurable: false });
    else if (d.value !== undefined || d.get || d.set) return { ok: false, kind: "internal", message: "cannot harden the REPL realm" };
  }

  var hosts = env.hostnames;
  var state = { violations: [], lastLoadAt: null, notBefore: env.notBefore, opened: [], pageBlocked: [] };
  // Target ids of every tab this bridge opened in this REPL context. A non-enumerable REPL global:
  // scripts cannot name it (scan) or reach the global object (shadowing + hardening).
  var reg = globalThis[env.registryKey];
  if (!reg) {
    reg = new Set();
    Object.defineProperty(globalThis, env.registryKey, { value: reg, enumerable: false, writable: false, configurable: false });
  }
  var hostOf = function (u, base) { try { return new URL(String(u), base).hostname.toLowerCase(); } catch (e) { return ""; } };
  var hostAllowed = function (h) { for (var i = 0; i < hosts.length; i++) { if (h === hosts[i] || h.endsWith("." + hosts[i])) return true; } return false; };
  var inScope = function (u, base) {
    var x; try { x = base === undefined ? new URL(String(u)) : new URL(String(u), base); } catch (e) { return null; }
    if (x.protocol !== "http:" && x.protocol !== "https:") return null;
    return hostAllowed(x.hostname.toLowerCase()) ? x.href : null;
  };
  var pageUrlOk = function (u) { u = String(u || ""); return u === "" || u.indexOf("about:") === 0 || u.indexOf("chrome-error:") === 0 || inScope(u) !== null; };
  var violate = function (kind, target, base) {
    var host = hostOf(target, base) || "an invalid or non-http URL";
    state.violations.push({ kind: kind, host: host });
    var e = new Error("blocked by the bridge: " + kind + " to " + host + " is outside the site's hostnames");
    e.__brbViolation = true;
    return e;
  };
  var gate = async function () {
    var wait = state.notBefore - Date.now();
    if (wait > 0) await realSleep(wait);
    var t = Date.now();
    state.lastLoadAt = t;
    state.notBefore = t + env.minIntervalMs;
  };
  var install = async function (raw) {
    await raw._sendToTarget("Network.setBlockedURLs", { urls: [], urlPatterns: env.blockPatterns });
    try { await raw._sendToTarget("Network.setBypassServiceWorker", { bypass: true }); } catch (e) { /* older browsers */ }
    await raw._sendToTarget("Page.addScriptToEvaluateOnNewDocument", { source: env.isolatedGuard, worldName: env.worldName });
    await raw._sendToTarget("Page.addScriptToEvaluateOnNewDocument", { source: env.mainGuard });
  };
  // Reads (and empties) the isolated-world guard stores of the tab's frames (main frame first).
  var drainGuard = async function (raw) {
    var list = [];
    var frameIds = [];
    try {
      var ft = await raw._sendToTarget("Page.getFrameTree", {});
      var walk = function (node) {
        if (!node || frameIds.length >= 20) return;
        if (node.frame && node.frame.id) frameIds.push(node.frame.id);
        (node.childFrames || []).forEach(walk);
      };
      walk(ft && ft.frameTree);
    } catch (e) { return; /* page closing or navigating: nothing to read */ }
    for (var fi = 0; fi < frameIds.length; fi++) {
      try {
        var w = await raw._sendToTarget("Page.createIsolatedWorld", { frameId: frameIds[fi], worldName: env.worldName });
        var r = await raw._sendToTarget("Runtime.evaluate", { expression: "typeof __bridgeDrain === 'function' ? __bridgeDrain() : []", contextId: w.executionContextId, returnByValue: true });
        if (r && r.result && Array.isArray(r.result.value)) list = list.concat(r.result.value);
      } catch (e) { /* cross-origin or detached frame */ }
    }
    list.forEach(function (v) {
      var host = v && typeof v.host === "string" ? v.host.slice(0, 120) : "an off-site URL";
      var kind = v && typeof v.kind === "string" ? v.kind.slice(0, 20) : "request";
      if (v && v.attributed) state.violations.push({ kind: kind, host: host });
      else if (state.pageBlocked.indexOf(host) < 0 && state.pageBlocked.length < 20) state.pageBlocked.push(host);
    });
  };
  // Closes tabs opened from bridge tabs (popups) that the bridge did not open itself. Two sources:
  // the REPL session's tabs (Aside attaches popups of session tabs there, also noopener ones) and
  // CDP targets whose opener is a bridge tab. About:blank tabs in the REPL list are skipped: they may
  // be a tab another call has just opened and not registered yet.
  var sweepPopups = async function (anyRaw) {
    var list = [];
    try { list = Array.isArray(tabs) ? tabs.slice() : []; } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      var id = ""; var u = "";
      try { id = String(x.targetId); u = String(x.url()); } catch (e) { continue; }
      if (reg.has(id) || u === "" || u === "about:blank") continue;
      if (!pageUrlOk(u)) state.violations.push({ kind: "popup", host: hostOf(u) || "an off-site page" });
      try { await realCloseTab(x); } catch (e) { /* already gone */ }
    }
    if (!anyRaw) return;
    var infos = [];
    try { var tg = await anyRaw._sendToTarget("Target.getTargets", {}); infos = tg && Array.isArray(tg.targetInfos) ? tg.targetInfos : []; } catch (e) { return; }
    for (var j = 0; j < infos.length; j++) {
      var ti = infos[j];
      if (!ti || ti.type !== "page" || !ti.openerId || !reg.has(String(ti.openerId)) || reg.has(String(ti.targetId))) continue;
      if (!pageUrlOk(ti.url)) state.violations.push({ kind: "popup", host: hostOf(ti.url) || "an off-site page" });
      try { await anyRaw._sendToTarget("Target.closeTarget", { targetId: String(ti.targetId) }); } catch (e) { /* already gone */ }
    }
  };
  var postCheck = async function (raw) {
    var u = "";
    try { u = String(raw.url()); } catch (e) { return; }
    await drainGuard(raw);
    if (pageUrlOk(u)) return;
    state.violations.push({ kind: "navigation", host: hostOf(u) || "an off-site page" });
    try { await raw.goto("about:blank"); } catch (e) { /* the call fails anyway */ }
  };
  var getRaw = async function (id) {
    var raw = await realGetTab(id);
    if (!raw) { var e = new Error("the tab is gone"); e.__brbTabGone = true; throw e; }
    return raw;
  };
  var openRaw = async function (url, waitUntil) {
    var raw = await realOpenTab("about:blank");
    reg.add(String(raw.targetId));
    try {
      await install(raw);
      await raw.goto(url, waitUntil ? { waitUntil: waitUntil } : {});
    } catch (e) {
      try { await realCloseTab(raw); } catch (x) { /* ignore */ }
      reg.delete(String(raw.targetId));
      throw e;
    }
    return raw;
  };

  // 2. Membrane over Aside objects handed to page scripts.
  var DENY = {};
  ["constructor", "prototype", "__proto__", "caller", "arguments", "call", "apply", "bind", "cdp", "browser", "frameManager", "events", "context", "close", "ensureAccess", "resolveSessionId", "exposeFunction", "exposeBinding", "addInitScript", "route", "unroute", "evaluateHandle", "setExtraHTTPHeaders", "opener", "pdf", "screenshot", "setInputFiles", "waitForEvent", "download"].forEach(function (k) { DENY[k] = true; });
  var NAV = { goto: true, reload: true, goBack: true, goForward: true };
  var LISTEN = { on: true, off: true, once: true, addListener: true, removeListener: true, prependListener: true };
  var denied = function (k) { return typeof k === "string" && (k.charAt(0) === "_" || hasOwn(DENY, k)); };
  var raws = new WeakMap();
  var proxies = new WeakMap();
  var listeners = new WeakMap();
  var unwrap = function (v) { return (v !== null && (typeof v === "object" || typeof v === "function") && raws.has(v)) ? raws.get(v) : v; };
  var isPlainObject = function (v) {
    var p = Object.getPrototypeOf(v);
    return p === null || (Object.getPrototypeOf(p) === null && hasOwn(p, "hasOwnProperty"));
  };
  var wrap;
  var invoke = function (fn, owner, name, thisArg, args) {
    var self = owner !== undefined ? owner : unwrap(thisArg);
    var a = args.map(function (x) {
      if (x !== null && typeof x === "object" && !raws.has(x) && (Array.isArray(x) || isPlainObject(x))) {
        var c = Array.isArray(x) ? [] : {};
        Object.keys(x).forEach(function (k) { c[k] = unwrap(x[k]); });
        return c;
      }
      if (typeof x === "function" && hasOwn(LISTEN, name) && !raws.has(x)) {
        var w = listeners.get(x);
        if (!w) { w = function () { return x.apply(undefined, Array.prototype.map.call(arguments, function (y) { return wrap(y); })); }; listeners.set(x, w); }
        return w;
      }
      return unwrap(x);
    });
    if (hasOwn(NAV, name)) {
      return (async function () {
        if (name === "goto") {
          var base; try { base = typeof self.url === "function" ? String(self.url()) : undefined; } catch (e) { base = undefined; }
          var target = inScope(a[0], base && base.indexOf("http") === 0 ? base : undefined);
          if (!target) throw violate("navigation", a[0], base);
          a[0] = target;
        }
        await gate();
        var r = await Reflect.apply(fn, self, a);
        if (self && typeof self.url === "function" && typeof self.goto === "function") await postCheck(self);
        return wrap(r);
      })();
    }
    return wrap(Reflect.apply(fn, self, a));
  };
  var fnProxy = function (fn, owner, name) {
    var p = new Proxy(function () {}, {
      get: function (t, k) { if (k === "name") return name; if (k === "length") return fn.length; return undefined; },
      set: function () { return false; },
      defineProperty: function () { return false; },
      getPrototypeOf: function () { return null; },
      apply: function (t, thisArg, args) { return invoke(fn, owner, name, thisArg, args); },
      construct: function () { throw new TypeError("not constructible"); }
    });
    raws.set(p, fn);
    return p;
  };
  // Objects become proxies with a private overlay: scripts can add or change fields on results
  // (e.g. evaluate() data) without touching the underlying object, and never see hidden members.
  var objProxy = function (target) {
    var overlay = {};
    var p = new Proxy(overlay, {
      get: function (t, k) {
        if (hasOwn(overlay, k)) return overlay[k];
        if (denied(k)) return undefined;
        var x = target[k];
        if (typeof x === "function") return fnProxy(x, target, String(k));
        return wrap(x);
      },
      has: function (t, k) { return hasOwn(overlay, k) || (!denied(k) && (k in target)); },
      set: function (t, k, v) { if (denied(k)) return false; overlay[k] = v; return true; },
      defineProperty: function () { return false; },
      deleteProperty: function (t, k) { delete overlay[k]; return true; },
      ownKeys: function () {
        var keys = Reflect.ownKeys(overlay);
        Reflect.ownKeys(target).forEach(function (k) { if (!denied(k) && keys.indexOf(k) < 0) keys.push(k); });
        return keys;
      },
      getOwnPropertyDescriptor: function (t, k) {
        if (hasOwn(overlay, k)) return Reflect.getOwnPropertyDescriptor(overlay, k);
        if (denied(k)) return undefined;
        var dd = Reflect.getOwnPropertyDescriptor(target, k);
        if (!dd) return undefined;
        return { value: dd.get || dd.set ? undefined : wrap(dd.value), writable: true, enumerable: dd.enumerable, configurable: true };
      },
      getPrototypeOf: function () { return null; },
      setPrototypeOf: function () { return false; }
    });
    raws.set(p, target);
    proxies.set(target, p);
    return p;
  };
  wrap = function (v, seen) {
    if (v === null || v === undefined) return v;
    var t = typeof v;
    if (t !== "object" && t !== "function") return v;
    if (raws.has(v)) return v;
    if (t === "function") return fnProxy(v, undefined, "");
    if (typeof v.then === "function") return Promise.resolve(v).then(function (x) { return wrap(x); });
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
    if (Array.isArray(v)) {
      seen = seen || new Map();
      if (seen.has(v)) return seen.get(v);
      var out = [];
      seen.set(v, out);
      for (var i = 0; i < v.length; i++) out.push(wrap(v[i], seen));
      return out;
    }
    var cached = proxies.get(v);
    return cached || objProxy(v);
  };

  // 3. Scoped helpers.
  var guardedFetch = async function (url, init) {
    init = init || {};
    var target = inScope(url);
    if (!target) throw violate("fetch", url);
    var method = String(init.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "POST") throw new Error("fetch: method " + method + " is not allowed");
    var body = init.body === undefined || init.body === null ? undefined : String(init.body);
    var headers = {};
    if (init.headers && typeof init.headers === "object") Object.keys(init.headers).forEach(function (k) { headers[k] = String(init.headers[k]); });
    await gate();
    for (var hop = 0; hop <= 5; hop++) {
      var opts = { method: method, headers: headers, redirect: "manual" };
      if (body !== undefined) opts.body = body;
      var res = await realFetch(target, opts);
      var loc = res.headers && res.headers.get ? res.headers.get("location") : null;
      if (res.status >= 300 && res.status < 400 && loc) {
        var next = inScope(loc, target);
        if (!next) throw violate("redirect", loc, target);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
        target = next;
        continue;
      }
      var hdrs = {};
      if (res.headers && res.headers.forEach) res.headers.forEach(function (v, k) { var lk = String(k).toLowerCase(); if (lk !== "set-cookie" && lk !== "set-cookie2") hdrs[lk] = String(v); });
      var text = method === "HEAD" ? "" : String(await res.text());
      return { status: res.status, url: target, headers: hdrs, text: text };
    }
    throw new Error("fetch: too many redirects");
  };
  var scriptFetch = async function (url, init) {
    var r = await guardedFetch(url, init);
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status, url: r.url,
      headers: { get: function (n) { var k = String(n).toLowerCase(); return hasOwn(r.headers, k) ? r.headers[k] : null; } },
      text: async function () { return r.text; },
      json: async function () { return JSON.parse(r.text); }
    };
  };
  var sessionRaw = null;
  var owned = function (raw) { return raw === sessionRaw || state.opened.indexOf(raw) >= 0; };
  var scriptOpenTab = async function (url) {
    var target = inScope(url);
    if (!target) throw violate("openTab", url);
    await gate();
    var raw = await openRaw(target);
    state.opened.push(raw);
    await postCheck(raw);
    return wrap(raw);
  };
  var scriptCloseTab = async function (p) {
    var raw = unwrap(p);
    var i = state.opened.indexOf(raw);
    if (i < 0) throw new Error("closeTab: only tabs opened by this script can be closed here");
    state.opened.splice(i, 1);
    await postCheck(raw);
    await realCloseTab(raw);
    reg.delete(String(raw.targetId));
  };
  var scriptSnapshot = async function (p, opts) {
    var raw = unwrap(p);
    if (!owned(raw)) throw new Error("snapshot: not a tab of this session");
    await postCheck(raw);
    var o = {};
    if (opts && typeof opts === "object") ["interactive", "showHidden", "ref", "selector"].forEach(function (k) { if (opts[k] !== undefined) o[k] = opts[k]; });
    var s = await realSnapshot(raw, o);
    return { tree: String(s && s.tree !== undefined ? s.tree : ""), diff: String(s && s.diff !== undefined ? s.diff : "") };
  };
  var quietConsole = { log: function () {}, info: function () {}, warn: function () {}, error: function () {}, debug: function () {} };

  var withDeadline = function (promise) {
    var timer;
    var deadline = new Promise(function (resolve, reject) {
      timer = setTimeout(function () { var e = new Error("step timed out"); e.__brbTimeout = true; reject(e); }, env.deadlineMs);
    });
    return Promise.race([promise, deadline]).finally(function () { clearTimeout(timer); });
  };
  var finish = function (value) {
    if (state.violations.length) return { ok: false, kind: "violation", violations: state.violations, lastLoadAt: state.lastLoadAt };
    var json;
    try { json = JSON.stringify(value === undefined ? null : value); } catch (e) { return { ok: false, kind: "script", message: "the result is not JSON-serializable", lastLoadAt: state.lastLoadAt }; }
    var out = { ok: true, value: JSON.parse(json === undefined ? "null" : json), lastLoadAt: state.lastLoadAt };
    if (state.pageBlocked.length) out.pageBlocked = state.pageBlocked;
    return out;
  };
  var fail = function (err) {
    if (state.violations.length) return { ok: false, kind: "violation", violations: state.violations, lastLoadAt: state.lastLoadAt };
    if (err && err.__brbTabGone) return { ok: false, kind: "tab_gone" };
    if (err && err.__brbTimeout) return { ok: false, kind: "timeout", lastLoadAt: state.lastLoadAt };
    var msg = err && typeof err.message === "string" ? err.message : String(err);
    return { ok: false, kind: "script", message: msg.slice(0, 500), lastLoadAt: state.lastLoadAt };
  };

  // 4. Operations.
  var op = env.op;
  try {
    if (op.kind === "probe") return finish({ ready: true });
    if (op.kind === "open") {
      var raw0;
      if (op.reuseTargetId) {
        raw0 = await getRaw(op.reuseTargetId);
        await gate();
        await withDeadline(raw0.goto(op.url, op.waitUntil ? { waitUntil: op.waitUntil } : {}));
      } else {
        await gate();
        raw0 = await withDeadline(openRaw(op.url, op.waitUntil));
      }
      await postCheck(raw0);
      await sweepPopups(raw0);
      if (state.violations.length && !op.reuseTargetId) {
        try { await realCloseTab(raw0); } catch (e) { /* ignore */ }
        reg.delete(String(raw0.targetId));
      }
      return finish({ targetId: String(raw0.targetId), url: String(raw0.url()) });
    }
    if (op.kind === "close") {
      var raw1 = await realGetTab(op.targetId);
      // Popups are swept (closed) here too, but a close never fails because of them.
      await sweepPopups(raw1 || null);
      var swept = state.violations;
      state.violations = [];
      if (raw1) await realCloseTab(raw1);
      reg.delete(String(op.targetId));
      return finish({ closed: Boolean(raw1), popups: swept });
    }
    if (op.kind === "snapshot") {
      var raw2 = await getRaw(op.targetId);
      await postCheck(raw2);
      if (state.violations.length) return finish(null);
      var snap = await withDeadline(realSnapshot(raw2, {}));
      return finish(String(snap && snap.tree !== undefined ? snap.tree : ""));
    }
    if (op.kind === "screenshot") {
      var raw3 = await getRaw(op.targetId);
      await postCheck(raw3);
      if (state.violations.length) return finish(null);
      var shot = await withDeadline(raw3.screenshot());
      var b64 = typeof shot === "string" ? shot : realBuffer ? realBuffer.from(shot).toString("base64") : "";
      return finish(b64);
    }
    if (op.kind === "fetch") {
      return finish(await withDeadline(guardedFetch(op.url, op.init)));
    }
    if (op.kind === "script") {
      var allow = {};
      env.allow.concat(env.params, [env.registryKey]).forEach(function (n) { allow[n] = true; });
      var missing = Object.getOwnPropertyNames(globalThis).filter(function (n) { return !hasOwn(allow, n) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) && env.unshadowable.indexOf(n) < 0 && n.indexOf(env.internalPrefix) !== 0; });
      if (missing.length) return { ok: false, kind: "globals", names: missing };
      if (op.targetId) sessionRaw = await getRaw(op.targetId);
      var provided = {
        page: sessionRaw ? wrap(sessionRaw) : undefined,
        args: op.args,
        openTab: scriptOpenTab,
        closeTab: scriptCloseTab,
        fetch: scriptFetch,
        snapshot: scriptSnapshot,
        sleep: function (ms) { return realSleep(Math.max(0, Math.min(Number(ms) || 0, 60000))); },
        console: quietConsole
      };
      var values = env.params.map(function (n) { return hasOwn(provided, n) ? provided[n] : undefined; });
      var result;
      try {
        result = await withDeadline(userFn.apply(undefined, values));
      } finally {
        var touched = state.opened.slice();
        for (var ti = 0; ti < touched.length; ti++) {
          await postCheck(touched[ti]);
          await sweepPopups(touched[ti]);
          try { await realCloseTab(touched[ti]); } catch (e) { /* ignore */ }
          reg.delete(String(touched[ti].targetId));
        }
        state.opened = [];
        if (sessionRaw) await postCheck(sessionRaw);
        await sweepPopups(sessionRaw);
      }
      return finish(result);
    }
    return { ok: false, kind: "internal", message: "unknown operation" };
  } catch (err) {
    return fail(err);
  }
}`;
