/**
 * Date parsing for adapters: every `publishedAt` is ISO 8601 with the site's offset, and
 * relative dates ("3시간 전", "yesterday") are resolved against the site's declared time zone at
 * request time. Pure functions; the clock comes in as `now`.
 *
 * Accepted inputs (case-insensitive, surrounding whitespace and a leading "on"/"posted"/"입력" etc.
 * ignored):
 * - ISO 8601: `2024-01-02`, `2024-01-02T15:04`, `2024-01-02T15:04:05.123Z`, `2024-01-02 15:04:05+09:00`
 *   (no offset → wall time in the site time zone)
 * - RFC 2822 / month names: `Tue, 02 Jan 2024 15:04:05 +0000`, `Jan 2, 2024`, `January 2, 2024 3:04 PM`,
 *   `2 Jan 2024`, with an optional zone `GMT`/`UTC`/`KST`/`GMT+9`/`+0900`
 * - Dotted/slashed: `2024.01.02.`, `2024. 1. 2. 오후 3:04`, `2024/01/02 15:04`
 * - Korean: `2024년 1월 2일`, `2024년 1월 2일 오후 3시 4분`, `1월 2일` (current year)
 * - Unix time: 10-digit seconds or 13-digit milliseconds
 * - Relative, English: `just now`, `now`, `5 minutes ago`, `an hour ago`, `2h ago`, `3 days ago`,
 *   `2 weeks ago`, `a month ago`, `1 year ago`, `today`, `yesterday`, `yesterday at 3:04 PM`
 * - Relative, Korean: `방금`, `방금 전`, `30초 전`, `5분 전`, `3시간 전`, `2시간전`, `3일 전`, `2주 전`,
 *   `3개월 전`, `3달 전`, `1년 전`, `오늘`, `어제`, `그제`/`그저께`, `어제 15:30`, `어제 오후 3:30`
 *
 * Precision: a time of day (or a relative amount below a day) → `minute`; a calendar date only → `day`.
 * Day-precision values are written as local midnight with the zone's offset. Ambiguous numeric forms
 * such as `01/02/2024` are not guessed: they return null.
 */
import type { DatePrecision } from "../core/models.js";
import type { ParsedDate } from "../ports/adapter.js";

export type { ParsedDate };

export interface ParseDateOptions {
  /** IANA time zone of the site (manifest `timezone`); default `UTC`. */
  timezone?: string | undefined;
  /** The request time used for relative dates; default the current time. */
  now?: Date | undefined;
}

/** Wall-clock fields in some time zone. Month is 1-12. */
export interface ZonedFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of `instant` in `timeZone`. */
export function zonedFields(instant: Date, timeZone: string): ZonedFields {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (east positive: Seoul → 540). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const f = zonedFields(instant, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60_000);
}

/** The instant at which the wall clock in `timeZone` shows `fields` (DST gaps resolve forward). */
export function zonedTimeToDate(fields: ZonedFields, timeZone: string): Date {
  const guess = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  const off1 = zoneOffsetMinutes(new Date(guess), timeZone);
  let t = guess - off1 * 60_000;
  const off2 = zoneOffsetMinutes(new Date(t), timeZone);
  if (off2 !== off1) t = guess - off2 * 60_000;
  return new Date(t);
}

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, "0");
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const m = Math.abs(minutes);
  return `${sign}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** `instant` as ISO 8601 in `timeZone` with its offset: `2024-01-02T15:04:05+09:00`. */
export function formatInZone(instant: Date, timeZone: string): string {
  const f = zonedFields(instant, timeZone);
  const offset = zoneOffsetMinutes(instant, timeZone);
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}${formatOffset(offset)}`;
}

