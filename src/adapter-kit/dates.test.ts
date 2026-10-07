import { describe, expect, it } from "vitest";
import {
  dayWindowInZone,
  detectDatePrecision,
  formatInZone,
  parseDate,
  zoneOffsetMinutes,
  zonedTimeToDate,
} from "./dates.js";

// 2026-10-05 12:30 in Seoul.
const now = new Date("2026-10-05T03:30:00Z");
const seoul = { timezone: "Asia/Seoul", now };

function p(input: string, options = seoul) {
  return parseDate(input, options);
}

describe("parseDate: Korean relative dates (site time zone Asia/Seoul)", () => {
  it.each([
    ["3시간 전", "2026-10-05T09:30:00+09:00", "minute"],
    ["2시간전", "2026-10-05T10:30:00+09:00", "minute"],
    ["5분 전", "2026-10-05T12:25:00+09:00", "minute"],
    ["30초 전", "2026-10-05T12:29:00+09:00", "minute"],
    ["방금", "2026-10-05T12:30:00+09:00", "minute"],
    ["방금 전", "2026-10-05T12:30:00+09:00", "minute"],
    ["한 시간 전", "2026-10-05T11:30:00+09:00", "minute"],
    ["어제", "2026-10-04T00:00:00+09:00", "day"],
    ["어제 15:30", "2026-10-04T15:30:00+09:00", "minute"],
    ["어제 오후 3:30", "2026-10-04T15:30:00+09:00", "minute"],
    ["오늘 오전 9시 5분", "2026-10-05T09:05:00+09:00", "minute"],
    ["그저께", "2026-10-03T00:00:00+09:00", "day"],
    ["그제", "2026-10-03T00:00:00+09:00", "day"],
    ["3일 전", "2026-10-02T00:00:00+09:00", "day"],
    ["2주 전", "2026-09-21T00:00:00+09:00", "day"],
    ["3개월 전", "2026-07-05T00:00:00+09:00", "day"],
    ["3달 전", "2026-07-05T00:00:00+09:00", "day"],
    ["1년 전", "2025-10-05T00:00:00+09:00", "day"],
  ])("%s → %s", (input, publishedAt, datePrecision) => {
    expect(p(input)).toEqual({ publishedAt, datePrecision });
  });

  it("resolves the calendar day in the site zone, not in UTC", () => {
    // 2026-10-04 23:30 UTC is already 2026-10-05 08:30 in Seoul: "어제" is 10-04 in Seoul.
    const lateUtc = new Date("2026-10-04T23:30:00Z");
    expect(parseDate("어제", { timezone: "Asia/Seoul", now: lateUtc })?.publishedAt).toBe(
      "2026-10-04T00:00:00+09:00",
    );
    expect(parseDate("yesterday", { timezone: "UTC", now: lateUtc })?.publishedAt).toBe(
      "2026-10-03T00:00:00+00:00",
    );
  });
});

describe("parseDate: English relative dates", () => {
  it.each([
    ["5 hours ago", "2026-10-05T07:30:00+09:00", "minute"],
    ["an hour ago", "2026-10-05T11:30:00+09:00", "minute"],
    ["a minute ago", "2026-10-05T12:29:00+09:00", "minute"],
    ["2h ago", "2026-10-05T10:30:00+09:00", "minute"],
    ["10 mins ago", "2026-10-05T12:20:00+09:00", "minute"],
    ["just now", "2026-10-05T12:30:00+09:00", "minute"],
    ["today", "2026-10-05T00:00:00+09:00", "day"],
    ["yesterday", "2026-10-04T00:00:00+09:00", "day"],
    ["Yesterday at 3:04 PM", "2026-10-04T15:04:00+09:00", "minute"],
    ["3 days ago", "2026-10-02T00:00:00+09:00", "day"],
    ["2 weeks ago", "2026-09-21T00:00:00+09:00", "day"],
    ["a month ago", "2026-09-05T00:00:00+09:00", "day"],
    ["2 years ago", "2024-10-05T00:00:00+09:00", "day"],
  ])("%s → %s", (input, publishedAt, datePrecision) => {
    expect(p(input)).toEqual({ publishedAt, datePrecision });
  });

  it("clamps month arithmetic to the last day of the month", () => {
    const endOfMarch = new Date("2026-03-31T12:00:00Z");
    expect(parseDate("1 month ago", { timezone: "UTC", now: endOfMarch })?.publishedAt).toBe(
      "2026-02-28T00:00:00+00:00",
    );
  });
});

