import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { Env } from "../src/config";
import { handleRequest } from "../src/handler";

export const HOST = "https://example.com";
export const PREFIX = "/wp-content/uploads/";

let counter = 0;

/** The in-memory R2 bucket miniflare provides. */
export function realBucket(): R2Bucket {
  return testEnv.UPLOADS;
}

export interface BucketCall {
  readonly method: "get" | "head";
  readonly key: string;
  readonly options: R2GetOptions | undefined;
}

/** Wraps the real bucket and records every call. */
export class SpyBucket {
  readonly calls: BucketCall[] = [];
  throwOn: "get" | "head" | "all" | null = null;

  constructor(private readonly inner: R2Bucket) {}

  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    this.calls.push({ method: "get", key, options });
    if (this.throwOn === "get" || this.throwOn === "all") {
      return Promise.reject(new Error("simulated R2 failure"));
    }
    return this.inner.get(key, options);
  }

  head(key: string): Promise<R2Object | null> {
    this.calls.push({ method: "head", key, options: undefined });
    if (this.throwOn === "head" || this.throwOn === "all") {
      return Promise.reject(new Error("simulated R2 failure"));
    }
    return this.inner.head(key);
  }

  count(method?: "get" | "head"): number {
    return method === undefined ? this.calls.length : this.calls.filter((c) => c.method === method).length;
  }
}

/** A fake origin that records requests. */
export class Origin {
  readonly requests: Request[] = [];
  handler: (request: Request) => Response | Promise<Response> = () =>
    new Response("origin 404 page", { status: 404, headers: { "content-type": "text/html" } });

  readonly fetch = async (request: Request): Promise<Response> => {
    this.requests.push(request);
    return this.handler(request);
  };
}

/** A Cache wrapper that can throw, count, or hold writes open. */
export class TestCache {
  readonly puts: string[] = [];
  readonly matches: string[] = [];
  throwOnMatch = false;
  throwOnPut = false;
  gate: Promise<void> | null = null;

  constructor(readonly inner: Cache) {}

  async match(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<Response | undefined> {
    this.matches.push(request instanceof Request ? request.url : String(request));
    if (this.throwOnMatch) {
      throw new Error("simulated cache lookup failure");
    }
    return this.inner.match(request, options);
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.puts.push(request instanceof Request ? request.url : String(request));
    if (this.gate !== null) {
      await this.gate;
    }
    if (this.throwOnPut) {
      throw new Error("simulated cache write failure");
    }
    await this.inner.put(request, response);
  }

  delete(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<boolean> {
    return this.inner.delete(request, options);
  }

  /** Looks at the underlying cache without recording a lookup. */
  peek(url: string): Promise<Response | undefined> {
    return this.inner.match(new Request(url));
  }
}

export interface Harness {
  readonly bucket: SpyBucket;
  readonly origin: Origin;
  readonly cache: TestCache;
  readonly env: Env;
  /** Prefix under which this harness stores objects. */
  readonly keyPrefix: string;
  seed(relativeKey: string, body: string | Uint8Array, http?: R2HTTPMetadata): Promise<R2Object>;
  run(pathOrRequest: string | Request, init?: RequestInit): Promise<Response>;
  /** Runs and waits for background work (cache writes) to finish. */
  runAndSettle(pathOrRequest: string | Request, init?: RequestInit): Promise<Response>;
}

/**
 * A fresh, isolated set-up: its own key prefix in the shared bucket, its own
 * Cache API cache, its own origin mock and its own environment object.
 */
export async function harness(vars: Partial<Env> = {}, options: { cache?: boolean } = {}): Promise<Harness> {
  counter += 1;
  const keyPrefix = `t${Date.now()}-${counter}/`;
  const bucket = new SpyBucket(realBucket());
  const origin = new Origin();
  const cache = new TestCache(await caches.open(`test-${keyPrefix}`));
  const env: Env = { UPLOADS: bucket as unknown as R2Bucket, KEY_PREFIX: keyPrefix, ...vars };
  const useCache = options.cache ?? true;

  const toRequest = (pathOrRequest: string | Request, init?: RequestInit): Request =>
    typeof pathOrRequest === "string" ? new Request(HOST + pathOrRequest, init) : pathOrRequest;

  const exec = async (request: Request, settle: boolean): Promise<Response> => {
    const ctx = createExecutionContext();
    const response = await handleRequest(request, env, ctx, {
      fetch: origin.fetch,
      cache: useCache ? cache : null,
    });
    if (settle) {
      await waitOnExecutionContext(ctx);
    }
    return response;
  };

  return {
    bucket,
    origin,
    cache,
    env,
    keyPrefix,
    seed: async (relativeKey, body, http) =>
      realBucket().put(keyPrefix + relativeKey, body, http === undefined ? {} : { httpMetadata: http }),
    run: (p, init) => exec(toRequest(p, init), false),
    runAndSettle: (p, init) => exec(toRequest(p, init), true),
  };
}

/** Bytes 0..n-1, each the index modulo 256. */
export function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = i % 256;
  }
  return out;
}

export async function bodyBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

export const SOURCE = "x-uploads-source";

/** Decodes a body as UTF-8 without the runtime's content-type warning. */
export async function text(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

/** Fast byte comparison; `toEqual` on megabytes is slow. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
