import ts from "typescript";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { FakeDocumentSpec, FakeNodeSpec, FakePage } from "../../../test/support/fake-aside-repl.js";
import { FakeAsideRepl, FakeDom } from "../../../test/support/fake-aside-repl.js";
import { OutcomeError } from "../../core/outcome.js";
import type { Logger } from "../../ports/logger.js";
import type { ReplClient } from "./repl-client.js";
import { InMemoryScheduler } from "./scheduler.js";
import type { CaptchaTimings } from "./captcha.js";
import {
  CAPTCHA_MESSAGES,
  CAPTCHA_PAGE_SOURCE,
  CAPTCHA_STEP_SOURCE,
  CAPTCHA_VENDOR_HOSTS,
  CAPTCHA_WIDGETS,
  DEFAULT_CAPTCHA_BUDGET_MS,
  MAX_CAPTCHA_ROUNDS,
  isCaptchaVendorHost,
} from "./captcha.js";
import { parseCaptchaCheckArgs } from "./captcha-check.js";
import { blockedUrlPatterns } from "./hosts.js";
import { AsideBrowserPort } from "./port.js";
import {
  KNOWN_REPL_GLOBALS,
  STANDARD_GLOBALS,
  buildGuardCsp,
  buildIsolatedGuard,
  buildReplCode,
  parseReplOutput,
  shadowParams,
} from "./shim.js";

const SITE = "example.com";
const URL1 = "https://example.com/challenge";
const scope = { siteKey: "example", hostnames: [SITE] };

/** No waiting in unit tests. */
const FAST: Partial<CaptchaTimings> = {
  noneWaitMs: 0,
  pendingWaitMs: 0,
  pollMs: 10,
  settleMs: 0,
  textSettleMs: 0,
  minRoundMs: 0,
};

// ---------------------------------------------------------------------------------------------
// Fixtures: how pages look after the widened reload (vendor widgets loaded).

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

const RECAPTCHA_ANCHOR =
  "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Le-site&co=aHR0cHM6&hl=en&v=abc&size=normal&cb=x";
const RECAPTCHA_BFRAME = "https://www.google.com/recaptcha/api2/bframe?hl=en&v=abc&k=6Le-site";

function recaptchaPage(options: { challengeVisible?: boolean; token?: string } = {}): FakeDocumentSpec {
  return {
    title: "Sign up",
    body: [
      {
        tag: "form",
        attrs: { action: "/verify", method: "post" },
        rect: rect(80, 150, 400, 200),
        children: [
          {
            tag: "div",
            attrs: { class: "g-recaptcha", "data-sitekey": "6Le-site" },
            children: [
              {
                tag: "iframe",
                attrs: { src: RECAPTCHA_ANCHOR, title: "reCAPTCHA" },
                rect: rect(100, 200, 304, 78),
              },
              {
                tag: "textarea",
                attrs: { name: "g-recaptcha-response", id: "g-recaptcha-response" },
                style: { display: "none" },
                value: options.token ?? "",
              },
            ],
          },
          { tag: "input", attrs: { type: "submit", value: "Continue" }, rect: rect(100, 300, 100, 30) },
        ],
      },
      // Google keeps the image challenge frame hidden off-screen until it is needed.
      {
        tag: "div",
        style: options.challengeVisible ? {} : { visibility: "hidden" },
        children: [
          {
            tag: "iframe",
            attrs: { src: RECAPTCHA_BFRAME, title: "recaptcha challenge expires in two minutes" },
            rect: options.challengeVisible ? rect(60, 40, 400, 580) : rect(0, -10000, 400, 580),
          },
        ],
      },
    ],
  };
}

const ARTICLE: FakeDocumentSpec = {
  title: "An article",
  body: [{ tag: "article", rect: rect(0, 0, 1280, 2000), text: "Full text of the article." }],
};

const ACCESS_DENIED: FakeDocumentSpec = {
  title: "Access Denied",
  body: [{ tag: "h1", rect: rect(0, 0, 600, 40), text: "You don't have permission to access this page." }],
};

const HCAPTCHA: FakeDocumentSpec = {
  title: "Verify",
  body: [
    {
      tag: "div",
      attrs: { class: "h-captcha", "data-sitekey": "10000000-ffff" },
      children: [
        {
          tag: "iframe",
          attrs: {
            src: "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=0x1&host=example.com&sitekey=10000000-ffff",
          },
          rect: rect(20, 300, 303, 78),
        },
        { tag: "textarea", attrs: { name: "h-captcha-response" }, style: { display: "none" } },
      ],
    },
    {
      tag: "div",
      style: { visibility: "hidden" },
      children: [
        {
          tag: "iframe",
          attrs: {
            src: "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=0x1",
          },
          rect: rect(0, 0, 400, 600),
        },
      ],
    },
  ],
};

const TURNSTILE_FRAME =
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAAA/auto/fbE/new/normal/auto/";

const CLOUDFLARE_RUNNING: FakeDocumentSpec = {
  title: "Just a moment...",
  body: [{ tag: "div", attrs: { id: "challenge-running" }, rect: rect(0, 0, 600, 100), text: "Checking" }],
};

const CLOUDFLARE_TURNSTILE: FakeDocumentSpec = {
  title: "Just a moment...",
  body: [
    {
      tag: "div",
      attrs: { id: "challenge-stage" },
      rect: rect(0, 0, 600, 200),
      children: [{ tag: "iframe", attrs: { src: TURNSTILE_FRAME }, rect: rect(150, 320, 300, 65) }],
    },
  ],
};

/** Turnstile rendered in a closed shadow root: only its container is visible from the page. */
const TURNSTILE_SHADOW: FakeDocumentSpec = {
  title: "Sign up",
  body: [
    { tag: "div", attrs: { class: "cf-turnstile", "data-sitekey": "0x4AAA" }, rect: rect(40, 500, 300, 65) },
    { tag: "input", attrs: { type: "hidden", name: "cf-turnstile-response" }, value: "" },
  ],
};

const GEETEST_SLIDER: FakeDocumentSpec = {
  title: "Verify",
  body: [
    {
      tag: "div",
      attrs: { class: "geetest_captcha geetest_boxshow" },
      rect: rect(480, 200, 340, 300),
      children: [
        {
          tag: "div",
          attrs: { class: "geetest_box" },
          rect: rect(480, 200, 340, 300),
          children: [
            {
              tag: "div",
              attrs: { class: "geetest_track" },
              rect: rect(500, 400, 300, 40),
              children: [{ tag: "div", attrs: { class: "geetest_btn" }, rect: rect(500, 400, 40, 40) }],
            },
          ],
        },
      ],
    },
  ],
};

