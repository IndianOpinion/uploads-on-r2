import { describe, expect, it } from "vitest";
import { formatHttpDate } from "../src/http";
import { bytes, harness, type Harness, PREFIX, SOURCE } from "./helpers";

async function seeded(vars = {}): Promise<{ h: Harness; etag: string; uploaded: Date }> {
  const h = await harness(vars);
  const object = await h.seed("a.jpg", bytes(100));
  return { h, etag: object.httpEtag, uploaded: object.uploaded };
}

const second = 1000;

describe("4.7 conditional requests", () => {
  it("T34: a failing If-Match is 412, never 304; If-Match: * on an existing object is 200", async () => {
    const { h, etag } = await seeded();
    const failed = await h.run(PREFIX + "a.jpg", { headers: { "if-match": '"other"', "if-none-match": etag } });
    expect(failed.status).toBe(412);
    expect(failed.body).toBeNull();
    const weak = await h.run(PREFIX + "a.jpg", { headers: { "if-match": `W/${etag}` } });
    expect(weak.status).toBe(412);
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-match": "*" } })).status).toBe(200);
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-match": `"x", ${etag}` } })).status).toBe(200);
  });

  it("T35: If-Unmodified-Since before the upload time is 412, and is ignored when If-Match is present", async () => {
    const { h, etag, uploaded } = await seeded();
    const before = formatHttpDate(new Date(uploaded.getTime() - 3600 * second));
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-unmodified-since": before } })).status).toBe(412);
    const after = formatHttpDate(new Date(uploaded.getTime() + 3600 * second));
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-unmodified-since": after } })).status).toBe(200);
    const both = await h.run(PREFIX + "a.jpg", { headers: { "if-unmodified-since": before, "if-match": etag } });
    expect(both.status).toBe(200);
  });

  it("T36: a matching If-None-Match is 304: exact, weak, in a list, and *", async () => {
    const { h, etag } = await seeded();
    for (const value of [etag, `W/${etag}`, `"a", ${etag}, "b"`, "*"]) {
      const res = await h.run(PREFIX + "a.jpg", { headers: { "if-none-match": value } });
      expect(res.status, value).toBe(304);
    }
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-none-match": '"nope"' } })).status).toBe(200);
  });

  it("T37: If-Modified-Since at or after the upload time is 304; ignored when If-None-Match is present", async () => {
    const { h, uploaded } = await seeded();
    const at = formatHttpDate(uploaded);
    const later = formatHttpDate(new Date(uploaded.getTime() + 3600 * second));
    const earlier = formatHttpDate(new Date(uploaded.getTime() - 3600 * second));
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-modified-since": at } })).status).toBe(304);
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-modified-since": later } })).status).toBe(304);
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-modified-since": earlier } })).status).toBe(200);
    const both = await h.run(PREFIX + "a.jpg", { headers: { "if-modified-since": later, "if-none-match": '"nope"' } });
    expect(both.status).toBe(200);
  });

  it("T38: 304 and 412 carry validators, cache-control, nosniff and source; no body or full length", async () => {
    const { h, etag } = await seeded();
    for (const headers of [{ "if-none-match": etag }, { "if-match": '"nope"' }]) {
      const res = await h.run(PREFIX + "a.jpg", { headers });
      expect([304, 412]).toContain(res.status);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.has("last-modified")).toBe(true);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get(SOURCE)).toBe("r2");
      expect(res.headers.get("content-length")).not.toBe("100");
      expect(res.body).toBeNull();
    }
  });

  it("T39: an unparseable If-Modified-Since or If-Unmodified-Since is ignored", async () => {
    const { h } = await seeded();
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-modified-since": "yesterday" } })).status).toBe(200);
    expect((await h.run(PREFIX + "a.jpg", { headers: { "if-unmodified-since": "garbage" } })).status).toBe(200);
  });

  it("T40: conditionals give the same answers on edge-cache hits and on R2 reads", async () => {
    const { h, etag, uploaded } = await seeded();
    await (await h.runAndSettle(PREFIX + "a.jpg")).arrayBuffer();
    const r2 = await harness({ EDGE_CACHE: "off", KEY_PREFIX: h.keyPrefix });
    const cases: Record<string, string>[] = [
      { "if-match": '"nope"' },
      { "if-match": etag },
      { "if-none-match": etag },
      { "if-none-match": `W/${etag}` },
      { "if-modified-since": formatHttpDate(uploaded) },
      { "if-unmodified-since": formatHttpDate(new Date(uploaded.getTime() - 3600 * second)) },
      { "if-modified-since": "garbage" },
      { range: "bytes=0-9", "if-range": etag },
      { range: "bytes=0-9", "if-range": '"stale"' },
      { range: "bytes=500-" },
    ];
    for (const headers of cases) {
      const fromCache = await h.run(PREFIX + "a.jpg", { headers });
      const fromR2 = await r2.run(PREFIX + "a.jpg", { headers });
      expect(fromCache.headers.get(SOURCE), JSON.stringify(headers)).toBe("edge-cache");
      expect(fromR2.headers.get(SOURCE)).toBe("r2");
      expect(fromCache.status, JSON.stringify(headers)).toBe(fromR2.status);
      for (const name of ["etag", "last-modified", "content-length", "content-range", "cache-control"]) {
        expect(fromCache.headers.get(name), `${name} ${JSON.stringify(headers)}`).toBe(fromR2.headers.get(name));
      }
      await fromCache.body?.cancel();
      await fromR2.body?.cancel();
    }
    expect(h.bucket.count()).toBe(1);
  });
});
