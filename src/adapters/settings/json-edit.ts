/**
 * Minimal-change edits of a JSON object file: one value is replaced or one member inserted, and
 * every other byte (other keys, their order, formatting) is left as it was. JSON has no comments,
 * so "preserve" means the text around the edit.
 */

interface Span {
  start: number;
  end: number;
}

interface ObjectNode extends Span {
  kind: "object";
  members: Array<{ key: string; keyStart: number; value: ValueNode }>;
}

type ValueNode = ObjectNode | (Span & { kind: "other" });

/**
 * Returns `text` with the value at `path` set to `value`. Missing parents are created; a parent
 * that is not an object is replaced by one. An empty text starts a new top-level object.
 * Throws when `text` is not a JSON object.
 */
export function setJsonValue(text: string, path: readonly string[], value: unknown): string {
  if (path.length === 0) throw new Error("setJsonValue needs a non-empty path");
  if (text.trim() === "") return `{\n  ${member(path, value)}\n}\n`;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the file must contain a JSON object");
  }
  const root = new Scanner(text).document();
  if (root.kind !== "object") throw new Error("the file must contain a JSON object");

  let node: ObjectNode = root;
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i]!;
    const found = node.members.filter((m) => m.key === key).at(-1);
    const remaining = path.slice(i + 1);
    if (found === undefined) return insertMember(text, node, path.slice(i), value, node === root);
    if (remaining.length === 0) return splice(text, found.value, inlineJson(value));
    if (found.value.kind !== "object") return splice(text, found.value, inlineJson(nested(remaining, value)));
    node = found.value;
  }
  throw new Error("unreachable");
}

function nested(path: readonly string[], value: unknown): unknown {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
}

function member(path: readonly string[], value: unknown): string {
  return `${JSON.stringify(path[0])}: ${inlineJson(nested(path.slice(1), value))}`;
}

function splice(text: string, span: Span, replacement: string): string {
  return text.slice(0, span.start) + replacement + text.slice(span.end);
}

function insertMember(
  text: string,
  node: ObjectNode,
  path: readonly string[],
  value: unknown,
  isRoot: boolean,
): string {
  const entry = member(path, value);
  const last = node.members.at(-1);
  if (last === undefined) {
    return splice(text, node, isRoot ? `{\n  ${entry}\n}` : `{ ${entry} }`);
  }
  const lineStart = text.lastIndexOf("\n", last.keyStart) + 1;
  const indent = text.slice(lineStart, last.keyStart);
  const separator = /^[ \t]*$/.test(indent) && lineStart > node.start ? `,\n${indent}` : ", ";
  const at = last.value.end;
  return text.slice(0, at) + separator + entry + text.slice(at);
}

/** Compact JSON with spaces, in the style of `config/bridge.example.json`'s one-line objects. */
export function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** Records value spans of text already known to be valid JSON. */
class Scanner {
  private pos = 0;

  constructor(private readonly text: string) {}

  document(): ValueNode {
    this.ws();
    return this.value();
  }

  private ws(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos += 1;
  }

  private value(): ValueNode {
    const c = this.text[this.pos];
    if (c === "{") return this.object();
    const start = this.pos;
    if (c === "[") this.array();
    else if (c === '"') this.string();
    else while (this.pos < this.text.length && !/[\s,\]}]/.test(this.text[this.pos]!)) this.pos += 1;
    return { kind: "other", start, end: this.pos };
  }

  private object(): ObjectNode {
    const start = this.pos;
    this.pos += 1;
    const members: ObjectNode["members"] = [];
    this.ws();
    while (this.text[this.pos] !== "}") {
      const keyStart = this.pos;
      const key = JSON.parse(this.text.slice(keyStart, this.string())) as string;
      this.ws();
      this.pos += 1; // ':'
      this.ws();
      members.push({ key, keyStart, value: this.value() });
      this.ws();
      if (this.text[this.pos] === ",") {
        this.pos += 1;
        this.ws();
      }
    }
    this.pos += 1;
    return { kind: "object", start, end: this.pos, members };
  }

  private array(): void {
    this.pos += 1;
    this.ws();
    while (this.text[this.pos] !== "]") {
      this.value();
      this.ws();
      if (this.text[this.pos] === ",") {
        this.pos += 1;
        this.ws();
      }
    }
    this.pos += 1;
  }

  /** Skips a string starting at the opening quote; returns the offset after the closing quote. */
  private string(): number {
    this.pos += 1;
    while (this.text[this.pos] !== '"') this.pos += this.text[this.pos] === "\\" ? 2 : 1;
    this.pos += 1;
    return this.pos;
  }
}
