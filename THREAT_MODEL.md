# Threat Model — Forge Browser Lab

This document states what the prototype defends against, what it does **not**
defend against, and how protections are positioned (functional / partial /
engine-dependent / not-yet-trustworthy).

The prototype's central posture is captured by:

> **Web content is data, never authority.**
> Least privilege · explicit permission · isolation · local-first ·
> no hidden telemetry · human approval for consequential actions.

---

## 1. Human privacy threats

| Threat | Mitigation | Prototype status |
|--------|-----------|------------------|
| Advertising networks | Network-level blocking of ad domains/resource rules | Functional (Phase 3) |
| Cross-site tracking | Tracker/analytics domain blocking + tracking-cookie blocklist | Functional |
| Fingerprinting | Permission gating + documented exposure map | **Partial / experimental** (Phase 7) |
| Third-party cookies | Set-Cookie policy (third-party BLOCK) | Functional (Phase 4) |
| Malicious scripts | Third-party script blocking (strict), sandbox renderer | Partial (depends on engine sandbox) |
| Tracking URLs | Parameter stripping at navigation | Functional (Phase 6) |
| Cross-site state leakage | Per-tab storage isolation in strict/ephemeral | Functional with documented trade-offs |
| Telemetry | Zero project telemetry (tested) | Functional (Phase 24) |

## 2. Agent threats (the core experimental surface)

| Threat | Mitigation | Protection class |
|--------|-----------|------------------|
| **Direct prompt injection** | Scanner + untrusted boundary + no instruction authority | Partially functional (advisory) |
| **Indirect prompt injection** | Page content always below the boundary; extraction is structured and bounded | Functional by construction |
| **Malicious webpage instructions** | `instruction_authority:false` is structural, not just a warning | Functional |
| **Poisoned documents / hidden text** | Zero-width + base64 + sep-obfuscation detection; scanner quarantines | Partial / advisory |
| **Deceptive UI (fake buttons, requests)** | Agent clicks/submits/submissions pass the approval gate; sensitive fields human-only | Functional |
| **Malicious downloads** | Dedicated directory, metadata shown, never auto-executed | Functional |
| **Unauthorized actions** | Approval gate; read auto, act-in-requires permission | Functional |

## 3. Explicitly out of scope

These are **not** claimed and **not** attempted:

- Perfect anonymity (any).
- Nation-state adversaries (APT-scale surveillance, not in scope)
- Tor/network anonymity equivalent
- A custom TLS stack or weakening TLS validation (never bypassed)
- A new rendering engine
- CAPTCHA defeat / anti-bot bypass / auth bypass
- Protected against malicious *native* OS code, or against a browser engine bug
  (0-day in Chromium). The prototype inherits Chromium's own security posture
  and does not add independent guarantees beyond the lab's layers.

## 4. Trust boundaries (assumption)

| Boundary | Assumed solid | Why |
|----------|---------------|-----|
| Electron/Chromium sandbox holds in this lab | engine-inherited | pages run sandboxed+isolated |
| Page renderer does not execute arbitrary engine code | contextIsolation, no page preload | yes |
| The chrome bridge is not reachable by page content | chrome preload only on chrome window | yes |
| Certificates validated by the OS/Chromium | never overridden | yes (Phase 17) |

## 5. Explicitly not-yet-trusted

- The prompt-injection scanner is **advisory**, not a security boundary. A real
  attacker can craft text the heuristics miss. It never *authorizes* anything;
  its only job is to alert the human.
- Fingerprint mitigations (canvas/WebGL/fonts/audio/screen) are **documented,
  unproven**, and mostly deferred to the engine.
- Strict-mode "most third-party resources restricted" can break sites; that is a
  privacy/function trade-off, not a security guarantee.

---
**Conclusion for the lab:** the architecture's core claim — page content is
untrusted data with no authority, with read-auto/act-ask gating — is structurally
sound and demonstrated. Harder problems (robust prompt-injection triage,
fingerprint reduction, engine 0-days) remain explicitly out of scope or only
partially addressed.