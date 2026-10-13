# Changelog

## [Unreleased]

### Added
- Per-site permission controls in the site panel: Ask, Allow, or Block for camera and microphone, location, notifications, and clipboard read. The permission prompt can also remember "Always allow" or "Never allow" for the site.
- A link that asks for a new window (`target="_blank"`, `window.open`) now opens as a ForgeOS tab in a human tab, right after user input. Previously it did nothing.
- Keyboard shortcuts: Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+R/F5, Alt+Left/Right, Ctrl+Tab, Ctrl+1–9, Ctrl+=/−/0, F11 and F12, from a page or from the toolbar.
- HTTPS-only mode, on by default: `http://` navigations are retried over `https://`. If the secure attempt fails you are asked before continuing over HTTP, per site, until the browser closes. Loopback, private addresses and local-network names are exempt. Toggle it in the settings menu.
- Print (Ctrl+P or the menu) and Save page as PDF.
- Update notice: installed builds ask GitHub once a day whether a newer release exists and mark the toolbar version when one does. The request carries no identifier, nothing is downloaded or installed, and it can be turned off in Settings.
- Reopen the last closed tab with Ctrl+Shift+T (up to 10). Remembered in memory only, never for agent, forget-on-close, Strict or Ephemeral tabs, and wiped by Clear Session and by a privacy-mode change.
- The browser is single-instance: a second launch, or a link opened from another application, becomes a new tab in the running browser.
- Linux: per-user installer (`npm run install:linux`) with launcher entry, icon, and optional default-browser registration. An application icon.

### Changed
- Client-hint headers repeat the brand list the engine reports to JavaScript (Chromium) and are sent only to secure origins. ForgeOS no longer claims to be Google Chrome. Set `identifyAsChrome: true` in the settings file if a sign-in page requires that claim.
- The Control Center demo click, which acts on the human's own page, always asks for confirmation.

### Fixed
- An agent tab could not load sites hosted in `192.0.0.0/16` outside the two reserved `/24` blocks, such as iana.org; the agent proxy refused them as non-public.
- An agent that opened its tab while the browser was still starting lost it as the visible tab, and every following agent call failed.
- Plugin job events were never written to the event log.

### Maintenance and trust
- Updated Electron to 44.7.0 (Chromium 152), the build tooling, and the pinned GitHub Actions.
- Dependabot checks Electron and the build dependencies daily and opens pull requests.
- A nightly workflow fails when Electron is behind its release line, when the pinned major is unsupported, or when a high-severity advisory is published.
- Added `SECURITY.md` with private vulnerability reporting, scope, and response intentions.

### Limits
- Remembered choices apply to the exact origin in the top-level page only, in Standard mode, and never to agent-owned tabs. Embedded frames always prompt.
- A site that checks a permission before requesting it still sees `denied` until you choose Allow, because the engine offers no "prompt" answer.
- Sites that require a Google Chrome identity, such as some Google sign-in pages, may refuse the browser unless `identifyAsChrome` is set.
- New tabs from links are refused without recent user input on that tab, and in agent tabs.

## [0.16.0] - 2026-09-24

### Added
- Native find in page with Ctrl+F, F3, Shift+F3, match count, and chrome-owned UI.
- Per-site privacy panel, explicit host exceptions, and origin-scoped storage clearing.
- Human-curated local research notebook with cited excerpts, comparison, text export, and query-distinguishing HMAC source fingerprints.
- Agent action preview tied to the observed target and private effect proof through one-time approval and execution.
- Named Work, Personal, and Research containers with separate persistent Electron sessions.

### Security and reliability
- Hardened agent redaction, action approval, network proxy, and transport boundaries.
- Rejected recognized structured and provider-prefixed credentials from notebook notes, titles, excerpts, persisted state, and export.
- Verified source-bound package members and portable ZIP contents across the five target build configurations.
- Permission checks now follow the same defaults as permission requests. Electron answered every check with "granted", so `navigator.permissions.query` and check-only APIs bypassed the policy, including in Strict mode. Pages now see `denied` until the user approves a site; serial, HID, and USB devices are never pre-granted.
- Every IPC channel refuses senders other than the toolbar and Control Center windows, which now run in their own session under a CSP without inline script.
- "Open" works only for inert document and media downloads; other files are reveal-only.
- Settings, history, bookmarks, and site exceptions are stored owner-only in the user-data directory (next to the executable only in portable mode); files from earlier builds are moved once.
- The User-Agent and `Sec-CH-UA-Platform` report the real operating system, matching what JavaScript exposes.
- Packaged builds disable the Electron `RunAsNode`, `NODE_OPTIONS`, and `--inspect` fuses and load the app only from `app.asar`.
- Updated Electron to 43.7.9, cleared `npm audit` findings in build dependencies, kept the inference key out of external tools' environment, and pinned GitHub Actions to commit SHAs.

### Limits
- Notebook credentials are blocked by recognized patterns, not a general-purpose secret detector. It does not send captured content to the agent by default.
- Shared-session origin clearing preserves cookies and cache where removal could affect other sites.
- Portable builds are unsigned; macOS signing/notarization and installed auto-updates are not included.
- The `Sec-CH-UA` brand list still names Google Chrome while JavaScript reports Chromium.
- The re-signed Apple Silicon bundle is packaged and verified in CI but has not been launched on a Mac.
