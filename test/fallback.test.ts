import { describe, expect, it, vi } from "vitest";
import { bytes, harness, PREFIX, SOURCE, text } from "./helpers";

describe("4.9 origin fallback", () => {
  it("T52: an R2 miss forwards method, Range, conditionals and query; status and headers are kept", async () => {
    const h = await harness();
    h.origin.handler = () =>
      new Response("partial", { status: 206, headers: { "content-range": "bytes 0-6/100", "x-origin": "1" } });
    const res = await h.run(PREFIX + "missing.jpg?ver=9", {
      method: "GET",
      headers: { range: "bytes=0-6", "if-none-match": '"x"' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-6/100");
    expect(res.headers.get("x-origin")).toBe("1");
    expect(res.headers.get(SOURCE)).toBe("origin");
    expect(await text(res)).toBe("partial");
    const sent = h.origin.requests[0];
    expect(sent?.method).toBe("GET");
    expect(sent?.headers.get("range")).toBe("bytes=0-6");
    expect(sent?.headers.get("if-none-match")).toBe('"x"');
    expect(sent?.url).toBe("https://example.com/wp-content/uploads/missing.jpg?ver=9");
  });

  it("T53: an R2 binding that throws produces a fallback", async () => {
    const h = await harness();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.bucket.throwOn = "all";
    h.origin.handler = () => new Response("origin copy");
    for (const method of ["GET", "HEAD"]) {
      const res = await h.run(PREFIX + "a.jpg", { method });
      expect(res.status).toBe(200);
      expect(res.headers.get(SOURCE)).toBe("origin");
    }
    expect(errors.mock.calls.some((c) => String(c[0]).includes("r2_error"))).toBe(true);
    errors.mockRestore();
  });

  it("T54: origin cache-control and set-cookie reach the client unchanged", async () => {
    const h = await harness();
    h.origin.handler = () =>
      new Response("generated", { headers: { "cache-control": "max-age=60", "set-cookie": "a=b; Path=/" } });
    const res = await h.run(PREFIX + "a-300x200.jpg");
    expect(res.headers.get("cache-control")).toBe("max-age=60");
    expect(res.headers.get("set-cookie")).toBe("a=b; Path=/");
  });

  it("T55: an origin 404 is returned with the origin body", async () => {
    const h = await harness();
    const res = await h.run(PREFIX + "missing.jpg");
    expect(res.status).toBe(404);
    expect(await text(res)).toBe("origin 404 page");
    expect(res.headers.get("content-type")).toBe("text/html");
  });

  it("T56: an origin fetch that throws gives 502, no-store, origin-error", async () => {
    const h = await harness();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.origin.handler = () => {
      throw new Error("connection refused");
    };
    const res = await h.run(PREFIX + "missing.jpg");
    expect(res.status).toBe(502);
    expect(await text(res)).toBe("Bad Gateway");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get(SOURCE)).toBe("origin-error");
    expect(errors.mock.calls.some((c) => String(c[0]).includes("origin_error"))).toBe(true);
    errors.mockRestore();
  });

  it("T57: a request with the hop header is passed with no R2 read; fallback subrequests carry the header", async () => {
    const h = await harness({ ORIGIN_OVERRIDE: "https://origin.example.net" });
    await h.seed("a.jpg", bytes(5));
    h.origin.handler = () => new Response("origin");
    const res = await h.run(PREFIX + "a.jpg", { headers: { "x-uploads-hop": "1" } });
    expect(await text(res)).toBe("origin");
    expect(res.headers.has(SOURCE)).toBe(false);
    expect(h.bucket.count()).toBe(0);
    // A hop request goes out unchanged, never through the override.
    expect(h.origin.requests[0]?.url).toBe("https://example.com/wp-content/uploads/a.jpg");
    await h.run(PREFIX + "missing.jpg");
    expect(h.origin.requests[1]?.headers.get("x-uploads-hop")).toBe("1");
  });

  it("T57: the hop header name is configurable", async () => {
    const h = await harness({ HOP_HEADER: "X-Edge-Loop" });
    await h.seed("a.jpg", bytes(5));
    await h.run(PREFIX + "a.jpg", { headers: { "x-edge-loop": "1" } });
    expect(h.bucket.count()).toBe(0);
    await h.run(PREFIX + "missing.jpg");
    expect(h.origin.requests[1]?.headers.get("x-edge-loop")).toBe("1");
  });

  it("T58: with ORIGIN_OVERRIDE the fallback goes to the override base with the same path and query", async () => {
    const h = await harness({ ORIGIN_OVERRIDE: "https://origin.example.net/base/" });
    await h.run(PREFIX + "missing.jpg?ver=2");
    expect(h.origin.requests[0]?.url).toBe("https://origin.example.net/base/wp-content/uploads/missing.jpg?ver=2");
    await h.run("/about/?x=1");
    expect(h.origin.requests[1]?.url).toBe("https://origin.example.net/base/about/?x=1");
  });

  it("T60: the three 404 sources are distinguishable by the source header", async () => {
    const h = await harness({ NEGATIVE_CACHE_SECONDS: "0" });
    h.origin.handler = (r) =>
      r.url.includes("page.css")
        ? new Response("css 404", { status: 404 })
        : new Response("media 404", { status: 404 });
    const denied = await h.run(PREFIX + "wc-logs/a.jpg");
    const missing = await h.run(PREFIX + "missing.jpg");
    const other = await h.run(PREFIX + "page.css");
    expect([denied.status, missing.status, other.status]).toEqual([404, 404, 404]);
    expect(denied.headers.get(SOURCE)).toBe("deny");
    expect(missing.headers.get(SOURCE)).toBe("origin");
    expect(other.headers.has(SOURCE)).toBe(false);
  });

  it("T61: a missing UPLOADS binding makes media requests fall back, with one error logged", async () => {
    const h = await harness();
    const env = { KEY_PREFIX: h.keyPrefix };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { createExecutionContext } = await import("cloudflare:test");
    const { handleRequest } = await import("../src/handler");
    for (let i = 0; i < 3; i++) {
      const res = await handleRequest(
        new Request("https://example.com" + PREFIX + "a.jpg"),
        env,
        createExecutionContext(),
        {
          fetch: h.origin.fetch,
          cache: null,
        },
      );
      expect(res.headers.get(SOURCE)).toBe("origin");
    }
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("UPLOADS"))).toHaveLength(1);
    errors.mockRestore();
  });

  it("the source header can be renamed or disabled", async () => {
    const renamed = await harness({ SOURCE_HEADER: "X-Served-By" });
    await renamed.seed("a.jpg", bytes(5));
    expect((await renamed.run(PREFIX + "a.jpg")).headers.get("x-served-by")).toBe("r2");
    const off = await harness({ SOURCE_HEADER: "" });
    await off.seed("a.jpg", bytes(5));
    const res = await off.run(PREFIX + "a.jpg");
    expect(res.headers.has(SOURCE)).toBe(false);
    expect((await off.run(PREFIX + "wc-logs/a.jpg")).headers.has(SOURCE)).toBe(false);
  });

  it("logs one JSON line per request with no query string", async () => {
    const h = await harness();
    await h.seed("a.jpg", bytes(5));
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await h.run(PREFIX + "a.jpg?secret=1");
    expect(logs).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(logs.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      method: "GET",
      path: PREFIX + "a.jpg",
      status: 200,
      source: "r2",
      cache: "miss",
      r2: "hit",
    });
    expect(typeof line.ms).toBe("number");
    expect(JSON.stringify(line)).not.toContain("secret");
    logs.mockRestore();
  });
});
