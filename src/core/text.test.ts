import { describe, expect, it } from "vitest";
import { truncateText } from "./text.js";

describe("truncateText", () => {
  it("returns short text unchanged with truncated=false", () => {
    expect(truncateText("hello\n\nworld", 100)).toEqual({ text: "hello\n\nworld", truncated: false });
    expect(truncateText("abcde", 5)).toEqual({ text: "abcde", truncated: false });
  });

  it("cuts at the last paragraph boundary within the limit", () => {
    const text = ["para one", "para two is here", "para three is longer than the rest"].join("\n\n");
    const out = truncateText(text, 30);
    expect(out).toEqual({ text: "para one\n\npara two is here", truncated: true });
    expect(out.text.length).toBeLessThanOrEqual(30);
  });

  it("falls back to a line, then word boundary, then a hard cut", () => {
    expect(truncateText("line one\nline two\nline three", 20)).toEqual({
      text: "line one\nline two",
      truncated: true,
    });
    expect(truncateText("alpha beta gamma delta", 13)).toEqual({ text: "alpha beta", truncated: true });
    expect(truncateText("abcdefghij", 4)).toEqual({ text: "abcd", truncated: true });
  });
});
