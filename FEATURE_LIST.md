# ForgeOS Browser — Feature List

This is the canonical product backlog. Work should move in small, testable
increments. Status legend: `[x]` shipped, `[~]` in progress, `[ ]` planned.

## Now

- [x] **Download Center v1** — implemented in v0.10.0
  - Live progress, transfer speed, and estimated time for YouTube jobs.
  - Live progress for regular browser downloads.
  - Persistent in-session status for running, completed, failed, and cancelled
    downloads.
  - Cancel active jobs, retry failed YouTube jobs, open completed files, and
    reveal files in the operating-system file manager.
  - Keep every external download behind the existing human approval boundary.

## Next — Browser essentials

- [ ] Automatic update notification and an About ForgeOS page.
- [ ] Advanced tabs: reopen closed, pin, duplicate, mute, group, and restore the
  previous session.
- [~] Find in page with result count, Ctrl+F/F3 navigation and a chrome-owned search bar (feature branch; pending review).
- [ ] Site permission controls for camera, microphone, location, notifications,
  and clipboard access.
- [ ] Complete keyboard shortcut reference and command palette.
- [ ] Reader mode, print, save as PDF, and full-page screenshots.
- [ ] Side-by-side browsing and vertical tabs.

## Privacy and security

- [~] Per-site protection panel with live-origin counters and reversible host exceptions (feature branch; pending review).
- [ ] HTTPS-only mode and certificate details.
- [~] Clear current-origin storage; clear host-only cookies/cache only when the session is dedicated. Shared sessions preserve cookies/cache to avoid deleting another origin's data.
- [~] Named persistent Work, Personal and Research containers with distinct Electron sessions; banking/social names remain planned.
- [ ] Privacy-preserving phishing and lookalike-domain warnings.
- [ ] Exportable local security and permission report.

## AI with user control

- [ ] Ask questions about the current page with source references.
- [ ] Page summaries with short, detailed, outline, and plain-language modes.
- [~] Local human-curated research notebook with selected excerpts, URL/title/date provenance, comparison and text export; AI synthesis remains planned.
- [~] Browser-owned agent action preview before one-time approval, invalidated on changed observation, target or effect (feature branch; pending review).
- [ ] Agent permission levels: read only, navigate, and act with approval.
- [ ] Local model support through user-controlled providers such as Ollama or
  LM Studio; no cloud API required.
- [ ] ForgeOS MCP server with temporary capability tokens and an action audit
  trail.
- [ ] Prompt-injection detection v2 with highlighted evidence and blocked action
  inheritance.

## Media and transcripts

- [ ] Video quality and audio-only selection with size estimates.
- [ ] Transcript library with plain-text and timestamped views.
- [ ] Local speech-to-text for media without captions.
- [ ] Speaker identification and user-editable speaker names.
- [ ] Transcript translation while preserving the original.
- [ ] AI-assisted chapters, summaries, study notes, and tasks.
- [ ] Local media library with source, thumbnail, format, and compatibility
  metadata.

## Productivity

- [ ] Local notes, highlights, and read-later collections.
- [ ] Project workspaces containing tabs, notes, downloads, and research.
- [ ] Page translation through a user-selected local or remote provider.
- [ ] Encrypted opt-in synchronization between devices.

## Platform and distribution

- [ ] Signed and notarized macOS releases.
- [ ] Installers and update delivery for Windows and Linux.
- [ ] Set ForgeOS as the operating-system default browser.
- [ ] Secure operating-system keychain integration.
- [ ] Multiple named browser profiles.
- [ ] Controlled extension support evaluation.

## Product constraints

- No telemetry by default.
- No CAPTCHA, authentication, or anti-bot bypass.
- No silent agent actions with external side effects.
- No claim of anonymity or protection from operating-system malware.
- No feature may weaken the sandboxed, context-isolated page boundary.
