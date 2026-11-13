/**
 * The request pipeline. Order is fixed: path check, key normalisation,
 * deny check, loop guard, key length, method, extension, edge cache, R2,
 * negative cache, origin fallback.
 */

import { type Config, type Env, getConfig } from "./config";
import { cacheControlFor, contentTypeFor } from "./content-type";
import {
  evaluatePreconditions,
  formatHttpDate,
  ifRangeMatches,
  parseHttpDate,
  parseRangeSpec,
  type RangeSpec,
  resolveRange,
} from "./http";
import { extensionOf, normaliseKey } from "./key";
import { discard, sliceStream, withLength } from "./stream";

/** Values of the diagnostic source header. */
export type Source = "r2" | "edge-cache" | "origin" | "origin-error" | "deny" | "negative-cache";

/** The two side effects the pipeline needs, injectable for tests. */
export interface Deps {
  /** Sends a subrequest to the origin. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** The Cache API cache to use, or null for none. */
  readonly cache: Cache | null;
}

/** The representation metadata every response is built from. */
export interface Meta {
  readonly size: number;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentType: string;
  readonly contentDisposition?: string | undefined;
  readonly contentLanguage?: string | undefined;
  readonly contentEncoding?: string | undefined;
}

type CacheOutcome = "hit" | "miss" | "skip";
type R2Outcome = "hit" | "miss" | "error" | "skip";

interface State {
  readonly request: Request;
  readonly url: URL;
  readonly config: Config;
  readonly deps: Deps;
  readonly ctx: ExecutionContext;
  cache: CacheOutcome;
  r2: R2Outcome;
}

const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
const NEGATIVE_MARKER = "x-uploads-negative";
const NEGATIVE_PARAM = "uploads-on-r2-negative";
/**
 * Set on every entry this Worker writes. On a zone route the Cache API
 * shares its keys with the zone cache, so the zone's own copy of a fallback
 * response can sit under the same URL; only marked entries are trusted.
 */
const ENTRY_MARKER = "x-uploads-entry";

const warnedMissingBinding = new WeakSet();

/** Raised by R2 when a range starts at or beyond the object size. */
function isUnsatisfiableRange(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("10039") || /not satisfiable/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logError(event: string, error: unknown, path?: string): void {
  console.error(JSON.stringify({ event, message: errorMessage(error), ...(path === undefined ? {} : { path }) }));
}

/** Handles one request. Never throws. */
export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, deps: Deps): Promise<Response> {
  const started = Date.now();
  const config = getConfig(env);
  const url = new URL(request.url);
  const state: State = { request, url, config, deps, ctx, cache: "skip", r2: "skip" };
  const response = await route(state, env);
  const source = config.sourceHeader === null ? null : response.headers.get(config.sourceHeader);
  console.log(
    JSON.stringify({
      method: request.method,
      path: url.pathname,
      status: response.status,
      source: source ?? "pass",
      cache: state.cache,
      r2: state.r2,
      ms: Date.now() - started,
    }),
  );
  return response;
}

async function route(state: State, env: Env): Promise<Response> {
  const { request, url, config } = state;
  const key = normaliseKey(url.pathname, config);
  if (key.kind === "outside") {
    return pass(state);
  }
  if (key.kind === "deny") {
    return denyResponse(config);
  }
  if (request.headers.has(config.hopHeader)) {
    // Already a fallback subrequest: go straight to the origin, unchanged,
    // never through the override, so a loop ends here.
    return passThrough(state, request);
  }
  if (key.tooLong) {
    return pass(state);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return pass(state);
  }
  const extension = extensionOf(key.relativeKey);
  if (!config.mediaExtensions.has(extension)) {
    return pass(state);
  }
  const bucket = env.UPLOADS;
  if (bucket === undefined || typeof bucket.get !== "function" || typeof bucket.head !== "function") {
    if (!warnedMissingBinding.has(env)) {
      warnedMissingBinding.add(env);
      logError("config_error", new Error("the UPLOADS R2 binding is missing; every media request falls back"));
    }
    return fallback(state);
  }
  try {
    return await serveMedia(state, bucket, key.objectKey, extension);
  } catch (error) {
    state.r2 = "error";
    logError("r2_error", error, url.pathname);
    return fallback(state);
  }
}

// ---------------------------------------------------------------------------
// Origin

function originRequest(state: State): Request {
  const { request, url, config } = state;
  const target = config.originOverride === null ? request.url : config.originOverride + url.pathname + url.search;
  const outbound = new Request(target, request);
  outbound.headers.set(config.hopHeader, "1");
  return outbound;
}

