/**
 * Configuration: parsing and validation of Worker variables. Parsing is
 * pure; the cached accessor logs each problem once per environment object,
 * which in production means once per isolate.
 */

import { isHeaderName, isHeaderValue } from "./http";

/** Content-type families that can carry their own browser cache policy. */
export const FAMILIES = ["image", "video", "audio", "document", "other"] as const;
export type Family = (typeof FAMILIES)[number];

/** The bindings and variables the Worker reads. Every variable is optional. */
export interface Env {
  UPLOADS?: R2Bucket;
  PUBLIC_PREFIX?: string;
  KEY_PREFIX?: string;
  MEDIA_EXTENSIONS?: string;
  EXTRA_DENY_PREFIXES?: string;
  BROWSER_CACHE_CONTROL?: string;
  CACHE_CONTROL_BY_FAMILY?: string | Record<string, unknown>;
  EDGE_CACHE?: string;
  EDGE_CACHE_MAX_BYTES?: string | number;
  NEGATIVE_CACHE_SECONDS?: string | number;
  ORIGIN_OVERRIDE?: string;
  SOURCE_HEADER?: string;
  HOP_HEADER?: string;
}

/** Parsed, validated configuration. */
export interface Config {
  readonly publicPrefix: string;
  readonly keyPrefix: string;
  readonly mediaExtensions: ReadonlySet<string>;
  /** Built-in plus extra deny prefixes, lower-cased, each ending in `/`. */
  readonly denyPrefixes: readonly string[];
  readonly cacheControl: Readonly<Record<Family, string>>;
  readonly edgeCache: boolean;
  readonly edgeCacheMaxBytes: number;
  readonly negativeCacheSeconds: number;
  /** Origin override base, without a trailing slash, or null. */
  readonly originOverride: string | null;
  /** Diagnostic header name, or null when disabled. */
  readonly sourceHeader: string | null;
  readonly hopHeader: string;
}

export const DEFAULT_PUBLIC_PREFIX = "/wp-content/uploads/";
export const DEFAULT_KEY_PREFIX = "wp-content/uploads/";
export const DEFAULT_MEDIA_EXTENSIONS: readonly string[] = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "svg",
  "mp4",
  "webm",
  "mp3",
  "pdf",
];
/** Private WordPress upload directories. Configuration can add to this list, never remove from it. */
export const BUILT_IN_DENY_PREFIXES: readonly string[] = [
  "wp-personal-data-exports/",
  "wc-logs/",
  "woocommerce_uploads/",
  "wpcf7_uploads/",
];
export const DEFAULT_BROWSER_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const DEFAULT_EDGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_NEGATIVE_CACHE_SECONDS = 60;
export const MAX_NEGATIVE_CACHE_SECONDS = 3600;
export const DEFAULT_SOURCE_HEADER = "x-uploads-source";
export const DEFAULT_HOP_HEADER = "x-uploads-hop";

/** The parse result: a usable configuration plus the problems found. */
export interface ParsedConfig {
  readonly config: Config;
  readonly errors: readonly string[];
}

