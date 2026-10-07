import { describe, expect, it } from "vitest";
import { setJsonValue } from "./json-edit.js";

const SAMPLE = `{
  "publicPort": 8787,
  "asideAccount": "u0",
  "redirectUriAllowlist": [
    "https://claude.ai/api/mcp/auth_callback",
    "http://127.0.0.1/*"
  ],
  "git": { "autoCommit": true },
  "onboarding": { "model": "claude-opus-5-5", "effort": "high" },
  "oauth": { "extraResources": [] },
  "chatgpt": null,
  "tunables": {
    "searchDefaultLimit": 10
  }
}
`;

describe("setJsonValue", () => {
  it("replaces an existing value and leaves every other byte alone", () => {
    const next = setJsonValue(SAMPLE, ["asideAccount"], "u4");
    expect(next).toBe(SAMPLE.replace('"asideAccount": "u0"', '"asideAccount": "u4"'));
  });

  it("replaces a nested value inside a one-line object", () => {
    const next = setJsonValue(SAMPLE, ["onboarding", "effort"], "medium");
    expect(next).toBe(SAMPLE.replace('"effort": "high"', '"effort": "medium"'));
  });

  it("adds a missing key to a one-line object after its last member", () => {
    const next = setJsonValue(SAMPLE, ["onboarding", "runtime"], "codex");
    expect(next).toBe(SAMPLE.replace('"effort": "high" }', '"effort": "high", "runtime": "codex" }'));
    expect((JSON.parse(next) as { onboarding: unknown }).onboarding).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      runtime: "codex",
    });
  });

  it("adds a missing key to a multi-line object with the members' indentation", () => {
    const next = setJsonValue(SAMPLE, ["tunables", "searchMaxLimit"], 30);
    expect(next).toContain('    "searchDefaultLimit": 10,\n    "searchMaxLimit": 30\n  }');
  });

  it("adds a missing top-level key at the end, keeping key order", () => {
    const next = setJsonValue(SAMPLE, ["dataDir"], "store");
    const parsed = JSON.parse(next) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(JSON.parse(SAMPLE) as object), "dataDir"]);
    expect(next).toContain('  },\n  "dataDir": "store"\n}\n');
  });

  it("creates a missing parent object", () => {
    const text = '{ "publicPort": 1 }';
    const next = setJsonValue(text, ["onboarding", "runtime"], "auto");
    expect(next).toBe('{ "publicPort": 1, "onboarding": { "runtime": "auto" } }');
  });

  it("replaces null and arrays with compact values", () => {
    const marker = {
      managed: true,
      tunnelId: `tunnel_${"0".repeat(32)}`,
      profile: "browser-research-bridge",
    };
    let next = setJsonValue(SAMPLE, ["chatgpt"], marker);
    expect(next).toContain(
      `"chatgpt": { "managed": true, "tunnelId": "tunnel_${"0".repeat(32)}", "profile": "browser-research-bridge" },`,
    );
    next = setJsonValue(next, ["oauth", "extraResources"], ["https://a.example/x"]);
    expect(next).toContain('"oauth": { "extraResources": ["https://a.example/x"] },');
    expect((JSON.parse(next) as { chatgpt: unknown }).chatgpt).toEqual(marker);
  });

  it("starts an empty or missing file as an object", () => {
    expect(setJsonValue("", ["onboarding", "runtime"], "claude")).toBe(
      '{\n  "onboarding": { "runtime": "claude" }\n}\n',
    );
    expect(setJsonValue("{}", ["asideAccount"], "u1")).toBe('{\n  "asideAccount": "u1"\n}');
  });

  it("replaces a non-object parent that the loader would reject", () => {
    const next = setJsonValue('{"onboarding": "broken"}', ["onboarding", "runtime"], "auto");
    expect(JSON.parse(next)).toEqual({ onboarding: { runtime: "auto" } });
  });

  it("handles strings with escapes, braces, and duplicate keys (last wins, like JSON.parse)", () => {
    const text = '{"a": "x\\"}{,", "b": 1, "b": 2}';
    const next = setJsonValue(text, ["b"], 3);
    expect(next).toBe('{"a": "x\\"}{,", "b": 1, "b": 3}');
    expect(JSON.parse(next)).toEqual({ a: 'x"}{,', b: 3 });
  });

  it("refuses text that is not a JSON object", () => {
    expect(() => setJsonValue("{ not json", ["a"], 1)).toThrow();
    expect(() => setJsonValue("[1]", ["a"], 1)).toThrow(/object/);
  });
});
