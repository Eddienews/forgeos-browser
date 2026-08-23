# Privacy Model — Forge Browser Lab

Describes the privacy-first defaults, the three modes, and exactly what each
claim means. **None of these modes is anonymity.**

## Global privacy defaults (Phase 15)

| Capability | Default | Behavior |
|-----------|---------|----------|
| Third-party cookies | **OFF** | BLOCK at Set-Cookie boundary |
| Telemetry | **OFF** | no project telemetry; tested zero |
| Usage analytics | **OFF** | analytics domains blocked |
| Crash upload | **OFF** | nothing configured; event log is local |
| Ad personalization | **OFF** | ads/analytics/trackers blocked |
| Location | ASK | permission handler → dialog (Deny in strict) |
| Camera | ASK | same |
| Microphone | ASK | same |
| Notifications | ASK | same |
| Clipboard read | ASK | same |
| Persistent site access | ASK | memory-in-strict defaults to per-purpose denies |

Nothing is silently granted. Unknown permission requests are **DENY**.

## 2. Cookie policy (Phase 4)

| Cookie class | Standard | Strict / Ephemeral |
|--------------|----------|--------------------|
| First-party session | ALLOW | ALLOW (in-session) |
| First-party persistent | ALLOW | BLOCK |
| Third-party (any) | BLOCK | BLOCK |
| Known tracking (any party) | BLOCK | BLOCK |
| Site data | kept | per-tab isolation / wiped on close |

**"Forget this site when closed"** uses a dedicated non-persist partition for
that tab; on close, its cookies, local storage, IndexedDB, caches, and
service-worker state are cleared.

## 3. Storage isolation (Phase 5)

- **Standard**: shared default session — normal browser SameSite partitioning.
- **Strict / Ephemeral / Forget-on-close**: one dedicated never-persisted
  partition per tab. Cross-site state is isolated; nothing survives the tab or
  (for strict/ephemeral) the app session.
- Documented limitation: same-site state does not share across tabs in these
  modes (a login in one tab won't carry to another). A deliberate lab trade-off.

## 4. Tracking-parameter removal (Phase 6)

Before navigation, known tracking parameters (`utm_*`, `fbclid`, `gclid`,
`msclkid`, …) are stripped **when safe** — functional parameters are preserved.
The parameter list lives in `lists/tracking-params.json`, separate from code.

## 5. Fingerprinting posture (Phase 7)

- Do not claim anonymity. Do not use naive per-request randomization (can be more
  identifying).
- What this prototype does: **permission gating** for privacy-relevant APIs, and
  a documented exposure map.
- What it **does not** do yet: reduce canvas/WebGL/font/audio/screen entropy.
  That is engine-dependent and marked **experimental**.

## 6. Modes (Phase 22) — NOT anonymity

```
Standard : ads+trackers blocked; 3P cookies blocked; persistent 1P cookies kept.
Strict   : + persistent cookies blocked; + most 3P resources restricted;
           + per-tab ephemeral-per-site storage + per-tab sessions.
Ephemeral: everything temporary; no history retained; session wiped on close.
```

Wording: modes reduce tracking; they are **not** anonymity ("Ephemeral" is not
Tor or proxy privacy) — reflecting THREAT_MODEL out-of-scope.

## 7. Local event log (Phase 23)

All events (`[BLOCK]`, `[CLEAN]`, `[WARN]`, `[ASK]`, `[DENY]`, …) are written to
`logs/forge-events.log` (and a bounded in-memory ring). Values are sanitized:
passwords/tokens/keys never appear. The log **never leaves the machine** and is
never synced.

## 8. No telemetry (Phase 24)

- The project ships no analytics/telemetry code; there are no network beacons.
- Dropping in an analytics SDK is not included.
- Vendor/engine requests (Chromium update channel) are **not** silenced; any that
  occur are documented rather than hidden.

---
_See also THREAT_MODEL.md (what we accept as out-of-scope) and
SECURITY_MODEL.md (agent-side boundaries)._