/** Local midnight of a calendar day in `timeZone`, as ISO 8601 with offset. */
export function formatDayInZone(year: number, month: number, day: number, timeZone: string): string {
  return formatInZone(
    zonedTimeToDate({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone),
    timeZone,
  );
}

/**
 * Bounds of an inclusive `YYYY-MM-DD` window in the site's time zone, for adapters that apply date
 * filters natively: `from` is local midnight of `after`, `until` is local midnight of the day after
 * `before` (exclusive). Either side is null when not given or malformed.
 */
export function dayWindowInZone(
  after: string | null,
  before: string | null,
  timeZone: string,
): { from: Date | null; until: Date | null } {
  const parse = (s: string | null): [number, number, number] | null => {
    const m = s === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return validDay(y, mo, d) ? [y, mo, d] : null;
  };
  const a = parse(after);
  const b = parse(before);
  const from = a
    ? zonedTimeToDate({ year: a[0], month: a[1], day: a[2], hour: 0, minute: 0, second: 0 }, timeZone)
    : null;
  let until: Date | null = null;
  if (b) {
    const next = new Date(Date.UTC(b[0], b[1] - 1, b[2] + 1));
    until = zonedTimeToDate(
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone,
    );
  }
  return { from, until };
}

function validDay(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validTime(h: number, mi: number, s: number): boolean {
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 60;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** Common zone abbreviations (offset minutes). Anything else is not accepted as a zone. */
const ZONE_ABBREVIATIONS: Readonly<Record<string, number>> = {
  z: 0,
  utc: 0,
  gmt: 0,
  ut: 0,
  kst: 540,
  jst: 540,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
  bst: 60,
  cet: 60,
  cest: 120,
};

/** Parses a zone suffix: `Z`, `+09:00`, `+0900`, `GMT+9`, `UTC-05:30`, `KST`. Null = not a zone. */
function parseZone(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const s = raw.trim().toLowerCase();
  if (s in ZONE_ABBREVIATIONS) return ZONE_ABBREVIATIONS[s] ?? null;
  const m = /^(?:gmt|utc)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? "0");
  if (minutes > 14 * 60) return null;
  return m[1] === "-" ? -minutes : minutes;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  time: { hour: number; minute: number; second: number } | null;
  /** Explicit offset in minutes; undefined = wall time in the site zone. */
  offset: number | undefined;
}

function to24h(hour: number, meridiem: string | undefined): number {
  if (meridiem === undefined) return hour;
  const m = meridiem.toLowerCase().replace(/\./g, "");
  const pm = m === "pm" || m === "오후";
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

const ZONE = String.raw`(z|utc|gmt|ut|kst|jst|est|edt|cst|cdt|mst|mdt|pst|pdt|bst|cet|cest|(?:gmt|utc)?\s*[+-]\d{1,2}(?::?\d{2})?)`;

type Clock24 = { hour: number; minute: number; second: number };

/**
 * Parses what follows a calendar date: an optional time (`15:04`, `3:04:05 PM`, `오후 3:04`,
 * `오후 3시 4분`, `at 3pm`) and an optional zone. Empty → no time, no zone. Null → not a time.
 */
function parseTimeTail(raw: string | undefined): { time: Clock24 | null; offset: number | undefined } | null {
  const tail = (raw ?? "")
    .trim()
    .replace(/^,\s*/, "")
    .replace(/^(?:at|@)\s*/i, "")
    .trim();
  if (tail === "") return { time: null, offset: undefined };
  const zoneOnly = new RegExp(String.raw`^\(?${ZONE}\)?$`, "i").exec(tail);
  if (zoneOnly) {
    const offset = parseZone(zoneOnly[1]);
    return offset === null ? null : { time: null, offset };
  }
  const m = new RegExp(
    String.raw`^(?:(오전|오후)\s*)?(\d{1,2})(?::(\d{2})(?::(\d{2})(?:[.,]\d+)?)?|\s*시(?:\s*(\d{1,2})\s*분)?)?\s*(a\.?m\.?|p\.?m\.?)?(?:\s*\(?${ZONE}\)?)?$`,
    "i",
  ).exec(tail);
  if (!m) return null;
  const explicit = m[3] !== undefined || /시/.test(tail) || m[6] !== undefined;
  if (!explicit) return null;
  const hour = to24h(Number(m[2]), m[1] ?? m[6]);
  const minute = Number(m[3] ?? m[5] ?? "0");
  const second = Number(m[4] ?? "0");
  if (!validTime(hour, minute, second)) return null;
  const offset = parseZone(m[7]);
  if (offset === null) return null;
  return { time: { hour, minute, second }, offset };
}

function withTail(year: number, month: number, day: number, tail: string | undefined): DateParts | null {
  const t = parseTimeTail(tail);
  if (t === null) return null;
  return { year, month, day, time: t.time, offset: t.offset };
}

function parseAbsolute(input: string, now: Date, timeZone: string): DateParts | null {
  const s = input;
  let m: RegExpExecArray | null;

  // Unix time.
  if ((m = /^(\d{10}|\d{13})$/.exec(s))) {
    const ms = m[1]!.length === 13 ? Number(m[1]) : Number(m[1]) * 1000;
    const d = new Date(ms);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      time: { hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() },
      offset: 0,
    };
  }

  // ISO 8601.
  m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[t\s]+(\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
      s,
    );
  if (m) {
    const offset = parseZone(m[7]);
    if (offset === null) return null;
    const time =
      m[4] !== undefined ? { hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? "0") } : null;
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), time, offset };
  }

  // Dotted / slashed, year first: 2024.01.02. | 2024. 1. 2. 오후 3:04 | 2024/01/02 15:04
  m = /^(\d{4})\s*([./-])\s*(\d{1,2})\s*\2\s*(\d{1,2})\.?(?:[,\s]+(.*))?$/.exec(s);
  if (m) return withTail(Number(m[1]), Number(m[3]), Number(m[4]), m[5]);

  // Korean: 2024년 1월 2일 [(화)] [오후 3시 4분 | 15:04]; without a year → the current year in the site zone.
  m = /^(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*\([^)]*\))?(?:[,\s]+(.*))?$/.exec(s);
  if (m) {
    let year = m[1] !== undefined ? Number(m[1]) : zonedFields(now, timeZone).year;
    if (m[1] === undefined) {
      // A yearless date later than tomorrow is from last year (e.g. "12월 30일" read on 2 January).
      const today = zonedFields(now, timeZone);
      if (Number(m[2]) * 100 + Number(m[3]) > today.month * 100 + today.day + 1) year -= 1;
    }
    return withTail(year, Number(m[2]), Number(m[3]), m[4]);
  }

  // Month names: [Tue,] 02 Jan 2024 15:04:05 +0000 | Jan 2, 2024 3:04 PM GMT | January 2 2024
  const stripped = s.replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, "");
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:(?:,\s*|\s+)(.*))?$/i.exec(stripped);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    return month === undefined ? null : withTail(Number(m[3]), month, Number(m[2]), m[4]);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})(?:(?:,\s*|\s+)(.*))?$/i.exec(stripped);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month === undefined ? null : withTail(Number(m[3]), month, Number(m[1]), m[4]);
  }
  return null;
}