const DATADOME_CAPTCHA: FakeDocumentSpec = {
  title: "reuters.com",
  body: [
    {
      tag: "iframe",
      attrs: {
        src: "https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqA&cid=abc&t=fe&referer=https%3A%2F%2Fexample.com%2F&s=1",
      },
      rect: rect(0, 0, 1280, 800),
    },
  ],
};

const DATADOME_INTERSTITIAL: FakeDocumentSpec = {
  title: "example.com",
  body: [
    {
      tag: "iframe",
      attrs: { src: "https://geo.captcha-delivery.com/interstitial/?initialCid=AHrlqA&cid=abc&s=1" },
      rect: rect(0, 0, 1280, 800),
    },
  ],
};

function textCaptchaPage(withSubmit = true): FakeDocumentSpec {
  const children: FakeNodeSpec[] = [
    { tag: "img", attrs: { src: "/captcha/image?id=7", alt: "captcha" }, rect: rect(40, 100, 200, 70) },
    {
      tag: "input",
      attrs: { type: "text", name: "answer", placeholder: "Type the characters" },
      rect: rect(40, 180, 200, 30),
    },
  ];
  if (withSubmit)
    children.push({ tag: "button", attrs: { type: "submit" }, text: "Verify", rect: rect(40, 220, 100, 30) });
  return {
    title: "Security check",
    body: [
      { tag: "form", attrs: { action: "/verify", method: "post" }, rect: rect(20, 80, 400, 200), children },
    ],
  };
}

// ---------------------------------------------------------------------------------------------

interface Detection {
  kind: string;
  vendor: string | null;
  reason: string | null;
  box?: unknown;
  from?: unknown;
  to?: unknown;
  image?: unknown;
}

/** Runs the in-page detection (as the solver's isolated world does) against a fixture. */
function detect(spec: FakeDocumentSpec, url = URL1): Detection {
  const dom = new FakeDom(spec, url);
  return dom.evaluate(
    `(${CAPTCHA_PAGE_SOURCE})(${JSON.stringify({ mode: "detect", table: CAPTCHA_WIDGETS })})`,
  ) as Detection;
}

describe("captcha vendor hosts", () => {
  it("are exactly the fixed list of spec 6.3, reCAPTCHA hosts limited to its paths, and frozen", () => {
    expect(CAPTCHA_VENDOR_HOSTS.map((h) => [h.host, h.pathPrefix ?? null])).toEqual([
      ["captcha-delivery.com", null],
      ["google.com", "/recaptcha/"],
      ["gstatic.com", "/recaptcha/"],
      ["hcaptcha.com", null],
      ["challenges.cloudflare.com", null],
      ["geetest.com", null],
    ]);
    expect(Object.isFrozen(CAPTCHA_VENDOR_HOSTS)).toBe(true);
    expect(CAPTCHA_VENDOR_HOSTS.every((h) => Object.isFrozen(h))).toBe(true);
  });

  it("isCaptchaVendorHost: exact or subdomain match on the entries' hosts, path limits ignored", () => {
    for (const host of [
      "captcha-delivery.com",
      "geo.captcha-delivery.com",
      "GEO.Captcha-Delivery.com.",
      "www.google.com",
      "accounts.google.com",
      "www.gstatic.com",
      "js.hcaptcha.com",
      "challenges.cloudflare.com",
      "static.geetest.com",
    ]) {
      expect(isCaptchaVendorHost(host), host).toBe(true);
    }
    for (const host of [
      "example.com",
      "cloudflare.com",
      "www.cloudflare.com",
      "notcaptcha-delivery.com",
      "captcha-delivery.com.evil.test",
      "google.co.uk",
      "",
      "an off-site URL",
    ]) {
      expect(isCaptchaVendorHost(host), host).toBe(false);
    }
  });

  it("widen the request filter only for those hosts and paths, keeping the block rules last", () => {
    const patterns = blockedUrlPatterns([SITE], CAPTCHA_VENDOR_HOSTS);
    const allowed = (u: string) => {
      for (const p of patterns) if (new URLPattern(p.urlPattern).test(u)) return !p.block;
      return true;
    };
    expect(allowed("https://www.google.com/recaptcha/api2/anchor?k=1")).toBe(true);
    expect(allowed("https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js")).toBe(true);
    expect(allowed("https://geo.captcha-delivery.com/captcha/?cid=1")).toBe(true);
    expect(allowed("https://newassets.hcaptcha.com/captcha/v1/x")).toBe(true);
    expect(allowed("https://challenges.cloudflare.com/turnstile/v0/api.js")).toBe(true);
    expect(allowed("https://static.geetest.com/v4/gt4.js")).toBe(true);
    expect(allowed("https://www.example.com/x")).toBe(true);
    expect(allowed("https://www.google.com/search?q=x")).toBe(false);
    expect(allowed("https://www.gstatic.com/other/x.js")).toBe(false);
    expect(allowed("https://cloudflare.com/")).toBe(false);
    expect(allowed("https://evil.test/")).toBe(false);
    expect(patterns.slice(-2).every((p) => p.block)).toBe(true);
    expect(blockedUrlPatterns([SITE])).toEqual(blockedUrlPatterns([SITE], []));
  });

  it("widen the guard CSP for subresources and frames but never for form actions", () => {
    const csp = buildGuardCsp([SITE], CAPTCHA_VENDOR_HOSTS);
    const directive = (name: string) =>
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? "";
    for (const d of ["frame-src", "child-src", "script-src", "connect-src", "img-src", "style-src"]) {
      expect(directive(d)).toContain("google.com/recaptcha/ *.google.com/recaptcha/");
      expect(directive(d)).toContain("captcha-delivery.com *.captcha-delivery.com");
      expect(directive(d)).toContain("challenges.cloudflare.com *.challenges.cloudflare.com");
    }
    expect(directive("form-action")).toBe("form-action example.com *.example.com");
    expect(buildGuardCsp([SITE])).not.toContain("captcha");
    expect(buildGuardCsp([SITE], [])).toBe(buildGuardCsp([SITE]));
  });

  it("let the widened isolated guard allow vendor-path navigations in frames and still cancel others", () => {
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const add = (t: string, fn: (e: unknown) => void) => (listeners[t] ??= []).push(fn);
    const ctx = vm.createContext({
      window: { addEventListener: add, navigation: { addEventListener: add } },
      document: {
        readyState: "complete",
        head: { prepend() {} },
        documentElement: {},
        addEventListener: add,
        createElement: () => ({}),
        querySelectorAll: () => [],
      },
      location: { href: "https://example.com/" },
      URL,
      MutationObserver: class {
        observe() {}
      },
    });
    vm.runInContext(buildIsolatedGuard([SITE], "t3st", CAPTCHA_VENDOR_HOSTS), ctx);
    const cancelled: string[] = [];
    for (const url of [
      "https://www.google.com/recaptcha/api2/bframe?k=1",
      "https://www.google.com/search?q=1",
      "https://newassets.hcaptcha.com/captcha/v1/x",
      "https://evil.test/",
    ]) {
      (listeners["navigate"] ?? []).forEach((fn) =>
        fn({ destination: { url }, cancelable: true, preventDefault: () => cancelled.push(url) }),
      );
    }
    expect(cancelled).toEqual(["https://www.google.com/search?q=1", "https://evil.test/"]);
  });
});

