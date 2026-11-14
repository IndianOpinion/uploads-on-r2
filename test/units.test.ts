import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { cacheControlFor, contentTypeFor, familyOf } from "../src/content-type";
import {
  evaluatePreconditions,
  formatHttpDate,
  ifRangeMatches,
  parseEntityTags,
  parseHttpDate,
  parseRange,
  parseRangeSpec,
} from "../src/http";
import { extensionOf, isDenied, normaliseKey } from "../src/key";
import { sliceStream } from "../src/stream";
import { bytes } from "./helpers";

describe("http dates", () => {
  it("parses the three formats RFC 9110 requires", () => {
    const expected = Date.UTC(1994, 10, 6, 8, 49, 37) / 1000;
    expect(parseHttpDate("Sun, 06 Nov 1994 08:49:37 GMT")).toBe(expected);
    expect(parseHttpDate("Sunday, 06-Nov-94 08:49:37 GMT")).toBe(expected);
    expect(parseHttpDate("Sun Nov  6 08:49:37 1994")).toBe(expected);
  });

  it("rejects garbage and impossible dates", () => {
    for (const bad of [
      "",
      "yesterday",
      "Sun, 31 Feb 2026 00:00:00 GMT",
      "Sun, 06 Nov 1994 25:00:00 GMT",
      "1994-11-06T08:49:37Z",
    ]) {
      expect(parseHttpDate(bad), bad).toBeNull();
    }
  });

  it("formats IMF-fixdate", () => {
    expect(formatHttpDate(new Date(Date.UTC(1994, 10, 6, 8, 49, 37)))).toBe("Sun, 06 Nov 1994 08:49:37 GMT");
  });
});

describe("entity tags and preconditions", () => {
  it("parses lists, weak tags and the wildcard", () => {
    expect(parseEntityTags("*")).toBe("*");
    expect(parseEntityTags('"a", W/"b" ,"c,d"')).toEqual([
      { weak: false, opaque: "a" },
      { weak: true, opaque: "b" },
      { weak: false, opaque: "c,d" },
    ]);
    expect(parseEntityTags('bogus, "x"')).toEqual([{ weak: false, opaque: "x" }]);
  });

  it("evaluates in RFC 9110 order", () => {
    const lm = new Date(Date.UTC(2026, 0, 1));
    const h = (init: Record<string, string>): Headers => new Headers(init);
    expect(evaluatePreconditions(h({}), '"e"', lm)).toBe("pass");
    expect(evaluatePreconditions(h({ "if-match": '"x"', "if-none-match": '"e"' }), '"e"', lm)).toBe(412);
    expect(evaluatePreconditions(h({ "if-match": '"e"', "if-none-match": '"e"' }), '"e"', lm)).toBe(304);
    expect(evaluatePreconditions(h({ "if-none-match": 'W/"e"' }), '"e"', lm)).toBe(304);
    expect(
      evaluatePreconditions(h({ "if-unmodified-since": formatHttpDate(new Date(lm.getTime() - 1000)) }), '"e"', lm),
    ).toBe(412);
    expect(evaluatePreconditions(h({ "if-unmodified-since": formatHttpDate(lm) }), '"e"', lm)).toBe("pass");
  });

  it("If-Range needs a strong tag or an exact date", () => {
    const lm = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 900));
    expect(ifRangeMatches('"e"', '"e"', lm)).toBe(true);
    expect(ifRangeMatches('W/"e"', '"e"', lm)).toBe(false);
    expect(ifRangeMatches(formatHttpDate(lm), '"e"', lm)).toBe(true);
    expect(ifRangeMatches("nonsense", '"e"', lm)).toBe(false);
  });
});

describe("ranges", () => {
  it("parses single byte ranges only", () => {
    expect(parseRangeSpec("bytes=0-99")).toEqual({ kind: "bounded", start: 0, end: 99 });
    expect(parseRangeSpec("Bytes = 5-")).toEqual({ kind: "open", start: 5 });
    expect(parseRangeSpec("bytes=-20")).toEqual({ kind: "suffix", length: 20 });
    for (const bad of [
      "bytes=0-1,2-3",
      "items=0-1",
      "bytes=abc",
      "bytes=5-2",
      "bytes=-",
      "bytes=1e3-",
      "bytes=99999999999999999-",
    ]) {
      expect(parseRangeSpec(bad), bad).toBeNull();
    }
  });

  it("resolves against the size", () => {
    expect(parseRange(null, 10)).toEqual({ type: "none" });
    expect(parseRange("bytes=-0", 10)).toEqual({ type: "unsatisfiable" });
    expect(parseRange("bytes=0-", 0)).toEqual({ type: "unsatisfiable" });
    expect(parseRange("bytes=-3", 10)).toEqual({ type: "partial", start: 7, end: 9 });
    expect(parseRange("bytes=8-100", 10)).toEqual({ type: "partial", start: 8, end: 9 });
  });
});

