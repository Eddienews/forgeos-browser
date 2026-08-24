# ForgeOS Browser — Roadmap

Laboratory prototype · Electron/Chromium · local-first · zero telemetry.
Status legend: [x] done · [~] partial · [ ] planned · (v0.x) target version.

---

## v0.1 — Foundation ✅ (shipped)

- [x] Minimal browser: tabs, address bar, back/forward/reload, HTTPS badge
- [x] Single compact 42px bar (no native title bar); all settings in ⚙ menu
- [x] Privacy engine: request classification + policy (FIRST_PARTY/ADS/
      TRACKING/ANALYTICS/THIRD_PARTY)
- [x] EasyList + EasyPrivacy loaded via lists/*.txt (~110k rules)
- [x] Filter engine: suffix trie + lowercase-once (~µs/request worst case ~2.7ms
      pathological; options-only rules skipped; generic rules never block mainFrame)
- [x] Cookie policy: third-party blocked, tracking-cookie blocklist,
      persistent-by-mode
- [x] Tracking-parameter stripping on navigation (lists/tracking-params.json)
- [x] Storage isolation: per-tab never-persisted partitions in Strict/Ephemeral;
      Forget-this-site-on-close
- [x] Fingerprint hardening v1: generic Chrome UA, standardized screen/hardware
      (canvas/WebGL/fonts/audio remain engine-exposed — documented)
- [x] Permission handler: sensors ASK (DENY in strict), unknown DENY, nothing silent
- [x] Agent security layer: untrusted Agent View, sensitive-field redaction,
      prompt-injection scanner (advisory), action approval gate (read auto /
      act ASK / passwords HUMAN_ONLY)
- [x] Plugins: ⬇ video (yt-dlp ≤1080p mp4), ✎ transcript (auto .txt flatten),
      📁 open downloads folder
- [x] Download UX: persistent progress pill with % + completion toast
- [x] Local event log (logs/forge-events.log), zero telemetry (tested)
- [x] Packaging: electron-packager per-OS; portable zip; runtime dirs next to exe

## v0.2 — Settings maturity (current)

- [ ] Rename to ForgeOS Browser everywhere (window title, product name, exe,
      zip, UA string stays generic-Chrome)
- [ ] ⚙ Settings sections (replacing flat list):
  - [ ] Privacidade & Segurança:
    - [ ] Ad/tracker blocking toggle + live counters inline
    - [ ] Third-party cookies: Block (default) / Allow
    - [ ] Strip tracking parameters: On/Off
    - [ ] Fingerprint hardening: Standard / Reduced / Off
    - [ ] Site permissions summary (camera/mic/location → Ask/Deny global)
  - [ ] Downloads & Plugins:
    - [x] Show downloads folder path + open button (📁 already in bar)
    - [ ] yt-dlp status: found/not-found, path, "check for update" button
    - [ ] Preferred subtitle languages (en, pt, both) — feeds --sub-langs
  - [ ] Aparência:
    - [ ] Page zoom default (90/100/110%) persisted per app
  - [ ] Sessão & Dados:
    - [ ] Session history list (local only) + clear individual entries
    - [ ] Per-domain site data usage + "forget this domain" button
  - [ ] Sobre:
    - [ ] Version/engine info, links to THREAT_MODEL/PRIVACY_MODEL docs
    - [ ] Explicit "Telemetry: ZERO" badge
- [ ] Persist user settings (JSON next to exe / userData dir): mode, toggles,
      zoom, subtitle langs — survives restarts
- [ ] Settings apply live without restart where possible (blocking toggle =
      policy flag; cookies/params = flags consulted by the adapter)

## v0.3 — Blocking depth

- [ ] Cosmetic filtering research spike (element hiding needs renderer CSS
      injection — evaluate declarativeNetRequest-style scoping in Electron)
- [ ] $domain= multi-site option full support (currently partial)
- [ ] Custom filter rules UI (user can paste own ABP lines; stored locally)
- [ ] Allowlist per site ("disable blocking on this site") with one-click badge
- [ ] Turtlecute host-list merge option (covers remaining host checks)

## v0.4 — Fingerprint depth

- [ ] Canvas noise per-site (deterministic light noise in toDataURL/toBlob via
      page preload) — reduces hash stability across sites without breaking pages
- [ ] WebGL vendor/renderer mask (WEBGL_debug_renderer_info → generic ANGLE)
- [ ] AudioContext noise (light deterministic perturbation)
- [ ] Re-run coveryourtracks.eff.org before/after and record bits delta in
      results/BENCHMARK.md
- [ ] Do NOT randomize per-request (documented: increases uniqueness)

## v0.5 — Agent layer hardening

- [ ] Agent View: expose via local-only HTTP/IPC endpoint for external agents
      (localhost bind, token handshake, still behind permission gate)
- [ ] Prompt-injection scanner v2: section-aware scoring, fewer LOW false
      positives (benign "ignore the error" phrasing)
- [ ] Action gate: per-site memory of approved actions (optional, off by default)
- [ ] Mock agent v2: scripted multi-step task demo with approval checkpoints

## v0.6+ — Ideas parking lot

- [ ] Multi-profile sessions (separate cookie jars by named profile)
- [ ] Reader mode using the existing Agent View extraction
- [ ] Basic extensions story evaluation (Chromium MV3 in Electron — likely out
      of scope; document decision)
- [ ] macOS notarized build instructions + Linux AppImage target
- [ ] Auto-update of filter lists on launch (opt-in, direct fetch, no telemetry)

---

## Non-goals (stable)

- Not anonymous; no Tor/network-layer anonymity
- No CAPTCHA/anti-bot/auth bypass
- No telemetry, ever
- No engine fork; fingerprinting depth limited to what preload injection allows
- Not hardened against OS-level malware or Chromium 0-days

## Verification ritual (every release)

1. npm test            (unit, 87+)
2. npm run verify      (gates A–J composed)
3. adblock.turtlecute.org   → target ≥110/132
4. adblock-tester.com       → target ≥95/100
5. coveryourtracks.eff.org  → ads Yes / invisible Yes / fingerprint bits recorded
6. YouTube playback + CNN images render (over-blocking regression check)
7. Plugin round-trip: download video + transcript txt on a fresh tab
8. Repackage, run dist exe, repeat 3 & 6 quickly