describe("captcha detection table (pages after the widened reload)", () => {
  it("finds a reCAPTCHA checkbox by its anchor iframe and returns the iframe's box", () => {
    expect(detect(recaptchaPage())).toMatchObject({
      kind: "checkbox",
      vendor: "recaptcha",
      box: { x: 100, y: 200, width: 304, height: 78 },
    });
  });

  it("treats a visible reCAPTCHA image challenge (after the checkbox) as unknown", () => {
    expect(detect(recaptchaPage({ challengeVisible: true }))).toMatchObject({
      kind: "unknown",
      vendor: "recaptcha",
    });
  });

  it("does not report a checkbox whose response token is already filled in", () => {
    expect(detect(recaptchaPage({ token: "03AFcWeA-token" }))).toMatchObject({ kind: "none" });
  });

  it("ignores the invisible reCAPTCHA badge", () => {
    const badge: FakeDocumentSpec = {
      title: "An article",
      body: [
        {
          tag: "div",
          attrs: { class: "grecaptcha-badge" },
          children: [
            {
              tag: "iframe",
              attrs: { src: RECAPTCHA_ANCHOR.replace("size=normal", "size=invisible") },
              rect: rect(1000, 700, 256, 60),
            },
          ],
        },
      ],
    };
    expect(detect(badge)).toMatchObject({ kind: "none" });
  });

  it("finds an hCaptcha checkbox and ignores its hidden challenge frame", () => {
    expect(detect(HCAPTCHA)).toMatchObject({
      kind: "checkbox",
      vendor: "hcaptcha",
      box: { x: 20, y: 300, width: 303, height: 78 },
    });
  });

  it("finds a Turnstile checkbox by its iframe, or by its container when the iframe is in a closed shadow root", () => {
    expect(detect(CLOUDFLARE_TURNSTILE)).toMatchObject({
      kind: "checkbox",
      vendor: "turnstile",
      box: { x: 150, y: 320, width: 300, height: 65 },
    });
    expect(detect(TURNSTILE_SHADOW)).toMatchObject({
      kind: "checkbox",
      vendor: "turnstile",
      box: { x: 40, y: 500, width: 300, height: 65 },
    });
  });

  it("finds Turnstile on Cloudflare's own challenge page by the shadow host around its hidden field", () => {
    const page: FakeDocumentSpec = {
      title: "Just a moment...",
      body: [
        {
          tag: "div",
          attrs: { id: "challenge-stage" },
          rect: rect(0, 0, 800, 300),
          children: [
            {
              tag: "div",
              rect: rect(250, 200, 300, 65),
              children: [
                {
                  tag: "input",
                  attrs: { type: "hidden", name: "cf-turnstile-response", id: "cf-chl-widget-a1_response" },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(detect(page)).toMatchObject({
      kind: "checkbox",
      vendor: "turnstile",
      box: { x: 250, y: 200, width: 300, height: 65 },
    });
  });

  it("never treats a page-sized container as a clickable widget", () => {
    const page: FakeDocumentSpec = {
      title: "Sign up",
      body: [{ tag: "input", attrs: { type: "hidden", name: "cf-turnstile-response" } }],
    };
    expect(detect(page)).toMatchObject({ kind: "none" });
  });

  it("finds a GeeTest slider and drags from the handle's center to the track's end", () => {
    expect(detect(GEETEST_SLIDER)).toMatchObject({
      kind: "slider",
      vendor: "geetest",
      from: { x: 520, y: 420 },
      to: { x: 780, y: 420 },
    });
  });

  it("finds a text captcha: an image next to a text input and a submit control", () => {
    expect(detect(textCaptchaPage())).toMatchObject({
      kind: "text",
      image: { x: 40, y: 100, width: 200, height: 70 },
    });
    // Without a submit control it is not a text captcha the solver can answer.
    expect(detect(textCaptchaPage(false)).kind).not.toBe("text");
  });

  it("reports a DataDome captcha frame as unknown: its slider is inside the cross-origin frame", () => {
    expect(detect(DATADOME_CAPTCHA)).toMatchObject({ kind: "unknown", vendor: "datadome" });
  });

  it("reports auto-resolving interstitials (DataDome device check, Cloudflare check) as pending", () => {
    expect(detect(DATADOME_INTERSTITIAL)).toMatchObject({ kind: "pending", vendor: "datadome" });
    expect(detect(CLOUDFLARE_RUNNING)).toMatchObject({ kind: "pending" });
  });

  it("reports a block page without a widget as unknown and an ordinary page as none", () => {
    expect(detect(ACCESS_DENIED)).toMatchObject({ kind: "unknown" });
    expect(detect(ARTICLE)).toMatchObject({ kind: "none", vendor: null });
    expect(detect({ body: [] })).toMatchObject({ kind: "none" });
  });

  it("keeps the table fixed in code and serializable into the REPL call", () => {
    expect(Object.isFrozen(CAPTCHA_WIDGETS)).toBe(true);
    expect(JSON.parse(JSON.stringify(CAPTCHA_WIDGETS))).toEqual(CAPTCHA_WIDGETS);
  });
});

// ---------------------------------------------------------------------------------------------

function setup(
  options: { captcha?: boolean; warmTabTtlMs?: number; timings?: Partial<CaptchaTimings> } = {},
) {
  const repl = new FakeAsideRepl(options.captcha === false ? { captcha: false } : {});
  const info = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  const logger: Logger = { debug, info, warn, error: vi.fn() };
  const port = new AsideBrowserPort({
    repl,
    logger,
    warmTabTtlMs: options.warmTabTtlMs ?? 0,
    stepTimeoutMs: 5000,
    captchaTimings: { ...FAST, ...options.timings },
  });
  return { repl, port, info, warn, debug, logger };
}

const NORMAL_PATTERNS = blockedUrlPatterns([SITE]);
const WIDENED_PATTERNS = blockedUrlPatterns([SITE], CAPTCHA_VENDOR_HOSTS);

function expectNormalGuard(page: FakePage) {
  expect(page.blockPatterns).toEqual(NORMAL_PATTERNS);
  expect(page.initScripts).toHaveLength(2);
  expect(page.guardCsp()).toBe(buildGuardCsp([SITE]));
  for (const s of page.initScripts) {
    for (const h of CAPTCHA_VENDOR_HOSTS) expect(s.source).not.toContain(h.host);
  }
}

describe("AsideBrowserPort.solveChallenge", () => {
  it("clicks a checkbox in a fresh tab widened to the vendor hosts, then restores the tab's filter and guard", async () => {
    const { repl, port, info } = setup({ warmTabTtlMs: 60_000 });
    repl.documents.set(URL1, recaptchaPage());
    repl.captchaHandlers.click = (page) => page.show(ARTICLE);
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toEqual({
      solved: true,
      kind: "checkbox",
      rounds: 1,
      available: true,
      message: expect.stringContaining("re-run") as string,
    });
    expect(repl.captchaCalls).toHaveLength(1);
    const call = repl.captchaCalls[0]!;
    expect(call.method).toBe("click");
    expect(call.args).toEqual([{ x: 100, y: 200, width: 304, height: 78 }]);
    // Widened only while the attempt ran.
    expect(call.blockPatterns).toEqual(WIDENED_PATTERNS);
    expect(call.guardCsp).toBe(buildGuardCsp([SITE], CAPTCHA_VENDOR_HOSTS));
    const page = repl.pages.get(call.targetId)!; // kept warm for the adapter's re-run
    expectNormalGuard(page);
    // Opened with the normal filter and guard, adopted, widened, then reloaded.
    expect(page.navigations).toEqual([URL1, URL1]);
    expect(repl.userTab.navigations).toEqual([]);
    expect(info).toHaveBeenCalledWith("captcha attempt", {
      site: "example",
      kind: "checkbox",
      rounds: 1,
      result: "solved",
      durationMs: expect.any(Number) as number,
      message: r.message,
    });
    await port.shutdown();
  });

  it("widens the adapter's own tab, reloads the challenge URL, acts, and restores the original filter and guard", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, recaptchaPage());
    const session = await port.openSession(scope);
    const tab = await session.openTab(URL1);
    const page = repl.pages.get(tab.id)!;
    // The adapter's load: the vendor widget was blocked by the filter and the guard CSP.
    expect(page.dom!.querySelectorAll("iframe")).toHaveLength(0);
    const before = page.initScripts.map((s) => s.identifier);

    repl.captchaHandlers.click = (p) => p.show(ARTICLE);
    const r = await port.solveChallenge({ scope, tab, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: true, kind: "checkbox", rounds: 1 });
    expect(repl.captchaCalls.map((c) => c.targetId)).toEqual([tab.id]);
    expect(repl.captchaCalls[0]!.blockPatterns).toEqual(WIDENED_PATTERNS);
    expect(page.navigations).toEqual([URL1, URL1]); // reloaded once, after widening
    // The registered init scripts were removed (narrow on widening, widened on restore) and replaced.
    expect(page.removedScripts.slice(0, 2)).toEqual(before);
    expect(page.removedScripts).toHaveLength(4);
    expectNormalGuard(page);
    expect(repl.pages.has(tab.id)).toBe(true); // the caller's tab stays open
    expect(repl.pages.size).toBe(1); // no extra tab
    await session.dispose();
  });

  it("drags a slider from its handle to the end of its track", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, GEETEST_SLIDER);
    repl.captchaHandlers.drag = (page) => page.show(ARTICLE);
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: true, kind: "slider", rounds: 1, available: true });
    expect(repl.captchaCalls.map((c) => c.method)).toEqual(["drag"]);
    expect(repl.captchaCalls[0]!.args.slice(0, 2)).toEqual([
      { x: 520, y: 420 },
      { x: 780, y: 420 },
    ]);
  });

  it("reads a text captcha from the cropped image only, types the answer, and submits it", async () => {
    const { repl, port, info, warn, debug } = setup();
    repl.documents.set(URL1, textCaptchaPage());
    repl.captchaHandlers.readText = () => " AB 12c ";
    const submitted: Array<Record<string, string>> = [];
    repl.onFormSubmit = (page) => {
      submitted.push(page.dom!.submissions.at(-1)!);
      page.show(ARTICLE);
    };
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: true, kind: "text", rounds: 1 });
    expect(repl.captchaCalls.map((c) => c.method)).toEqual(["readText"]);
    expect(repl.captchaCalls[0]!.args).toEqual([{ x: 40, y: 100, width: 200, height: 70 }]);
    expect(submitted).toEqual([{ answer: "AB12c" }]);
    // The answer and page content never reach logs or the REPL result.
    const logged = JSON.stringify([info.mock.calls, warn.mock.calls, debug.mock.calls]);
    expect(logged).not.toContain("AB12c");
    expect(logged).not.toContain("Security check");
    expect(JSON.stringify(r)).not.toContain("AB12c");
  });

  it("reports a text captcha as unsolved when Aside has no vision model configured", async () => {
    const { repl, port, info } = setup();
    repl.documents.set(URL1, textCaptchaPage());
    const submitted: unknown[] = [];
    repl.onFormSubmit = (p) => submitted.push(p.targetId);
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toEqual({
      solved: false,
      kind: "text",
      rounds: 0,
      available: true,
      message: "text captcha: no vision model is configured in Aside",
    });
    expect(repl.captchaCalls.map((c) => c.method)).toEqual(["readText"]);
    expect(submitted).toEqual([]);
    // The solver's fixed message reaches the log line (it is never page content).
    expect(info).toHaveBeenCalledWith(
      "captcha attempt",
      expect.objectContaining({
        kind: "text",
        result: "unsolved",
        rounds: 0,
        message: "text captcha: no vision model is configured in Aside",
      }),
    );
  });

  it("stops after the checkbox when an image challenge follows (unknown, no further action)", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, recaptchaPage());
    repl.captchaHandlers.click = (page) => page.show(recaptchaPage({ challengeVisible: true }));
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: false, kind: "unknown", rounds: 1, available: true });
    expect(repl.captchaCalls).toHaveLength(1);
  });

  it("takes no action on a block page it does not recognize", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, ACCESS_DENIED);
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: false, kind: "unknown", rounds: 0, available: true });
    expect(repl.captchaCalls).toEqual([]);
  });

  it("takes no action on a DataDome frame (its slider is in a cross-origin frame)", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, DATADOME_CAPTCHA);
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: false, kind: "unknown", rounds: 0 });
    expect(repl.captchaCalls).toEqual([]);
  });

  it("reports kind none when the page shows no challenge after the reload", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, ARTICLE);
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: false, kind: "none", rounds: 0, available: true });
    expect(repl.captchaCalls).toEqual([]);
  });

  it("waits for an auto-resolving interstitial within the pending window", async () => {
    const { repl, port } = setup({ timings: { pendingWaitMs: 3000, pollMs: 20 } });
    repl.documents.set(URL1, DATADOME_INTERSTITIAL);
    const opened = new Promise<FakePage>((resolve) => {
      const iv = setInterval(() => {
        const p = [...repl.pages.values()][0];
        if (p?.dom) {
          clearInterval(iv);
          resolve(p);
        }
      }, 5);
    });
    void opened.then((p) => setTimeout(() => p.show(ARTICLE), 100));
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: false, kind: "none", rounds: 0 });
  });

  it("reports unavailable without opening a tab when Aside has no captcha capability", async () => {
    const { repl, port, info } = setup({ captcha: false });
    repl.documents.set(URL1, recaptchaPage());
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toEqual({
      solved: false,
      kind: "unknown",
      rounds: 0,
      available: false,
      message: "captcha solving is not available in this Aside version",
    });
    expect(repl.pages.size).toBe(0);
    expect(repl.cdpLog).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "captcha attempt",
      expect.objectContaining({
        site: "example",
        result: "unavailable",
        rounds: 0,
        message: "captcha solving is not available in this Aside version",
      }),
    );
  });

  it(`performs at most ${MAX_CAPTCHA_ROUNDS} action rounds`, async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, recaptchaPage());
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: false, kind: "checkbox", rounds: MAX_CAPTCHA_ROUNDS });
    expect(repl.captchaCalls).toHaveLength(MAX_CAPTCHA_ROUNDS);
  });

  it("stops when the budget cannot cover another round, and still restores the tab", async () => {
    const { repl, port } = setup({ warmTabTtlMs: 60_000, timings: { minRoundMs: 1000 } });
    repl.documents.set(URL1, recaptchaPage());
    repl.captchaHandlers.click = () => new Promise((resolve) => setTimeout(resolve, 300));
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 1200 });
    expect(r).toMatchObject({ solved: false, kind: "checkbox", rounds: 1 });
    expect(r.message).toMatch(/time/);
    expect(repl.captchaCalls).toHaveLength(1);
    expectNormalGuard(repl.pages.get(repl.captchaCalls[0]!.targetId)!);
    await port.shutdown();
  });

  it("returns unsolved without touching the browser when the budget is already spent", async () => {
    const { repl, port } = setup();
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 0 });
    expect(r).toEqual({
      solved: false,
      kind: "unknown",
      rounds: 0,
      available: true,
      message: "detection did not finish in time",
    });
    expect(repl.pages.size).toBe(0);
  });

  it("closes the tab instead of keeping it warm when its widened guard cannot be removed", async () => {
    const { repl, port } = setup({ warmTabTtlMs: 60_000 });
    repl.documents.set(URL1, recaptchaPage());
    let id = "";
    repl.captchaHandlers.click = (page) => {
      id = page.targetId;
      page.failScriptRemoval = true;
    };
    await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(id).not.toBe("");
    expect(repl.pages.has(id)).toBe(false);
    await port.shutdown();
  });

  it("uses a fresh tab when the given tab is not a usable tab of this scope (never the user's tab)", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, recaptchaPage());
    repl.captchaHandlers.click = (page) => page.show(ARTICLE);
    const r = await port.solveChallenge({
      scope,
      tab: { id: "USER-TAB", url: "https://mail.example.org/inbox" },
      url: URL1,
      budgetMs: 10_000,
    });
    expect(r.solved).toBe(true);
    expect(repl.captchaCalls[0]!.targetId).not.toBe("USER-TAB");
    expect(repl.userTab.navigations).toEqual([]);
    expect(repl.userTab.initScripts).toEqual([]);

    // A tab of another site's session is not used either.
    const other = await port.openSession({ siteKey: "other", hostnames: ["other.test"] });
    repl.documents.set("https://other.test/", ARTICLE);
    const otherTab = await other.openTab("https://other.test/");
    repl.captchaHandlers.click = (page) => page.show(ARTICLE);
    await port.solveChallenge({ scope, tab: otherTab, url: URL1, budgetMs: 10_000 });
    expect(repl.captchaCalls.at(-1)!.targetId).not.toBe(otherTab.id);
    expect(repl.pages.get(otherTab.id)!.blockPatterns).toEqual(blockedUrlPatterns(["other.test"]));
    await other.dispose();
  });

  it("rejects a challenge URL outside the scope before reaching the REPL", async () => {
    const { repl, port, warn } = setup();
    await expect(
      port.solveChallenge({ scope, url: "https://www.google.com/recaptcha/api2/demo", budgetMs: 10_000 }),
    ).rejects.toMatchObject({ status: "adapter_error" });
    expect(repl.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "browser shim violation",
      expect.objectContaining({ site: "example", kind: "captcha" }),
    );
  });

  it("waits the politeness interval once per load and before the action, never twice", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, recaptchaPage());
    const clicks: number[] = [];
    repl.captchaHandlers.click = (page) => {
      clicks.push(Date.now());
      page.show(ARTICLE);
    };
    const loadTimes = () => repl.loads.map((l) => l.at);
    const interval = 300;
    const scheduler = new InMemoryScheduler();

    // The adapter's tab: its load, then the attempt's reload of the widened tab, then the click.
    await scheduler.runForSite(
      { site: "example", holder: "read", acquireTimeoutMs: 5000, minIntervalMs: interval },
      async (lease) => {
        const session = await port.openSession({ ...scope, lease });
        const tab = await session.openTab(URL1);
        const r = await port.solveChallenge({ scope: { ...scope, lease }, tab, url: URL1, budgetMs: 10_000 });
        expect(r.solved).toBe(true);
        await session.dispose();
      },
    );
    let loads = loadTimes();
    expect(loads).toHaveLength(2);
    expect(clicks).toHaveLength(1);
    // One interval between the loads and one before the click (a double wait would make them 600 ms).
    expect(loads[1]! - loads[0]!).toBeGreaterThanOrEqual(interval - 20);
    expect(loads[1]! - loads[0]!).toBeLessThan(2 * interval - 50);
    expect(clicks[0]! - loads[1]!).toBeGreaterThanOrEqual(interval - 20);
    expect(clicks[0]! - loads[1]!).toBeLessThan(2 * interval - 50);

    // A fresh tab: its first load at once, the widened reload one interval later.
    repl.loads.length = 0;
    clicks.length = 0;
    let start = 0;
    await scheduler.runForSite(
      { site: "example", holder: "captcha", acquireTimeoutMs: 5000, minIntervalMs: interval },
      async (lease) => {
        start = Date.now();
        const r = await port.solveChallenge({ scope: { ...scope, lease }, url: URL1, budgetMs: 10_000 });
        expect(r.solved).toBe(true);
      },
    );
    loads = loadTimes();
    expect(loads).toHaveLength(2);
    expect(loads[0]! - start).toBeLessThan(interval - 50);
    expect(loads[1]! - loads[0]!).toBeGreaterThanOrEqual(interval - 20);
    expect(loads[1]! - loads[0]!).toBeLessThan(2 * interval - 50);
    expect(clicks[0]! - loads[1]!).toBeGreaterThanOrEqual(interval - 20);
  });
});

