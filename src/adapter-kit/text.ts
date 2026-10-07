/**
 * Document text extraction: page HTML or an Aside accessibility snapshot →
 * Markdown-ish plain text with paragraphs, `#` headings, `-`/`1.` list items and fenced `pre` blocks;
 * links become their text; navigation, ads, comments and other boilerplate regions are dropped.
 * Truncation is the core's job (it cuts at a paragraph boundary), so nothing here limits length.
 */
import type { ExtractTextOptions } from "../ports/adapter.js";
import { decodeEntities, tokenizeHtml, VOID_ELEMENTS } from "./html.js";

export type { ExtractTextOptions };

/** Never text: dropped with their content in every mode. */
const ALWAYS_DROPPED: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "canvas",
  "iframe",
  "object",
  "embed",
  "select",
  "button",
  "textarea",
  "head",
  "title",
  "audio",
  "video",
  "map",
  "datalist",
  "dialog",
]);

/** Boilerplate containers dropped unless `keepBoilerplate`. */
const BOILERPLATE_ELEMENTS: ReadonlySet<string> = new Set(["nav", "aside", "footer", "menu"]);

const BOILERPLATE_ROLES: ReadonlySet<string> = new Set([
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "menu",
  "menubar",
  "dialog",
  "alertdialog",
  "toolbar",
  "tablist",
  "tooltip",
]);

/** Class/id tokens of ads, comments, share bars, newsletter boxes, related links, cookie notices, … */
const BOILERPLATE_TOKEN =
  /^(?:ads?|advert(?:isement)?s?|adsbygoogle|ad[-_].+|.+[-_]ads?|sponsor(?:ed|s)?|promo(?:tion)?s?|comments?|comment[-_](?:list|section|area|thread|form)s?|commentlist|disqus.*|social|social[-_].+|share|sharing|share[-_].+|newsletter.*|related(?:[-_].+)?|recommend(?:ed|ations?)?(?:[-_].+)?|cookie.*|consent.*|gdpr.*|breadcrumbs?|sidebar|subscribe(?:[-_].+)?|outbrain|taboola)$/i;

/** Elements whose end tag is optional; never matched by class/role (their extent is unreliable). */
const OPTIONAL_END: ReadonlySet<string> = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "tfoot",
  "option",
  "optgroup",
  "rt",
  "rp",
  "colgroup",
  "caption",
]);

const PARAGRAPH_BLOCKS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "figure",
  "figcaption",
  "blockquote",
  "address",
  "details",
  "summary",
  "table",
  "form",
  "fieldset",
  "center",
  "hgroup",
  "dl",
  "hr",
  "body",
  "html",
  "nav",
  "aside",
  "caption",
]);

const LINE_BLOCKS: ReadonlySet<string> = new Set(["tr", "dt", "dd", "legend", "option"]);

const HEADING = /^h([1-6])$/;

/** Accumulates Markdown-ish text with whitespace collapsing and pending block breaks. */
class TextBuilder {
  private out = "";
  private pendingBreak = 0;
  private pendingSpace = false;
  private prefix = "";
  preDepth = 0;

  get length(): number {
    return this.out.length;
  }

  slice(from: number): string {
    return this.out.slice(from);
  }

  /** Requests `n` (1 = line, 2 = paragraph) newlines before the next content. */
  block(n: 1 | 2): void {
    this.pendingBreak = Math.max(this.pendingBreak, n);
    this.pendingSpace = false;
  }

  /** A hard line break (`<br>`). Two in a row make a paragraph break. */
  lineBreak(): void {
    if (this.out === "") return;
    if (this.pendingBreak === 0) {
      this.out = this.out.replace(/[ \t]+$/, "");
      this.out += "\n";
    } else if (this.pendingBreak === 1) {
      this.pendingBreak = 2;
    }
    this.pendingSpace = false;
  }

  /** Text to put before the next content (a heading's `## ` or a list marker). */
  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  private startContent(): void {
    if (this.pendingBreak > 0) {
      if (this.out !== "") {
        this.out = this.out.replace(/[ \t]+$/, "");
        const have = /\n*$/.exec(this.out)?.[0].length ?? 0;
        this.out += "\n".repeat(Math.max(0, this.pendingBreak - have));
      }
      this.pendingBreak = 0;
      this.pendingSpace = false;
    }
    if (this.prefix !== "") {
      this.out += this.prefix;
      this.prefix = "";
      this.pendingSpace = false;
    }
  }

  /** Inline text (entities already decoded). */
  text(raw: string): void {
    if (this.preDepth > 0) {
      if (raw === "") return;
      this.startContent();
      this.out += raw;
      return;
    }
    const collapsed = raw.replace(/[\s\u00a0]+/g, " ");
    if (collapsed === "") return;
    const content = collapsed.trim();
    if (content === "") {
      this.pendingSpace = true;
      return;
    }
    const leading = collapsed.startsWith(" ");
    const hadBreak = this.pendingBreak > 0 || this.prefix !== "";
    this.startContent();
    if (!hadBreak && (leading || this.pendingSpace) && this.out !== "" && !/[\s]$/.test(this.out)) {
      this.out += " ";
    }
    this.out += content;
    this.pendingSpace = collapsed.endsWith(" ");
  }

