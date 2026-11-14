/**
 * Pure HTTP helpers: HTTP dates, entity tags, preconditions (RFC 9110
 * section 13) and single byte ranges (RFC 9110 section 14). No I/O.
 */

/** Result of evaluating the request preconditions against a representation. */
export type PreconditionResult = "pass" | 304 | 412;

/** A syntactically valid single byte range, before the size is known. */
export type RangeSpec =
  | { readonly kind: "bounded"; readonly start: number; readonly end: number }
  | { readonly kind: "open"; readonly start: number }
  | { readonly kind: "suffix"; readonly length: number };

/** A range resolved against a known representation size. */
export type RangeResult =
  | { readonly type: "none" }
  | { readonly type: "unsatisfiable" }
  | { readonly type: "partial"; readonly start: number; readonly end: number };

interface EntityTag {
  readonly weak: boolean;
  readonly opaque: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_DIGITS = 15;

/** Formats a date as an IMF-fixdate, for example `Sun, 06 Nov 1994 08:49:37 GMT`. */
export function formatHttpDate(date: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return (
    `${DAYS[date.getUTCDay()] ?? ""}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""} ` +
    `${String(date.getUTCFullYear()).padStart(4, "0")} ${pad(date.getUTCHours())}:` +
    `${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`
  );
}

/**
 * Parses an HTTP date. Accepts the three formats RFC 9110 section 5.6.7
 * says a recipient must accept. Returns epoch seconds, or null when the
 * value is not a valid HTTP date (the caller then ignores the header).
 */
export function parseHttpDate(value: string): number | null {
  const v = value.trim();
  // IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
  let m = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(v);
  if (m !== null) {
    return toEpoch(m[3], m[2], m[1], m[4], m[5], m[6]);
  }
  // rfc850-date: Sunday, 06-Nov-94 08:49:37 GMT
  m =
    /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      v,
    );
  if (m !== null) {
    const yy = Number(m[3]);
    // Two-digit years: RFC 9110 says to treat a year more than 50 years in
    // the future as the past century.
    const now = new Date().getUTCFullYear();
    let year = 2000 + yy;
    if (year > now + 50) {
      year -= 100;
    }
    return toEpoch(String(year), m[2], m[1], m[4], m[5], m[6]);
  }
  // asctime-date: Sun Nov  6 08:49:37 1994
  m = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(v);
  if (m !== null) {
    return toEpoch(m[6], m[1], (m[2] ?? "").trim(), m[3], m[4], m[5]);
  }
  return null;
}

function toEpoch(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
  hour: string | undefined,
  minute: string | undefined,
  second: string | undefined,
): number | null {
  const mi = MONTHS.indexOf(month ?? "");
  const y = Number(year);
  const d = Number(day);
  const h = Number(hour);
  const min = Number(minute);
  const s = Number(second);
  if (mi < 0 || d < 1 || d > 31 || h > 23 || min > 59 || s > 60) {
    return null;
  }
  const ms = Date.UTC(y, mi, d, h, min, Math.min(s, 59));
  const check = new Date(ms);
  if (Number.isNaN(ms) || check.getUTCDate() !== d) {
    return null;
  }
  return Math.floor(ms / 1000);
}

/** Epoch seconds of a date, truncated, which is the precision HTTP dates carry. */
export function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Parses an entity-tag list (`If-Match`, `If-None-Match`). Returns `"*"`
 * for the wildcard, or the list of tags. Malformed members are skipped.
 */
export function parseEntityTags(value: string): "*" | EntityTag[] {
  const v = value.trim();
  if (v === "*") {
    return "*";
  }
  const tags: EntityTag[] = [];
  let i = 0;
  while (i < v.length) {
    while (i < v.length && (v[i] === " " || v[i] === "\t" || v[i] === ",")) {
      i++;
    }
    if (i >= v.length) {
      break;
    }
    let weak = false;
    if (v.startsWith("W/", i)) {
      weak = true;
      i += 2;
    }
    if (v[i] !== '"') {
      // Malformed member: skip to the next comma.
      const next = v.indexOf(",", i);
      i = next < 0 ? v.length : next + 1;
      continue;
    }
    const close = v.indexOf('"', i + 1);
    if (close < 0) {
      break;
    }
    tags.push({ weak, opaque: v.slice(i + 1, close) });
    i = close + 1;
  }
  return tags;
}

function parseSingleTag(value: string): EntityTag | null {
  const parsed = parseEntityTags(value);
  if (parsed === "*" || parsed.length !== 1) {
    return null;
  }
  return parsed[0] ?? null;
}

function strongMatch(a: EntityTag, b: EntityTag): boolean {
  return !a.weak && !b.weak && a.opaque === b.opaque;
}

function weakMatch(a: EntityTag, b: EntityTag): boolean {
  return a.opaque === b.opaque;
}

