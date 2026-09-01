# Test Plan — Forge Browser Lab

Two suites: **pure engine unit tests** (no browser, fast, deterministic) and a
**real-Chromium e2e harness** on local fixtures only — no third-party websites
are contacted (blocked hosts are proven to never reach the network).

Run: `npm test` · `npm run test:e2e` · `npm run verify` → `results/gates.md`.

## Test A — Advertisement request

- Engine: `decideRequest(doubleclick / googlesyndication / GA)` → **BLOCK**.
- E2E `ad_tracking.html`: `<img src=doubleclick>` and `<script src=google-analytics>`
  never fire `onload`; first-party `/ok.png` does ⇒ browser-observed BLOCK.

## Test B — First-party cookie

- Unit: Set-Cookie from same origin → **ALLOW** (session + persistent in standard).
- E2E: server sets `forge_1p` on document; JS `document.cookie='session_js'`; both
  present in the real jar after load.

## Test C — Third-party cookie

- Unit: Set-Cookie from a different host → **BLOCK**.
- E2E: `127.0.0.2/3p.gif` (different loopback host) tries `partner=`; it is
  absent from the jar.

## Test D — Tracking URL

- Input `/article?id=10&utm_source=test` → `/article?id=10` (parameter list
  stripped, functional `id` kept) — both in unit and real navigation
  (`/clean.html?utm_source=…&fbclid=…&id=10` navigates to `…?id=10`).

## Test E — Prompt injection

- Fixture `prompt_injection.html` contains synthetic sample strings.
- Expected: agent view `untrusted:true`, `instruction_authority:false`,
  severity HIGH/CRITICAL, injected text still PRESENT in content, **no
  action executed** (nothing automated from the text).

## Test F — Agent tries to upload a file

- `requestAction('UPLOAD_FILE')` → verdict **APPROVAL REQUIRED** (ASK). Same for
  submit/post/purchase/delete/access-local-file.

## Test G — Password field

- `forms.html` password & card-number values are `<REDACTED>` in the agent view;
  a plain text field remains visible; the form is flagged ✓ for sensitive fields.

## Gate journal (dev procedure, Phase 28)

Gate A — Browser launches (real app → example.com, HTTPS). **PASS**
Gate B — Network interception (classification + policies unit/e2e). **PASS**
Gate C — Ad/tracker blocking. **PASS**
Gate D — Cookie policy. **PASS**
Gate E — Tracking URL cleanup. **PASS**
Gate F — Agent-safe content representation. **PASS**
Gate G — Prompt-injection warnings. **PASS**
Gate H — Action approval system. **PASS**
Gate I — Privacy dashboard. **PASS**
Gate J — Tests pass (unit + e2e), including offline YouTube plugin lifecycle. **PASS**
Gate K — Real page trust boundary (sandbox + isolation + no privileged globals). **PASS**

### Evidence files

| File | Contents |
|------|----------|
| `results/unit-results.json` | unit results, per-gate |
| `results/e2e-results.json` | real-Chromium Tests A–G + counters |
| `results/smoke-report.json` | real app example.com smoke |
| `results/gates.md` | composed gate table |

### Known regressions / run-to-verify

- Re-run `npm run verify` after touching any `src/engine/*` or
  `src/ext/electron-adapter.js` change.
- If a security-critical gate fails, fix it, re-run the suite, and obtain an
  independent clean re-read before declaring completion (fail-closed).

---
_See also README.md (How to run) and the docs for interpretation._
