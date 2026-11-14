# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-14

### Added

- Cloudflare Worker that serves `GET` and `HEAD` for media under the
  WordPress uploads path from an R2 bucket, on the unchanged public URLs.
- Origin fallback on an R2 miss, an R2 error or a missing binding, with a
  loop guard header and an optional origin override for testing.
- Deny list on the decoded, lower-cased key (personal-data exports,
  WooCommerce logs and uploads, Contact Form 7 uploads), also under
  multisite `sites/<n>/`; operators can add prefixes but not remove them.
- Media extension allowlist; everything else goes to the origin untouched.
- Content type from stored metadata, corrected when missing, generic or
  able to run as a document or of another kind than the extension;
  `nosniff` everywhere and a sandboxing CSP on SVG.
- Conditional requests (`304` and `412`) in RFC 9110 order, and single
  byte ranges (`206` and `416`) including suffix ranges and `If-Range`.
- Edge caching through the Cache API (objects up to 64 MiB, only entries
  the Worker wrote are served), with ranges cut from a cached full copy,
  and a 60 second negative cache for repeated origin 404s.
- Browser cache policy per content-type family through a small map.
- One JSON log line per request, and a diagnostic source header.
- `scripts/sync-uploads.sh`: copy-only rclone wrapper with media filters,
  deny exclusions, content types by extension and an rclone version gate.

[Unreleased]: https://github.com/IndianOpinion/uploads-on-r2/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/IndianOpinion/uploads-on-r2/releases/tag/v0.1.0
