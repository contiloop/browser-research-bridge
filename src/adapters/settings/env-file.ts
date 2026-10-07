/**
 * `.env` text handling with Node's own semantics. Values are read with `util.parseEnv` (the parser
 * behind `--env-file`), and every written value is checked to read back identically through it.
 * Edits replace one definition's value in place and leave every other byte of the file as it was.
 */
import { parseEnv } from "node:util";

/** Every assignment of the file, as Node's `--env-file` would load it (later lines win). */
export function parseEnvText(text: string): Record<string, string> {
  return parseEnv(text) as Record<string, string>;
}

/** Characters a `.env` line cannot hold: line breaks and other control characters except tab. */
// eslint-disable-next-line no-control-regex
const UNSTORABLE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/**
 * The text to put after `NAME=` so that Node reads back exactly `value`, or null when no such text
 * exists (a line break, a control character, an unpaired surrogate, or every quote kind plus `#`).
 */
export function encodeEnvValue(value: string): string | null {
  if (UNSTORABLE.test(value)) return null;
  if (Buffer.from(value, "utf8").toString("utf8") !== value) return null;
  const candidates = [`'${value}'`, `\`${value}\``, `"${value}"`, value];
  for (const candidate of candidates) {
    if (parseEnv(`KEY=${candidate}\n`)["KEY"] === value) return candidate;
  }
  return null;
}

export interface EnvDefinition {
  name: string;
  /** Offset of the value text (after `=` and spaces). */
  valueStart: number;
  /** Offset just after the value text (closing quote included); a trailing comment follows. */
  valueEnd: number;
}

const DEFINITION = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=/;

/** All definitions in file order, skipping comment lines and the inside of multi-line quoted values. */
export function listEnvDefinitions(text: string): EnvDefinition[] {
  const out: EnvDefinition[] = [];
  let lineStart = 0;
  while (lineStart < text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const match = DEFINITION.exec(text.slice(lineStart, lineEnd));
    if (match === null) {
      lineStart = lineEnd + 1;
      continue;
    }
    let valueStart = lineStart + match[0].length;
    while (valueStart < lineEnd && (text[valueStart] === " " || text[valueStart] === "\t")) valueStart += 1;
    const quote = text[valueStart];
    let valueEnd: number;
    let nextLine: number;
    const closing =
      quote === "'" || quote === '"' || quote === "`" ? text.indexOf(quote, valueStart + 1) : -1;
    if (closing !== -1) {
      // Node looks for the closing quote across lines; the definition ends on that quote's line.
      valueEnd = closing + 1;
      const after = text.indexOf("\n", closing);
      nextLine = after === -1 ? text.length : after + 1;
    } else {
      const hash = text.indexOf("#", valueStart);
      const stop = hash !== -1 && hash < lineEnd ? hash : lineEnd;
      valueEnd = valueStart + text.slice(valueStart, stop).trimEnd().length;
      nextLine = lineEnd + 1;
    }
    out.push({ name: match[1]!, valueStart, valueEnd });
    lineStart = nextLine;
  }
  return out;
}

/** The definition Node uses for `name` (the last one), or null. */
export function findEnvDefinition(text: string, name: string): EnvDefinition | null {
  const all = listEnvDefinitions(text).filter((d) => d.name === name);
  return all.at(-1) ?? null;
}

/**
 * Returns `text` with `name` set to `value`: the value of its winning definition is replaced
 * (an `export` prefix and a trailing comment are kept), or a new line is appended.
 * Throws when the value cannot be stored faithfully; callers check {@link encodeEnvValue} first.
 */
export function setEnvValue(text: string, name: string, value: string): string {
  const encoded = encodeEnvValue(value);
  if (encoded === null) throw new Error(`the value of ${name} cannot be stored in a .env file`);
  const existing = findEnvDefinition(text, name);
  let next: string;
  if (existing !== null) {
    let lineEnd = text.indexOf("\n", existing.valueEnd);
    if (lineEnd === -1) lineEnd = text.length;
    const tail = text.slice(existing.valueEnd, lineEnd);
    // Keep a trailing comment; drop text Node ignored after a closing quote, which would join an unquoted value.
    const keptTail = /^[ \t]*(#.*)?\r?$/.test(tail) ? tail : "";
    next = text.slice(0, existing.valueStart) + encoded + keptTail + text.slice(lineEnd);
  } else {
    const prefix = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
    next = `${prefix}${name}=${encoded}\n`;
  }
  if (parseEnv(next)[name] !== value) {
    throw new Error(`the value of ${name} cannot be stored in this .env file`);
  }
  return next;
}
