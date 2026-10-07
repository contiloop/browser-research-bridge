import { describe, expect, it } from "vitest";
import { parseOnboardArgs } from "./cli-args.js";

describe("parseOnboardArgs", () => {
  it("parses an Add with a note", () => {
    expect(
      parseOnboardArgs(["https://blog.naver.com", "--note", "search only my neighbors' blogs"]).command,
    ).toEqual({
      kind: "add",
      input: "https://blog.naver.com",
      note: "search only my neighbors' blogs",
    });
    expect(parseOnboardArgs(["Naver", "Blog"]).command).toEqual({
      kind: "add",
      input: "Naver Blog",
      note: null,
    });
  });

  it("parses retry, repair, and the SDK check", () => {
    expect(parseOnboardArgs(["--retry", "reuters"]).command).toEqual({ kind: "retry", key: "reuters" });
    expect(parseOnboardArgs(["--repair", "reuters", "--note", "x"]).command).toEqual({
      kind: "repair",
      key: "reuters",
      note: "x",
    });
    expect(parseOnboardArgs(["--sdk-check"]).command).toEqual({ kind: "sdk-check" });
  });

  it("reports usage errors", () => {
    expect(parseOnboardArgs([]).error).toContain("give a URL");
    expect(parseOnboardArgs(["x.com", "--retry", "x"]).error).toContain("only one");
    expect(parseOnboardArgs(["--retry", "Bad Key"]).error).toContain("invalid site key");
    expect(parseOnboardArgs(["--note"]).error).toBe("--note needs a value");
    expect(parseOnboardArgs(["--bogus"]).error).toBe("unknown option --bogus");
  });
});
