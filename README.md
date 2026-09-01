# ForgeOS Browser

**A private, local-first browser built for humans — and prepared for trusted AI agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build](https://github.com/Eddienews/forgeos-browser/actions/workflows/build.yml/badge.svg)](https://github.com/Eddienews/forgeos-browser/actions)
[![Tests](https://img.shields.io/badge/tests-94%20passing-brightgreen)](https://github.com/Eddienews/forgeos-browser/blob/main/tests/run-tests.js)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20·%20macOS%20·%20Linux%20·%20Pi-blue)](https://github.com/Eddienews/forgeos-browser/releases)
[![Telemetry](https://img.shields.io/badge/telemetry-zero-orange)](https://github.com/Eddienews/forgeos-browser/blob/main/PRIVACY_MODEL.md)

ForgeOS Browser is an educational, open-source study of what a browser should look like in the age of AI agents: a trust boundary between humans, websites, and autonomous agents. It is **not a production browser** and sends **zero telemetry**.

## Why it exists

Mainstream browsers treat AI as a surface feature. ForgeOS Browser treats the agent as a potentially untrusted entity that needs a structural containment wall:

- **Content is untrusted data** — every page is a sandboxed, unprivileged surface
- **Reading is automatic** — the agent can read
- **Acting requires human approval** — the agent proposes, the user disposes

## Features

- 🛡 **Ad/tracker blocking** — EasyList + EasyPrivacy (110k network rules, trie-optimized, ~µs/request) + cosmetic filtering (13k+17k rules, DOM removal)
- 🧬 **Fingerprint hardening** — canvas/audio/WebGL farbling per-origin (Brave-class), hardware/screen standardization, GPU vendor masking
- 🍪 **Cookie policy** — third-party cookies blocked, per-mode storage isolation (Standard/Strict/Ephemeral)
- 🚫 **Prompt-injection scanner** — advisory-only heuristic, never modifies page content
- 🔌 **Agent API** — localhost-only, capability-token-gated HTTP surface (read/navigate/full scopes, TTL, rate-limited) for external agents
- ⚙️ **Trust presets** — one decision releases a whole provider ecosystem (Google, Microsoft, Apple, Social), reversible
- 🔐 **No-credentials policy** — identity-provider sign-in is intercepted with an honest notice; credentials stay in your main browser
- 🕵️ **Zero telemetry** — nothing leaves the machine, ever

## Security model

See [SECURITY_MODEL.md](SECURITY_MODEL.md), [THREAT_MODEL.md](THREAT_MODEL.md), [PRIVACY_MODEL.md](PRIVACY_MODEL.md), [ARCHITECTURE.md](ARCHITECTURE.md).

**Central rule:** the agent's reads are automatic; any state-changing action requires human approval.

## Benchmarks

Measured vs Brave/Chrome/Edge on the same machine (see [results/BENCHMARK.md](results/BENCHMARK.md)):

| Test | ForgeOS | Brave | Chrome | Edge |
|---|---|---|---|---|
| adblock-tester (0-100) | **95** | 96 | 77 | 48 |
| turtlecute (/132) | **94** | ~83 | 30 | 9 |
| CYT canvas/audio/WebGL | **randomized** | randomized | exposed | exposed |
| Telemetry | **zero** | minimal | massive | massive |

## Build & run

```bash
npm install
npm start                 # dev
npm test                  # 94 unit tests
npm run package           # electron-packager for host platform
node scripts/make-portable.js   # portable zip
# cross-platform: node scripts/package.js --platform=linux,darwin --arch=x64,arm64
```

Portable mode: place a `.portable` marker file next to the executable to keep runtime data local.

### Run on each platform

**Windows**
```bash
# Option A — dev
npm install && npm start
# Option B — packaged exe
npm run package
dist\ForgeBrowserLab-win32-x64\ForgeBrowserLab.exe
# Option C — portable zip (no install, runs from USB)
node scripts/make-portable.js
# unzip dist\ForgeBrowserLab-portable-win32-x64.zip → run ForgeBrowserLab.exe
```

**macOS**
```bash
npm install && npm start
# packaged app:
npm run package
open dist/ForgeBrowserLab-darwin-x64/ForgeBrowserLab.app   # Intel
open dist/ForgeBrowserLab-darwin-arm64/ForgeBrowserLab.app # Apple Silicon
```
Unsigned CI builds: first launch via right-click → Open → Open.

**Linux (x64)**
```bash
npm install && npm start
npm run package
./dist/ForgeBrowserLab-linux-x64/forge-browser-lab
```

**Raspberry Pi (arm64, Pi 4/5)**
```bash
npm install && npm start
npm run package -- --platform=linux --arch=arm64
./dist/ForgeBrowserLab-linux-arm64/forge-browser-lab
```
> armv7l (32-bit Pi) is NOT supported — Electron dropped 32-bit ARM. Use a 64-bit OS (Raspberry Pi OS arm64).

### CI builds (no local compile)

Every version tag (`v0.8.7`, …) triggers GitHub Actions to build all 5 targets:
Windows x64 · macOS x64/arm64 · Linux x64/arm64.
Download from: **Actions → latest run → Artifacts**.

## Architecture

```
src/
├── main.js               Electron shell (window, tabs, WebContentsView)
├── engine/               pure, testable core
│   ├── filter-engine.js      network blocking (suffix trie)
│   ├── cosmetic-engine.js    element-hiding rules
│   ├── fingerprint*.js       hardening + farbling
│   ├── agent-view.js         untrusted-context boundary
│   ├── credential-policy.js  no-credentials gate
│   └── ...                 17 modules total
├── ext/
│   ├── electron-adapter.js  webRequest + cookie policy wiring
│   ├── agent-api.js         localhost capability API
│   └── plugins.js           yt-dlp integrations
└── renderer/              single-bar walnut-glass UI
```

## Disclaimer

**Educational laboratory prototype.** Not a production browser. Not an anonymity tool (see THREAT_MODEL "Out of Scope"). Some identity providers block embedded Chromium; ForgeOS Browser does not pretend to be Chrome — credentials belong in your main browser.

## License

MIT — see [LICENSE](LICENSE). Contributions welcome: issues, PRs, and threat-model reviews.
