import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args.js";

describe("site:validate arguments", () => {
  it("parses key and flags", () => {
    expect(parseCliArgs(["reuters", "--staging"])).toMatchObject({
      key: "reuters",
      staging: true,
      light: false,
      error: null,
    });
    expect(parseCliArgs(["example-news", "--light", "--account", "u1"])).toMatchObject({
      key: "example-news",
      light: true,
      account: "u1",
      error: null,
    });
    expect(parseCliArgs(["--help"])).toMatchObject({ help: true, error: null });
  });

  it("reports usage errors", () => {
    expect(parseCliArgs([]).error).toBe("missing <key>");
    expect(parseCliArgs(["a-b", "--bogus"]).error).toBe("unknown option --bogus");
    expect(parseCliArgs(["../etc"]).error).toContain("invalid site key");
    expect(parseCliArgs(["ab", "--staging", "--light"]).error).toContain("cannot be combined");
  });
});
