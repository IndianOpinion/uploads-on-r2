## What and why

## How it was tested

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build` (dry run only)
- [ ] `bats test/sh` (if the sync script changed)

## Checklist

- [ ] Every behaviour change has a test that names the PRD case it covers
- [ ] README and `docs/ARCHITECTURE.md` updated if behaviour or configuration changed
- [ ] CHANGELOG entry under Unreleased
- [ ] No real host, bucket, zone or account names anywhere
