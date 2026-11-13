# Contributing

Thank you for helping. This is a small project with a narrow job, so the
bar is: correct HTTP, no new runtime dependencies, and a test for every
behaviour.

## Setup

You need Node 22.12 or later (Wrangler 4 requires it) and npm 10.

```sh
git clone https://github.com/IndianOpinion/uploads-on-r2.git
cd uploads-on-r2
npm ci
```

For the sync script tests you also need `bats` and, ideally, `shellcheck`.

## Tests

```sh
npm test            # vitest, inside the real Workers runtime (workerd)
npm run test:sh     # bats tests for scripts/sync-uploads.sh
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint and prettier --check
npm run build       # wrangler deploy --dry-run --outdir dist
npm run check       # all of the above except bats
```

`npm run build` is a dry run. It needs no Cloudflare login and talks to no
account. Never run a real `wrangler deploy` from this repository's CI.

Each test names the PRD case it covers (`T41`, and so on). A new behaviour
needs a new case in `docs/PRD.md` or a decision in `docs/ARCHITECTURE.md`,
and a test that names it.

## Style

- TypeScript `strict`, ES modules, no runtime dependencies.
- Prettier formats; eslint (typescript-eslint, strict type-checked) lints.
- No regular expression that can backtrack on request input.
- Never buffer a body. Stream it.
- British spelling in prose. Short sentences. No em dashes.

## Pull requests

- One topic per pull request. Keep the diff small.
- Fill in the template, including how you tested.
- Add a line to `CHANGELOG.md` under Unreleased.
- CI must be green.
- Never commit real host names, bucket names, zone names, account ids or
  tokens. `wrangler.toml` keeps its placeholders.

A sign-off line (DCO) is not required.
