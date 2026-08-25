/*
 * credential-policy.js — v0.7: NO CREDENTIALS policy.
 *
 * Positioning decision (Eddie, 2026-08-25): ForgeOS Browser does not fight
 * the anti-bot war. Google/Microsoft et al. detect embedded Chromium faster
 * than we can spoof, and pretending to be Chrome puts us in an unwinnable
 * arms race that also weakens our honest privacy story.
 *
 * Policy: this browser is for private browsing and agent work. CREDENTIAL
 * LOGIN to major identity providers is BLOCKED by default — with a clear
 * in-page notice instead of a silent failure ("Couldn't sign you in").
 *
 * The user can still:
 *   - browse these sites read-only (allowlist presets keep content working)
 *   - explicitly opt in per-site via the site menu ("Allow sign-in here")
 *     if they accept the risk of anti-bot blocks.
 */
'use strict';

/** Identity/auth hosts where credential login is intercepted by default. */
const CREDENTIAL_HOSTS = [
  'accounts.google.com', 'accounts.youtube.com',
  'login.microsoftonline.com', 'login.live.com',
  'appleid.apple.com', 'id.apple.com',
  'facebook.com/login', 'www.facebook.com/login',
  'x.com/i/flow', 'twitter.com/i/flow',
  'linkedin.com/uas', 'www.linkedin.com/uas',
];

const NOTICE_HTML = (host) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sign-in blocked by policy</title>
<style>
  body { background:#16130f; color:#ece3d4; font-family: system-ui, sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:96vh; margin:0; }
  .card { max-width:560px; padding:40px; background:rgba(255,255,255,.03);
          border:1px solid rgba(236,227,212,.12); border-radius:12px; }
  h1 { font-size:20px; margin:0 0 14px; color:#ffaa3c; }
  p { line-height:1.6; font-size:14px; color:#c9c0b2; }
  code { background:rgba(255,170,60,.1); color:#ffaa3c; padding:2px 6px; border-radius:4px; }
</style></head>
<body><div class="card">
<h1>🔐 Sign-in blocked by your browser's policy</h1>
<p>ForgeOS Browser runs in <b>no-credentials mode</b>: it never logs into
identity providers (${host}), because their anti-bot systems block
alternative browsers and we will not pretend to be Chrome.</p>
<p>This protects you from half-working logins that leak partial session data.</p>
<p><b>To use accounts like Gmail/YouTube:</b> open them in your main browser.
ForgeOS stays for private browsing and agent work.</p>
<p style="opacity:.6;font-size:12px">You can allow sign-in per-site via the
HTTPS badge menu → "Allow sign-in on this site", if you accept the risk.</p>
</div></body></html>`;

function matchesCredentialHost(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return CREDENTIAL_HOSTS.some((entry) => {
      if (entry.includes('/')) {
        // path-qualified entry
        const [h, p] = entry.split('/');
        return (host === h || host.endsWith('.' + h)) && u.path.startsWith('/' + p);
      }
      return host === entry || host.endsWith('.' + entry);
    });
  } catch { return false; }
}

module.exports = { CREDENTIAL_HOSTS, NOTICE_HTML, matchesCredentialHost };