# Contributing to ForgeOS Browser

Thanks for wanting to help. This is a small, deliberately-scoped project — the
contribution bar is low, but the design bar is high. Read this before opening
your first PR.

## What we welcome

- **Bug reports** — clear reproduction steps, expected vs actual, platform/version.
  Screenshots or logs help a lot.
- **Threat-model reviews** — the most valuable contribution type. Read
  `THREAT_MODEL.md`, `SECURITY_MODEL.md`, `PRIVACY_MODEL.md` and break them.
- **Tests** — every fix ships with a test; new features ship with tests.
- **Docs** — especially platform-specific notes from real usage (macOS, Linux, Pi).
- **Small, focused code changes** — prefer 3 small PRs over 1 large one.

We are **not** looking for: new browsers to spoof, "make it look more like
Chrome" changes, telemetry of any kind, or scope creep beyond the educational
prototype positioning.

## The core rules (non-negotiable)

1. **Zero telemetry.** Nothing ever leaves the machine. No analytics, no
   phone-home, no crash reporters with remote endpoints.
2. **Content is untrusted.** Page content never gets privileges. The bridge
   (`window.forge`) exists only in the chrome window, never in page contexts.
3. **Read = automatic, act = approved.** Agent reads may be automatic; any
   state-changing action requires human approval. Do not weaken this.
4. **Honest boundaries, not invisible workarounds.** We do not disguise the
   browser as Chrome, do not fight anti-bot wars, and do not claim privacy
   features are anonymity.
5. **Blocklists are data, not code.** Filter lists live in `lists/` and are
   parsed by the engine; logic and data stay separate.

## Getting started

```bash
git clone https://github.com/Eddienews/forgeos-browser.git
cd forgeos-browser
npm install
npm start          # run the browser
npm test           # 94 unit tests
```

The engine (`src/engine/`) is pure Node and testable without Electron —
write tests in `tests/unit/`, run with `npm test`.

## Workflow

1. **Open an issue first** for anything non-trivial. Describe the problem or
   the design change; get a thumbs-up before writing a lot of code.
2. **Branch** from `main`: `git checkout -b fix/your-fix`.
3. **Commit small** with clear messages. Reference the issue: `Fixes #12`.
4. **Push** and open a PR against `main`.
5. **CI runs the unit tests** on your PR (Linux x64 + arm64 + Windows + macOS).
   Fix failures if any.
6. **Review**: `main` is protected — at least one approving review required.
   A maintainer will review within a few days.

## Code style

- Node 22, CommonJS (this project predates ESM; keep it consistent).
- 2-space indent, no semicolons is fine, `'use strict'` in engine modules.
- No new runtime dependencies without discussion (the dependency surface is
  intentionally tiny).
- Keep engine modules pure (no Electron imports) so they stay unit-testable.

## Testing

```bash
npm test                    # all unit tests
node tests/run-tests.js     # same thing, verbose
```

Every PR must keep **all** tests green. Add tests for new behavior:
- Engine logic → `tests/unit/*.test.js`
- End-to-end UI → `tests/e2e/` (see existing examples)

## Releasing

Maintainers only. Releases are tagged (`vX.Y.Z`); CI builds all 5 targets
(Windows x64, macOS x64/arm64, Linux x64/arm64) and we attach the portable
zips to the GitHub Release.

## Code of conduct

Be constructive. This project is a learning artifact and a public experiment;
dismissive or hostile review comments will be removed. Disagreement is welcome,
disrespect is not.

MIT License — by contributing you agree your work is released under it.