async function passThrough(state: State, outbound: Request): Promise<Response> {
  try {
    return await state.deps.fetch(outbound);
  } catch (error) {
    logError("origin_error", error, state.url.pathname);
    return badGateway(state.config);
  }
}

/** Forwards to the origin and returns its response unmodified. */
function pass(state: State): Promise<Response> {
  return passThrough(state, originRequest(state));
}

/** Forwards to the origin and marks the response with the source header. */
async function fallback(state: State): Promise<Response> {
  let response: Response;
  try {
    response = await state.deps.fetch(originRequest(state));
  } catch (error) {
    logError("origin_error", error, state.url.pathname);
    return badGateway(state.config);
  }
  const header = state.config.sourceHeader;
  if (header === null) {
    return response;
  }
  const marked = new Response(response.body, response);
  marked.headers.set(header, "origin");
  return marked;
}

// ---------------------------------------------------------------------------
// Fixed responses

function plainResponse(status: number, body: string, config: Config, source: Source, head = false): Response {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (config.sourceHeader !== null) {
    headers.set(config.sourceHeader, source);
  }
  return new Response(head ? null : body, { status, headers });
}

/** The single 404 for malformed and private keys, for every method. */
export function denyResponse(config: Config): Response {
  return plainResponse(404, "Not Found", config, "deny");
}

function badGateway(config: Config): Response {
  return plainResponse(502, "Bad Gateway", config, "origin-error");
}

// ---------------------------------------------------------------------------
// Metadata and headers

function metaFromR2(object: R2Object, extension: string): Meta {
  const http = object.httpMetadata ?? {};
  return {
    size: object.size,
    etag: object.httpEtag,
    lastModified: object.uploaded,
    contentType: contentTypeFor(extension, http.contentType),
    contentDisposition: http.contentDisposition,
    contentLanguage: http.contentLanguage,
    contentEncoding: http.contentEncoding,
  };
}

function metaFromCache(response: Response): Meta | null {
  const h = response.headers;
  if (response.status !== 200 || h.get(ENTRY_MARKER) !== "1") {
    return null;
  }
  const length = h.get("content-length");
  const etag = h.get("etag");
  const lastModified = h.get("last-modified");
  const contentType = h.get("content-type");
  if (length === null || !/^\d{1,15}$/.test(length) || etag === null || lastModified === null || contentType === null) {
    return null;
  }
  const seconds = parseHttpDate(lastModified);
  if (seconds === null) {
    return null;
  }
  return {
    size: Number(length),
    etag,
    lastModified: new Date(seconds * 1000),
    contentType,
    contentDisposition: h.get("content-disposition") ?? undefined,
    contentLanguage: h.get("content-language") ?? undefined,
    contentEncoding: h.get("content-encoding") ?? undefined,
  };
}

/** Headers carried by every response built from a representation. */
function validatorHeaders(meta: Meta, config: Config, source: Source | null): Headers {
  const headers = new Headers({
    etag: meta.etag,
    "last-modified": formatHttpDate(meta.lastModified),
    "cache-control": cacheControlFor(meta.contentType, config),
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  });
  if (source !== null && config.sourceHeader !== null) {
    headers.set(config.sourceHeader, source);
  }
  return headers;
}

/** The full header set for a 200 or 206. */
function representationHeaders(meta: Meta, config: Config, source: Source | null, length: number): Headers {
  const headers = validatorHeaders(meta, config, source);
  headers.set("content-type", meta.contentType);
  headers.set("content-length", String(length));
  if (meta.contentType.toLowerCase().startsWith("image/svg+xml")) {
    headers.set("content-security-policy", SVG_CSP);
  }
  if (meta.contentDisposition !== undefined && meta.contentDisposition !== "") {
    headers.set("content-disposition", meta.contentDisposition);
  }
  if (meta.contentLanguage !== undefined && meta.contentLanguage !== "") {
    headers.set("content-language", meta.contentLanguage);
  }
  if (meta.contentEncoding !== undefined && meta.contentEncoding !== "") {
    headers.set("content-encoding", meta.contentEncoding);
  }
  return headers;
}

function makeResponse(body: ReadableStream | null, status: number, headers: Headers, meta: Meta): Response {
  const manual = meta.contentEncoding !== undefined && meta.contentEncoding !== "";
  return new Response(body, manual ? { status, headers, encodeBody: "manual" } : { status, headers });
}

// ---------------------------------------------------------------------------
// Decisions

type Outcome =
  | { readonly status: 200 }
  | { readonly status: 206; readonly start: number; readonly end: number }
  | { readonly status: 304 }
  | { readonly status: 412 }
  | { readonly status: 416 };

