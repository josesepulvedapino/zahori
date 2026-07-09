# Security Policy

## Supported versions

Only the latest published version receives security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them privately via [GitHub Security Advisories](https://github.com/josesepulvedapino/zahori/security/advisories/new) and you will get a response as soon as possible.

Notes relevant to this project's threat model:

- zahori drives a real browser against untrusted web pages. It runs headless with a fresh, isolated browser context per run and never reuses your personal browser profile.
- Profiles can contain an `eval` step that runs JavaScript **inside the visited page** (not in Node). Only install profiles from sources you trust, the same way you treat any configuration that touches a browser.
- Resolved stream URLs may be signed and short-lived; zahori never stores them.
