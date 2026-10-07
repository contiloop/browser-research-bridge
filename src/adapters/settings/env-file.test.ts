import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeEnvValue, findEnvDefinition, parseEnvText, setEnvValue } from "./env-file.js";

/** Values that must survive a write and a read by both this module and Node. */
const SPECIAL_VALUES: readonly string[] = [
  "plain-passphrase-123",
  `it's a "quoted" passphrase`,
  "hash # inside and #end",
  "#starts-with-hash-xyz",
  "  leading and trailing spaces  ",
  "비밀번호는 한국어로 된 문장입니다",
  "émoji 😀 and ünïcode",
  "back`tick and 'single' quote",
  `all three ' " \` quotes no hash`,
  "backslash \\n is not a newline \\t",
  "tab\tinside the value ok",
  "=equals=at=edges=",
  "export FOO=bar style text",
];

describe("encodeEnvValue", () => {
  it.each(SPECIAL_VALUES)("encodes %j so Node's parser reads it back identically", (value) => {
    const encoded = encodeEnvValue(value);
    expect(encoded).not.toBeNull();
    expect(parseEnv(`KEY=${encoded}\n`)["KEY"]).toBe(value);
  });

  it.each(["two\nlines", "carriage\rreturn", "crlf\r\nvalue", "nul\u0000char", "lone \ud800 surrogate"])(
    "refuses %j",
    (value) => {
      expect(encodeEnvValue(value)).toBeNull();
    },
  );

  it("refuses a value that holds every quote kind and a hash", () => {
    expect(encodeEnvValue(`a ' " \` # b`)).toBeNull();
  });
});

describe("setEnvValue", () => {
  const sample = [
    "# Leading comment",
    "",
    "BRIDGE_PASSPHRASE=old value here # inline note",
    "PUBLIC_URL=https://bridge.example.com",
    "# BRIDGE_ASIDE_ACCOUNT=u9",
    'MULTI="first line',
    "NOT_A_KEY=inside multiline",
    'last line"',
    "export EXPORTED='kept'",
    "TRAILING=1",
  ].join("\n");

  it("replaces only the value of the named line and keeps everything else byte for byte", () => {
    const next = setEnvValue(sample, "BRIDGE_PASSPHRASE", "new passphrase value");
    const before = sample.split("\n");
    const after = next.split("\n");
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i += 1) {
      if (i === 2) expect(after[i]).toBe("BRIDGE_PASSPHRASE='new passphrase value' # inline note");
      else expect(after[i]).toBe(before[i]);
    }
    const parsedBefore = parseEnv(sample);
    const parsedAfter = parseEnv(next);
    expect(parsedAfter["BRIDGE_PASSPHRASE"]).toBe("new passphrase value");
    expect({ ...parsedAfter, BRIDGE_PASSPHRASE: undefined }).toEqual({
      ...parsedBefore,
      BRIDGE_PASSPHRASE: undefined,
    });
  });

  it("does not treat a line inside a multi-line quoted value as a definition", () => {
    expect(findEnvDefinition(sample, "NOT_A_KEY")).toBeNull();
    const next = setEnvValue(sample, "NOT_A_KEY", "x");
    expect(next.startsWith(sample)).toBe(true);
    expect(parseEnv(next)["MULTI"]).toBe(parseEnv(sample)["MULTI"]);
    expect(parseEnv(next)["NOT_A_KEY"]).toBe("x");
  });

  it("keeps an export prefix", () => {
    const next = setEnvValue(sample, "EXPORTED", "changed");
    expect(next).toContain("export EXPORTED='changed'");
    expect(parseEnv(next)["EXPORTED"]).toBe("changed");
  });

  it("appends a missing key on its own line and ignores commented-out lines", () => {
    const next = setEnvValue(sample, "BRIDGE_ASIDE_ACCOUNT", "u3");
    expect(next).toBe(`${sample}\nBRIDGE_ASIDE_ACCOUNT='u3'\n`);
    expect(setEnvValue("", "A", "b")).toBe("A='b'\n");
    expect(setEnvValue("X=1\n", "A", "b")).toBe("X=1\nA='b'\n");
  });

  it("updates the last of duplicate definitions, which is the one Node uses", () => {
    const text = "A=first\nB=2\nA=second\n";
    const next = setEnvValue(text, "A", "third");
    expect(next).toBe("A=first\nB=2\nA='third'\n");
    expect(parseEnv(next)["A"]).toBe("third");
  });

  it("fills an empty assignment in place", () => {
    expect(setEnvValue("BRIDGE_PASSPHRASE=\nX=1\n", "BRIDGE_PASSPHRASE", "abc")).toBe(
      "BRIDGE_PASSPHRASE='abc'\nX=1\n",
    );
  });

  it("refuses a value it cannot store", () => {
    expect(() => setEnvValue("", "A", "two\nlines")).toThrow(/cannot be stored/);
  });

  it("reads the file with Node's own parser", () => {
    expect(parseEnvText(sample)).toEqual(parseEnv(sample));
  });
});

describe("round trip through node --env-file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-envfile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads every special value identically when the process starts with --env-file", () => {
    let text = "# comment\nOTHER=1\n";
    const names = SPECIAL_VALUES.map((_, i) => `VALUE_${i}`);
    SPECIAL_VALUES.forEach((value, i) => {
      text = setEnvValue(text, names[i]!, value);
    });
    const file = join(dir, ".env");
    writeFileSync(file, text);
    const result = spawnSync(
      process.execPath,
      [
        `--env-file=${file}`,
        "-e",
        `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((n) => process.env[n] ?? null)))`,
      ],
      { env: { PATH: process.env["PATH"] ?? "" }, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(SPECIAL_VALUES);
    const parsed = parseEnvText(text);
    expect(names.map((n) => parsed[n])).toEqual(SPECIAL_VALUES);
  });
});