/** Preconditions first, then `If-Range`, then the range itself. */
function decide(meta: Meta, headers: Headers, spec: RangeSpec | null): Outcome {
  const pre = evaluatePreconditions(headers, meta.etag, meta.lastModified);
  if (pre !== "pass") {
    return { status: pre };
  }
  if (spec === null) {
    return { status: 200 };
  }
  const ifRange = headers.get("if-range");
  if (ifRange !== null && !ifRangeMatches(ifRange, meta.etag, meta.lastModified)) {
    return { status: 200 };
  }
  const resolved = resolveRange(spec, meta.size);
  return resolved === null ? { status: 416 } : { status: 206, ...resolved };
}

/** Builds a response that carries no representation body. */
function bodilessResponse(outcome: Outcome, meta: Meta, config: Config, source: Source): Response {
  switch (outcome.status) {
    case 304:
    case 412:
      return new Response(null, { status: outcome.status, headers: validatorHeaders(meta, config, source) });
    case 416: {
      const headers = validatorHeaders(meta, config, source);
      headers.set("cache-control", "no-store");
      headers.set("content-range", `bytes */${meta.size}`);
      return new Response(null, { status: 416, headers });
    }
    case 200: {
      return makeResponse(null, 200, representationHeaders(meta, config, source, meta.size), meta);
    }
    case 206: {
      const headers = representationHeaders(meta, config, source, outcome.end - outcome.start + 1);
      headers.set("content-range", `bytes ${outcome.start}-${outcome.end}/${meta.size}`);
      return makeResponse(null, 206, headers, meta);
    }
  }
}

/**
 * Responds from a full body (or none, for HEAD). A 206 is cut from the
 * full body by streaming, so it works for cached copies too.
 */
async function respondFromFull(
  state: State,
  meta: Meta,
  body: ReadableStream<Uint8Array> | null,
  spec: RangeSpec | null,
  source: Source,
): Promise<Response> {
  const isHead = state.request.method === "HEAD";
  const outcome = decide(meta, state.request.headers, spec);
  if (isHead || body === null || (outcome.status !== 200 && outcome.status !== 206)) {
    await discard(body);
    return bodilessResponse(outcome, meta, state.config, source);
  }
  if (outcome.status === 200) {
    return makeResponse(
      withLength(body, meta.size),
      200,
      representationHeaders(meta, state.config, source, meta.size),
      meta,
    );
  }
  const length = outcome.end - outcome.start + 1;
  const headers = representationHeaders(meta, state.config, source, length);
  headers.set("content-range", `bytes ${outcome.start}-${outcome.end}/${meta.size}`);
  return makeResponse(withLength(sliceStream(body, outcome.start, length), length), 206, headers, meta);
}

// ---------------------------------------------------------------------------
// Edge cache

function cacheKey(url: URL, negative = false): Request {
  const key = `https://${url.host}${url.pathname}${negative ? `?${NEGATIVE_PARAM}=1` : ""}`;
  return new Request(key, { method: "GET" });
}

function cacheEnabled(state: State): Cache | null {
  return state.config.edgeCache ? state.deps.cache : null;
}

async function cacheLookup(state: State, cache: Cache): Promise<Response | null> {
  try {
    return (await cache.match(cacheKey(state.url))) ?? null;
  } catch (error) {
    logError("cache_lookup_error", error, state.url.pathname);
    return null;
  }
}

function cacheWrite(state: State, cache: Cache, key: Request, response: Response): void {
  const write = (async (): Promise<void> => {
    try {
      await cache.put(key, response);
    } catch (error) {
      logError("cache_write_error", error, state.url.pathname);
      await discard(response.body);
    }
  })();
  state.ctx.waitUntil(write);
}

function cacheable(state: State, meta: Meta): boolean {
  return (
    state.request.method === "GET" &&
    meta.size <= state.config.edgeCacheMaxBytes &&
    (meta.contentEncoding === undefined || meta.contentEncoding === "")
  );
}

// ---------------------------------------------------------------------------
// Media

