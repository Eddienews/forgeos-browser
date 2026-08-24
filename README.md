# Forge Browser Lab

**v0.4.0** · Windows · macOS · Linux · Raspberry Pi · Electron/Chromium · educational, non-commercial, **laboratory prototype**.

A minimal browser built to study **two simultaneous security goals**:

1. **Protect the human** from tracking, advertising, unnecessary cookies, and cross-site data leakage.
2. **Protect AI agents** from malicious or manipulative content encountered while browsing.

> ⚠️ **This is not a production browser.** It is not designed to replace Chrome,
> Firefox, Brave, Safari, or Tor. Passing its own laboratory tests says nothing
> about real-world security. It is *not* secure, *not* anonymous, and *not*
> privacy-certified. See [THREAT_MODEL.md](THREAT_MODEL.md) "Out of Scope".

---

## What it is

A small browser shell (tabs, address bar, back/forward/reload, security badge)
over Chrome via Electron's `WebContentsView`, with three layers:

1. **Privacy policy engine** — network-level request classification, ad/tracker
   blocking, a cookie policy, tracking-parameter stripping, per-tab storage
   isolation, and three privacy modes (Standard / Strict / Ephemeral).
2. **Agent security layer** — page content is *always* untrusted data; a
   structured Agent View with an explicit untrusted boundary; a prompt-injection
   scanner; an action-approval gate; redaction of sensitive fields.
3. **Local audit posture** — a local event log and **zero telemetry** created by
   this project.

## What it is NOT

- ❌ Not a Chromium fork or a new rendering engine.
- ❌ Not a tool to defeat CAPTCHA, bypass anti-bot protections, or bypass
  authentication controls.
- ❌ Not a surveillance tool: no telemetry, no history upload, no credential theft.
- ❌ Not for automatic uploads/form-submission of sensitive data.
- ❌ **Not verified** to be anonymous, secure against a determined adversary, or
  privacy-certified.

## Install

Requires **Node.js ≥ 18** and npm.

```sh
cd ForgeBrowserLab
npm install --save-dev electron   # one-time Electron runtime download (~150 MB)
```

## Launch

```bash
npm start          # or: npx electron .
```

Navigate with the address bar (e.g. `example.com`), press **☰ Panels** for the
control center: privacy dashboard, structured agent view, live event log,
downloads, and a mock-agent demo (Phase 25).

## Tests

```bash
npm test               # 87 pure-engine unit tests (Gates B–J), no network
npm run test:e2e       # real Chromium + local fixtures, Tests A–G
npm run verify         # compose Gates A–J from unit + e2e + smoke -> results/gates.md
```

## Layout

```
ForgeBrowserLab/
  README.md  ARCHITECTURE.md  THREAT_MODEL.md  PRIVACY_MODEL.md
  SECURITY_MODEL.md  TEST_PLAN.md
  src/
    main.js            # browser shell: tabs (WebContentsView), IPC, agent API, smoke
    preload.js         # chrome-only bridge; page WebContentsViews get NO preload
    renderer/          # minimal toolbar + control-center panels (rockets)
    engine/            # pure, browser-agnostic policy engine (unit-tested)
    ext/electron-adapter.js   # webRequest/cookies/permissions/downloads wiring
    lists/             # filter data maintained SEPARATELY from code
    agent/             # (mock agent demo boots from the control center)
  tests/
    unit/              # pure-engine suites (Gates B–J)
    e2e/               # real-Chromium integration harness (Tests A–G)
    pages/             # local HTML fixtures (no third-party traffic)
  downloads/           # laboratory download directory (runtime)
  logs/                # local event log (runtime, never leaves the machine)
  results/             # test/gate evidence (runtime)
```

## Architecture at a glance

```text
SYSTEM INSTRUCTIONS ─┐
USER TASK ───────────┼  authority (never page-derived)
AGENT POLICY ────────┘
────────────────────────────── UNTRUSTED WEB CONTENT BOUNDARY
PAGE CONTENT                (always untrusted: true; instruction authority: NONE)
```

The engine (src/engine/*) is pure logic with no Electron dependency, so every
policy decision is unit-testable. The Electron layer only wires it to real
network/session events. Full detail in [ARCHITECTURE.md](ARCHITECTURE.md).

## Known limitations

- **Referrer-based cookie attribution** — a response with `Referer` stripped can
  be misclassified for third-party-cookie purposes.
- **Per-tab storage isolation** (Strict/Ephemeral) is stricter than a normal
  SameSite cookie jar: a login in one tab does not carry to another tab of the
  same site. This is a deliberate laboratory trade-off.
- **Fingerprint protections are advisory** — canvas/WebGL/font/audio/screen
  entropy is engine-dependent and *not* mitigated here (see SECURITY_MODEL.md).
- **Set-Cookie header parsing is approximate** (quoting edge cases out of scope).
- **Bundled filter lists are a compact starter**; run `npm run update-lists` to
  fetch full EasyList/EasyPrivacy as standalone data files.
- **No extension ecosystem** — this is a lab harness, not a browser product.

## Verification evidence

| Suite | Result |
|-------|--------|
| Unit (engine) | 87 passed / 0 failed |
| E2E (real Chromium, local fixtures) | Tests A–G all pass |
| Real-app smoke (example.com) | loads over HTTPS; agent view `untrusted:true` |
| Gates A–J | **all pass** — see `results/gates.md` |
| Telemetry created by this project | **zero** (tested + source-audited) |

---
_See also: [ARCHITECTURE](ARCHITECTURE.md) · [THREAT_MODEL](THREAT_MODEL.md) ·
[PRIVACY_MODEL](PRIVACY_MODEL.md) · [SECURITY_MODEL](SECURITY_MODEL.md) ·
[TEST_PLAN](TEST_PLAN.md)._

---

## OPEN SOURCE

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Raspberry%20Pi-lightgrey)
![Node](https://img.shields.io/badge/Node-%E2%89%A518-brightgreen)

Forge Browser Lab is released under the **MIT License** (see [LICENSE](LICENSE)).

### Contributing

This is an **educational laboratory prototype** — not a production browser. Contributions are welcome but **experimental in nature**. Before submitting a pull request:

- Run `npm test` to confirm all 87+ engine unit tests pass.
- Verify your changes respect the existing security models (`THREAT_MODEL.md`, `SECURITY_MODEL.md`).
- Avoid introducing new runtime dependencies or telemetry.
- Keep the `src/engine/` layer pure (no Electron dependency) so it remains unit-testable.

### Educational / Research Disclaimer

This project is a **study of browser architecture, privacy policy engines, and agent-safe content boundaries**. It is not intended for:

- Bypassing CAPTCHA, anti-bot systems, or authentication controls.
- Surveillance, data collection, or credential harvesting.
- Replacing a general-purpose browser.

The authors provide this software **as-is** for educational and research purposes. Use at your own risk.