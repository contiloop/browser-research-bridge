/**
 * A small, tolerant HTML tokenizer and entity decoder for adapters that process page HTML in the
 * bridge (no DOM there). It does not build a tree: callers keep their own stack. Raw-text elements
 * (`script`, `style`, `textarea`, `title`, `xmp`, `noembed`, `noframes`, `noscript`) are returned as
 * one start token, one text token and one end token, so their content never looks like markup.
 */

export type HtmlToken =
  | { type: "text"; text: string }
  | { type: "start"; name: string; attrs: Readonly<Record<string, string>>; selfClosing: boolean }
  | { type: "end"; name: string }
  | { type: "comment"; text: string };

/** Elements that never have content or an end tag. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "noembed",
  "noframes",
  "noscript",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200c",
  zwj: "\u200d",
  shy: "\u00ad",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bdquo: "\u201e",
  laquo: "\u00ab",
  raquo: "\u00bb",
  lsaquo: "\u2039",
  rsaquo: "\u203a",
  bull: "\u2022",
  middot: "\u00b7",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  deg: "\u00b0",
  times: "\u00d7",
  divide: "\u00f7",
  plusmn: "\u00b1",
  para: "\u00b6",
  sect: "\u00a7",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  frac12: "\u00bd",
  frac14: "\u00bc",
  frac34: "\u00be",
  larr: "\u2190",
  rarr: "\u2192",
  uarr: "\u2191",
  darr: "\u2193",
  harr: "\u2194",
  hearts: "\u2665",
  dagger: "\u2020",
  prime: "\u2032",
  Prime: "\u2033",
  minus: "\u2212",
  le: "\u2264",
  ge: "\u2265",
  ne: "\u2260",
  asymp: "\u2248",
  infin: "\u221e",
  micro: "\u00b5",
  iexcl: "\u00a1",
  iquest: "\u00bf",
  ordm: "\u00ba",
  ordf: "\u00aa",
  sup1: "\u00b9",
  sup2: "\u00b2",
  sup3: "\u00b3",
  acute: "\u00b4",
  uml: "\u00a8",
  aacute: "\u00e1",
  eacute: "\u00e9",
  iacute: "\u00ed",
  oacute: "\u00f3",
  uacute: "\u00fa",
  agrave: "\u00e0",
  egrave: "\u00e8",
  auml: "\u00e4",
  ouml: "\u00f6",
  uuml: "\u00fc",
  Auml: "\u00c4",
  Ouml: "\u00d6",
  Uuml: "\u00dc",
  szlig: "\u00df",
  ntilde: "\u00f1",
  ccedil: "\u00e7",
};

function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(cp);
}

/** Decodes character references (`&amp;`, `&#39;`, `&#x27;`, and common named entities). */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));?/g,
    (whole, dec, hex, name) => {
      if (dec !== undefined) return codePointToString(Number(dec));
      if (hex !== undefined) return codePointToString(parseInt(String(hex), 16));
      const v = NAMED_ENTITIES[String(name)];
      return v ?? whole;
    },
  );
}

const NAME_START = /[A-Za-z]/;

function parseAttributes(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1]!.toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Index of the `>` that ends a tag starting at `from`, honoring quoted attribute values. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** Splits HTML into tokens. Text tokens hold raw text (entities not decoded). */
export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end: number): void => {
    if (end > textStart) tokens.push({ type: "text", text: html.slice(textStart, end) });
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      flushText(lt);
      const close = html.indexOf("-->", lt + 4);
      const end = close < 0 ? html.length : close + 3;
      tokens.push({ type: "comment", text: html.slice(lt + 4, close < 0 ? html.length : close) });
      i = textStart = end;
      continue;
    }
    if (next === "!" || next === "?") {
      flushText(lt);
      const close = html.indexOf(">", lt);
      i = textStart = close < 0 ? html.length : close + 1;
      continue;
    }
    if (next === "/" && NAME_START.test(html[lt + 2] ?? "")) {
      flushText(lt);
      const close = html.indexOf(">", lt);
      const end = close < 0 ? html.length : close;
      const name = /^[^\s/>]+/.exec(html.slice(lt + 2, end))?.[0]?.toLowerCase() ?? "";
      tokens.push({ type: "end", name });
      i = textStart = close < 0 ? html.length : close + 1;
      continue;
    }
    if (NAME_START.test(next)) {
      const close = tagEnd(html, lt + 1);
      if (close < 0) break; // an unterminated tag: the rest is text
      flushText(lt);
      const inner = html.slice(lt + 1, close);
      const name = /^[^\s/>]+/.exec(inner)?.[0]?.toLowerCase() ?? "";
      const selfClosing = inner.endsWith("/");
      const attrs = parseAttributes(inner.slice(name.length, selfClosing ? -1 : undefined));
      tokens.push({ type: "start", name, attrs, selfClosing });
      i = textStart = close + 1;
      if (RAW_TEXT_ELEMENTS.has(name) && !selfClosing) {
        const endRe = new RegExp(`</${name}[\\s>/]`, "ig");
        endRe.lastIndex = i;
        const m = endRe.exec(html);
        const contentEnd = m ? m.index : html.length;
        if (contentEnd > i) tokens.push({ type: "text", text: html.slice(i, contentEnd) });
        tokens.push({ type: "end", name });
        const after = m ? html.indexOf(">", m.index) : -1;
        i = textStart = after < 0 ? html.length : after + 1;
      }
      continue;
    }
    i = lt + 1; // a literal "<"
  }
  textStart = Math.min(textStart, html.length);
  flushText(html.length);
  return tokens;
}
