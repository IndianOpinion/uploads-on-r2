# PRD: uploads-on-r2

Status: draft for review. Audience: the engineer who builds version 0.1.0
from this document alone.

Placeholders used throughout: `<your-bucket>` (the R2 bucket),
`<your-zone>` (the Cloudflare zone), `<your-worker>` (the Worker name),
`example.com` (the site host). No real names appear here, and none may
appear in the shipped code or config.

## 1. Problem

A WordPress site keeps every upload (images, video, audio, PDFs) on the
origin server's disk under `/wp-content/uploads/`. Every cache miss for a
media file costs the origin a request, the origin's disk is the only copy
that serves, and when the origin is slow, moved or down, every image on the
site breaks with it. Moving the files into an object store fixes the
storage side, but WordPress, themes, feeds and years of published HTML all
point at the same `/wp-content/uploads/...` URLs. Rewriting those URLs is
slow, risky and never complete.

This project is a Cloudflare Worker that sits on the uploads path of the
zone and answers those same URLs from an R2 bucket, falling back to the
origin when an object is not in the bucket yet. URLs do not change. The
worst case (object missing, Worker error) is exactly the behaviour the site
had before the Worker existed.

Measured result from production: the first version served any object in the
bucket, because a Worker in front of the origin bypasses the web server's
own deny rules; a WordPress personal-data export archive, plugin log files
and PHP stubs were publicly readable through it until a deny list and a
media-only allowlist were added. That lesson shapes cases 8 to 16 below.

## 2. Goals and non-goals

### Goals

- Serve `GET` and `HEAD` for media under the uploads path from R2, on the
  unchanged public URLs.
- Fall back to the origin, transparently, when the object is missing, the
  request is not for media, or R2 fails.
- Never serve private WordPress upload directories, whatever the bucket
  holds.
- Correct HTTP: content types, `ETag`, `Last-Modified`, conditional
  requests (`304` and `412`), single byte ranges (`206` and `416`),
  `HEAD`.
- Long browser caching for R2-served media, and optional edge caching
  through the Workers Cache API so repeated requests do not read R2.
- Zero runtime dependencies. Strict TypeScript. Tests that run in the real
  Workers runtime.
- A small companion script that copies the origin's uploads into the
  bucket, so the Worker has something to serve.

### Non-goals

- Writing to R2 from the Worker. The Worker is read-only. Uploads reach the
  bucket through the companion script or any other copier.
- Deleting from R2. Neither the Worker nor the script ever deletes an
  object.
- Image resizing, format conversion (WebP, AVIF), or on-the-fly thumbnails.
  WordPress makes its sizes at upload time; anything generated on demand
  stays on the origin and is reached through fallback.
- Multipart byte ranges (`multipart/byteranges`).
- Signed or private URLs, hotlink protection, or access control beyond the
  deny list.
- Rewriting HTML or URLs in WordPress.
- Serving anything outside the uploads path.

## 3. Users and setting

- **Who installs it:** a site operator with a Cloudflare account that holds
  both the zone and the R2 bucket. They deploy with Wrangler from their own
  machine or CI.
- **Where it runs:** a Cloudflare Worker attached by route to
  `example.com/wp-content/uploads/*` (and the `www.` variant if used) on
  `<your-zone>`, with an R2 binding to `<your-bucket>` in the same account.
  Because the binding is native, no access keys or request signing are
  needed.
- **Origin:** any WordPress host behind Cloudflare (nginx, Apache, managed
  hosting). The origin keeps the files; the bucket is a copy.
- **Companion script:** runs on the origin (cron) to copy new uploads to
  the bucket.

## 4. Behaviour

Terms. *Prefix* is the configured public path, default
`/wp-content/uploads/`. *Relative key* is the part of the path after the
prefix, percent-decoded. *Object key* is the configured key prefix (default
`wp-content/uploads/`) followed by the relative key. *Pass* means the
Worker forwards the request to the origin with `fetch(request)` and returns
the origin's response unchanged. *Fallback* means the same forward, but the
Worker adds its source header with value `origin`. *Deny* means the fixed
404 response in case 8.

Processing order is fixed: path check, key normalisation, deny check,
method check, extension check, edge cache, R2, fallback. The deny check
runs before the method check so that no method can reach a private path.

