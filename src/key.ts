/**
 * Mapping a request path to an object key, with the deny list applied to
 * the decoded key. Pure functions, no I/O.
 */

import type { Config } from "./config";

/** R2's maximum key length, in bytes of UTF-8. */
export const MAX_KEY_BYTES = 1024;

/** The outcome of mapping a path to a key. */
export type KeyResult =
  /** The path is not under the public prefix: pass to the origin. */
  | { readonly kind: "outside" }
  /** Malformed or private: the fixed 404, nothing else is asked. */
  | { readonly kind: "deny"; readonly reason: string }
  /** A usable key. `tooLong` means pass without an R2 read. */
  | {
      readonly kind: "key";
      readonly relativeKey: string;
      readonly objectKey: string;
      readonly tooLong: boolean;
    };

const MULTISITE = /^sites\/\d{1,10}\//;

/**
 * True when a decoded relative key falls under a deny prefix. The
 * comparison is lower-cased, and is also made after a leading multisite
 * `sites/<n>/` segment, where WordPress keeps each site's private folders.
 */
export function isDenied(relativeKey: string, denyPrefixes: readonly string[]): boolean {
  const lower = relativeKey.toLowerCase();
  const site = MULTISITE.exec(lower);
  const candidates = site === null ? [lower] : [lower, lower.slice(site[0].length)];
  return candidates.some((k) => denyPrefixes.some((p) => k.startsWith(p)));
}

/**
 * Maps a raw (still percent-encoded) URL path to an object key.
 *
 * The relative key is decoded exactly once, as UTF-8. Control characters,
 * backslashes, empty, `.` and `..` segments are denied after decoding, so
 * `%2e%2e` and `%2F` cannot smuggle anything past the URL parser. No
 * Unicode normalisation is applied.
 */
export function normaliseKey(rawPath: string, config: Config): KeyResult {
  if (!rawPath.startsWith(config.publicPrefix)) {
    return { kind: "outside" };
  }
  const encoded = rawPath.slice(config.publicPrefix.length);
  if (encoded === "") {
    return { kind: "deny", reason: "empty" };
  }
  let relativeKey: string;
  try {
    relativeKey = decodeURIComponent(encoded);
  } catch {
    return { kind: "deny", reason: "bad-escape" };
  }
  for (let i = 0; i < relativeKey.length; i++) {
    const c = relativeKey.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x5c) {
      return { kind: "deny", reason: "bad-char" };
    }
  }
  for (const segment of relativeKey.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return { kind: "deny", reason: "bad-segment" };
    }
  }
  if (isDenied(relativeKey, config.denyPrefixes)) {
    return { kind: "deny", reason: "private" };
  }
  const objectKey = config.keyPrefix + relativeKey;
  const tooLong = new TextEncoder().encode(objectKey).length > MAX_KEY_BYTES;
  return { kind: "key", relativeKey, objectKey, tooLong };
}

/**
 * The extension of the final path segment: the text after its last dot,
 * lower-cased. Empty when there is no dot or the only dot leads the name.
 */
export function extensionOf(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}
