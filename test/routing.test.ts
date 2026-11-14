import { describe, expect, it } from "vitest";
import { BUILT_IN_DENY_PREFIXES, parseConfig } from "../src/config";
import { normaliseKey } from "../src/key";
import { bodyBytes, bytes, harness, PREFIX, SOURCE, text } from "./helpers";

const config = parseConfig({}).config;

describe("4.1 routing", () => {
  it("T1: a path outside the prefix is passed unchanged, with no source header", async () => {
    const h = await harness();
    h.origin.handler = () =>
      new Response("about page", { status: 200, headers: { "x-origin": "yes", "cache-control": "private" } });
    const res = await h.run("/about/");
    expect(res.status).toBe(200);
    expect(await text(res)).toBe("about page");
    expect(res.headers.get("x-origin")).toBe("yes");
    expect(res.headers.get("cache-control")).toBe("private");
    expect(res.headers.has(SOURCE)).toBe(false);
    expect(h.origin.requests).toHaveLength(1);
    expect(h.bucket.count()).toBe(0);
  });

  it("T2: the prefix match is exact and case-sensitive", async () => {
    const h = await harness();
    h.origin.handler = () => new Response("origin");
    for (const path of ["/wp-content/uploads", "/WP-CONTENT/uploads/a.jpg"]) {
      const res = await h.run(path);
      expect(await text(res)).toBe("origin");
      expect(res.headers.has(SOURCE)).toBe(false);
    }
    expect(h.bucket.count()).toBe(0);
  });

  it("T3: the bare prefix is denied", async () => {
    const h = await harness();
    const res = await h.run(PREFIX);
    expect(res.status).toBe(404);
    expect(res.headers.get(SOURCE)).toBe("deny");
    expect(h.origin.requests).toHaveLength(0);
  });
});