### 4.1 Routing

1. A request whose path does not start with the prefix is passed. This
   covers a route that was set wider than intended. The response is not
   modified and carries no source header.
2. The prefix match is exact and case-sensitive. `/wp-content/uploads`
   (no trailing slash) and `/WP-CONTENT/uploads/x.jpg` are passed.
3. A path equal to the prefix (`/wp-content/uploads/`) has an empty
   relative key and is denied (404). Directory listings are never served.

### 4.2 Key normalisation

4. The relative key is percent-decoded exactly once, as UTF-8. An invalid
   escape (`%zz`, a truncated `%4`, or bytes that are not valid UTF-8)
   is denied.
5. After decoding, a relative key containing a control character
   (U+0000 to U+001F, U+007F) or a backslash is denied.
6. After decoding, the relative key is split on `/`. Any empty segment
   (`a//b.jpg`, a trailing `/`), any `.` segment or any `..` segment is
   denied. The check runs on the decoded key, so `%2e%2e` and `%2F`
   cannot smuggle a traversal past the URL parser.
7. An encoded slash `%2F` decodes to `/` and is then treated as a segment
   separator like any other slash. `2026/01/a.jpg` and `2026%2F01%2Fa.jpg`
   name the same object.
8. **Deny list.** The decoded relative key is compared, lower-cased,
   against each deny prefix. On a match the Worker returns, for every
   method, without touching R2, the cache or the origin: status 404, body
   `Not Found`, `content-type: text/plain; charset=utf-8`,
   `cache-control: no-store`, `x-content-type-options: nosniff`, source
   header `deny`. Built-in deny prefixes, which cannot be removed:
   `wp-personal-data-exports/`, `wc-logs/`, `woocommerce_uploads/`,
   `wpcf7_uploads/`. The operator may add more (section 7). Because the
   comparison is on the decoded, lower-cased key, `WC-LOGS/x.jpg` and
   `%77c-logs/x.jpg` are denied.
9. Cases 3 to 6 use the same 404 response as case 8. A malformed key is
   indistinguishable from a private one.
10. The query string never forms part of the object key. `a.jpg?ver=3`
    reads object `.../a.jpg`. The query string is kept on pass and
    fallback requests.
11. The object key keeps the case of the request. `Photo.JPG` and
    `photo.jpg` are different objects, as they are on a Linux origin.
12. `+` is a literal plus, not a space. `%20` is a space. A double-encoded
    `%2520` decodes once to the three characters `%20`, which is then the
    literal key.
13. No Unicode normalisation is applied. The key bytes are the decoded
    request bytes. A file stored under an NFD name and requested in NFC is
    a miss and falls back (see lesson 9 in section 14).
14. A relative key whose object key is longer than 1024 bytes of UTF-8
    (the R2 key limit) is passed without an R2 read.

### 4.3 Methods

15. `GET` and `HEAD` continue to the extension check.
16. Every other method (`POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`) is
    passed, after the deny check. The origin decides.

### 4.4 Extension allowlist

17. The extension is taken from the final segment only: the text after the
    last dot, lower-cased. A name with no dot, or whose only dot is the
    first character (`.htaccess`), has no extension and is passed.
18. Only extensions in the media allowlist are read from R2. Default:
    `jpg`, `jpeg`, `png`, `gif`, `webp`, `avif`, `svg`, `mp4`, `webm`,
    `mp3`, `pdf`. Everything else (`css`, `js`, `json`, `php`, `txt`,
    `log`, `zip`, `html`) is passed, so the origin's own deny and serve
    rules still apply. Page-builder CSS that some plugins write under
    uploads is the common example.
19. Matching is case-insensitive on the extension (`A.JPG` is media) but
    the key keeps its case (case 11).
20. A double extension (`shell.php.jpg`) is judged by its last extension
    only and is media. It is served with the image content type and
    `nosniff`, so it cannot execute.

### 4.5 Edge cache (when enabled)

21. A `GET` without a `Range` header looks up the Cache API first, using a
    key request built from `https://<host><path>` only: no query string,
    no request headers, method `GET`. On a hit the Worker evaluates the
    request's conditional headers against the cached `ETag` and
    `Last-Modified` (cases 33 to 38) and returns `304`, `412` or the
    cached `200`, with source header `edge-cache`.
