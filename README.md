# uploads-on-r2

A Cloudflare Worker that serves the WordPress uploads path from an R2 bucket with origin fallback, correct content types, immutable cache headers, and a sync script for the origin. Media stops depending on the server.
