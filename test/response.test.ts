import { describe, expect, it } from "vitest";
import { bodyBytes, bytes, harness, PREFIX, sameBytes, SOURCE } from "./helpers";

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("4.6 R2 read and the 200 response", () => {
  it("T29: a 5 MB object streams with the right bytes and content-length", async () => {
    const h = await harness({ EDGE_CACHE: "off" });
    const big = bytes(5 * 1024 * 1024);
    await h.seed("video.mp4", big);
    const res = await h.run(PREFIX + "video.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(big.length));
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(sameBytes(await bodyBytes(res), big)).toBe(true);
  });

  it("T30: the full header set; stored cache-control replaced; generic type fixed; custom metadata absent", async () => {
    const h = await harness();
    const object = await realPut(h, "a.png", {
      contentType: "application/octet-stream",
      cacheControl: "no-cache",
      contentDisposition: 'inline; filename="a.png"',
      contentLanguage: "en",
    });
    const res = await h.run(PREFIX + "a.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("etag")).toBe(object.httpEtag);
    expect(res.headers.get("last-modified")).toBe(object.uploaded.toUTCString());
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get(SOURCE)).toBe("r2");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="a.png"');
    expect(res.headers.get("content-language")).toBe("en");
    expect(res.headers.has("content-security-policy")).toBe(false);
    expect(res.headers.has("x-secret")).toBe(false);
    expect([...res.headers.values()].join(" ")).not.toContain("custom-value");
  });

  it("T31: SVG gets image/svg+xml and the sandboxing CSP", async () => {
    const h = await harness();
    await h.seed("logo.svg", "<svg/>", { contentType: "text/html" });
    const res = await h.run(PREFIX + "logo.svg");
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    );
  });

  it("T32: an object stored gzip-encoded is returned byte-identical with that header", async () => {
    const h = await harness();
    const compressed = await gzip(new TextEncoder().encode("<svg>" + "x".repeat(1000) + "</svg>"));
    await h.seed("a.svg", compressed, { contentType: "image/svg+xml", contentEncoding: "gzip" });
    const res = await h.run(PREFIX + "a.svg");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-length")).toBe(String(compressed.length));
    expect(await bodyBytes(res)).toEqual(compressed);
  });

  it("T33 (ruling 3): HEAD returns the GET headers, no body, and uses the R2 head call only", async () => {
    const h = await harness({ EDGE_CACHE: "off" });
    await h.seed("a.jpg", bytes(123), { contentType: "image/jpeg" });
    const get = await h.run(PREFIX + "a.jpg");
    await get.arrayBuffer();
    const head = await h.run(PREFIX + "a.jpg", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect([...head.headers.entries()]).toEqual([...get.headers.entries()]);
    expect(h.bucket.calls.map((c) => c.method)).toEqual(["get", "head"]);
  });
});

describe("content types and cache policy (ruling 5)", () => {
  it("PDFs share the image policy by default", async () => {
    const h = await harness();
    await h.seed("a.pdf", "%PDF");
    await h.seed("a.jpg", "jpg");
    const pdf = await h.run(PREFIX + "a.pdf");
    const jpg = await h.run(PREFIX + "a.jpg");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("cache-control")).toBe(jpg.headers.get("cache-control"));
  });

  it("a family map overrides the policy for one family only, on R2 and edge-cache responses", async () => {
    const h = await harness({ CACHE_CONTROL_BY_FAMILY: { document: "public, max-age=3600" } });
    await h.seed("a.pdf", "%PDF");
    await h.seed("a.mp3", "mp3");
    const pdf = await h.runAndSettle(PREFIX + "a.pdf");
    await pdf.arrayBuffer();
    expect(pdf.headers.get("cache-control")).toBe("public, max-age=3600");
    const again = await h.run(PREFIX + "a.pdf");
    expect(again.headers.get(SOURCE)).toBe("edge-cache");
    expect(again.headers.get("cache-control")).toBe("public, max-age=3600");
    expect((await h.run(PREFIX + "a.mp3")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("a stored active type on a media extension is never trusted", async () => {
    const h = await harness();
    await h.seed("a.png", "x", { contentType: "application/xhtml+xml" });
    await h.seed("b.jpg", "x", { contentType: "image/svg+xml" });
    await h.seed("c.webp", "x", { contentType: "image/webp; charset=binary" });
    expect((await h.run(PREFIX + "a.png")).headers.get("content-type")).toBe("image/png");
    expect((await h.run(PREFIX + "b.jpg")).headers.get("content-type")).toBe("image/jpeg");
    expect((await h.run(PREFIX + "c.webp")).headers.get("content-type")).toBe("image/webp; charset=binary");
  });

  it("an added extension with no table entry uses its stored type or octet-stream", async () => {
    const h = await harness({ MEDIA_EXTENSIONS: "jpg,ogg,heic" });
    await h.seed("a.ogg", "x", { contentType: "audio/ogg" });
    await h.seed("a.heic", "x");
    expect((await h.run(PREFIX + "a.ogg")).headers.get("content-type")).toBe("audio/ogg");
    expect((await h.run(PREFIX + "a.heic")).headers.get("content-type")).toBe("application/octet-stream");
  });
});

async function realPut(h: Awaited<ReturnType<typeof harness>>, key: string, http: R2HTTPMetadata): Promise<R2Object> {
  const { realBucket } = await import("./helpers");
  return realBucket().put(h.keyPrefix + key, bytes(10), {
    httpMetadata: http,
    customMetadata: { "x-secret": "custom-value" },
  });
}
