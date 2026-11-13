# uploads-on-r2

A Cloudflare Worker that answers your WordPress `/wp-content/uploads/` URLs
from an R2 bucket, and falls back to the origin when a file is not there
yet. Media stops depending on the server, URLs do not change, and the worst
case is exactly the site you had before the Worker.

This project came out of the work on indianopinion.org and is written from
scratch; it is independent of and not affiliated with any third-party plugin
it integrates with.

**Measured in production:** a first, naive version served anything in the
bucket, including a WordPress personal-data export and plugin log files,
because a Worker bypasses the origin's own deny rules. This version denies
private folders on the decoded key and reads only media extensions.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [The sync script](#the-sync-script)
- [Runbook](#runbook)
- [Limitations](#limitations)
- [FAQ](#faq)
- [Licence](#licence)

## Install

You need a Cloudflare account that holds both the zone and an R2 bucket,
Node 22.12 or later, and Wrangler (installed as a dev dependency here).

With npm (the usual way):

```sh
git clone https://github.com/IndianOpinion/uploads-on-r2.git
cd uploads-on-r2
npm ci
```

Without a package manager: the Worker has no runtime dependencies. You can
bundle `src/index.ts` with any TypeScript-aware bundler (or let Wrangler do
it) and upload the result. The package is not published to npm.

## Quick start

1. Copy your uploads into the bucket first (see [the sync script](#the-sync-script)).
   Keys must be `wp-content/uploads/<path>` by default.
2. Edit `wrangler.toml`: replace `your-worker`, `example.com` and
   `your-bucket` with your own names. Keep every top-level key above the
   first `[table]` header.
3. Check the bundle and config without touching your account:

   ```sh
   npm run build      # wrangler deploy --dry-run
   ```

4. Deploy from your own machine or pipeline, with your own credentials:

   ```sh
   npx wrangler deploy
   ```

5. Check it:

   ```sh
   curl -sI https://example.com/wp-content/uploads/2026/01/photo.jpg | grep -i x-uploads-source
   # x-uploads-source: r2
   ```

Bindings the Worker needs:

| Binding   | Kind      | Set in                              |
| --------- | --------- | ----------------------------------- |
| `UPLOADS` | R2 bucket | `[[r2_buckets]]` in `wrangler.toml` |

There are no secrets. The R2 binding is native, so no access keys or
request signing are involved.

## Configuration

All variables are optional; set them under `[vars]` in `wrangler.toml`. An
invalid value is replaced by its default and logged once per isolate.

| Variable                  | Default                                           | Meaning                                                                                                          |
| ------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_PREFIX`           | `/wp-content/uploads/`                            | Public path served. Must start and end with `/`.                                                                 |
| `KEY_PREFIX`              | `wp-content/uploads/`                             | Prepended to the path after the prefix to make the object key. May be empty.                                     |
| `MEDIA_EXTENSIONS`        | `jpg,jpeg,png,gif,webp,avif,svg,mp4,webm,mp3,pdf` | Comma-separated. Replaces the default list. Only these are read from R2.                                         |
| `EXTRA_DENY_PREFIXES`     | empty                                             | Comma-separated key prefixes to refuse, added to the built-in list. End a folder with `/`.                       |
| `BROWSER_CACHE_CONTROL`   | `public, max-age=31536000, immutable`             | `cache-control` on R2 and edge-cache responses.                                                                  |
| `CACHE_CONTROL_BY_FAMILY` | empty                                             | Per-family override: a TOML table or JSON object with keys `image`, `video`, `audio`, `document` (PDF), `other`. |
| `EDGE_CACHE`              | `on`                                              | `on` or `off`. Edge caching through the Workers Cache API.                                                       |
| `EDGE_CACHE_MAX_BYTES`    | `67108864` (64 MiB)                               | Larger objects are never written to the edge cache. Also the ceiling: a larger value is clamped to 64 MiB.       |
| `NEGATIVE_CACHE_SECONDS`  | `60`                                              | How long a repeated origin 404 is answered by the Worker. `0` turns it off. Max 3600. Needs the edge cache.      |
| `ORIGIN_OVERRIDE`         | unset                                             | Absolute `https://` base URL for fallback. For testing on a host with no route only.                             |
| `SOURCE_HEADER`           | `x-uploads-source`                                | Diagnostic header name. An empty string disables it.                                                             |
| `HOP_HEADER`              | `x-uploads-hop`                                   | Loop-guard header name.                                                                                          |

Built-in deny prefixes, which cannot be removed: `wp-personal-data-exports/`,
`wc-logs/`, `woocommerce_uploads/`, `wpcf7_uploads/`. They also apply under
a multisite `sites/<n>/` folder.

Example: keep images immutable for a year, but let PDFs (which editors
sometimes replace in place) refresh daily.

```toml
[vars]
CACHE_CONTROL_BY_FAMILY = { document = "public, max-age=86400" }
```

## How it works

Every request goes through the same fixed steps:

1. **Path.** Not under `PUBLIC_PREFIX`: passed to the origin untouched.
2. **Key.** The rest of the path is percent-decoded once. Bad escapes,
   control characters, backslashes, empty, `.` or `..` segments: 404.
3. **Deny.** The decoded, lower-cased key starts with a deny prefix: 404,
   `no-store`, for every method. R2, the cache and the origin are never asked.
4. **Loop guard.** A request carrying the hop header goes straight to the origin.
5. **Method and extension.** Only `GET` and `HEAD` of a media extension go
   further. Everything else (uploads CSS from page builders, `POST`s) goes
   to the origin, whose own rules apply.
6. **Edge cache.** A hit answers the request, including conditionals and ranges.
7. **R2.** A hit is streamed with `content-type`, `content-length`, `etag`,
   `last-modified`, `accept-ranges`, `cache-control`, `nosniff` (and a
   sandboxing CSP for SVG). Full `200`s are copied to the edge cache in the
   background.
8. **Fallback.** A miss or an R2 error goes to the origin, and the origin's
   response comes back as it is. If the origin is unreachable: `502`.

The `x-uploads-source` header says which path answered: `r2`, `edge-cache`,
`origin`, `origin-error`, `deny` or `negative-cache`. Passed responses carry
none. `docs/ARCHITECTURE.md` has the modules, the data flow and every
design decision.

## The sync script

`scripts/sync-uploads.sh` runs on the origin and copies media into the
bucket with rclone. It copies and never deletes, copies only media
extensions, skips the private folders, and sets the content type by
extension.

```sh
scripts/sync-uploads.sh \
  --source /var/www/example.com/wp-content/uploads \
  --remote r2:your-bucket \
  --rclone /usr/local/bin/rclone \
  --max-age 30m
```

| Option                   | Default               | Meaning                                             |
| ------------------------ | --------------------- | --------------------------------------------------- |
| `--source <dir>`         | required              | The uploads directory                               |
| `--remote <name:bucket>` | required              | rclone remote and bucket                            |
| `--key-prefix <p>`       | `wp-content/uploads/` | Key prefix in the bucket; may be empty              |
| `--max-age <d>`          | none                  | Only files changed within this window (`90m`, `2h`) |
| `--dry-run`              | off                   | Show what would be copied                           |
| `--rclone <path>`        | `rclone`              | rclone binary                                       |
| `--min-version <v>`      | `1.63.0`              | Refuse an older rclone                              |
| `--extensions <list>`    | Worker default        | Media extensions to copy                            |
| `--deny <prefix>`        | none                  | Extra private folder to skip; repeatable            |

Exit codes: 0 success, 1 usage error, 2 rclone missing or too old, 3 copy failed.

Notes:

- Old distribution builds of rclone false-fail against R2. Install a
  current one and pass it by path.
- A token scoped to one bucket needs `no_check_bucket = true` in the rclone
  remote. See `examples/rclone.conf.example`.
- `examples/sync-uploads.cron` runs a short window every 10 minutes and a
  full pass nightly.

## Runbook

- **Is it R2 or the origin?** `curl -sI <url> | grep -i x-uploads-source`,
  or `examples/check-source.sh <url>`.
- **Spotting a sync gap.** Many `origin` sources for recent uploads in the
  logs (`wrangler tail`, or Workers Logs) mean the copier is behind or
  failing. Run the sync script by hand with `--dry-run` to see what it
  would copy.
- **A file was replaced under the same name.** Browsers keep the old one
  for the `max-age`. Purge the URL in the Cloudflare dashboard (this also
  clears the Worker's edge-cache copy when the Worker runs on a zone route),
  and prefer new file names.
- **Rolling back.** Remove the route (or the Worker). Uploads are served by
  the origin again at once. The bucket is left as it is.
- **Logs.** One JSON line per request: method, path (no query string),
  status, source, cache outcome, R2 outcome, duration. Errors are logged
  with `console.error`.

## Limitations

- Read-only: the Worker never writes to or deletes from R2.
- No image resizing or format conversion. Sizes WordPress makes on demand
  are served by the origin through fallback until they are synced.
- Single byte ranges only; multi-range requests get a full `200`.
- The edge cache is per data centre, and the Cache API does nothing on the
  default Workers subdomain. Test caching on a zone route.
- Objects stored with a `content-encoding` are served as stored but not
  written to the edge cache.
- No Unicode normalisation: keys must match the file names byte for byte.

## FAQ

**Why not rewrite the URLs in WordPress to point at R2?** Years of
published HTML, feeds and caches already hold the old URLs. Serving the
same URLs is complete on day one and needs no content change.

**What happens if R2 is down?** Every media request falls back to the
origin, as if the Worker were not there.

**Can someone read my personal-data exports through the Worker?** No. The
built-in deny list is checked on the decoded key, for every method, before
anything is read, and it cannot be switched off.

**Why does a `.php.jpg` file come back as an image?** Only the last
extension counts, and it is sent with an image content type and `nosniff`,
so a browser will not run it.

**Can I route the Worker on the whole zone?** Do not. Keep the route on the
uploads path; a zone-wide route makes the Worker a single point of failure
for the site.

## Licence

MIT. See [LICENSE](LICENSE). Contributions are welcome: see
[CONTRIBUTING.md](CONTRIBUTING.md).