function partsToParsed(p: DateParts, timeZone: string): ParsedDate | null {
  if (!validDay(p.year, p.month, p.day)) return null;
  if (p.time === null) {
    // A calendar date (with or without a zone) stays the day as written.
    return { publishedAt: formatDayInZone(p.year, p.month, p.day, timeZone), datePrecision: "day" };
  }
  const { hour, minute, second } = p.time;
  if (!validTime(hour, minute, second)) return null;
  const instant =
    p.offset === undefined
      ? zonedTimeToDate({ year: p.year, month: p.month, day: p.day, hour, minute, second }, timeZone)
      : new Date(Date.UTC(p.year, p.month - 1, p.day, hour, minute, second) - p.offset * 60_000);
  if (Number.isNaN(instant.getTime())) return null;
  return { publishedAt: formatInZone(instant, timeZone), datePrecision: "minute" };
}

type Unit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

const EN_UNITS: Readonly<Record<string, Unit>> = {
  s: "second",
  sec: "second",
  secs: "second",
  second: "second",
  seconds: "second",
  m: "minute",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  h: "hour",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
  d: "day",
  day: "day",
  days: "day",
  w: "week",
  wk: "week",
  wks: "week",
  week: "week",
  weeks: "week",
  mo: "month",
  mos: "month",
  month: "month",
  months: "month",
  y: "year",
  yr: "year",
  yrs: "year",
  year: "year",
  years: "year",
};

const KO_UNITS: Readonly<Record<string, Unit>> = {
  초: "second",
  분: "minute",
  시간: "hour",
  일: "day",
  주: "week",
  주일: "week",
  개월: "month",
  달: "month",
  년: "year",
};