describe("keys", () => {
  const config = parseConfig({}).config;

  it("denies private folders at the root and under a multisite site folder", () => {
    expect(isDenied("sites/12/wc-logs/a.log", config.denyPrefixes)).toBe(true);
    expect(isDenied("Sites/2/WP-Personal-Data-Exports/a.zip", config.denyPrefixes)).toBe(true);
    expect(isDenied("sites/2/2026/01/a.jpg", config.denyPrefixes)).toBe(false);
    expect(isDenied("2026/wc-logs/a.jpg", config.denyPrefixes)).toBe(false);
  });

  it("maps a path to an object key", () => {
    expect(normaliseKey("/wp-content/uploads/2026/01/a.jpg", config)).toEqual({
      kind: "key",
      relativeKey: "2026/01/a.jpg",
      objectKey: "wp-content/uploads/2026/01/a.jpg",
      tooLong: false,
    });
    expect(normaliseKey("/elsewhere/a.jpg", config)).toEqual({ kind: "outside" });
  });

  it("measures key length in UTF-8 bytes", () => {
    const fits = "é".repeat(Math.floor((1024 - "wp-content/uploads/".length) / 2));
    const result = normaliseKey("/wp-content/uploads/" + encodeURIComponent(fits), config);
    expect(result.kind === "key" && result.tooLong).toBe(false);
    const over = normaliseKey("/wp-content/uploads/" + encodeURIComponent(fits + "é"), config);
    expect(over.kind === "key" && over.tooLong).toBe(true);
  });

  it("takes the extension from the final segment", () => {
    expect(extensionOf("a.b/c")).toBe("");
    expect(extensionOf("dir/.htaccess")).toBe("");
    expect(extensionOf("x/Photo.JPG")).toBe("jpg");
    expect(extensionOf("a.")).toBe("");
    expect(extensionOf("shell.php.jpg")).toBe("jpg");
  });
});

describe("content types", () => {
  it("prefers a safe stored type and falls back to the table", () => {
    expect(contentTypeFor("png", "image/png")).toBe("image/png");
    expect(contentTypeFor("png", "binary/octet-stream")).toBe("image/png");
    expect(contentTypeFor("png", undefined)).toBe("image/png");
    expect(contentTypeFor("jpg", "text/html; charset=utf-8")).toBe("image/jpeg");
    expect(contentTypeFor("pdf", "application/vnd.foo+xml")).toBe("application/pdf");
    expect(contentTypeFor("svg", "text/plain")).toBe("image/svg+xml");
    expect(contentTypeFor("heic", "")).toBe("application/octet-stream");
  });

  it("trusts a stored type only when it is one well-formed type of the same kind as the extension", () => {
    expect(contentTypeFor("jpg", "image/pjpeg")).toBe("image/pjpeg");
    expect(contentTypeFor("mp4", "video/quicktime")).toBe("video/quicktime");
    expect(contentTypeFor("jpg", "application/pdf")).toBe("image/jpeg");
    expect(contentTypeFor("jpg", "text/plain")).toBe("image/jpeg");
    expect(contentTypeFor("pdf", "image/png")).toBe("application/pdf");
    expect(contentTypeFor("mp3", "video/mp4")).toBe("audio/mpeg");
    // A comma list lets a browser pick the last type; never trusted.
    expect(contentTypeFor("jpg", "image/jpeg, text/html")).toBe("image/jpeg");
    expect(contentTypeFor("jpg", "image/jpeg\r\nx-evil: 1")).toBe("image/jpeg");
    expect(contentTypeFor("jpg", "image")).toBe("image/jpeg");
    expect(contentTypeFor("jpg", "TEXT/HTML ")).toBe("image/jpeg");
    // An added extension with no table entry: stored type if safe, else octet-stream.
    expect(contentTypeFor("heic", "image/heic")).toBe("image/heic");
    expect(contentTypeFor("heic", "text/html")).toBe("application/octet-stream");
    expect(contentTypeFor("heic", "application/rss+xml")).toBe("application/octet-stream");
    expect(contentTypeFor("heic", "text/javascript; charset=utf-8")).toBe("application/octet-stream");
  });

  it("groups types into cache families", () => {
    expect(familyOf("image/webp")).toBe("image");
    expect(familyOf("video/mp4")).toBe("video");
    expect(familyOf("audio/mpeg")).toBe("audio");
    expect(familyOf("application/pdf")).toBe("document");
    expect(familyOf("application/octet-stream")).toBe("other");
    const config = parseConfig({ CACHE_CONTROL_BY_FAMILY: { document: "no-cache" } }).config;
    expect(cacheControlFor("application/pdf", config)).toBe("no-cache");
    expect(cacheControlFor("image/png", config)).toBe("public, max-age=31536000, immutable");
  });
});

describe("sliceStream", () => {
  async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function chunked(data: Uint8Array, size: number): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller): void {
        if (offset >= data.length) {
          controller.close();
          return;
        }
        controller.enqueue(data.slice(offset, offset + size));
        offset += size;
      },
    });
  }

  it("cuts across chunk boundaries", async () => {
    const data = bytes(100);
    for (const [start, length, chunk] of [
      [0, 100, 7],
      [3, 10, 4],
      [95, 5, 10],
      [50, 1, 1],
    ] as const) {
      expect(await collect(sliceStream(chunked(data, chunk), start, length))).toEqual(
        data.slice(start, start + length),
      );
    }
  });

  it("errors when the source is shorter than the range", async () => {
    await expect(collect(sliceStream(chunked(bytes(10), 4), 5, 10))).rejects.toThrow();
  });
});
