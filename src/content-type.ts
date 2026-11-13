/**
 * Content types and browser cache policy by content-type family.
 */

import type { Config, Family } from "./config";

/** Extension to content type, used when the stored type is missing, generic or unsafe. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  pdf: "application/pdf",
};

const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/**
 * Types a browser may render as an active document on the site's own
 * origin. A stored type in this set is never trusted.
 */
const ACTIVE = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "text/xsl",
  "application/xslt+xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
  "image/svg+xml",
  "multipart/x-mixed-replace",
  "application/x-shockwave-flash",
]);

function essence(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Chooses the content type for a response. The stored type wins unless it
 * is empty, generic, or a type that could run as a document; then the
 * extension table decides. `svg` is always `image/svg+xml`. An extension
 * with no table entry falls back to `application/octet-stream`.
 */
export function contentTypeFor(extension: string, stored: string | undefined): string {
  const table = CONTENT_TYPES[extension];
  if (extension === "svg") {
    return "image/svg+xml";
  }
  const s = (stored ?? "").trim();
  const e = essence(s);
  if (GENERIC.has(e) || ACTIVE.has(e) || e.endsWith("+xml") || /[\r\n\0]/.test(s)) {
    return table ?? "application/octet-stream";
  }
  return s;
}

/** The cache-policy family of a content type. */
export function familyOf(contentType: string): Family {
  const e = essence(contentType);
  if (e.startsWith("image/")) {
    return "image";
  }
  if (e.startsWith("video/")) {
    return "video";
  }
  if (e.startsWith("audio/")) {
    return "audio";
  }
  if (e === "application/pdf") {
    return "document";
  }
  return "other";
}

/** The browser `cache-control` value for a content type. */
export function cacheControlFor(contentType: string, config: Config): string {
  return config.cacheControl[familyOf(contentType)];
}