describe("parseDate: absolute dates", () => {
  it.each([
    ["2024-01-02", "2024-01-02T00:00:00+09:00", "day"],
    ["2024-01-02T15:04:05Z", "2024-01-03T00:04:05+09:00", "minute"],
    ["2024-01-02T15:04:05.123+00:00", "2024-01-03T00:04:05+09:00", "minute"],
    ["2024-01-02 15:04", "2024-01-02T15:04:00+09:00", "minute"],
    ["Updated: 2024-01-02T10:00:00+09:00", "2024-01-02T10:00:00+09:00", "minute"],
    ["2024.01.02.", "2024-01-02T00:00:00+09:00", "day"],
    ["2024.1.2", "2024-01-02T00:00:00+09:00", "day"],
    ["2024. 1. 2. 오후 3:04", "2024-01-02T15:04:00+09:00", "minute"],
    ["2024. 1. 2. 15:04", "2024-01-02T15:04:00+09:00", "minute"],
    ["입력 2024.01.02. 15:04", "2024-01-02T15:04:00+09:00", "minute"],
    ["2024/01/02 15:04", "2024-01-02T15:04:00+09:00", "minute"],
    ["2024년 1월 2일", "2024-01-02T00:00:00+09:00", "day"],
    ["2024년 1월 2일 (화) 오후 3시 4분", "2024-01-02T15:04:00+09:00", "minute"],
    ["Tue, 02 Jan 2024 15:04:05 +0000", "2024-01-03T00:04:05+09:00", "minute"],
    ["Tue, 02 Jan 2024 15:04:05 GMT", "2024-01-03T00:04:05+09:00", "minute"],
    ["Jan 2, 2024", "2024-01-02T00:00:00+09:00", "day"],
    ["January 2, 2024 3:04 PM", "2024-01-02T15:04:00+09:00", "minute"],
    ["October 5, 2026 3:04 PM GMT+9", "2026-10-05T15:04:00+09:00", "minute"],
    ["Sept. 3rd, 2025", "2025-09-03T00:00:00+09:00", "day"],
    ["2 Jan 2024", "2024-01-02T00:00:00+09:00", "day"],
    ["on Feb 22, 2008", "2008-02-22T00:00:00+09:00", "day"],
    ["1704110400", "2024-01-01T21:00:00+09:00", "minute"],
    ["1704110400000", "2024-01-01T21:00:00+09:00", "minute"],
  ])("%s → %s", (input, publishedAt, datePrecision) => {
    expect(p(input)).toEqual({ publishedAt, datePrecision });
  });

  it("puts a yearless Korean date that would lie in the future into last year", () => {
    expect(p("12월 30일")?.publishedAt).toBe("2025-12-30T00:00:00+09:00");
    expect(p("10월 1일")?.publishedAt).toBe("2026-10-01T00:00:00+09:00");
  });

  it("keeps wall times without an offset in the site zone, across DST", () => {
    const ny = { timezone: "America/New_York", now };
    expect(parseDate("2024-07-01 12:00", ny)?.publishedAt).toBe("2024-07-01T12:00:00-04:00");
    expect(parseDate("2024-01-15 12:00", ny)?.publishedAt).toBe("2024-01-15T12:00:00-05:00");
    expect(parseDate("2024-01-15T17:00:00Z", ny)?.publishedAt).toBe("2024-01-15T12:00:00-05:00");
  });

  it.each([
    "01/02/2024",
    "2024-02-30",
    "2024-13-01",
    "hello",
    "",
    "Jan 2, 2024 15",
    "3 parsecs ago",
    "25:00",
  ])("returns null for %j", (input) => {
    expect(p(input)).toBeNull();
  });

  it("returns null for an unknown time zone", () => {
    expect(parseDate("2024-01-02", { timezone: "Mars/Olympus" })).toBeNull();
  });

  it("defaults to UTC", () => {
    expect(parseDate("2024-01-02 03:04")?.publishedAt).toBe("2024-01-02T03:04:00+00:00");
  });
});

describe("detectDatePrecision", () => {
  it("is minute with a time of day, day for a calendar date, null otherwise", () => {
    expect(detectDatePrecision("2024-01-02T03:04:05Z")).toBe("minute");
    expect(detectDatePrecision("3시간 전", seoul)).toBe("minute");
    expect(detectDatePrecision("2024.01.02.")).toBe("day");
    expect(detectDatePrecision("어제", seoul)).toBe("day");
    expect(detectDatePrecision("soon")).toBeNull();
  });
});

describe("time zone utilities", () => {
  it("computes offsets and converts wall time", () => {
    expect(zoneOffsetMinutes(new Date("2024-07-01T00:00:00Z"), "Asia/Seoul")).toBe(540);
    expect(zoneOffsetMinutes(new Date("2024-07-01T00:00:00Z"), "America/New_York")).toBe(-240);
    expect(
      zonedTimeToDate(
        { year: 2024, month: 3, day: 10, hour: 12, minute: 0, second: 0 },
        "America/New_York",
      ).toISOString(),
    ).toBe("2024-03-10T16:00:00.000Z");
    expect(formatInZone(new Date("2024-01-01T00:00:00Z"), "Asia/Kolkata")).toBe("2024-01-01T05:30:00+05:30");
  });

  it("dayWindowInZone gives local-midnight bounds with an exclusive end", () => {
    const w = dayWindowInZone("2024-01-01", "2024-01-31", "Asia/Seoul");
    expect(w.from?.toISOString()).toBe("2023-12-31T15:00:00.000Z");
    expect(w.until?.toISOString()).toBe("2024-01-31T15:00:00.000Z");
    expect(dayWindowInZone(null, "bad", "UTC")).toEqual({ from: null, until: null });
    expect(dayWindowInZone(null, "2024-12-31", "UTC").until?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });
});