describe("the detection budget of a quick attempt", () => {
  const DETECT_LATE = "detection did not finish in time";

  /** Runs one attempt as a pool task of the site with the given politeness interval. */
  async function inPool(
    port: AsideBrowserPort,
    minIntervalMs: number,
    options: { budgetMs: number; detectBudgetMs?: number; tab?: boolean },
  ) {
    const scheduler = new InMemoryScheduler();
    return scheduler.runForSite(
      { site: "example", holder: "captcha", acquireTimeoutMs: 5000, minIntervalMs },
      async (lease) => {
        const started = Date.now();
        const r = await port.solveChallenge({
          scope: { ...scope, lease },
          url: URL1,
          budgetMs: options.budgetMs,
          ...(options.detectBudgetMs !== undefined ? { detectBudgetMs: options.detectBudgetMs } : {}),
        });
        return { r, ms: Date.now() - started };
      },
    );
  }

  it("has a fixed message for a detection that did not finish in time", () => {
    expect(CAPTCHA_MESSAGES.detectLate).toBe(DETECT_LATE);
  });

  it("covers the politeness wait before the widened reload: unknown, no action, the tab restored", async () => {
    const { repl, port, info } = setup();
    repl.documents.set(URL1, recaptchaPage());
    // The fresh tab loads at once; its widened reload would wait 5 s for the site's interval.
    const { r, ms } = await inPool(port, 5000, { budgetMs: 10_000, detectBudgetMs: 300 });
    expect(r).toEqual({ solved: false, kind: "unknown", rounds: 0, available: true, message: DETECT_LATE });
    expect(ms).toBeLessThan(2000);
    expect(repl.captchaCalls).toEqual([]);
    expect(repl.loads).toHaveLength(1); // the reload never went out
    expectNoWidenedTab(repl);
    expect(info).toHaveBeenCalledWith(
      "captcha attempt",
      expect.objectContaining({ kind: "unknown", rounds: 0, result: "unsolved", message: DETECT_LATE }),
    );
    await port.shutdown();
  });

  it("is clipped to the attempt's own budget", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, recaptchaPage());
    const { r, ms } = await inPool(port, 5000, { budgetMs: 300, detectBudgetMs: 20_000 });
    expect(r).toMatchObject({ solved: false, kind: "unknown", rounds: 0, message: DETECT_LATE });
    expect(ms).toBeLessThan(2000);
    expectNoWidenedTab(repl);
    await port.shutdown();
  });

  it("covers the interstitial wait: an automatic check still running when it ends is unknown, no action", async () => {
    const { repl, port } = setup({ timings: { pendingWaitMs: 3000, pollMs: 20 } });
    repl.documents.set(URL1, DATADOME_INTERSTITIAL);
    const started = Date.now();
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000, detectBudgetMs: 1500 });
    expect(r).toEqual({ solved: false, kind: "unknown", rounds: 0, available: true, message: DETECT_LATE });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(repl.captchaCalls).toEqual([]);
    expectNoWidenedTab(repl);
    // Without a separate detection budget the attempt waits the whole pending window first.
    const slow = setup({ timings: { pendingWaitMs: 600, pollMs: 20 } });
    slow.repl.documents.set(URL1, DATADOME_INTERSTITIAL);
    const r2 = await slow.port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r2).toMatchObject({ kind: "unknown", rounds: 0, message: CAPTCHA_MESSAGES.pending });
  });

  it("action rounds after the detection use the rest of the attempt budget", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, recaptchaPage());
    repl.captchaHandlers.click = (page) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          page.show(ARTICLE);
          resolve();
        }, 1200),
      );
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000, detectBudgetMs: 800 });
    expect(r).toMatchObject({ solved: true, kind: "checkbox", rounds: 1 });
    expect(repl.captchaCalls).toHaveLength(1);
    expectNoWidenedTab(repl);
  });

  it("a detection that finishes in time is acted on as before (kind none, unknown, checkbox)", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, ACCESS_DENIED);
    expect(
      await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000, detectBudgetMs: 5000 }),
    ).toMatchObject({
      solved: false,
      kind: "unknown",
      rounds: 0,
      message: expect.stringContaining("cannot handle") as string,
    });
    repl.documents.set(URL1, ARTICLE);
    expect(
      await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000, detectBudgetMs: 5000 }),
    ).toMatchObject({
      kind: "none",
      rounds: 0,
    });
  });
});