22. A `HEAD` may be answered from a cache hit with the same headers and no
    body. A `HEAD` never writes to the cache.
23. On a miss, the Worker reads R2. When the result is a full `200` for a
    `GET`, the Worker returns it to the client and writes a copy to the
    cache in the background (`ctx.waitUntil`), so the client never waits
    for the write. The response body is split (`tee` or `clone`) so the
    client stream and the cache stream are independent.
24. Never cached: `206`, `304`, `412`, `416`, deny responses, fallback
    responses, error responses, and objects larger than the configured
    maximum cacheable size (default 512 MiB, the common Cloudflare cache
    object limit).
25. A request with a `Range` header skips the cache lookup and reads R2
    directly (but see open question Q1).
26. A failure in cache lookup or cache write is logged and ignored; the
    request continues to R2 as if the cache were empty.
27. The query string is not in the cache key (case 10), so `?ver=4` does
    not bust the cache. Changing a file means a new file name (WordPress
    already does this for edited images) or a purge.
28. When edge caching is disabled, cases 21 to 27 do not apply and every
    media request reads R2.

### 4.6 R2 read and the 200 response

29. A hit on a plain `GET` returns `200` with the body streamed from R2,
    never buffered.
30. Response headers on every R2 or edge-cache response:
    - `content-type`: from the object's stored HTTP metadata, unless that
      is empty, `application/octet-stream` or `binary/octet-stream`, in
      which case it comes from the extension table in section 7. An
      `svg` is always `image/svg+xml`.
    - `content-length`: object size (or range length, case 41).
    - `etag`: the object's quoted HTTP ETag as R2 reports it.
    - `last-modified`: the object's upload time, in IMF-fixdate.
    - `accept-ranges: bytes`.
    - `cache-control`: the configured browser cache value, which replaces
      any cache control stored on the object.
    - `x-content-type-options: nosniff`.
    - the source header (`r2` or `edge-cache`).
    - for `svg` only: `content-security-policy: default-src 'none';
      style-src 'unsafe-inline'; img-src data:; sandbox`. An SVG opened
      directly cannot run script or load anything.
    - `content-disposition`, `content-language` and `content-encoding`
      from stored metadata, when present. Custom metadata is never
      exposed.
31. An object stored with a `content-encoding` (for example `gzip`) is
    served with that header and its bytes passed through unchanged, using
    manual body encoding so the runtime does not compress or decompress it
    again.
32. `HEAD` on a hit returns the same status and headers as `GET` would,
    with no body. It must not read the object body from R2 (use a
    metadata-only read, or a read that is not consumed).

### 4.7 Conditional requests

Conditionals are evaluated in the order RFC 9110 section 13.2.2 sets, for
`GET` and `HEAD`, whether the object came from R2 or the edge cache.

33. `If-Match` that does not match the current ETag (strong comparison;
    `*` matches any existing object) returns `412` with no body.
34. `If-Unmodified-Since` (ignored when `If-Match` is present) earlier than
    the upload time returns `412`.
35. `If-None-Match` that matches (weak comparison, comma lists, `*`)
    returns `304`.
36. `If-Modified-Since` (ignored when `If-None-Match` is present) at or
    after the upload time returns `304`.
37. A `304` or `412` carries `etag`, `last-modified`, `cache-control`,
    `x-content-type-options` and the source header, with no body and no
    `content-length` of the full object.
38. An unparseable date in `If-Modified-Since` or `If-Unmodified-Since` is
    ignored, as RFC 9110 requires.
39. A failed `If-Match` must produce `412`, never `304`. (The first version
    returned `304` for every failed precondition. See lesson 4 in section 14.)
40. When the read uses R2's own precondition support to avoid transferring
    a body, the Worker must still decide between `304` and `412` itself.

### 4.8 Range requests

Only a single range in the `bytes` unit is honoured.

41. `Range: bytes=0-99` on a 1000-byte object returns `206`,
    `content-range: bytes 0-99/1000`, `content-length: 100`, and exactly
    those bytes.
42. Open-ended `bytes=500-` returns bytes 500 to the end.
43. Suffix `bytes=-200` returns the last 200 bytes, with
    `content-range: bytes 800-999/1000`. (R2 reports a suffix range
    without an offset; see lesson 3 in section 14.)
