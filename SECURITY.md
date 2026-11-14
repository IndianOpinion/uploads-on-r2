# Security policy

## Reporting a vulnerability

Email hello@indianopinion.org with "uploads-on-r2 security" in the subject.
Please do not open a public issue for a security problem.

Include what you found, how to reproduce it (a request and the response is
ideal), and the version or commit you tested. Leave out your own host,
bucket and account names.

## What to expect

- We acknowledge your report within 3 working days.
- We send a first assessment within 10 working days.
- We aim to ship a fix within 30 days for a confirmed issue, and we credit
  you in the release notes unless you ask us not to.

## Scope

In scope: anything that lets a request read a file the Worker should refuse
(private upload folders, non-media files, traversal), header injection,
cache poisoning through the Worker, and anything in the sync script that
could delete or expose files.

Out of scope: the security of your origin server, your Cloudflare account
settings, and files you choose to put in the bucket under a media extension.

## Supported versions

Only the latest release gets fixes.