function shiftDays(now: Date, timeZone: string, days: number): { year: number; month: number; day: number } {
  const f = zonedFields(now, timeZone);
  const d = new Date(Date.UTC(f.year, f.month - 1, f.day - days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function shiftMonths(
  now: Date,
  timeZone: string,
  months: number,
): { year: number; month: number; day: number } {
  const f = zonedFields(now, timeZone);
  const total = f.year * 12 + (f.month - 1) - months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(f.day, last) };
}

function relativeAmount(amount: number, unit: Unit, now: Date, timeZone: string): ParsedDate | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const ms: Partial<Record<Unit, number>> = { second: 1_000, minute: 60_000, hour: 3_600_000 };
  const step = ms[unit];
  if (step !== undefined) {
    const t = Math.floor((now.getTime() - amount * step) / 60_000) * 60_000;
    return { publishedAt: formatInZone(new Date(t), timeZone), datePrecision: "minute" };
  }
  const day =
    unit === "day"
      ? shiftDays(now, timeZone, amount)
      : unit === "week"
        ? shiftDays(now, timeZone, amount * 7)
        : unit === "month"
          ? shiftMonths(now, timeZone, amount)
          : shiftMonths(now, timeZone, amount * 12);
  return { publishedAt: formatDayInZone(day.year, day.month, day.day, timeZone), datePrecision: "day" };
}

/** A relative day word with an optional time: `yesterday 3:04 PM`, `어제 15:30`, `오늘 오후 2:10`. */
function relativeDay(daysBack: number, timeText: string, now: Date, timeZone: string): ParsedDate | null {
  const day = shiftDays(now, timeZone, daysBack);
  const parts = withTail(day.year, day.month, day.day, timeText);
  return parts ? partsToParsed(parts, timeZone) : null;
}

function parseRelative(s: string, now: Date, timeZone: string): ParsedDate | null {
  let m: RegExpExecArray | null;
  if (/^(?:just now|now|moments? ago|a moment ago|방금(?:\s*전)?|지금)$/i.test(s)) {
    return relativeAmount(0, "minute", now, timeZone);
  }
  if ((m = /^(today|yesterday|오늘|어제|그제|그저께|엊그제)(.*)$/i.exec(s))) {
    const word = m[1]!.toLowerCase();
    const back = word === "today" || word === "오늘" ? 0 : word === "yesterday" || word === "어제" ? 1 : 2;
    return relativeDay(back, m[2] ?? "", now, timeZone);
  }
  if ((m = /^(?:(\d+)|an?|one)\s*([a-z]+)\.?\s+ago$/i.exec(s))) {
    const unit = EN_UNITS[m[2]!.toLowerCase()];
    if (unit === undefined) return null;
    return relativeAmount(m[1] !== undefined ? Number(m[1]) : 1, unit, now, timeZone);
  }
  if ((m = /^(\d+)\s*(초|분|시간|주일|일|주|개월|달|년)\s*(?:전|前)$/.exec(s))) {
    const unit = KO_UNITS[m[2]!];
    if (unit === undefined) return null;
    return relativeAmount(Number(m[1]), unit, now, timeZone);
  }
  if ((m = /^(?:한|두|세)\s*(시간|달)\s*전$/.exec(s))) {
    const n = s.startsWith("한") ? 1 : s.startsWith("두") ? 2 : 3;
    return relativeAmount(n, KO_UNITS[m[1]!]!, now, timeZone);
  }
  return null;
}

const LEADING_WORDS =
  /^(?:on|posted|published|updated|last updated|created|date|입력|수정|작성|등록|게시|발행|업데이트)\s*[:：]?\s+/i;

/** Parses a site date string; null when it is not a recognizable date. See the module comment. */
export function parseDate(input: string, options: ParseDateOptions = {}): ParsedDate | null {
  const timeZone = options.timezone ?? "UTC";
  if (!isKnownTimeZone(timeZone)) return null;
  const now = options.now ?? new Date();
  let s = String(input)
    .replace(/[\u00a0\u2009\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 2; i++) s = s.replace(LEADING_WORDS, "");
  s = s.replace(/^[[(]|[\])]$/g, "").trim();
  if (s === "" || s.length > 80) return null;
  const relative = parseRelative(s, now, timeZone);
  if (relative) return relative;
  const parts = parseAbsolute(s, now, timeZone);
  return parts ? partsToParsed(parts, timeZone) : null;
}

/** The precision a date string carries (`minute` with a time of day, `day` for a date), or null. */
export function detectDatePrecision(input: string, options: ParseDateOptions = {}): DatePrecision | null {
  return parseDate(input, options)?.datePrecision ?? null;
}
