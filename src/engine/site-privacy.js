'use strict';

// Never accept a renderer URL as authority. The caller must pass the live page URL.
function exactOrigin(url) {
  if (typeof url !== 'string' || /[\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.origin === 'null') return null;
    return u.origin;
  } catch { return null; }
}

function liveSiteUrl(tab) {
  const url = tab.wc.getURL();
  return tab.blockedCredentialNoticeUrl && url === tab.blockedCredentialNoticeUrl
    ? tab.blockedCredentialUrl : url;
}

function siteSnapshot(tab, allowed, credentialAllowed, sessionCounts) {
  if (!tab || tab.wc.isDestroyed() || tab.agentOwned || tab.closing) return null;
  const origin = exactOrigin(liveSiteUrl(tab));
  if (!origin) return null;
  const host = new URL(origin).hostname;
  return { origin, host, tabId: tab.id, allowed: allowed(host), credentialAllowed: !!credentialAllowed(host),
    credentialRisk: 'Allowing sign-in disables the no-credentials warning on this host; identity providers may still reject this browser.',
    counts: { ...(tab.siteCounts || tab.pageCounts) }, sessionCounts: { ...sessionCounts } };
}

function assertCurrent(tab, current, origin) {
  if (!tab || current() !== tab || tab.agentOwned || tab.closing || tab.wc.isDestroyed() || exactOrigin(liveSiteUrl(tab)) !== origin)
    throw new Error('Active human site changed; no data was cleared.');
}

// The cookie jar is host/path scoped, not origin scoped. Never invoke clearData
// with cookies: Chromium expands it to the registrable domain. Remove only
// host-only cookies when no other live origin in this session uses that host.
async function clearOriginData({ tab, current, tabs, session, confirm, dedicated }) {
  const origin = tab && !tab.agentOwned && exactOrigin(liveSiteUrl(tab));
  if (!origin) return { ok: false, reason: 'Open an HTTP(S) page in a human tab.' };
  const host = new URL(origin).hostname;
  const approved = await confirm(origin);
  if (!approved) return { ok: false, reason: 'Cancelled.' };
  try {
    assertCurrent(tab, current, origin);
    if (tab.wc.session !== session) throw new Error('Session changed; no data was cleared.');
    if (tabs.some(t => t !== tab && t.wc.session === session && !t.wc.isDestroyed() &&
      exactOrigin(liveSiteUrl(t)) && new URL(liveSiteUrl(t)).hostname === host && exactOrigin(liveSiteUrl(t)) !== origin))
      return { ok: false, reason: 'Another origin on this host shares cookies; close that tab first.' };
    // Obtain cookie inventory before mutation, so any lookup error fails closed.
    const cookies = await session.cookies.get({ url: origin + '/' });
    assertCurrent(tab, current, origin);
    // cookies.remove(url,name) also matches domain cookies with the same name.
    // Refuse ambiguous removals rather than deleting a sibling's domain cookie.
    const scoped = cookies.filter(c => c.hostOnly === true && c.domain.toLowerCase() === host &&
      !cookies.some(other => other !== c && other.name === c.name && !other.hostOnly));
    const sharedSession = !dedicated || tabs.some(t => t !== tab && t.wc.session === session);
    // The default session may contain closed tabs' cookies/cache too. Neither
    // cookie deletion (shared across schemes/ports) nor cache clearing is safe.
    await session.clearData({ origins: [origin], originMatchingMode: 'origin-in-all-contexts',
      dataTypes: [...(!sharedSession ? ['cache'] : []), 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL'] });
    let removed = 0;
    for (const c of sharedSession ? [] : scoped) {
      assertCurrent(tab, current, origin);
      await session.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, c.name);
      removed++;
    }
    return { ok: true, origin, cookiesRemoved: removed, sharedCookiesSkipped: cookies.length - removed,
      cacheCleared: !sharedSession,
      note: sharedSession ? 'Shared session: origin storage cleared; cookies and cache preserved to protect other origins.' :
        'Host-only cookies removed; domain cookies shared with sibling hosts preserved.' };
  } catch (error) { return { ok: false, reason: String(error.message || error) }; }
}

module.exports = { exactOrigin, siteSnapshot, clearOriginData };