/**
 * A REPL client that lets the REPL run a call whose title matches, then reports it cut short, as when
 * the bridge side gives up (abort or budget) while the REPL has already changed the tab.
 */
function cutShortAfter(repl: FakeAsideRepl, title: RegExp, onCut: () => void = () => {}): ReplClient {
  let cut = false;
  return {
    account: repl.account,
    generation: () => repl.generation(),
    ensureReady: () => repl.ensureReady(),
    close: () => repl.close(),
    async call(request) {
      const res = await repl.call(request);
      if (!cut && title.test(request.title)) {
        cut = true;
        onCut();
        throw new OutcomeError("timeout", "browser step cancelled (time budget spent)");
      }
      return res;
    },
  };
}

function cutShortPort(repl: FakeAsideRepl, title: RegExp, onCut?: () => void) {
  return new AsideBrowserPort({
    repl: cutShortAfter(repl, title, onCut),
    warmTabTtlMs: 60_000,
    stepTimeoutMs: 5000,
    captchaTimings: FAST,
  });
}

/** No tab is left open with the vendor hosts in its filter or guard. */
function expectNoWidenedTab(repl: FakeAsideRepl) {
  for (const p of repl.pages.values()) expectNormalGuard(p);
}

describe("challenge attempts never leave a widened tab behind", () => {
  it("closes the adapter's tab when the attempt is abandoned while the widening call runs", async () => {
    const repl = new FakeAsideRepl();
    repl.documents.set(URL1, recaptchaPage());
    const controller = new AbortController();
    const port = cutShortPort(repl, /captcha widen tab/, () => controller.abort());
    const session = await port.openSession(scope);
    const tab = await session.openTab(URL1);
    const page = repl.pages.get(tab.id)!;
    const r = await port.solveChallenge({
      scope: { ...scope, signal: controller.signal },
      tab,
      url: URL1,
      budgetMs: 10_000,
    });
    expect(r).toMatchObject({ solved: false, rounds: 0, available: true });
    // The REPL did widen it before the bridge gave up: the tab must be gone, not left widened.
    expect(page.blockPatterns).toEqual(WIDENED_PATTERNS);
    expect(repl.pages.has(tab.id)).toBe(false);
    expect(repl.captchaCalls).toEqual([]);
    // The session forgot it: dispose neither keeps it warm nor touches it again.
    await session.dispose();
    expect(repl.pages.size).toBe(0);
    await port.shutdown();
  });

  it("closes the adapter's tab when the widening call's budget runs out (its effect is unknown)", async () => {
    const repl = new FakeAsideRepl();
    repl.documents.set(URL1, recaptchaPage());
    const port = cutShortPort(repl, /captcha widen tab/);
    const session = await port.openSession(scope);
    const tab = await session.openTab(URL1);
    const r = await port.solveChallenge({ scope, tab, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: false, rounds: 0 });
    expect(r.message).toMatch(/time/);
    expect(repl.pages.has(tab.id)).toBe(false);
    expectNoWidenedTab(repl);
    await session.dispose();
    await port.shutdown();
  });

  it("closes a fresh tab cut short while widening instead of keeping it warm", async () => {
    const repl = new FakeAsideRepl();
    repl.documents.set(URL1, recaptchaPage());
    const controller = new AbortController();
    const port = cutShortPort(repl, /captcha widen tab/, () => controller.abort());
    const r = await port.solveChallenge({
      scope: { ...scope, signal: controller.signal },
      url: URL1,
      budgetMs: 10_000,
    });
    expect(r).toMatchObject({ solved: false, rounds: 0 });
    expect(repl.closedTabs).toHaveLength(1);
    expect(repl.pages.size).toBe(0);
    // Nothing warm is handed to the next session of the site.
    const next = await port.openSession(scope);
    const tab = await next.openTab(URL1);
    expect(tab.id).not.toBe(repl.closedTabs[0]);
    expectNormalGuard(repl.pages.get(tab.id)!);
    await next.dispose();
    await port.shutdown();
  });

  it("closes and forgets the attempt's tab when the attempt is abandoned later (site removed)", async () => {
    const repl = new FakeAsideRepl();
    repl.documents.set(URL1, recaptchaPage());
    const controller = new AbortController();
    const port = cutShortPort(repl, /captcha detect/, () => controller.abort());
    const r = await port.solveChallenge({
      scope: { ...scope, signal: controller.signal },
      url: URL1,
      budgetMs: 10_000,
    });
    expect(r).toMatchObject({ solved: false, rounds: 0 });
    // Abandoned: closed rather than restored and kept warm.
    expect(repl.pages.size).toBe(0);
    expect(repl.closedTabs).toHaveLength(1);
    await port.shutdown();
  });

  it("still keeps a fresh tab warm, restored, after an attempt that ran to its end", async () => {
    const repl = new FakeAsideRepl();
    repl.documents.set(URL1, ARTICLE);
    const port = new AsideBrowserPort({
      repl,
      warmTabTtlMs: 60_000,
      stepTimeoutMs: 5000,
      captchaTimings: FAST,
    });
    const r = await port.solveChallenge({ scope, url: URL1, budgetMs: 10_000 });
    expect(r).toMatchObject({ solved: false, kind: "none" });
    expect(repl.pages.size).toBe(1);
    expectNoWidenedTab(repl);
    const session = await port.openSession(scope);
    const tab = await session.openTab(URL1);
    expect(repl.pages.size).toBe(1); // the warm tab was taken
    expectNormalGuard(repl.pages.get(tab.id)!);
    await session.dispose();
    await port.shutdown();
  });
});

