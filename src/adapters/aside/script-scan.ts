/**
 * Static scan of page scripts before they are sent to the Aside REPL.
 *
 * The scan is deliberately conservative: it works on the raw text (strings and comments included)
 * plus a copy with `\u`/`\x` escapes decoded, so a forbidden name cannot hide behind an escape or
 * inside a string used as a computed key. A rejected script fails with `adapter_error`; the
 * onboarding agent rewrites it.
 */

export interface ScanViolation {
  rule: "forbidden-identifier" | "computed-key" | "too-large";
  detail: string;
  /** 1-based line in the original script, when known. */
  line?: number | undefined;
}

export const MAX_PAGE_SCRIPT_CHARS = 200_000;

/**
 * REPL globals the shim shadows with `undefined`. Rejected as identifier references; allowed as a
 * property name after `.`/`?.` (`/re/.exec(s)` is fine, the global `exec` is not).
 */
export const SHADOWED_REPL_NAMES = ["fs", "aside", "require", "process", "exec", "memory_search"] as const;

/** Rejected in any position, including property names and strings (the names that reach Node, the file system, or Aside, plus known escape routes). */
export const ALWAYS_FORBIDDEN_NAMES = [
  "globalThis",
  "eval",
  "Function",
  "constructor",
  "import",
  "Reflect",
  "__proto__",
  "getPrototypeOf",
  "setPrototypeOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "fromCharCode",
  "fromCodePoint",
  "contentWindow",
  // Aside internals / tab attachment the bridge never exposes.
  "_sendToTarget",
  "frameManager",
  "attachBrowserTab",
  "attachActiveBrowserTab",
  "listBrowserTabs",
  "getTabByTargetId",
  "installPageScript",
] as const;

/** Prefix of the shim's own locals; scripts may not name them. */
export const INTERNAL_PREFIX = "__brb";

const ID_CHAR = "[A-Za-z0-9_$\\u0080-\\uFFFF]";

/** Keywords after which `[` starts an array literal, not a member access. */
const KEYWORDS_BEFORE_ARRAY = new Set([
  "return",
  "of",
  "in",
  "typeof",
  "case",
  "do",
  "else",
  "void",
  "yield",
  "await",
  "delete",
  "instanceof",
  "throw",
  "new",
]);

function decodeEscapes(src: string): string {
  return src
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)));
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanIdentifiers(src: string, out: ScanViolation[], seen: Set<string>): void {
  const push = (detail: string, index: number) => {
    if (seen.has(detail)) return;
    seen.add(detail);
    out.push({ rule: "forbidden-identifier", detail, line: lineOf(src, index) });
  };
  for (const name of ALWAYS_FORBIDDEN_NAMES) {
    const re = new RegExp(`(?<!${ID_CHAR})${escapeRegExp(name)}(?!${ID_CHAR})`, "g");
    const m = re.exec(src);
    if (m) push(name, m.index);
  }
  for (const name of SHADOWED_REPL_NAMES) {
    const re = new RegExp(`(?<!\\.\\s*)(?<!${ID_CHAR})${escapeRegExp(name)}(?!${ID_CHAR})`, "g");
    const m = re.exec(src);
    if (m) push(name, m.index);
  }
  const internal = new RegExp(`(?<!${ID_CHAR})${INTERNAL_PREFIX}${ID_CHAR}*`, "g");
  for (const m of src.matchAll(internal)) push(m[0], m.index);
}

const SINGLE_STRING_LITERAL = /^(['"])(?:(?!\1)[^\\\n])*\1$/;

/** Characters after which `/` starts a division (anything else starts a regex literal). */
const DIVISION_AFTER = /[A-Za-z0-9_$)\]]/;

/**
 * Same-length copy of the source with the contents of strings, template text, regex literals and
 * comments blanked (quote characters and `${...}` code are kept). Used to find member-access
 * brackets in code only, so CSS selectors such as `'a[href*="x"]'` are not mistaken for them.
 * When unsure whether `/` starts a regex it assumes division, which only keeps more text visible.
 */