  /** Raw text that is not whitespace-collapsed (code fences). */
  raw(text: string): void {
    this.startContent();
    this.out += text;
  }

  finish(): string {
    return this.out
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

function classTokens(attrs: Readonly<Record<string, string>>): string[] {
  const tokens = (attrs["class"] ?? "").split(/\s+/).filter((t) => t !== "");
  if (attrs["id"]) tokens.push(attrs["id"]);
  return tokens;
}

function isBoilerplate(
  name: string,
  attrs: Readonly<Record<string, string>>,
  extraDrop: ReadonlySet<string>,
  keepBoilerplate: boolean,
): boolean {
  if (OPTIONAL_END.has(name) || VOID_ELEMENTS.has(name)) return false;
  const tokens = classTokens(attrs);
  if (extraDrop.size > 0 && tokens.some((t) => extraDrop.has(t.toLowerCase()))) return true;
  if (keepBoilerplate) return false;
  if (BOILERPLATE_ELEMENTS.has(name)) return true;
  if ("hidden" in attrs || attrs["aria-hidden"] === "true") return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs["style"] ?? "")) return true;
  const role = (attrs["role"] ?? "").toLowerCase().trim();
  if (role !== "" && BOILERPLATE_ROLES.has(role)) return true;
  return tokens.some((t) => BOILERPLATE_TOKEN.test(t));
}

function resolveHref(href: string, baseUrl: string | undefined): string | null {
  try {
    const u = baseUrl !== undefined ? new URL(href, baseUrl) : new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

interface ListState {
  ordered: boolean;
  counter: number;
}

/**
 * HTML (a whole page or a fragment such as an article body's innerHTML) → Markdown-ish text.
 * Headings become `#`…`######` lines, list items `- ` / `1. ` (nested lists indented by two spaces),
 * `pre` blocks are fenced with ```, table cells are joined with ` | `, and paragraphs are separated
 * by one blank line.
 */
export function extractText(html: string, options: ExtractTextOptions = {}): string {
  const keepBoilerplate = options.keepBoilerplate === true;
  const extraDrop = new Set((options.dropClassNames ?? []).map((c) => c.toLowerCase()));
  const linksInline = options.links === "inline";
  const b = new TextBuilder();
  const lists: ListState[] = [];
  const cells: number[] = [];
  const anchors: { href: string | null; start: number }[] = [];
  let skip: { name: string; depth: number } | null = null;

  for (const token of tokenizeHtml(html)) {
    if (skip !== null) {
      if (
        token.type === "start" &&
        token.name === skip.name &&
        !token.selfClosing &&
        !VOID_ELEMENTS.has(token.name)
      ) {
        skip.depth += 1;
      } else if (token.type === "end" && token.name === skip.name) {
        skip.depth -= 1;
        if (skip.depth === 0) skip = null;
      }
      continue;
    }
    if (token.type === "comment") continue;
    if (token.type === "text") {
      b.text(decodeEntities(token.text));
      continue;
    }
    const name = token.name;
    if (token.type === "start") {
      if (ALWAYS_DROPPED.has(name) || isBoilerplate(name, token.attrs, extraDrop, keepBoilerplate)) {
        if (!token.selfClosing && !VOID_ELEMENTS.has(name)) skip = { name, depth: 1 };
        continue;
      }
      const heading = HEADING.exec(name);
      if (heading) {
        b.block(2);
        b.setPrefix(`${"#".repeat(Number(heading[1]))} `);
      } else if (name === "br") {
        b.lineBreak();
      } else if (name === "ul" || name === "ol") {
        b.block(lists.length === 0 ? 2 : 1);
        const start = Number(token.attrs["start"] ?? "1");
        lists.push({ ordered: name === "ol", counter: Number.isFinite(start) ? start - 1 : 0 });
      } else if (name === "li") {
        b.block(1);
        const list = lists[lists.length - 1];
        const indent = "  ".repeat(Math.max(0, lists.length - 1));
        if (list?.ordered) {
          list.counter += 1;
          b.setPrefix(`${indent}${list.counter}. `);
        } else {
          b.setPrefix(`${indent}- `);
        }
      } else if (name === "pre") {
        b.block(2);
        if (b.preDepth === 0) b.raw("```\n");
        b.preDepth += 1;
      } else if (name === "tr") {
        b.block(1);
        cells.push(0);
      } else if (name === "td" || name === "th") {
        const n = cells.length > 0 ? cells[cells.length - 1]! : 0;
        if (n > 0) b.text(" | ");
        if (cells.length > 0) cells[cells.length - 1] = n + 1;
      } else if (name === "a") {
        if (!token.selfClosing) {
          const href = linksInline ? resolveHref(token.attrs["href"] ?? "", options.baseUrl) : null;
          anchors.push({ href, start: b.length });
        }
      } else if (name === "img" && token.attrs["alt"] && linksInline) {
        // Images carry no text; their alt text is kept only in the verbose (inline-links) mode.
        b.text(` ${token.attrs["alt"]} `);
      } else if (PARAGRAPH_BLOCKS.has(name)) {
        b.block(2);
      } else if (LINE_BLOCKS.has(name)) {
        b.block(1);
      }
      continue;
    }
    // End tags.
    if (HEADING.test(name)) {
      b.block(2);
      b.setPrefix("");
    } else if (name === "ul" || name === "ol") {
      lists.pop();
      b.block(lists.length === 0 ? 2 : 1);
    } else if (name === "li") {
      b.block(1);
    } else if (name === "pre") {
      if (b.preDepth > 0) {
        b.preDepth -= 1;
        if (b.preDepth === 0) {
          b.raw(b.slice(b.length - 1) === "\n" ? "```" : "\n```");
          b.block(2);
        }
      }
    } else if (name === "tr") {
      cells.pop();
      b.block(1);
    } else if (name === "a") {
      const anchor = anchors.pop();
      if (anchor?.href) {
        const text = b.slice(anchor.start).trim();
        if (text !== "" && text !== anchor.href && !anchor.href.endsWith(text)) b.text(` (${anchor.href})`);
      }
    } else if (PARAGRAPH_BLOCKS.has(name)) {
      b.block(2);
    } else if (LINE_BLOCKS.has(name)) {
      b.block(1);
    }
  }
  return b.finish();
}

/** Accessibility roles whose subtree is dropped from snapshot text. */
const SNAPSHOT_DROPPED_ROLES: ReadonlySet<string> = new Set([
  ...BOILERPLATE_ROLES,
  "button",
  "img",
  "image",
  "combobox",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "progressbar",
  "scrollbar",
  "option",
  "listbox",
  "figure",
  "title",
]);

const SNAPSHOT_PARAGRAPH_ROLES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "list",
  "article",
  "main",
  "region",
  "table",
  "blockquote",
  "separator",
  "document",
  "group",
  "code",
  "note",
  "definition",
  "term",
]);

