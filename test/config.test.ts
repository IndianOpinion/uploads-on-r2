import { exports } from "cloudflare:workers";
import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MEDIA_EXTENSIONS, getConfig, parseConfig } from "../src/config";
import wranglerToml from "../wrangler.toml?raw";
import { bytes, harness, PREFIX, realBucket, SOURCE } from "./helpers";

describe("7 configuration", () => {
  it("defaults", () => {
    const { config, errors } = parseConfig({});
    expect(errors).toEqual([]);
    expect(config.publicPrefix).toBe("/wp-content/uploads/");
    expect(config.keyPrefix).toBe("wp-content/uploads/");
    expect([...config.mediaExtensions]).toEqual(DEFAULT_MEDIA_EXTENSIONS);
    expect(config.edgeCache).toBe(true);
    expect(config.edgeCacheMaxBytes).toBe(64 * 1024 * 1024);
    expect(config.negativeCacheSeconds).toBe(60);
    expect(config.originOverride).toBeNull();
    expect(config.sourceHeader).toBe("x-uploads-source");
    expect(config.hopHeader).toBe("x-uploads-hop");
    expect(new Set(Object.values(config.cacheControl))).toEqual(new Set(["public, max-age=31536000, immutable"]));
  });

  it("T62: invalid values fall back to defaults, each reported", () => {
    const { config, errors } = parseConfig({
      PUBLIC_PREFIX: "wp-content/uploads",
      EDGE_CACHE: "maybe",
      EDGE_CACHE_MAX_BYTES: "lots",
      ORIGIN_OVERRIDE: "http://insecure.example.com",
      MEDIA_EXTENSIONS: "jpg,../php",
      NEGATIVE_CACHE_SECONDS: "99999",
      SOURCE_HEADER: "bad header",
      HOP_HEADER: "bad:header",
      BROWSER_CACHE_CONTROL: "public\r\nx-evil: 1",
      CACHE_CONTROL_BY_FAMILY: "{not json",
      KEY_PREFIX: "/leading",
    });
    expect(errors).toHaveLength(11);
    expect(config).toEqual(parseConfig({}).config);
  });

  it("EDGE_CACHE_MAX_BYTES cannot be raised above the 64 MiB ceiling", () => {
    const high = parseConfig({ EDGE_CACHE_MAX_BYTES: String(512 * 1024 * 1024) });
    expect(high.config.edgeCacheMaxBytes).toBe(64 * 1024 * 1024);
    expect(high.errors).toHaveLength(1);
    const low = parseConfig({ EDGE_CACHE_MAX_BYTES: "1048576" });
    expect(low.config.edgeCacheMaxBytes).toBe(1048576);
    expect(low.errors).toEqual([]);
  });

  it("T62: each config problem is logged once per environment, not per request", async () => {
    const h = await harness({ EDGE_CACHE: "maybe", EDGE_CACHE_MAX_BYTES: "lots" });
    await h.seed("a.jpg", bytes(5));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let i = 0; i < 3; i++) {
      const res = await h.run(PREFIX + "a.jpg");
      expect(res.headers.get(SOURCE)).not.toBeNull();
    }
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("config_error"))).toHaveLength(2);
    expect(getConfig(h.env).edgeCache).toBe(true);
    errors.mockRestore();
  });

  it("the deny list can grow but built-ins cannot be removed", () => {
    const { config } = parseConfig({ EXTRA_DENY_PREFIXES: "" });
    expect(config.denyPrefixes).toContain("wc-logs/");
  });

  it("CACHE_CONTROL_BY_FAMILY accepts a table or JSON and rejects unknown families", () => {
    const fromJson = parseConfig({ CACHE_CONTROL_BY_FAMILY: '{"video":"public, max-age=600"}' });
    expect(fromJson.config.cacheControl.video).toBe("public, max-age=600");
    expect(fromJson.config.cacheControl.image).toBe("public, max-age=31536000, immutable");
    const unknown = parseConfig({ CACHE_CONTROL_BY_FAMILY: { fonts: "x" } });
    expect(unknown.errors).toHaveLength(1);
  });

  it("a custom public prefix and an empty key prefix map paths to keys", async () => {
    const h = await harness({ PUBLIC_PREFIX: "/media/", KEY_PREFIX: "" });
    await realBucket().put("root-level-object.jpg", bytes(3));
    const res = await h.run("/media/root-level-object.jpg");
    expect(res.headers.get(SOURCE)).toBe("r2");
    expect(h.bucket.calls[0]?.key).toBe("root-level-object.jpg");
  });
});

describe("5.4 wrangler.toml", () => {
  it("T63: one route at top level, one R2 binding, placeholders only", () => {
    const toml = parse(wranglerToml) as Record<string, unknown>;
    const routes = toml.routes as { pattern: string; zone_name: string }[];
    expect(Array.isArray(routes)).toBe(true);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.pattern).toBe("example.com/wp-content/uploads/*");
    const buckets = toml.r2_buckets as Record<string, unknown>[];
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toEqual({ binding: "UPLOADS", bucket_name: "your-bucket" });
    expect(toml.workers_dev).toBe(false);
    expect(toml.name).toBe("your-worker");
    expect(String(toml.compatibility_date) >= "2026-10-01").toBe(true);
    // Nothing that belongs at top level has slipped under a table.
    for (const table of [toml.vars, toml.observability, ...buckets] as (Record<string, unknown> | undefined)[]) {
      for (const key of ["routes", "route", "name", "main", "compatibility_date", "workers_dev"]) {
        expect(table === undefined ? false : key in table, key).toBe(false);
      }
    }
  });
});

describe("default export", () => {
  it("serves through the real runtime with caches.default and the R2 binding", async () => {
    await realBucket().put("wp-content/uploads/smoke-test.png", bytes(64), {
      httpMetadata: { contentType: "image/png" },
    });
    const res = await exports.default.fetch("https://example.com/wp-content/uploads/smoke-test.png");
    expect(res.status).toBe(200);
    expect(res.headers.get(SOURCE)).toBe("r2");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(64));
    const denied = await exports.default.fetch("https://example.com/wp-content/uploads/wc-logs/a.png");
    expect(denied.status).toBe(404);
    expect(denied.headers.get(SOURCE)).toBe("deny");
  });
});
