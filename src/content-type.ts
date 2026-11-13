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

/** `type/subtype` made of RFC 9110 token characters only. */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** The top-level type (`image`, `video`, ...) a table entry allows. */
function topLevel(contentType: string): string {
  return contentType.slice(0, contentType.indexOf("/"));
}

/**
 * Chooses the content type for a response. The stored type wins only when
 * it is a single well-formed media type that cannot run as a document and,
 * for an extension in the table, belongs to the same kind of file (an
 * `image/*` for a `.jpg`, exactly `application/pdf` for a `.pdf`).
 * Otherwise the extension table decides. `svg` is always `image/svg+xml`.
 * An extension with no table entry falls back to `application/octet-stream`.
 */
export function contentTypeFor(extension: string, stored: string | undefined): string {
  const table = CONTENT_TYPES[extension];
  if (extension === "svg") {
    return "image/svg+xml";
  }
  const fallback = table ?? "application/octet-stream";
  const s = (stored ?? "").trim();
  const e = essence(s);
  if (GENERIC.has(e) || ACTIVE.has(e) || e.endsWith("+xml") || !MEDIA_TYPE.test(e) || /[\r\n\0,]/.test(s)) {
    return fallback;
  }
  if (table !== undefined) {
    const sameKind = table === "application/pdf" ? e === table : topLevel(e) === topLevel(table);
    if (!sameKind) {
      return table;
    }
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