describe("4.2 key normalisation", () => {
  it("T4: invalid escapes and invalid UTF-8 are denied", async () => {
    const h = await harness();
    for (const bad of ["a%zz.jpg", "a%4", "a%C3%28.jpg"]) {
      const res = await h.run(PREFIX + bad);
      expect(res.status, bad).toBe(404);
      expect(res.headers.get(SOURCE), bad).toBe("deny");
    }
    expect(h.bucket.count()).toBe(0);
    expect(h.origin.requests).toHaveLength(0);
  });

  it("T5: control characters and backslashes are denied", async () => {
    const h = await harness();
    for (const bad of ["a%00.jpg", "a%1F.jpg", "a%7F.jpg", "a%5Cb.jpg"]) {
      const res = await h.run(PREFIX + bad);
      expect(res.status, bad).toBe(404);
      expect(res.headers.get(SOURCE), bad).toBe("deny");
    }
    expect(h.bucket.count()).toBe(0);
  });

  it("T6: empty, dot and dot-dot segments are denied after decoding", async () => {
    // The URL parser resolves literal and %2e dot segments before the Worker
    // sees the path, so the pure function is checked on raw paths, and the
    // Worker on the forms that survive URL parsing.
    for (const raw of [
      "a//b.jpg",
      "a/./b.jpg",
      "a/%2e%2e/b.jpg",
      "a/../b.jpg",
      "a/",
      "a%2F..%2Fb.jpg",
      "a%2F%2Fb.jpg",
    ]) {
      expect(normaliseKey(PREFIX + raw, config).kind, raw).toBe("deny");
    }
    const h = await harness();
    for (const path of ["a//b.jpg", "a/", "a%2F..%2Fb.jpg", "a%2F.%2Fb.jpg", "a%2F%2Fb.jpg"]) {
      const res = await h.run(PREFIX + path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get(SOURCE), path).toBe("deny");
    }
    // A dot-dot the URL parser resolves cannot climb into a private folder either.
    const res = await h.run(PREFIX + "x/%2e%2e/wp-personal-data-exports/a.jpg");
    expect(res.headers.get(SOURCE)).toBe("deny");
    expect(h.bucket.count()).toBe(0);
    expect(h.origin.requests).toHaveLength(0);
  });

  it("T7: an encoded slash names the same object as a plain slash", async () => {
    const h = await harness();
    await h.seed("2026/01/a.jpg", "image-bytes", { contentType: "image/jpeg" });
    const res = await h.run(PREFIX + "2026%2F01%2Fa.jpg");
    expect(res.status).toBe(200);
    expect(await text(res)).toBe("image-bytes");
    expect(h.bucket.calls[0]?.key).toBe(h.keyPrefix + "2026/01/a.jpg");
  });

  it("T8: built-in deny prefixes are denied for every method, case-insensitively, after decoding", async () => {
    const h = await harness();
    const paths = [
      ...BUILT_IN_DENY_PREFIXES.map((p) => `${p}x.jpg`),
      "WC-LOGS/x.jpg",
      "%77c-logs/x.jpg",
      "sites/3/wp-personal-data-exports/x.zip",
    ];
    for (const path of paths) {
      await h.seed(decodeURIComponent(path), "secret");
      for (const method of ["GET", "HEAD", "POST"]) {
        const res = await h.run(PREFIX + path, { method });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.headers.get(SOURCE)).toBe("deny");
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect(h.bucket.count()).toBe(0);
    expect(h.origin.requests).toHaveLength(0);
  });

  it("T9: extra deny prefixes add to the built-in list", async () => {
    const h = await harness({ EXTRA_DENY_PREFIXES: "private-stuff/, /Backups/" });
    for (const path of ["private-stuff/a.jpg", "backups/a.jpg", "wc-logs/a.jpg"]) {
      const res = await h.run(PREFIX + path);
      expect(res.headers.get(SOURCE), path).toBe("deny");
    }
    expect(h.bucket.count()).toBe(0);
  });

  it("T10: malformed and private responses are identical", async () => {
    const h = await harness();
    const a = await h.run(PREFIX + "a%zz.jpg");
    const b = await h.run(PREFIX + "wc-logs/x.jpg");
    expect(a.status).toBe(b.status);
    expect(await text(a)).toBe(await text(b));
    expect([...a.headers.entries()]).toEqual([...b.headers.entries()]);
    expect(a.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(a.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("T11: the query string is not part of the key, and is kept on fallback", async () => {
    const h = await harness();
    await h.seed("a.jpg", "A");
    const res = await h.run(PREFIX + "a.jpg?ver=3");
    expect(await text(res)).toBe("A");
    expect(h.bucket.calls[0]?.key).toBe(h.keyPrefix + "a.jpg");
    await h.run(PREFIX + "missing.jpg?ver=3");
    expect(new URL(h.origin.requests[0]?.url ?? "").search).toBe("?ver=3");
  });

  it("T12: the key keeps the case of the request", async () => {
    const h = await harness();
    await h.seed("Photo.JPG", "upper");
    await h.seed("photo.jpg", "lower");
    expect(await text(await h.run(PREFIX + "Photo.JPG"))).toBe("upper");
    expect(await text(await h.run(PREFIX + "photo.jpg"))).toBe("lower");
  });

  it("T13: plus is literal, %20 is a space, %2520 decodes once", async () => {
    const h = await harness({ EDGE_CACHE: "off" });
    await h.run(PREFIX + "a+b.jpg");
    await h.run(PREFIX + "a%20b.jpg");
    await h.run(PREFIX + "a%2520b.jpg");
    expect(h.bucket.calls.map((c) => c.key.slice(h.keyPrefix.length))).toEqual(["a+b.jpg", "a b.jpg", "a%20b.jpg"]);
  });

  it("T14: no Unicode normalisation: an NFD key requested in NFC falls back", async () => {
    const h = await harness();
    await h.seed("café.jpg", "nfd");
    const res = await h.run(PREFIX + encodeURIComponent("café.jpg"));
    expect(res.headers.get(SOURCE)).toBe("origin");
    const nfd = await h.run(PREFIX + encodeURIComponent("café.jpg"));
    expect(await text(nfd)).toBe("nfd");
  });

  it("T15: a key over 1024 bytes is passed with no R2 call", async () => {
    const h = await harness();
    h.origin.handler = () => new Response("origin");
    const res = await h.run(PREFIX + "a".repeat(1100) + ".jpg");
    expect(await text(res)).toBe("origin");
    expect(res.headers.has(SOURCE)).toBe(false);
    expect(h.bucket.count()).toBe(0);
  });
});

describe("4.3 methods and 4.4 extensions", () => {
  it("T16: GET and HEAD reach R2; other methods are passed", async () => {
    const h = await harness({ EDGE_CACHE: "off" });
    await h.seed("a.jpg", "A");
    h.origin.handler = (r) => new Response(`origin ${r.method}`);
    expect((await h.run(PREFIX + "a.jpg")).headers.get(SOURCE)).toBe("r2");
    expect((await h.run(PREFIX + "a.jpg", { method: "HEAD" })).headers.get(SOURCE)).toBe("r2");
    expect(h.bucket.count()).toBe(2);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await h.run(PREFIX + "a.jpg", { method, ...(method === "POST" ? { body: "x" } : {}) });
      expect(await text(res)).toBe(`origin ${method}`);
      expect(res.headers.has(SOURCE)).toBe(false);
    }
    expect(h.bucket.count()).toBe(2);
  });

  it("T17: names with no extension are passed", async () => {
    const h = await harness();
    h.origin.handler = () => new Response("origin");
    for (const path of [".htaccess", "README", "dir/.hidden"]) {
      const res = await h.run(PREFIX + path);
      expect(res.headers.has(SOURCE), path).toBe(false);
    }
    expect(h.bucket.count()).toBe(0);
  });

  it("T18: non-media extensions are passed even when the bucket holds them", async () => {
    const h = await harness();
    h.origin.handler = () => new Response("origin");
    for (const path of ["x.css", "x.php", "x.zip", "x.log", "x.html", "x.json"]) {
      await h.seed(path, "in bucket");
      const res = await h.run(PREFIX + path);
      expect(await text(res), path).toBe("origin");
    }
    expect(h.bucket.count()).toBe(0);
  });

  it("T19: the extension match is case-insensitive, the key is not", async () => {
    const h = await harness();
    await h.seed("A.JPG", "upper");
    const res = await h.run(PREFIX + "A.JPG");
    expect(await text(res)).toBe("upper");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(h.bucket.calls[0]?.key).toBe(h.keyPrefix + "A.JPG");
  });

  it("T20: a double extension is judged by the last one and cannot execute", async () => {
    const h = await harness();
    await h.seed("shell.php.jpg", bytes(10), { contentType: "text/html" });
    const res = await h.run(PREFIX + "shell.php.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await bodyBytes(res)).toEqual(bytes(10));
  });
});