async function serveMedia(state: State, bucket: R2Bucket, objectKey: string, extension: string): Promise<Response> {
  const { request, config } = state;
  const isHead = request.method === "HEAD";
  const rangeHeader = request.headers.get("range");
  const spec = rangeHeader === null ? null : parseRangeSpec(rangeHeader);
  const cache = cacheEnabled(state);

  if (cache !== null) {
    const hit = await cacheLookup(state, cache);
    const meta = hit === null ? null : metaFromCache(hit);
    if (hit !== null && meta !== null) {
      state.cache = "hit";
      return respondFromFull(state, meta, hit.body, spec, "edge-cache");
    }
    await discard(hit?.body);
    state.cache = "miss";
  }

  if (isHead) {
    const head = await bucket.head(objectKey);
    if (head === null) {
      return miss(state);
    }
    state.r2 = "hit";
    return respondFromFull(state, metaFromR2(head, extension), null, spec, "r2");
  }

  if (spec === null) {
    return fullGet(state, bucket, objectKey, extension, null);
  }

  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(objectKey, { range: toR2Range(spec) });
  } catch (error) {
    if (!isUnsatisfiableRange(error)) {
      throw error;
    }
    // The range starts past the end. One metadata read gives the size.
    const head = await bucket.head(objectKey);
    if (head === null) {
      return miss(state);
    }
    state.r2 = "hit";
    const meta = metaFromR2(head, extension);
    const outcome = decide(meta, request.headers, spec);
    if (outcome.status === 200 || outcome.status === 206) {
      // A stale If-Range, or a disagreement about the size: send the
      // whole object, cut locally if a range still applies.
      return fullGet(state, bucket, objectKey, extension, outcome.status === 206 ? spec : null);
    }
    return bodilessResponse(outcome, meta, config, "r2");
  }
  if (object === null) {
    return miss(state);
  }
  state.r2 = "hit";
  const meta = metaFromR2(object, extension);
  const outcome = decide(meta, request.headers, spec);
  if (outcome.status === 206) {
    const length = outcome.end - outcome.start + 1;
    const headers = representationHeaders(meta, config, "r2", length);
    headers.set("content-range", `bytes ${outcome.start}-${outcome.end}/${meta.size}`);
    return makeResponse(withLength(object.body, length), 206, headers, meta);
  }
  await discard(object.body);
  if (outcome.status === 200) {
    // If-Range did not match: the range is ignored, so read the whole object.
    return fullGet(state, bucket, objectKey, extension, null);
  }
  return bodilessResponse(outcome, meta, config, "r2");
}

/** Reads the whole object; writes a full 200 to the edge cache when allowed. */
async function fullGet(
  state: State,
  bucket: R2Bucket,
  objectKey: string,
  extension: string,
  spec: RangeSpec | null,
): Promise<Response> {
  const object = await bucket.get(objectKey);
  if (object === null) {
    return miss(state);
  }
  state.r2 = "hit";
  const meta = metaFromR2(object, extension);
  const outcome = decide(meta, state.request.headers, spec);
  const cache = cacheEnabled(state);
  if (outcome.status !== 200 || cache === null || !cacheable(state, meta)) {
    return respondFromFull(state, meta, object.body, spec, "r2");
  }
  const [client, copy] = object.body.tee();
  const storedHeaders = representationHeaders(meta, state.config, null, meta.size);
  storedHeaders.set(ENTRY_MARKER, "1");
  const stored = new Response(withLength(copy, meta.size), { status: 200, headers: storedHeaders });
  cacheWrite(state, cache, cacheKey(state.url), stored);
  return makeResponse(
    withLength(client, meta.size),
    200,
    representationHeaders(meta, state.config, "r2", meta.size),
    meta,
  );
}

function toR2Range(spec: RangeSpec): R2Range {
  switch (spec.kind) {
    case "bounded":
      return { offset: spec.start, length: spec.end - spec.start + 1 };
    case "open":
      return { offset: spec.start };
    case "suffix":
      return { suffix: spec.length };
  }
}

// ---------------------------------------------------------------------------
// Miss: negative cache, then origin

async function miss(state: State): Promise<Response> {
  state.r2 = "miss";
  const cache = cacheEnabled(state);
  const seconds = state.config.negativeCacheSeconds;
  const useNegative = cache !== null && seconds > 0;
  const key = cacheKey(state.url, true);
  if (useNegative) {
    try {
      const hit = await cache.match(key);
      if (hit !== undefined) {
        const marked = hit.headers.get(NEGATIVE_MARKER) === "1";
        await discard(hit.body);
        if (marked) {
          return plainResponse(404, "Not Found", state.config, "negative-cache", state.request.method === "HEAD");
        }
      }
    } catch (error) {
      logError("cache_lookup_error", error, state.url.pathname);
    }
  }
  const response = await fallback(state);
  if (useNegative && response.status === 404) {
    const marker = new Response("", {
      status: 200,
      headers: { "cache-control": `public, max-age=${seconds}`, [NEGATIVE_MARKER]: "1" },
    });
    cacheWrite(state, cache, key, marker);
  }
  return response;
}
