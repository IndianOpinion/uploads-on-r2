# Architecture

This document describes how uploads-on-r2 0.1.0 is built, and records every
decision taken while building it from `docs/PRD.md`, including the answers
to the PRD's open questions (section 13).

## Modules

| File                      | Role                                                                                   | I/O                                    |
| ------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| `src/index.ts`            | Default export (the Worker's `fetch` handler) and the public helper exports            | Wires `fetch` and `caches.default`     |
| `src/handler.ts`          | The request pipeline: routing, R2 reads, edge cache, negative cache, fallback, logging | All I/O, through injected dependencies |
| `src/config.ts`           | Parses and validates the Worker variables; caches the result per environment object    | Logs config errors once                |
| `src/key.ts`              | Path to object key: decoding, segment checks, deny list, key length, extension         | None                                   |
| `src/http.ts`             | HTTP dates, entity tags, preconditions, `If-Range`, byte ranges, header-name checks    | None                                   |
| `src/content-type.ts`     | Content type choice and cache-policy families                                          | None                                   |
| `src/stream.ts`           | Range slicing of a stream, fixed-length wrapping, body discard                         | Streams only                           |
| `scripts/sync-uploads.sh` | Copy-only rclone wrapper that fills the bucket                                         | rclone                                 |

`handleRequest(request, env, ctx, deps)` takes a `Deps` object with the
origin `fetch` and the `Cache` to use. Production passes the global `fetch`
and `caches.default`; tests pass a recording origin and a wrapped cache.

Exported pure helpers (PRD 5.3): `parseConfig`, `getConfig`,
`normaliseKey`, `extensionOf`, `isDenied`, `parseRange`, `parseRangeSpec`,
`resolveRange`, `evaluatePreconditions`, `ifRangeMatches`, `parseHttpDate`,
`formatHttpDate`, `contentTypeFor`, `cacheControlFor`, `familyOf`,
`sliceStream`, plus `handleRequest` and `denyResponse`.

## Data flow

```
request
  |
  +-- path not under PUBLIC_PREFIX ---------------------> pass to origin (unchanged)
  +-- decode once; bad escape, control char, backslash,
  |   empty / . / .. segment, or deny prefix ------------> 404 deny (no-store)
  +-- hop header present -------------------------------> fetch(request) unchanged
  +-- object key > 1024 bytes, method not GET/HEAD,
  |   extension not media -----------------------------> pass to origin
  +-- binding missing ---------------------------------> fallback (error logged once)
  +-- edge cache on: cache.match(https://host/path)
  |     hit -> preconditions -> If-Range -> range -> 200 / 206 (sliced) / 304 / 412 / 416
  +-- R2
  |     HEAD:            head()                          -> same decision, no body
  |     GET, no Range:   get()                           -> 200 / 304 / 412; full 200 teed to cache
  |     GET, Range:      get({range})                    -> 206 / 304 / 412
  |                      R2 "range not satisfiable" -> head() -> 416 (or 304 / 412)
  |                      If-Range stale             -> get() -> 200
  |     null             -> miss
  |     throws           -> fallback
  +-- miss: negative cache hit -> 404 negative-cache
  |         else fallback to origin (+ source: origin); origin 404 -> negative marker written
  +-- origin fetch throws -> 502 origin-error
```

Every request ends with one JSON log line: method, path (no query), status,
source, cache outcome (`hit`, `miss`, `skip`), R2 outcome (`hit`, `miss`,
`error`, `skip`) and duration.

## Answers to the PRD's open questions

### Q1. Ranges from the edge cache (ruling: slice it yourself)

The Worker does not rely on `cache.match` honouring a `Range` header. The
cache lookup always uses a key request with no headers, so it returns the
full cached `200`. When the client sent a range, the Worker evaluates
preconditions and `If-Range` on the cached headers, resolves the range
against the cached `content-length`, and streams the slice with
`sliceStream` (bytes before the start are read and dropped; the source is
cancelled once the slice is out) through a `FixedLengthStream`.

Case 25 therefore changes: a `Range` request does look up the cache. On a
hit it is answered from the cached copy; on a miss it reads R2 with the
range and writes nothing. Tests T25 and T40 cover slicing (bounded, open,
suffix, oversize suffix, clamped end, and `416` with the cached size) and
check that no R2 call is made. Why: one code path for every range, and no
dependence on undocumented Cache API behaviour. The cost of dropping the
bytes before the start is bounded by `EDGE_CACHE_MAX_BYTES` (64 MiB).

### Q2. Purging edge-cache entries (ruling: document)

Entries written with `cache.put` while the Worker runs on a zone route live
in that zone's cache, keyed by URL, and Cloudflare's purge by single URL
(and purge everything) removes them. The key is `https://<host><path>` with
no query string, so purge that exact URL, without `?ver=...`. If the same
file is requested under another spelling (for example with `%2F`), that
spelling has its own entry and needs its own purge.

Caveats:

- On the default Workers subdomain (no zone route), the Cache API stores
  nothing, so there is nothing to purge and no caching to observe there.
- The cache is per data centre; a purge clears every data centre.
- Negative-cache markers are keyed `https://<host><path>?uploads-on-r2-negative=1`
  and expire after `NEGATIVE_CACHE_SECONDS`; they never need a purge, and a
  synced object wins over them at once because R2 is read first.
- This was not tested against a live zone from this repository (CI never
  touches an account). The procedure follows Cloudflare's documentation for
  the Cache API.

Procedure: Cloudflare dashboard, Caching, Configuration, Purge Cache,
Custom Purge, URL, then enter `https://example.com/wp-content/uploads/<path>`.

### Q3. HEAD (ruling: R2 head call, never a body)

`HEAD` uses `bucket.head()`, which returns metadata only, and evaluates
preconditions and ranges in the Worker. It never reads, and never needs to
cancel, an R2 body. A `HEAD` may still be answered from an edge-cache hit
(case 22); the cached body is then cancelled unread. A `HEAD` never writes
to the cache. Test T33 asserts that `HEAD` makes exactly one `head` call
and no `get`; T49 does the same with a range.

### Q4. Learning the size for a 416 (ruling: R2 head call)

A ranged `GET` reads R2 with the range (`offset`/`length`, `offset`, or
`suffix`). When the start is at or past the end, R2 rejects the read with
"range not satisfiable" (error 10039) instead of returning the size. The
Worker recognises that error, makes one `head()` call to learn the size and
validators, evaluates preconditions (a `304` or `412` still wins), and
returns `416` with `content-range: bytes */<size>`. Call count: two R2
operations on the `416` path, one everywhere else (PRD section 9). Any other
R2 error falls back to the origin. T46 asserts the `get`, `head` sequence.

Rare paths that cost one extra `get`: a stale `If-Range` (the range must be
ignored, so the whole object is read), and a disagreement between R2 and
the Worker about whether a range is satisfiable (the whole object is read
and cut locally).

### Q5. Browser cache policy for PDFs (ruling: per-family map)

`CACHE_CONTROL_BY_FAMILY` maps content-type families (`image`, `video`,
`audio`, `document` for PDF, `other`) to a `cache-control` value. Families
not in the map use `BROWSER_CACHE_CONTROL`. The default map is empty, so
PDFs get the same policy as images. The value is accepted as a TOML inline
table (an object in `env`) or a JSON string. Unknown families and values
with line breaks are reported and ignored. The value is applied when a
response is built, so an edge-cache hit always carries the current policy.
Why per family and not per extension: the reason to differ (files replaced
in place) follows the kind of file, and a map of five keys is easy to audit.

### Q6. Caching repeated origin 404s (ruling: 60 seconds)

After an R2 miss, if the edge cache is on and `NEGATIVE_CACHE_SECONDS` is
above 0 (default 60), the Worker checks a negative marker for the URL. If
present, it answers `404 Not Found`, `text/plain`, `no-store`, source
`negative-cache`, without asking the origin. If absent, it falls back, and
when the origin answers `404` it writes the marker in the background.

Details and reasons:

- R2 is still read on every request, so a file synced a second later is
  served at once; the marker cannot hide a real object.
- The marker is a tiny `200` with a marker header and
  `cache-control: public, max-age=<seconds>`, stored under a separate key.
  It does not depend on how the Cache API treats `404` statuses, and it
  cannot collide with the real entry (whose key never has a query string).
- The first 404 is the origin's own, unchanged (case 55). Repeats inside
  the window get the Worker's short 404. The source header tells them apart.
- R2 errors never write a marker; only a clean miss plus an origin `404` does.
- `0` turns it off; values above 3600 are rejected, so a mistake cannot hide
  files for long.

## Other decisions

1. **Test integration package.** `@cloudflare/vitest-pool-workers` has been
   renamed `@cloudflare/vitest-plugin` and the old name is deprecated. The
   build uses `@cloudflare/vitest-plugin` (same project, same runtime) with
   vitest 4. Tests still run inside workerd with a real in-memory R2 bucket
   and the real Cache API.
2. **Node 22.12 or later.** Wrangler 4 and Miniflare refuse older Node, so
   `engines.node` is `>=22.12` and CI runs Node 22 and 24 rather than 20 and 22.
3. **Placeholders without angle brackets.** Wrangler rejects `<your-bucket>`
   as a bucket name, which would break `wrangler deploy --dry-run` in CI.
   `wrangler.toml` uses `your-worker`, `your-bucket` and `example.com`.
4. **`EDGE_CACHE_MAX_BYTES` defaults to 64 MiB, not 512 MiB.** Writing to
   the cache tees the body. If the client reads slowly while the cache write
   reads fast, the runtime buffers the difference, and a large video could
   push an isolate past its 128 MB memory limit. 64 MiB keeps the worst case
   under half of it, and also bounds the bytes dropped when slicing a range
   from a cached copy. It is also the ceiling: operators can lower it, and a
   larger value is clamped to 64 MiB and logged.
5. **Stored content types are not always trusted.** Besides empty and
   generic types (case 30), a stored type a browser could run as a document
   on the site's origin (HTML, XHTML, XML and any `+xml`, JavaScript, SVG on
   a non-SVG extension) is replaced by the extension's type. A `.jpg`
   uploaded by another copier as `text/html` would otherwise be an XSS.
   For an extension in the table, the stored type must also be one
   well-formed type of the same kind (`image/*` for an image extension,
   exactly `application/pdf` for `.pdf`); a comma list, a bare word or a
   different kind is replaced too.