44. A suffix longer than the object (`bytes=-5000`) returns the whole
    object as `206` with `content-range: bytes 0-999/1000`.
45. An end beyond the object (`bytes=900-5000`) is clamped to the last
    byte.
46. A start at or beyond the size (`bytes=1000-`), or any range on a
    zero-length object, returns `416` with `content-range: bytes */1000`
    and no body.
47. Several ranges (`bytes=0-1,5-6`), a unit other than `bytes`, or a
    malformed header (`bytes=abc`, `bytes=5-2`) are ignored: full `200`.
48. `If-Range` with a matching strong ETag or an exact matching date lets
    the range apply. A non-matching `If-Range` ignores the range: full
    `200`.
49. `HEAD` with a valid range returns the `206` headers with no body.
50. A plain `GET` without `Range` is never answered with `206`. (R2 fills
    in range information even for a full read; see lesson 2 in section 14.)
51. `accept-ranges: bytes` is on every R2 and edge-cache response,
    including `206`.

### 4.9 Origin fallback

52. An R2 miss (the read returns no object) falls back: the original
    request (method, headers including `Range` and conditionals, query
    string) is sent to the origin and the origin's response is streamed
    back with its own status and headers, plus the source header `origin`.
53. Any exception from the R2 binding (timeout, internal error, invalid
    key) also falls back. Fallback fails open to the origin because the
    origin is what served this URL before the Worker existed.
54. The origin's `cache-control`, `set-cookie` and every other header are
    left as they are. Images the origin generates on demand keep the
    origin's caching rules.
55. A `404` from the origin is returned as is. The Worker does not invent
    its own 404 for a miss.
56. If the fallback fetch itself throws (origin unreachable, DNS failure),
    the Worker returns `502`, body `Bad Gateway`,
    `content-type: text/plain; charset=utf-8`, `cache-control: no-store`,
    source header `origin-error`, and logs the error.
57. **Loop guard.** Every fallback subrequest carries a hop header
    (default name `x-uploads-hop`, value `1`). A request that arrives with
    that header already set is passed straight to the origin with no R2
    read. This stops infinite recursion when the origin URL points back at
    the Worker.
58. When an origin override URL is configured (for testing on a host with
    no route, where `fetch(request)` would come back to the Worker), the
    fallback goes to that base URL with the same path and query. When it is
    not set, the fallback is `fetch(request)`, which on a zone route
    reaches the origin through the zone's normal cache.
59. Fallback responses are never written to the Worker's Cache API entry.
    They are cached, if at all, by the zone's normal caching of the
    subrequest.

### 4.10 404 behaviour summary

60. Private prefix or malformed key: Worker 404, `no-store`, source
    `deny`, origin never asked.
61. Media object absent from R2 and from the origin: the origin's 404,
    source `origin`.
62. Non-media or other method: the origin's response, unmodified.

### 4.11 Failure modes

| Failure | Result | Open or closed | Why |
|---|---|---|---|
| R2 binding missing from config | Every media request falls back; one error logged per isolate | Open | Same as having no Worker |
| R2 read throws | Fallback | Open | Origin served it before |
| Cache API throws | Ignored, read R2 | Open | Cache is an optimisation |
| Origin unreachable after miss | 502, no-store | Closed | Nothing else can serve it |
| Malformed or private key | 404, no-store | Closed | Never leak private files |
| Invalid configuration value | Built-in default, error logged | Open for serving, closed for deny | The deny list can only grow |

## 5. Public interface

The Worker is an ES module with a default export that has a `fetch`
handler. There is no other entry point.

### 5.1 Bindings and variables