export function maskNonCode(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const braceStack: number[] = []; // brace depth at which each open `${` returns to template text
  let depth = 0;
  let i = 0;
  let lastSignificant = "";
  const scanTemplate = (start: number): number => {
    // `start` is just after the opening backtick (or the closing `}` of a substitution).
    let k = start;
    while (k < src.length) {
      const c = src[k];
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === "`") {
        blank(start, k);
        return k + 1;
      }
      if (c === "$" && src[k + 1] === "{") {
        blank(start, k);
        braceStack.push(depth);
        depth += 1;
        return -(k + 2); // negative: continue in code mode at this index
      }
      k += 1;
    }
    blank(start, src.length);
    return src.length;
  };
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end < 0 ? src.length : end + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < src.length && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(k, src.length));
      i = k + 1;
      lastSignificant = c;
      continue;
    }
    if (c === "`") {
      const r = scanTemplate(i + 1);
      i = r < 0 ? -r : r;
      lastSignificant = r < 0 ? "{" : "`";
      continue;
    }
    if (c === "}" && braceStack.length > 0 && braceStack[braceStack.length - 1] === depth - 1) {
      braceStack.pop();
      depth -= 1;
      const r = scanTemplate(i + 1);
      i = r < 0 ? -r : r;
      lastSignificant = r < 0 ? "{" : "`";
      continue;
    }
    if (c === "/" && !DIVISION_AFTER.test(lastSignificant)) {
      // Regex literal: skip to the closing slash, honoring escapes and character classes.
      let k = i + 1;
      let inClass = false;
      while (k < src.length && src[k] !== "\n") {
        const d = src[k];
        if (d === "\\") {
          k += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        k += 1;
      }
      blank(i + 1, Math.min(k, src.length));
      i = k + 1;
      lastSignificant = "/";
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }
  return out.join("");
}

function scanComputedKeys(original: string, out: ScanViolation[]): void {
  const src = maskNonCode(original);
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== "[") continue;
    // What precedes the bracket decides member access vs array literal.
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j]!)) j -= 1;
    if (j < 0) continue;
    const prev = src[j]!;
    let member = false;
    if (prev === ")" || prev === "]") member = true;
    else if (prev === "." && src[j - 1] === "?") member = true;
    else if (/[A-Za-z0-9_$]/.test(prev)) {
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k]!)) k -= 1;
      const word = src.slice(k + 1, j + 1);
      member = !KEYWORDS_BEFORE_ARRAY.has(word);
    }
    if (!member) continue;
    // Find the matching bracket (naive about brackets inside strings; a mismatch only makes the
    // key text look odd, which is then rejected).
    let depth = 0;
    let end = -1;
    for (let k = i; k < src.length; k += 1) {
      const c = src[k];
      if (c === "[") depth += 1;
      else if (c === "]") {
        depth -= 1;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    const key = (end < 0 ? src.slice(i + 1) : src.slice(i + 1, end)).trim();
    const hasQuote = /['"`]/.test(key);
    const hasCall = key.includes("(");
    if ((hasQuote && !SINGLE_STRING_LITERAL.test(key)) || hasCall) {
      out.push({
        rule: "computed-key",
        detail: `computed property key built at runtime: [${key.length > 60 ? `${key.slice(0, 60)}…` : key}]`,
        line: lineOf(src, i),
      });
    }
  }
}

/** Returns every violation found; an empty array means the script may be sent. */
export function scanPageScript(script: string): ScanViolation[] {
  if (script.length > MAX_PAGE_SCRIPT_CHARS) {
    return [{ rule: "too-large", detail: String(script.length) }];
  }
  const out: ScanViolation[] = [];
  const seen = new Set<string>();
  scanIdentifiers(script, out, seen);
  const decoded = decodeEscapes(script);
  if (decoded !== script) scanIdentifiers(decoded, out, seen);
  scanComputedKeys(script, out);
  if (decoded !== script) {
    const before = out.length;
    const extra: ScanViolation[] = [];
    scanComputedKeys(decoded, extra);
    for (const v of extra) if (!out.slice(0, before).some((o) => o.detail === v.detail)) out.push(v);
  }
  return out;
}

export function describeViolations(violations: readonly ScanViolation[]): string {
  return violations
    .map((v) =>
      v.rule === "forbidden-identifier"
        ? `forbidden identifier "${v.detail}"${v.line ? ` (line ${v.line})` : ""}`
        : v.rule === "too-large"
          ? `script too large (${v.detail} chars, max ${MAX_PAGE_SCRIPT_CHARS})`
          : `${v.detail}${v.line ? ` (line ${v.line})` : ""}`,
    )
    .join("; ");
}
