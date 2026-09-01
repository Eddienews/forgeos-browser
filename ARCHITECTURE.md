# Architecture — Forge Browser Lab

The prototype is intentionally small and auditable. Its value is the **security
and privacy model**, not feature count (Phase 29: do not overengineer).

```
┌────────────────────────────────────────────┐
│             Forge Browser Lab              │
├────────────────────────────────────────────┤
│ Minimal Browser UI                         │
│   Tabs · Address Bar · Back/Fwd/Reload     │
│   Security/Privacy Indicator               │
├────────────────────────────────────────────┤
│ Privacy Policy Engine                      │
│   Ad Blocking · Tracker Blocking · Cookie  │
│   Policy · Tracking-Parameter Removal ·    │
│   Storage Isolation                        │
├────────────────────────────────────────────┤
│ Agent Security Layer                       │
│   Untrusted Content Boundary · Prompt-     │
│   Injection Detection · Agent Content      │
│   Extraction · Action Approval Gate        │
├────────────────────────────────────────────┤
│ Browser Engine / WebView  (Electron)       │
├────────────────────────────────────────────┤
│ OS Sandbox                                  │
└────────────────────────────────────────────┘
```

## Design rule

> **Web content is data, never authority.**

A webpage may contain text that *looks* like an instruction, but it must never
automatically become an instruction to an AI agent. Every page-derived value is
marked untrusted; instruction authority is structurally impossible for page
content because the agent policy/user task/system prompt live above the boundary
and are never derived from the page.

## Components

### 1. Browser UI (`src/renderer/*`, chrome window in `src/main.js`)

A single chrome window owns the toolbar (tab strip, address bar, back/forward/
reload, security badge, mode selector, forget-on-close, panel toggles). Each tab
is an Electron **`WebContentsView`** child composited below the toolbar.

- Page tabs run with `sandbox:true, contextIsolation:true, nodeIntegration:false`
  and no preload. Page content cannot reach the engine, filesystem, other tabs,
  credentials, or the OS. The production app and E2E harness share the same
  canonical web-preferences factory, enforced by Gate K.
- The chrome window's own preload exposes only the whitelisted `window.forge`
  bridge (`src/preload.js`). Untrusted content can never call it.

### 2. Privacy engine (`src/engine/*`, pure, no Electron)

| module | responsibility |
|--------|----------------|
| `classify` engine (`filter-engine.js` + `network-policy.js`) | request → FIRST_PARTY/THIRD_PARTY/ADVERTISING/TRACKING/ANALYTICS/UNKNOWN → ALLOW/BLOCK |
| `filter-engine.js` | compact domain sets + Adblock-format rule parser (EasyList subset, `@@` exceptions) |
| `cookie-policy.js` | Set-Cookie decisions (first-party ALLOW / third-party BLOCK / tracking BLOCK / persistent-by-mode) |
| `url-cleaner.js` | tracking-parameter stripping (list in `lists/tracking-params.json`) |
| `privacy-modes.js` | Standard/Strict/Ephemeral flag matrix |
| `storage-manager.js` | session partitioning plan + site-data clearing |
| `fingerprint.js` | exposure map + permission defaults (documented, experimental) |
| `event-log.js` | local audit log (bounded; sanitized; never leaves machine) |

### 3. Network interceptor (`src/ext/electron-adapter.js`)

Attached once per Electron session:

- `session.webRequest.onBeforeRequest` → classify → policy → `cancel` (BLOCK) or
  `redirectURL` (tracking-parameter cleanup on main-frame navigation).
- `session.webRequest.onHeadersReceived` → Strip disallowed `Set-Cookie` headers
  (third-party / tracking / persistent-blocked-by-mode).
- `session.setPermissionRequestHandler` → Phase 15 defaults: sensors asked-then-denied
  ask-then-deny in strict; nothing silently granted; unknown → DENY.
- `session.on('will-download')` → laboratory directory, metadata recorded, never
  auto-executed.

### 4. Cookie manager (`cookie-policy.js` + adapter)

Default (Standard): first-party session+persistent ALLOW, third-party BLOCK,
known tracking-cookie names BLOCK. Strict/Ephemeral: persistent BLOCK. Decisions
run on `Set-Cookie` headers at the network boundary, keeping the renderer clean.

### 5. Storage manager

Standard: shared default session (normal browser partitioning). Strict/Ephemeral/
Forget-on-close: **one dedicated, never-persisted session partition per tab**,
wiped on tab close (`clearStorageData` + cookie removal). This isolates
example-a.com state from example-b.com state and leaves no durable residue.
Documented limitation: same-site state does not share across tabs in these modes.

### 6. Agent security layer

- **Untrusted boundary** (`agent-view.js`): `IN_PAGE_SCRIPT` injects with
  `executeJavaScript`, returns a bounded structured snapshot (headings,
  paragraphs, links, tables, buttons, inputs, forms, bodyText). The analyzer
  re-checks sensitive redaction and runs the scanner. Output always carries
  `security.untrusted: true` and `security.instruction_authority: false`.
- **Sensitive fields** (`sensitive-fields.js`): password/cc/token/otp class;
  values REDACTED **in the page** and never cross the boundary; main re-checks
  as defense in depth.
- **Prompt-injection scanner** (`prompt-injection.js`): severity LOW–CRITICAL,
  advisory; quarantine = surfaced + flagged, text is never deleted.
- **Agent view** (`agent-view.js`): the JSON an agent may receive — never
  includes cookies, localStorage, tokens, filesystem, environment, or browser
  state.
- **Approval gate** (`permissions.js` + main): READ/NAVIGATE auto; ASK → native
  dialog; DENY never reaches automation; ENTER_PASSWORD is HUMAN_ONLY.

### 7. Agent integration interface (Phase 25)

`src/preload.js` `forge.agent` maps to IPC in `main.ts`:

```
navigate(url) · read_page() · get_links() · get_agent_view()
security_status() · click(selector) · request_action(action, details)
```

Mutating actions pass through the permission gate. A mock agent in the control
center drives these visibly (read, links, submit, upload, password, purchase).

### 8. History / clear session (Phase 16)

History is kept in-memory per tab (not synced/clouded). **Clear session**
wipes history, cookies, storage, caches, and agent browsing context, and reloads
tabs.

## Communication boundaries

```
chrome renderer ──preload/ipc──► main (approve, navigate, state)
main ──ipcRenderer.send──► chrome + panels (state, agent view, log, downloads)
main ──webContents.executeJavaScript──► page (untrusted extraction ONLY; never
       cookies/tokens; results come back as data)
normal page ──► webRequest ──► policy engine (block/clean/allow)
```

Boundaries that do **not** exist: page content never talks to the engine; page
content never reaches cookies/credentials/filesystem; the chrome bridge is the
only trusted channel, and only the chrome renderer (not page contents) holds
it.

## Do-not design

- No Chromium fork, no new render engine, no TLS override receiverer (certificate
  errors are never bypassed), no sandbox disabling, no weakening.

_See also: THREAT_MODEL.md, SECURITY_MODEL.md, PRIVACY_MODEL.md._
