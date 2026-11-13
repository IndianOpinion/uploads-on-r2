import { describe, expect, it } from "vitest";
import { formatHttpDate } from "../src/http";
import { bodyBytes, bytes, harness, type Harness, PREFIX, SOURCE } from "./helpers";

const DATA = bytes(1000);

async function seeded(): Promise<{ h: Harness; object: R2Object }> {
  const h = await harness({ EDGE_CACHE: "off" });
  const object = await h.seed("a.mp4", DATA, { contentType: "video/mp4" });
  return { h, object };
}

async function expectPartial(h: Harness, range: string, start: number, end: number): Promise<void> {
  const res = await h.run(PREFIX + "a.mp4", { headers: { range } });
  expect(res.status, range).toBe(206);
  expect(res.headers.get("content-range"), range).toBe(`bytes ${start}-${end}/1000`);
  expect(res.headers.get("content-length"), range).toBe(String(end - start + 1));
  expect(res.headers.get("accept-ranges")).toBe("bytes");
  expect(res.headers.get(SOURCE)).toBe("r2");
  expect(await bodyBytes(res), range).toEqual(DATA.slice(start, end + 1));
}

describe("4.8 range requests", () => {
  it("T41: bytes=0-99 returns exactly the first 100 bytes", async () => {
    const { h } = await seeded();
    await expectPartial(h, "bytes=0-99", 0, 99);
    expect(h.bucket.calls[0]?.options?.range).toEqual({ offset: 0, length: 100 });
  });

  it("T42: an open-ended range returns to the end", async () => {
    const { h } = await seeded();
    await expectPartial(h, "bytes=500-", 500, 999);
  });

  it("T43: a suffix range is computed from the size", async () => {
    const { h } = await seeded();
    await expectPartial(h, "bytes=-200", 800, 999);
  });

  it("T44: a suffix longer than the object returns the whole object as 206", async () => {
    const { h } = await seeded();
    await expectPartial(h, "bytes=-5000", 0, 999);
  });

  it("T45: an end beyond the object is clamped", async () => {
    const { h } = await seeded();
    await expectPartial(h, "bytes=900-5000", 900, 999);
  });

  it("T46 (ruling 4): a start at or past the size, or any range on an empty object, is 416 after one head call", async () => {
    const { h } = await seeded();
    await h.seed("empty.mp4", new Uint8Array(0));
    for (const [path, range, size] of [
      ["a.mp4", "bytes=1000-", 1000],
      ["a.mp4", "bytes=2000-3000", 1000],
      ["empty.mp4", "bytes=0-", 0],
      ["empty.mp4", "bytes=-5", 0],
    ] as const) {
      const before = h.bucket.calls.length;
      const res = await h.run(PREFIX + path, { headers: { range } });
      expect(res.status, `${path} ${range}`).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${size}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.body).toBeNull();
      expect(h.bucket.calls.slice(before).map((c) => c.method)).toEqual(["get", "head"]);
    }
  });

  it("T47: several ranges, another unit or a malformed header are ignored: full 200", async () => {
    const { h } = await seeded();
    for (const range of ["bytes=0-1,5-6", "items=0-1", "bytes=abc", "bytes=5-2", "bytes=", "bytes=-", "bytes=1-2-3"]) {
      const res = await h.run(PREFIX + "a.mp4", { headers: { range } });
      expect(res.status, range).toBe(200);
      expect(res.headers.has("content-range")).toBe(false);
      expect(await bodyBytes(res)).toEqual(DATA);
    }
  });

  it("T48: a matching If-Range applies the range; a stale one returns the whole object", async () => {
    const { h, object } = await seeded();
    await expectPartialWith(h, { range: "bytes=0-9", "if-range": object.httpEtag }, 206);
    await expectPartialWith(h, { range: "bytes=0-9", "if-range": formatHttpDate(object.uploaded) }, 206);
    await expectPartialWith(h, { range: "bytes=0-9", "if-range": '"stale"' }, 200);
    await expectPartialWith(h, { range: "bytes=0-9", "if-range": `W/${object.httpEtag}` }, 200);
    await expectPartialWith(h, { range: "bytes=0-9", "if-range": "Thu, 01 Jan 1970 00:00:00 GMT" }, 200);
    await expectPartialWith(h, { range: "bytes=5000-", "if-range": '"stale"' }, 200);
  });

  it("T49: HEAD with a valid range returns the 206 headers with no body", async () => {
    const { h } = await seeded();
    const res = await h.run(PREFIX + "a.mp4", { method: "HEAD", headers: { range: "bytes=0-99" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-99/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.body).toBeNull();
    expect(h.bucket.calls.map((c) => c.method)).toEqual(["head"]);
  });

  it("T50: a plain GET is never 206 and never passes a range to R2", async () => {
    const { h } = await seeded();
    const res = await h.run(PREFIX + "a.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.has("content-range")).toBe(false);
    expect(h.bucket.calls[0]?.options).toBeUndefined();
    await res.arrayBuffer();
  });

  it("T51: accept-ranges is on 200, 206 and 304", async () => {
    const { h, object } = await seeded();
    const headerSets: Record<string, string>[] = [{}, { range: "bytes=0-1" }, { "if-none-match": object.httpEtag }];
    for (const headers of headerSets) {
      const res = await h.run(PREFIX + "a.mp4", { headers });
      expect(res.headers.get("accept-ranges"), JSON.stringify(headers)).toBe("bytes");
      await res.body?.cancel();
    }
  });
});

async function expectPartialWith(h: Harness, headers: Record<string, string>, status: 200 | 206): Promise<void> {
  const res = await h.run(PREFIX + "a.mp4", { headers });
  expect(res.status, JSON.stringify(headers)).toBe(status);
  const body = await bodyBytes(res);
  expect(body).toEqual(status === 206 ? DATA.slice(0, 10) : DATA);
}