| Name | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `UPLOADS` | R2 bucket binding | yes | none | The bucket that holds the media, `<your-bucket>` |
| `PUBLIC_PREFIX` | var | no | `/wp-content/uploads/` | Public path served; must start and end with `/` |
| `KEY_PREFIX` | var | no | `wp-content/uploads/` | Prepended to the relative key to make the object key; may be empty |
| `MEDIA_EXTENSIONS` | var | no | the list in case 18 | Comma-separated, replaces the default list |
| `EXTRA_DENY_PREFIXES` | var | no | empty | Comma-separated, added to the built-in deny list |
| `BROWSER_CACHE_CONTROL` | var | no | `public, max-age=31536000, immutable` | `cache-control` on R2 and edge-cache responses |
| `EDGE_CACHE` | var | no | `on` | `on` or `off` |
| `EDGE_CACHE_MAX_BYTES` | var | no | `536870912` | Objects larger than this are not written to the cache |
| `ORIGIN_OVERRIDE` | var | no | unset | Absolute `https://` base URL for fallback, testing only |
| `SOURCE_HEADER` | var | no | `x-uploads-source` | Name of the diagnostic header; empty string disables it |
| `HOP_HEADER` | var | no | `x-uploads-hop` | Loop-guard header name |

### 5.2 Source header values

`r2`, `edge-cache`, `origin`, `origin-error`, `deny`. Pass responses carry
none.

### 5.3 Exported helpers

For tests and reuse, the module also exports pure functions with no
binding access. Suggested names (the builder may choose others and record
them in ARCHITECTURE.md): `parseConfig(env)`, `normaliseKey(path, config)`
returning a key or a deny marker, `extensionOf(key)`,
`parseRange(header, size)`, `evaluatePreconditions(headers, etag,
lastModified)`, `contentTypeFor(extension, stored)`.

### 5.4 `wrangler.toml`

Ships with placeholder values only: `name = "<your-worker>"`, a route
pattern `example.com/wp-content/uploads/*` with `zone_name =
"<your-zone>"`, one `[[r2_buckets]]` table with `binding = "UPLOADS"`
and `bucket_name = "<your-bucket>"`, `compatibility_date` of 2026-10-01
or later, `workers_dev = false`. Every top-level key sits above the first
table header (lesson 6 in section 14).

### 5.5 Companion sync script

`scripts/sync-uploads.sh`, bash, `set -euo pipefail`, shellcheck clean.

- Inputs: `--source <dir>` (the uploads directory), `--remote
  <rclone-remote>:<your-bucket>`, optional `--key-prefix`, `--dry-run`,
  `--max-age <duration>` (only files changed within this window, for
  frequent cron runs).
- Copies, never syncs or deletes. An object deleted on the origin stays in
  the bucket (lesson 10 in section 14).
- Includes only the media extensions, upper and lower case; excludes the
  deny prefixes, always.
- Sets content type by extension.
- Uses an rclone binary given by `--rclone <path>` (default: `rclone` on
  `PATH`), refuses to run on an rclone older than a configurable minimum,
  and documents `no_check_bucket = true` for bucket-scoped tokens.
- Exit codes: 0 success, 1 usage error, 2 rclone missing or too old, 3
  copy failed.
- Never reads credentials itself; rclone's config does.

## 6. Data

- The Worker stores nothing of its own. It reads R2 objects and, when edge
  caching is on, writes copies of full `200` responses into the Cache API
  of the data centre that served the request.
- Cache entries live until evicted or until their `cache-control` expires.
  Entries are keyed by public URL so that a zone purge by URL removes them
  (to be verified, Q2).
- R2 objects belong to the operator. Retention is the operator's choice;
  this project never deletes.
- Uninstall: remove the route and delete the Worker. The site returns to
  serving uploads from the origin with no other change. The bucket is left
  intact.

## 7. Configuration and sensible defaults

All defaults are listed in section 5.1. Extension to content type table
(used when the stored type is missing or generic):

| Extension | Content type |
|---|---|
| jpg, jpeg | image/jpeg |
| png | image/png |
| gif | image/gif |
| webp | image/webp |
| avif | image/avif |
| svg | image/svg+xml |
| mp4 | video/mp4 |
| webm | video/webm |
| mp3 | audio/mpeg |
| pdf | application/pdf |

An extension added through `MEDIA_EXTENSIONS` with no entry in this table
is served with its stored type, or `application/octet-stream` if none.

Validation: a malformed `PUBLIC_PREFIX`, an unknown `EDGE_CACHE` value, a
non-numeric `EDGE_CACHE_MAX_BYTES` or an `ORIGIN_OVERRIDE` that is not an
absolute `https` URL is replaced by its default and logged once per
isolate. Configuration is parsed once per isolate, not per request.

## 8. Security and privacy