describe("adapter scripts stay restricted", () => {
  it("cannot name the captcha global or reach vendor hosts, before and after an attempt", async () => {
    const { repl, port } = setup();
    repl.documents.set(URL1, recaptchaPage());
    const session = await port.openSession(scope);
    const tab = await session.openTab(URL1);
    const probe = async () => {
      await expect(session.runScript("return typeof captcha;", { tab })).resolves.toBe("undefined");
      // The tab blocks it; the step fails as a bot check (blocked access_denied), never reaching the host.
      await expect(
        session.runScript(
          `return await page.evaluate(async () => { try { await fetch("https://www.google.com/recaptcha/api.js"); } catch (e) {} return 1; });`,
          { tab },
        ),
      ).rejects.toMatchObject({ status: "access_denied", blocked: true });
      expect(repl.pageRequests.some((u) => u.includes("google.com"))).toBe(false);
      await expect(
        session.runScript(
          `try { await fetch("https://geo.captcha-delivery.com/captcha/"); } catch (e) {} return 1;`,
          {
            tab,
          },
        ),
      ).rejects.toMatchObject({ status: "adapter_error" });
    };
    await probe();
    repl.captchaHandlers.click = (p) => p.show(ARTICLE);
    await port.solveChallenge({ scope, tab, url: URL1, budgetMs: 10_000 });
    await probe();
    // No script call ever ran with the vendor hosts in its filter or guards.
    const scriptCalls = repl.calls.filter((x) => x.title.includes("page script"));
    expect(scriptCalls.length).toBeGreaterThan(0);
    for (const c of scriptCalls) {
      const line = c.code.split("\n").find((l) => l.startsWith("const __brbEnv = "))!;
      const env = JSON.parse(line.slice("const __brbEnv = ".length, -1)) as {
        blockPatterns: unknown;
        isolatedGuard: string;
        mainGuard: string;
        captcha: unknown;
      };
      expect(env.blockPatterns).toEqual(NORMAL_PATTERNS);
      expect(env.isolatedGuard).toContain(JSON.stringify(buildGuardCsp([SITE])));
      expect(env.mainGuard).toContain("const V = [];");
      expect(env.captcha).toBeNull();
    }
    await session.dispose();
  });

  it("keeps captcha shadowed: it is a known REPL global, not a standard one", () => {
    expect(KNOWN_REPL_GLOBALS).toContain("captcha");
    expect(STANDARD_GLOBALS).not.toContain("captcha");
    expect(shadowParams()).toContain("captcha");
  });
});