const SNAPSHOT_LINE_ROLES: ReadonlySet<string> = new Set(["listitem", "row", "rowgroup"]);

function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * An Aside accessibility snapshot (`ctx.browser.snapshot(tab)`, lines such as
 * `- heading "Title" [level=1] [ref=e3]` and `- text: "…"`) → Markdown-ish text. Navigation,
 * banners, buttons, form controls and images are dropped. Snapshot text loses inline structure, so
 * prefer extracting the article element's HTML with a page script when the page allows it.
 */
export function snapshotToText(snapshot: string): string {
  const b = new TextBuilder();
  let dropIndent: number | null = null;
  const blockIndents: number[] = [];
  const line = /^(\s*)- (?:([a-z][a-z-]*)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)(:)?(?: (.*))?|(".*"))$/;
  for (const raw of snapshot.split("\n")) {
    const m = line.exec(raw.replace(/\s+$/, ""));
    if (!m) continue;
    const indent = m[1]!.length;
    if (dropIndent !== null) {
      if (indent > dropIndent) continue;
      dropIndent = null;
    }
    while (blockIndents.length > 0 && indent <= blockIndents[blockIndents.length - 1]!) {
      blockIndents.pop();
      b.block(1);
    }
    if (m[7] !== undefined) {
      b.text(` ${unquote(m[7])} `);
      continue;
    }
    const role = m[2]!;
    const name = m[3] !== undefined ? unquote(m[3]) : "";
    const attrs = m[4] ?? "";
    const inline = m[6] !== undefined ? unquote(m[6]) : "";
    if (SNAPSHOT_DROPPED_ROLES.has(role)) {
      if (m[5] !== undefined) dropIndent = indent;
      continue;
    }
    if (role === "heading") {
      const level = Number(/\[level=(\d)\]/.exec(attrs)?.[1] ?? "2");
      b.block(2);
      b.setPrefix(`${"#".repeat(Math.min(6, Math.max(1, level)))} `);
      b.text(name || inline);
      b.block(2);
      if (m[5] !== undefined) dropIndent = indent; // the name already holds the heading text
      continue;
    }
    if (SNAPSHOT_PARAGRAPH_ROLES.has(role)) {
      b.block(2);
      blockIndents.push(indent);
    } else if (SNAPSHOT_LINE_ROLES.has(role)) {
      b.block(1);
      if (role === "listitem") b.setPrefix("- ");
      blockIndents.push(indent);
    }
    const text = role === "text" ? inline || name : name || inline;
    if (text !== "") b.text(` ${text} `);
  }
  return b.finish();
}

/** Collapses whitespace runs to single spaces and trims (titles, authors, excerpts). */
export function cleanInlineText(value: string | null | undefined): string {
  return decodeEntities(String(value ?? ""))
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

/**
 * Shortens `text` to at most `maxChars` at a word boundary, adding `…` when cut. For excerpts; the
 * core truncates document text itself.
 */
export function clipText(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, Math.max(0, maxChars - 1));
  if (/\s/.test(t.charAt(cut.length))) return `${cut.trimEnd()}…`;
  const space = cut.lastIndexOf(" ");
  return `${(space > maxChars * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