/**
 * Evaluates `If-Match`, `If-Unmodified-Since`, `If-None-Match` and
 * `If-Modified-Since` in the order RFC 9110 section 13.2.2 sets, for a
 * `GET` or `HEAD` of a representation that exists.
 *
 * A failed `If-Match` or `If-Unmodified-Since` is 412, never 304.
 *
 * @param etag the current quoted entity tag, for example `"abc"`
 * @param lastModified the current modification time
 */
export function evaluatePreconditions(headers: Headers, etag: string, lastModified: Date): PreconditionResult {
  const current = parseSingleTag(etag);
  const modified = epochSeconds(lastModified);

  const ifMatch = headers.get("if-match");
  if (ifMatch !== null) {
    const tags = parseEntityTags(ifMatch);
    const ok = tags === "*" || (current !== null && tags.some((t) => strongMatch(t, current)));
    if (!ok) {
      return 412;
    }
  } else {
    const ius = headers.get("if-unmodified-since");
    if (ius !== null) {
      const date = parseHttpDate(ius);
      if (date !== null && modified > date) {
        return 412;
      }
    }
  }

  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    const tags = parseEntityTags(ifNoneMatch);
    const matched = tags === "*" || (current !== null && tags.some((t) => weakMatch(t, current)));
    if (matched) {
      return 304;
    }
  } else {
    const ims = headers.get("if-modified-since");
    if (ims !== null) {
      const date = parseHttpDate(ims);
      if (date !== null && modified <= date) {
        return 304;
      }
    }
  }
  return "pass";
}

/**
 * Evaluates `If-Range` (RFC 9110 section 13.1.5). An entity tag must match
 * strongly; a date must equal the modification time exactly. Anything else,
 * including a malformed value, does not match and the range is ignored.
 */
export function ifRangeMatches(value: string, etag: string, lastModified: Date): boolean {
  const v = value.trim();
  if (v.startsWith('"') || v.startsWith("W/")) {
    const want = parseSingleTag(v);
    const current = parseSingleTag(etag);
    return want !== null && current !== null && strongMatch(want, current);
  }
  const date = parseHttpDate(v);
  return date !== null && date === epochSeconds(lastModified);
}

function parseDigits(s: string): number | null {
  if (s.length === 0 || s.length > MAX_DIGITS) {
    return null;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) {
      return null;
    }
  }
  return Number(s);
}

/**
 * Parses a `Range` header into a single byte range. Returns null when the
 * header must be ignored: another unit, several ranges, or bad syntax.
 * Uses no regular expression, so it cannot backtrack on user input.
 */
export function parseRangeSpec(header: string): RangeSpec | null {
  const v = header.trim();
  const eq = v.indexOf("=");
  if (eq < 0 || v.slice(0, eq).trim().toLowerCase() !== "bytes") {
    return null;
  }
  const set = v.slice(eq + 1).trim();
  if (set.includes(",")) {
    return null;
  }
  const dash = set.indexOf("-");
  if (dash < 0) {
    return null;
  }
  const first = set.slice(0, dash).trim();
  const last = set.slice(dash + 1).trim();
  if (first === "") {
    const length = parseDigits(last);
    return length === null ? null : { kind: "suffix", length };
  }
  const start = parseDigits(first);
  if (start === null) {
    return null;
  }
  if (last === "") {
    return { kind: "open", start };
  }
  const end = parseDigits(last);
  if (end === null || end < start) {
    return null;
  }
  return { kind: "bounded", start, end };
}

/** Resolves a range spec against a size. Null means unsatisfiable (416). */
export function resolveRange(spec: RangeSpec, size: number): { start: number; end: number } | null {
  if (size <= 0) {
    return null;
  }
  switch (spec.kind) {
    case "suffix":
      if (spec.length === 0) {
        return null;
      }
      return { start: Math.max(0, size - spec.length), end: size - 1 };
    case "open":
      return spec.start >= size ? null : { start: spec.start, end: size - 1 };
    case "bounded":
      return spec.start >= size ? null : { start: spec.start, end: Math.min(spec.end, size - 1) };
  }
}

/**
 * Parses a `Range` header against a known size, in one step. `none` means
 * serve the full representation.
 */
export function parseRange(header: string | null, size: number): RangeResult {
  if (header === null) {
    return { type: "none" };
  }
  const spec = parseRangeSpec(header);
  if (spec === null) {
    return { type: "none" };
  }
  const resolved = resolveRange(spec, size);
  return resolved === null ? { type: "unsatisfiable" } : { type: "partial", ...resolved };
}

/** True when a header name is a valid HTTP token, so it can be set safely. */
export function isHeaderName(name: string): boolean {
  if (name.length === 0 || name.length > 64) {
    return false;
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      "!#$%&'*+-.^_`|~".includes(name[i] ?? "");
    if (!ok) {
      return false;
    }
  }
  return true;
}

/** True when a value can go into a header without CR, LF or NUL. */
export function isHeaderValue(value: string): boolean {
  return value.trim().length > 0 && !/[\r\n\0]/.test(value);
}