6. **Multisite private folders.** Deny prefixes are matched at the start of
   the key and also after a leading `sites/<n>/`, where WordPress multisite
   keeps each site's exports and plugin folders.
7. **Dot segments and the URL parser.** The runtime's URL parser resolves
   literal and `%2e` dot segments before the Worker sees the path. The
   Worker still checks segments after decoding, which catches the forms
   that survive parsing (`%2F..%2F`, `%2F%2F`). T6 checks both the pure
   function on raw paths and the Worker on surviving forms.
8. **Preconditions are evaluated in the Worker, not with R2 `onlyIf`.** One
   evaluator serves R2 and the edge cache, so their answers match (T40),
   and the Worker always decides `304` against `412` itself (cases 39, 40).
   For a conditional `GET` the R2 body stream is cancelled unread.
9. **The hop request skips the override.** A request that already carries
   the hop header is sent on with `fetch(request)` unchanged, never to
   `ORIGIN_OVERRIDE`, so an override that points back at the Worker cannot
   loop. All other origin subrequests (pass and fallback) go to the
   override when set and carry the hop header.
10. **Encoded objects are not edge-cached.** Objects stored with a
    `content-encoding` are served with manual body encoding (case 31) but
    not written to the Cache API, to avoid any re-encoding of the cached copy.
11. **416 is `no-store`.** A `416` must not be cached for a year by the
    browser; it carries `cache-control: no-store` instead of the media policy.
12. **Configuration is cached per `env` object** (a `WeakMap`), which in
    production means once per isolate. Problems are logged once per object.
13. **Range parsing uses no regular expression,** and numbers longer than
    15 digits are treated as malformed (the range is ignored).
14. **Sync script: one rclone pass per extension,** each with
    `--header-upload "Content-Type: ..."`, so every object gets an exact type
    even where rclone's own guess is missing (for example `avif`). Filters
    are case-insensitive. The default minimum rclone is 1.63.0, configurable
    with `--min-version`.
15. **Unexpected errors fail open.** Any exception while serving media is
    logged and the request falls back to the origin, except deny and an
    unreachable origin, which fail closed (PRD 4.11).
16. **Edge-cache entries are marked.** On a zone route the Cache API shares
    keys with the zone cache, so the zone's own copy of a fallback response
    can sit under the same URL. Every entry the Worker writes carries an
    internal marker header, and a lookup that returns an unmarked entry (or
    a non-`200`) is treated as a miss. The marker is never sent to clients,
    because responses are rebuilt from the cached validators.