describe("solver REPL code", () => {
  it("is one awaited async IIFE with no top-level declarations", () => {
    const code = buildReplCode(
      { kind: "captcha", targetId: "T1", step: { action: "probe" } },
      {
        nonce: "abc",
        hostnames: [SITE],
        deadlineMs: 5000,
        notBefore: 0,
        minIntervalMs: 0,
        instanceId: "t3st",
        extraHosts: CAPTCHA_VENDOR_HOSTS,
      },
    );
    const sf = ts.createSourceFile(
      "repl.mjs",
      `${code}\nexport {};`,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    expect((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).toEqual([]);
    expect(sf.statements).toHaveLength(2);
    const stmt = sf.statements[0]!;
    expect(ts.isExpressionStatement(stmt)).toBe(true);
    expect(ts.isAwaitExpression((stmt as ts.ExpressionStatement).expression)).toBe(true);
  });

  it("never uses the REPL's global page or tabs", () => {
    expect(CAPTCHA_STEP_SOURCE).not.toMatch(/\bpage\b/);
    expect(CAPTCHA_STEP_SOURCE).not.toMatch(/\btabs\b/);
    expect(CAPTCHA_PAGE_SOURCE).not.toMatch(/\bcaptcha\.(click|drag|readText)\b/);
  });

  it("has a 45-second default budget", () => {
    expect(DEFAULT_CAPTCHA_BUDGET_MS).toBe(45_000);
  });
});

describe("browser:captcha-check arguments", () => {
  it("takes the URL's host as the ad-hoc scope and the account from --account, ASIDE_ACCOUNT, then u0", () => {
    expect(parseCaptchaCheckArgs(["https://www.Example.com/demo?x=1"], {})).toEqual({
      url: "https://www.example.com/demo?x=1",
      host: "www.example.com",
      account: "u0",
    });
    expect(
      parseCaptchaCheckArgs(["https://example.com/", "--account", "u2"], { ASIDE_ACCOUNT: "u1" }),
    ).toMatchObject({
      account: "u2",
    });
    expect(parseCaptchaCheckArgs(["--account", "u3", "https://example.com/"], {})).toMatchObject({
      url: "https://example.com/",
      account: "u3",
    });
    expect(parseCaptchaCheckArgs(["https://example.com/"], { ASIDE_ACCOUNT: "u1" })).toMatchObject({
      account: "u1",
    });
  });

  it("reports setup errors instead of running", () => {
    for (const argv of [
      [],
      ["not a url"],
      ["ftp://example.com/"],
      ["https://example.com/", "--account"],
      ["https://example.com/", "--budget", "5"],
      ["https://a.test/", "https://b.test/"],
    ]) {
      expect(parseCaptchaCheckArgs(argv, {})).toHaveProperty("error");
    }
  });
});

describe("REPL runtime ops for challenge attempts", () => {
  const ctx = (nonce: string, widened: boolean) => ({
    nonce,
    hostnames: [SITE],
    deadlineMs: 5000,
    notBefore: 0,
    minIntervalMs: 0,
    instanceId: "t3st",
    extraHosts: widened ? CAPTCHA_VENDOR_HOSTS : undefined,
  });
  async function runOp(repl: FakeAsideRepl, op: Parameters<typeof buildReplCode>[0], widened = false) {
    const nonce = `n${Math.random().toString(36).slice(2)}`;
    const res = await repl.call({
      title: "t",
      code: buildReplCode(op, ctx(nonce, widened)),
      timeoutMs: 10_000,
    });
    return parseReplOutput(res.text, nonce) as { ok: boolean; kind?: string; value?: unknown } | null;
  }
  async function openTab(repl: FakeAsideRepl): Promise<string> {
    const env = await runOp(repl, { kind: "open", url: URL1 });
    return (env!.value as { targetId: string }).targetId;
  }

  it("never re-guards or acts on a tab the bridge did not open (the user's tab)", async () => {
    const repl = new FakeAsideRepl();
    const g = await runOp(
      repl,
      { kind: "guard", targetId: "USER-TAB", onSite: false, closeIfStuck: true },
      true,
    );
    expect(g).toMatchObject({ ok: true, value: { replaced: false, closed: false, reason: "gone" } });
    const c = await runOp(repl, {
      kind: "captcha",
      targetId: "USER-TAB",
      step: { action: "detect", noneWaitMs: 0, pendingWaitMs: 0, pollMs: 10 },
    });
    expect(c).toMatchObject({ ok: false, kind: "tab_gone" });
    expect(repl.userTab.initScripts).toEqual([]);
    expect(repl.userTab.blockPatterns).toEqual([]);
    expect(repl.captchaCalls).toEqual([]);
  });

  it("refuses to widen a tab whose guard scripts are unknown, and closes it when restoring", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    vm.runInContext(`__brbInit.delete(${JSON.stringify(id)})`, repl.context);
    const widen = await runOp(repl, { kind: "guard", targetId: id, onSite: true, closeIfStuck: false }, true);
    expect(widen).toMatchObject({ ok: true, value: { replaced: false, closed: false } });
    expect(repl.pages.get(id)!.blockPatterns).toEqual(NORMAL_PATTERNS); // untouched
    const restore = await runOp(repl, { kind: "guard", targetId: id, onSite: false, closeIfStuck: true });
    expect(restore).toMatchObject({ ok: true, value: { replaced: false, closed: true } });
    expect(repl.pages.has(id)).toBe(false);
  });

  it("does not widen a tab that left the site", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    await repl.pages.get(id)!.goto("about:blank");
    const widen = await runOp(repl, { kind: "guard", targetId: id, onSite: true, closeIfStuck: false }, true);
    expect(widen).toMatchObject({ ok: true, value: { replaced: false, reason: "off-site" } });
    expect(repl.pages.get(id)!.blockPatterns).toEqual(NORMAL_PATTERNS);
  });

  it("keeps the registered init-script identifiers out of reach of page scripts", async () => {
    const repl = new FakeAsideRepl();
    await openTab(repl);
    const keys = vm.runInContext("Object.keys(globalThis)", repl.context) as string[];
    expect(keys).not.toContain("__brbInit");
    expect(shadowParams()).not.toContain("__brbInit");
  });
});