- The Worker runs in front of the origin's web server, so the origin's
  deny rules do not apply to anything the Worker serves. The deny list and
  the media allowlist are the only access control. Both are applied to the
  decoded key.
- The built-in deny prefixes cannot be removed by configuration.
- Only media types are read from R2. A bucket that also holds logs,
  archives or scripts does not expose them.
- `nosniff` on every R2 response; a sandboxing CSP on SVG.
- No secrets: the R2 binding is native. No tokens in the Worker, the
  config or the repo.
- No request data is logged beyond method, path, status, source and timing.
  No query strings, cookies or client IPs in logs.
- The diagnostic source header reveals only which path served the file.
  Operators who object can disable it.

## 9. Performance budget

- Per request at most: one Cache API lookup, one R2 operation (two only on
  the `416` path, where a size check is needed), one cache write in the
  background, one origin fetch on fallback. Well inside any plan's
  subrequest limit.
- CPU: under 2 ms per request on a hit, excluding I/O. No body buffering;
  bodies stream. Memory use does not grow with object size, so large video
  files work within the 128 MB isolate limit.
- No regular expressions that backtrack on user input.
- Edge-cache hit adds no R2 read. R2 hit adds one Class B read.

## 10. Compatibility

- Cloudflare Workers, ES modules, `compatibility_date` 2026-10-01 or later.
  TypeScript `strict`. Node 20 and 22 for tooling.
- R2 binding in the same account as the Worker.
- Any WordPress version that stores uploads under a single public path.
  Multisite `sites/<n>/` subdirectories work unchanged, because they sit
  under the same prefix.
- Works with any origin web server. Works alongside zone cache rules; the
  Worker runs before the zone cache on its route.
- The Cache API does nothing on the default Workers subdomain and is per data
  centre, not global.
- Object size: limited by R2 (single objects up to several terabytes);
  edge caching only up to `EDGE_CACHE_MAX_BYTES`.

## 11. Observability

- Source header on every response the Worker builds (section 5.2), so
  `curl -sI https://example.com/wp-content/uploads/...` shows which path
  served it.
- `console.log` one structured JSON line per request at most: method,
  path, status, source, cache outcome (`hit`, `miss`, `skip`), R2 outcome
  (`hit`, `miss`, `error`), duration in ms. Visible in Workers Logs or
  `wrangler tail`.
- `console.error` for R2 exceptions, cache write failures, fallback fetch
  failures and invalid configuration, with the error message.
- The README includes a short runbook: how to tell an R2 hit from a
  fallback, how to spot a sync gap (many `origin` sources for recent
  uploads), and how to roll back (remove the route).

## 12. Acceptance tests

Run with `vitest` and `@cloudflare/vitest-pool-workers`, with an
in-memory R2 bucket seeded per test and the origin mocked with a fetch
mock. Each test names the case it covers.

