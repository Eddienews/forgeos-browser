# ForgeOS Browser — Engineering Backlog

This file records confirmed product defects that are not part of the change
currently in progress. An item remains open until its acceptance checks pass on
every supported host platform that the change affects.

## Plugin reliability

- [ ] **Repair YouTube video download and transcript flows.** Both toolbar
      actions are currently reported as non-functional. Diagnose the complete
      path from UI → approval dialog → `yt-dlp` resolution/spawn → progress
      events → output-file discovery and transcript conversion.

  Acceptance checks:

  - A supported YouTube watch URL downloads a playable video at the selected
    quality into the configured downloads directory.
  - Transcript mode produces at least one readable `.txt` file when YouTube
    subtitles or automatic captions are available.
  - Missing `yt-dlp`, unavailable captions, network failures, age/login gates,
    cancellation, and non-zero exits produce clear actionable UI errors.
  - The approval gate runs before any external process or network request.
  - Automated tests cover URL parsing, command construction, progress/error
    propagation, output discovery, and VTT-to-text conversion without contacting
    YouTube.
  - A manual round-trip is recorded for macOS, Windows, and Linux before the
    item is marked complete.

## Privacy hardening

- [ ] **Reintroduce configurable page fingerprint mitigation without weakening
      the page trust boundary or navigation reliability.** Prefer supported
      Chromium/Electron controls or an isolated, navigation-safe mechanism;
      do not restore an unsandboxed page preload.

  Acceptance checks:

  - Page views remain sandboxed, context-isolated, Node-disabled, and free of
    preload or chrome-bridge access.
  - Standard, reduced, and off settings have observable, documented behavior.
  - Repeated cross-document navigation remains reliable in every mode.
  - Canvas, WebGL, audio, screen, hardware, and navigator claims match measured
    behavior and never overstate protection.
  - Gate K remains green on supported Electron versions.