function isSet(value: unknown): value is string {
  return typeof value === "string";
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseNonNegativeInteger(value: string | number): number | null {
  const s = typeof value === "number" ? String(value) : value.trim();
  if (!/^\d{1,15}$/.test(s)) {
    return null;
  }
  return Number(s);
}

/**
 * Parses and validates the Worker variables. Never throws: an invalid value
 * is replaced by its default and reported in `errors`.
 */
export function parseConfig(env: Env): ParsedConfig {
  const errors: string[] = [];

  let publicPrefix = DEFAULT_PUBLIC_PREFIX;
  if (isSet(env.PUBLIC_PREFIX)) {
    const v = env.PUBLIC_PREFIX;
    if (v.length >= 2 && v.startsWith("/") && v.endsWith("/") && !v.includes("//") && !/[\s?#%\\]/.test(v)) {
      publicPrefix = v;
    } else {
      errors.push("PUBLIC_PREFIX must start and end with '/'; using the default");
    }
  }

  let keyPrefix = DEFAULT_KEY_PREFIX;
  if (isSet(env.KEY_PREFIX)) {
    const v = env.KEY_PREFIX;
    // eslint-disable-next-line no-control-regex
    if (v === "" || (!v.startsWith("/") && !/[\u0000-\u001f\u007f\\]/.test(v))) {
      keyPrefix = v;
    } else {
      errors.push("KEY_PREFIX must not start with '/' or hold control characters; using the default");
    }
  }

  let mediaExtensions = new Set(DEFAULT_MEDIA_EXTENSIONS);
  if (isSet(env.MEDIA_EXTENSIONS)) {
    const list = splitList(env.MEDIA_EXTENSIONS).map((e) => e.replace(/^\./, "").toLowerCase());
    if (list.length > 0 && list.every((e) => /^[a-z0-9]{1,16}$/.test(e))) {
      mediaExtensions = new Set(list);
    } else {
      errors.push("MEDIA_EXTENSIONS must be a comma-separated list of extensions; using the default");
    }
  }

  const denyPrefixes = [...BUILT_IN_DENY_PREFIXES];
  if (isSet(env.EXTRA_DENY_PREFIXES)) {
    for (const raw of splitList(env.EXTRA_DENY_PREFIXES)) {
      const p = raw.replace(/^\/+/, "").toLowerCase();
      if (p.length === 0) {
        errors.push(`EXTRA_DENY_PREFIXES entry '${raw}' is empty after trimming; ignored`);
        continue;
      }
      denyPrefixes.push(p);
    }
  }

  let base = DEFAULT_BROWSER_CACHE_CONTROL;
  if (isSet(env.BROWSER_CACHE_CONTROL)) {
    if (isHeaderValue(env.BROWSER_CACHE_CONTROL)) {
      base = env.BROWSER_CACHE_CONTROL.trim();
    } else {
      errors.push("BROWSER_CACHE_CONTROL is empty or holds a line break; using the default");
    }
  }
  const cacheControl: Record<Family, string> = {
    image: base,
    video: base,
    audio: base,
    document: base,
    other: base,
  };
  if (env.CACHE_CONTROL_BY_FAMILY !== undefined) {
    let map: unknown = env.CACHE_CONTROL_BY_FAMILY;
    if (typeof map === "string") {
      try {
        map = map.trim() === "" ? {} : JSON.parse(map);
      } catch {
        map = null;
      }
    }
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      errors.push("CACHE_CONTROL_BY_FAMILY must be a table or a JSON object; ignored");
    } else {
      for (const [family, value] of Object.entries(map as Record<string, unknown>)) {
        if (!(FAMILIES as readonly string[]).includes(family)) {
          errors.push(`CACHE_CONTROL_BY_FAMILY has unknown family '${family}'; ignored`);
        } else if (typeof value !== "string" || !isHeaderValue(value)) {
          errors.push(`CACHE_CONTROL_BY_FAMILY value for '${family}' is not a valid header value; ignored`);
        } else {
          cacheControl[family as Family] = value.trim();
        }
      }
    }
  }

  let edgeCache = true;
  if (isSet(env.EDGE_CACHE)) {
    const v = env.EDGE_CACHE.trim().toLowerCase();
    if (v === "on" || v === "off") {
      edgeCache = v === "on";
    } else {
      errors.push("EDGE_CACHE must be 'on' or 'off'; using the default");
    }
  }

  let edgeCacheMaxBytes = DEFAULT_EDGE_CACHE_MAX_BYTES;
  if (env.EDGE_CACHE_MAX_BYTES !== undefined) {
    const n = parseNonNegativeInteger(env.EDGE_CACHE_MAX_BYTES);
    if (n === null) {
      errors.push("EDGE_CACHE_MAX_BYTES must be a non-negative integer; using the default");
    } else {
      edgeCacheMaxBytes = n;
    }
  }

  let negativeCacheSeconds = DEFAULT_NEGATIVE_CACHE_SECONDS;
  if (env.NEGATIVE_CACHE_SECONDS !== undefined) {
    const n = parseNonNegativeInteger(env.NEGATIVE_CACHE_SECONDS);
    if (n === null || n > MAX_NEGATIVE_CACHE_SECONDS) {
      errors.push(
        `NEGATIVE_CACHE_SECONDS must be an integer from 0 to ${MAX_NEGATIVE_CACHE_SECONDS}; using the default`,
      );
    } else {
      negativeCacheSeconds = n;
    }
  }

  let originOverride: string | null = null;
  if (isSet(env.ORIGIN_OVERRIDE) && env.ORIGIN_OVERRIDE.trim() !== "") {
    let url: URL | null;
    try {
      url = new URL(env.ORIGIN_OVERRIDE.trim());
    } catch {
      url = null;
    }
    if (url !== null && url.protocol === "https:" && url.search === "" && url.hash === "" && url.username === "") {
      originOverride = url.origin + url.pathname.replace(/\/+$/, "");
    } else {
      errors.push("ORIGIN_OVERRIDE must be an absolute https URL with no query; ignored");
    }
  }

  let sourceHeader: string | null = DEFAULT_SOURCE_HEADER;
  if (isSet(env.SOURCE_HEADER)) {
    const v = env.SOURCE_HEADER.trim();
    if (v === "") {
      sourceHeader = null;
    } else if (isHeaderName(v)) {
      sourceHeader = v.toLowerCase();
    } else {
      errors.push("SOURCE_HEADER is not a valid header name; using the default");
    }
  }

  let hopHeader = DEFAULT_HOP_HEADER;
  if (isSet(env.HOP_HEADER)) {
    const v = env.HOP_HEADER.trim();
    if (isHeaderName(v)) {
      hopHeader = v.toLowerCase();
    } else {
      errors.push("HOP_HEADER is not a valid header name; using the default");
    }
  }

  return {
    config: {
      publicPrefix,
      keyPrefix,
      mediaExtensions,
      denyPrefixes,
      cacheControl,
      edgeCache,
      edgeCacheMaxBytes,
      negativeCacheSeconds,
      originOverride,
      sourceHeader,
      hopHeader,
    },
    errors,
  };
}

const parsed = new WeakMap<object, Config>();

/**
 * Returns the configuration for an environment, parsing it on first use
 * and logging each problem once. Later calls with the same object reuse the
 * result, so a request pays nothing for configuration.
 */
export function getConfig(env: Env): Config {
  const cached = parsed.get(env);
  if (cached !== undefined) {
    return cached;
  }
  const result = parseConfig(env);
  for (const message of result.errors) {
    console.error(JSON.stringify({ event: "config_error", message }));
  }
  parsed.set(env, result.config);
  return result.config;
}
