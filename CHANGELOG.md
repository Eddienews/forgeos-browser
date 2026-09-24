# Changelog

## [Unreleased]

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

### Limits
- Notebook credentials are blocked by recognized patterns, not a general-purpose secret detector. It does not send captured content to the agent by default.
- Shared-session origin clearing preserves cookies and cache where removal could affect other sites.
- Portable builds are unsigned; macOS signing/notarization and installed auto-updates are not included.