| Test | Covers | Expectation |
|---|---|---|
| T1 | 1 | `/about/` is passed; response identical to origin, no source header |
| T2 | 2 | `/wp-content/uploads` and `/WP-CONTENT/uploads/a.jpg` are passed |
| T3 | 3 | `/wp-content/uploads/` returns deny 404 |
| T4 | 4 | `%zz`, `%4` and `%C3%28` in the path return deny 404 |
| T5 | 5 | `%00`, `%1F`, `%7F` and `%5C` return deny 404 |
| T6 | 6 | `a//b.jpg`, `a/./b.jpg`, `a/%2e%2e/b.jpg`, trailing `/` return deny 404 |
| T7 | 7 | `2026%2F01%2Fa.jpg` serves the object `2026/01/a.jpg` |
| T8 | 8 | each built-in prefix, `WC-LOGS/x.jpg` and `%77c-logs/x.jpg` return deny 404 for GET, HEAD, POST; R2 and origin mocks record no call |
| T9 | 8 | an `EXTRA_DENY_PREFIXES` entry is denied; built-ins still denied when the extra list is set |
| T10 | 9 | malformed and private responses have identical status, body and headers |
| T11 | 10 | `a.jpg?ver=3` serves object `a.jpg`; fallback request keeps `?ver=3` |
| T12 | 11 | `Photo.JPG` and `photo.jpg` read different objects |
| T13 | 12 | `a+b.jpg`, `a%20b.jpg`, `a%2520b.jpg` read keys `a+b.jpg`, `a b.jpg`, `a%20b.jpg` |
| T14 | 13 | an NFD-stored key requested in NFC falls back |
| T15 | 14 | a relative key over 1024 bytes is passed with no R2 call |
| T16 | 15, 16 | GET and HEAD reach R2; POST, PUT, DELETE, OPTIONS on a media path are passed |
| T17 | 17 | `.htaccess` and `README` are passed |
| T18 | 18 | `x.css`, `x.php`, `x.zip` are passed with no R2 call even when the bucket holds them |
| T19 | 19 | `A.JPG` is read from R2 under key `A.JPG` |
| T20 | 20 | `shell.php.jpg` served as `image/jpeg` with `nosniff` |
| T21 | 21 | second GET is served with source `edge-cache` and no R2 call |
| T22 | 22 | HEAD after a cached GET is served from cache, no body; HEAD on cold cache writes nothing |
| T23 | 23 | first GET returns before the cache write settles; the cache then holds a full copy with identical bytes |
| T24 | 24 | 206, 304, 412, 416, deny, fallback and oversize responses are never written to the cache |
| T25 | 25 | a Range request does not look up the cache |
| T26 | 26 | a throwing cache lookup and a throwing cache write both still return the R2 response |
| T27 | 27 | `a.jpg?ver=1` and `a.jpg?ver=2` share one cache entry |
| T28 | 28 | with `EDGE_CACHE=off`, two GETs make two R2 reads |
| T29 | 29 | a 5 MB object streams with correct bytes and `content-length` |
| T30 | 30 | full header set present; stored `cache-control` replaced; stored `application/octet-stream` on `.png` becomes `image/png`; custom metadata absent |
| T31 | 30 | `.svg` has the CSP header and `image/svg+xml` |
| T32 | 31 | an object stored with `content-encoding: gzip` is returned byte-identical with that header |
| T33 | 32 | HEAD returns the GET headers, no body, and does not read the body |
| T34 | 33, 39 | failing `If-Match` returns 412, not 304; `If-Match: *` on an existing object returns 200 |
| T35 | 34 | `If-Unmodified-Since` before upload time returns 412; ignored when `If-Match` present |
| T36 | 35 | matching `If-None-Match` (exact, `W/` prefixed, in a list, `*`) returns 304 |
| T37 | 36 | `If-Modified-Since` after upload returns 304; ignored when `If-None-Match` present |
| T38 | 37 | 304 and 412 carry etag, last-modified, cache-control, nosniff, source; no body |
| T39 | 38 | garbage `If-Modified-Since` returns 200 |
| T40 | 40 | conditional evaluated on edge-cache hits and R2 reads gives the same answers |
| T41 | 41 | `bytes=0-99` on 1000 bytes: 206, `bytes 0-99/1000`, length 100, correct bytes |
| T42 | 42 | `bytes=500-`: bytes 500 to 999 |
| T43 | 43 | `bytes=-200`: `bytes 800-999/1000`, last 200 bytes |
| T44 | 44 | `bytes=-5000`: `bytes 0-999/1000` |
| T45 | 45 | `bytes=900-5000`: `bytes 900-999/1000` |
| T46 | 46 | `bytes=1000-` and any range on an empty object: 416, `bytes */<size>` |
| T47 | 47 | multi-range, `items=0-1`, `bytes=abc`, `bytes=5-2`: full 200 |
| T48 | 48 | matching `If-Range` gives 206; stale `If-Range` gives 200 |
| T49 | 49 | HEAD with range: 206 headers, no body |
| T50 | 50 | plain GET never 206 |
| T51 | 51 | `accept-ranges: bytes` on 200, 206, 304 |
| T52 | 52 | R2 miss: origin mock receives method, Range, If-None-Match and query; response status and headers kept, source `origin` |
| T53 | 53 | an R2 binding that throws produces a fallback |
| T54 | 54 | origin `cache-control` and `set-cookie` reach the client unchanged |
| T55 | 55 | origin 404 is returned with origin body |
| T56 | 56 | origin fetch that throws gives 502, no-store, source `origin-error` |
| T57 | 57 | a request carrying the hop header is passed with no R2 read; fallback subrequests carry the hop header |
| T58 | 58 | with `ORIGIN_OVERRIDE`, fallback goes to the override base with same path and query |
| T59 | 59 | after a fallback, the cache holds nothing for that URL |
| T60 | 60 to 62 | the three 404 sources are distinguishable by source header |
| T61 | 4.11 | missing `UPLOADS` binding: media requests fall back, one error logged |
| T62 | 7 | invalid config values fall back to defaults with one logged error |
| T63 | 5.4 | parsing the shipped `wrangler.toml` yields one route at top level and one R2 binding |
| T64 | 5.5 | bats: sync script dry run includes only media, excludes deny prefixes, never passes a delete flag, exits 2 on old rclone |

