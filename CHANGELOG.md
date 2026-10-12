# Changelog

## [Unreleased]

### Maintenance and trust
- Dependabot checks Electron and the build dependencies daily and opens pull requests.
- A nightly workflow fails when Electron is behind its release line, when the pinned major is unsupported, or when a high-severity advisory is published.
- Added `SECURITY.md` with private vulnerability reporting, scope, and response intentions.

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
