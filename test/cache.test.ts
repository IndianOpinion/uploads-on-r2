import { describe, expect, it } from "vitest";
import { bodyBytes, bytes, harness, HOST, PREFIX, SOURCE, text } from "./helpers";

const URL_A = HOST + PREFIX + "a.jpg";

describe("4.5 edge cache", () => {
  it("T21: a second GET is served from the edge cache with no R2 call", async () => {
    const h = await harness();
    await h.seed("a.jpg", bytes(300), { contentType: "image/jpeg" });
    const first = await h.runAndSettle(PREFIX + "a.jpg");
    expect(first.headers.get(SOURCE)).toBe("r2");
    expect(await bodyBytes(first)).toEqual(bytes(300));
    const second = await h.run(PREFIX + "a.jpg");
    expect(second.status).toBe(200);
    expect(second.headers.get(SOURCE)).toBe("edge-cache");
    expect(second.headers.get("content-length")).toBe("300");
    expect(second.headers.get("content-type")).toBe("image/jpeg");
    expect(await bodyBytes(second)).toEqual(bytes(300));
    expect(h.bucket.count()).toBe(1);
  });

  it("T22: HEAD is answered from a cache hit with no body; HEAD on a cold cache writes nothing", async () => {
    const cold = await harness();
    await cold.seed("a.jpg", bytes(50));
    const coldHead = await cold.runAndSettle(PREFIX + "a.jpg", { method: "HEAD" });
    expect(coldHead.headers.get(SOURCE)).toBe("r2");
    expect(cold.cache.puts).toHaveLength(0);
    expect(await cold.cache.peek(URL_A)).toBeUndefined();

    const h = await harness();
    await h.seed("a.jpg", bytes(50));
    await (await h.runAndSettle(PREFIX + "a.jpg")).arrayBuffer();
    const head = await h.run(PREFIX + "a.jpg", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get(SOURCE)).toBe("edge-cache");
    expect(head.headers.get("content-length")).toBe("50");
    expect(head.body).toBeNull();
    expect(h.bucket.count()).toBe(1);
  });

  it("T23: the client gets the response before the cache write settles; the copy is byte-identical", async () => {
    const h = await harness();
    await h.seed("a.jpg", bytes(4096));
    let release: () => void = () => undefined;
    h.cache.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const { handleRequest } = await import("../src/handler");
    const ctx = createExecutionContext();
    const response = await handleRequest(new Request(URL_A), h.env, ctx, {
      fetch: h.origin.fetch,
      cache: h.cache,
    });
    expect(response.status).toBe(200);
    expect(h.cache.puts).toHaveLength(1);
    expect(await h.cache.peek(URL_A)).toBeUndefined();
    expect(await bodyBytes(response)).toEqual(bytes(4096));
    release();
    await waitOnExecutionContext(ctx);
    const cached = await h.cache.peek(URL_A);
    expect(cached).toBeDefined();
    expect(await bodyBytes(cached as Response)).toEqual(bytes(4096));
  });

  it("T24: 206, 304, 412, 416, deny, fallback and oversize responses are never written", async () => {
    const h = await harness({ EDGE_CACHE_MAX_BYTES: "100" });
    await h.seed("a.jpg", bytes(50));
    await h.seed("big.jpg", bytes(101));
    const etag = (await h.run(PREFIX + "a.jpg", { method: "HEAD" })).headers.get("etag") ?? "";
    const requests: [string, RequestInit][] = [
      ["a.jpg", { headers: { range: "bytes=0-9" } }],
      ["a.jpg", { headers: { "if-none-match": etag } }],
      ["a.jpg", { headers: { "if-match": '"nope"' } }],
      ["a.jpg", { headers: { range: "bytes=500-" } }],
      ["wc-logs/a.jpg", {}],
      ["missing.jpg", {}],
      ["big.jpg", {}],
    ];
    const statuses: number[] = [];
    for (const [path, init] of requests) {
      const res = await h.runAndSettle(PREFIX + path, init);
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses).toEqual([206, 304, 412, 416, 404, 404, 200]);
    // Only the negative-cache marker for missing.jpg may be written.
    expect(h.cache.puts.every((u) => u.includes("uploads-on-r2-negative"))).toBe(true);
    for (const path of ["a.jpg", "wc-logs/a.jpg", "missing.jpg", "big.jpg"]) {
      expect(await h.cache.peek(HOST + PREFIX + path), path).toBeUndefined();
    }
  });

  it("T25 (ruling 1): a range on a cold cache reads R2 and writes nothing; on a warm cache it is cut from the cached copy", async () => {
    const h = await harness();
    await h.seed("a.jpg", bytes(1000));
    const cold = await h.runAndSettle(PREFIX + "a.jpg", { headers: { range: "bytes=10-19" } });
    expect(cold.status).toBe(206);
    expect(cold.headers.get(SOURCE)).toBe("r2");
    expect(await bodyBytes(cold)).toEqual(bytes(1000).slice(10, 20));
    expect(h.cache.puts).toHaveLength(0);

    await (await h.runAndSettle(PREFIX + "a.jpg")).arrayBuffer();
    const r2Calls = h.bucket.count();
    const cases: [string, number, number][] = [
      ["bytes=0-99", 0, 99],
      ["bytes=500-", 500, 999],
      ["bytes=-200", 800, 999],
      ["bytes=-5000", 0, 999],
      ["bytes=900-5000", 900, 999],
    ];
    for (const [range, start, end] of cases) {
      const res = await h.run(PREFIX + "a.jpg", { headers: { range } });
      expect(res.status, range).toBe(206);
      expect(res.headers.get(SOURCE)).toBe("edge-cache");
      expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/1000`);
      expect(res.headers.get("content-length")).toBe(String(end - start + 1));
      expect(await bodyBytes(res)).toEqual(bytes(1000).slice(start, end + 1));
    }
    const unsatisfiable = await h.run(PREFIX + "a.jpg", { headers: { range: "bytes=1000-" } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */1000");
    expect(h.bucket.count()).toBe(r2Calls);
  });

  it("T26: a throwing cache lookup and a throwing cache write still return the R2 response", async () => {
    const h = await harness();
    await h.seed("a.jpg", bytes(20));
    h.cache.throwOnMatch = true;
    h.cache.throwOnPut = true;
    const res = await h.runAndSettle(PREFIX + "a.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get(SOURCE)).toBe("r2");
    expect(await bodyBytes(res)).toEqual(bytes(20));
    expect(h.cache.puts).toHaveLength(1);
  });

  it("T27: the query string is not part of the cache key", async () => {
    const h = await harness();
    await h.seed("a.jpg", bytes(20));
    await (await h.runAndSettle(PREFIX + "a.jpg?ver=1")).arrayBuffer();
    const second = await h.run(PREFIX + "a.jpg?ver=2");
    expect(second.headers.get(SOURCE)).toBe("edge-cache");
    expect(h.cache.puts).toEqual([URL_A]);
    expect(h.bucket.count()).toBe(1);
  });

  it("T28: with EDGE_CACHE=off two GETs make two R2 reads and nothing is cached", async () => {
    const h = await harness({ EDGE_CACHE: "off" });
    await h.seed("a.jpg", bytes(20));
    await (await h.runAndSettle(PREFIX + "a.jpg")).arrayBuffer();
    await (await h.runAndSettle(PREFIX + "a.jpg")).arrayBuffer();
    expect(h.bucket.count("get")).toBe(2);
    expect(h.cache.matches).toHaveLength(0);
    expect(h.cache.puts).toHaveLength(0);
  });

  it("T59: after a fallback the cache holds nothing for that URL", async () => {
    const h = await harness();
    h.origin.handler = () => new Response("from origin", { status: 200, headers: { "content-type": "image/jpeg" } });
    const res = await h.runAndSettle(PREFIX + "a.jpg");
    expect(await text(res)).toBe("from origin");
    expect(h.cache.puts).toHaveLength(0);
    expect(await h.cache.peek(URL_A)).toBeUndefined();
  });

  it("objects stored with a content-encoding are not written to the edge cache", async () => {
    const h = await harness();
    await h.seed("a.svg", bytes(20), { contentEncoding: "gzip" });
    await (await h.runAndSettle(PREFIX + "a.svg")).arrayBuffer();
    expect(h.cache.puts).toHaveLength(0);
  });
});

describe("negative cache (ruling 6)", () => {
  it("a repeated origin 404 is answered from the negative cache for the configured window", async () => {
    const h = await harness();
    const first = await h.runAndSettle(PREFIX + "missing.jpg");
    expect(first.status).toBe(404);
    expect(first.headers.get(SOURCE)).toBe("origin");
    expect(await text(first)).toBe("origin 404 page");
    const second = await h.run(PREFIX + "missing.jpg");
    expect(second.status).toBe(404);
    expect(second.headers.get(SOURCE)).toBe("negative-cache");
    expect(second.headers.get("cache-control")).toBe("no-store");
    expect(await text(second)).toBe("Not Found");
    const head = await h.run(PREFIX + "missing.jpg", { method: "HEAD" });
    expect(head.headers.get(SOURCE)).toBe("negative-cache");
    expect(h.origin.requests).toHaveLength(1);
    // R2 is still read every time, so a newly synced object wins at once.
    expect(h.bucket.count()).toBe(3);
    await h.seed("missing.jpg", bytes(5));
    const synced = await h.run(PREFIX + "missing.jpg");
    expect(synced.status).toBe(200);
    expect(synced.headers.get(SOURCE)).toBe("r2");
  });

  it("the marker is stored with the configured lifetime", async () => {
    const h = await harness({ NEGATIVE_CACHE_SECONDS: "30" });
    await h.runAndSettle(PREFIX + "missing.jpg");
    const marker = await h.cache.peek(HOST + PREFIX + "missing.jpg?uploads-on-r2-negative=1");
    expect(marker?.headers.get("cache-control")).toBe("public, max-age=30");
  });

  it("is off when NEGATIVE_CACHE_SECONDS is 0 or the edge cache is off", async () => {
    for (const vars of [{ NEGATIVE_CACHE_SECONDS: "0" }, { EDGE_CACHE: "off" }]) {
      const h = await harness(vars);
      await h.runAndSettle(PREFIX + "missing.jpg");
      const again = await h.runAndSettle(PREFIX + "missing.jpg");
      expect(again.headers.get(SOURCE)).toBe("origin");
      expect(h.origin.requests).toHaveLength(2);
    }
  });

  it("only origin 404s are remembered, and R2 errors never are", async () => {
    const h = await harness();
    h.origin.handler = () => new Response("gone", { status: 410 });
    await h.runAndSettle(PREFIX + "missing.jpg");
    expect(h.cache.puts).toHaveLength(0);
    const e = await harness();
    e.bucket.throwOn = "all";
    await e.runAndSettle(PREFIX + "x.jpg");
    expect(e.cache.puts).toHaveLength(0);
  });
});