## 13. Open questions

Answer each in `docs/ARCHITECTURE.md`.

- **Q1.** Does `cache.match` on Cloudflare honour a `Range` header on the
  lookup request and return a correct `206` from a cached full object? If
  verified in the runtime tests, ranges may be served from cache;
  otherwise keep case 25.
- **Q2.** Does a zone purge by single URL remove an entry written with
  `cache.put` under the same URL? Document the purge procedure either way.
- **Q3.** For `HEAD`, use R2's metadata-only read and evaluate
  preconditions in the Worker, or a conditional `get` whose body is
  cancelled? Pick one, record why.
- **Q4.** For the `416` path, how does the Worker learn the object size
  without a second R2 call when R2 rejects an out-of-range read? Record
  the approach and its call count.
- **Q5.** Should the browser cache value differ for `pdf` (which editors
  sometimes replace in place) from images? Default is one value for all;
  say whether a per-extension override is worth adding.
- **Q6.** Should repeated origin 404s for the same missing media be
  cached briefly by the Worker to protect the origin from scanners? The
  default is no; record the reasoning.

## 14. Lessons from production

1. **A Worker in front of the origin bypasses the origin's deny rules.**
   Apply a deny list and a media allowlist in the Worker, on the decoded
   key, for every method, before any read. Do not assume the bucket holds
   only public files.
2. **Never pass `range` to R2 unless the client sent `Range`.** R2 fills
   in range information even for a full read, and code that trusts it
   turns every plain `GET` into a `206`.
3. **R2 reports a suffix range without an offset.** Code that only handles
   offset ranges silently sends a `200` with the full length header and a
   partial body. Compute the served range yourself from the size.
4. **A missing body is not always `304`.** A failed `If-Match` or
   `If-Unmodified-Since` is `412`. Decide the status from which
   precondition failed.
5. **Check traversal and deny prefixes after decoding.** `%2e%2e`, `%2F`
   and `%77c-logs` survive URL parsing; only the decoded key is the truth.
6. **In `wrangler.toml`, every top-level key goes above the first table
   header.** TOML assigns a key after `[[r2_buckets]]` to that table. A
   `routes` line placed there deploys a Worker with no routes, and
   Wrangler only warns.
7. **A Worker with no route that calls `fetch(request)` calls itself.**
   Testing on a bare host needs an explicit origin override, and the loop
   guard is there for when someone points it at the Worker.
8. **The worst case must equal no Worker.** Any R2 or cache failure falls
   back to the origin. Only private keys and an unreachable origin fail
   closed.
9. **Sync is the Worker's blind spot.** New uploads, edited images and
   files generated on demand are missing from the bucket until the copier
   runs. Fallback hides this; watch the share of `origin` sources to see
   it. Keys must match the file system names byte for byte, including
   Unicode form.
10. **Copy, never mirror with delete.** A sync that deletes can empty the
    bucket when the source path is wrong. A file removed on the origin
    staying in the bucket is the lesser harm; remove it by hand.
11. **Old distribution builds of rclone false-fail against R2, and
    bucket-scoped tokens need `no_check_bucket`.** Pin a recent rclone by
    path and check its version before copying.
12. **`immutable` means immutable.** A file replaced under the same name
    stays stale in browsers for the max-age. Publish a new name, or lower
    the browser cache value for types that get replaced.
13. **Keep the route narrow.** Route only the uploads path. A zone-wide
    route makes the Worker a single point of failure for the whole site.
14. **Do not test the Cache API on the default Workers subdomain.** It does
    nothing there, and a passing check proves nothing.
