/*
 * page-processing-policy.js — keep aggressive page processing away from
 * media playback surfaces where DOM mutation or a large automatic snapshot
 * can interfere with complex, rapidly changing player internals.
 *
 * Network filtering, cookie policy, cosmetic CSS and sandboxing remain active.
 * Only destructive DOM removal and automatic Agent View extraction are
 * deferred. A user-initiated Agent View refresh still works.
 */
'use strict';

const MEDIA_HOSTS = new Set([
  'youtube.com',
  'youtube-nocookie.com',
]);

function normalizedUrl(value) {
  try { return new URL(String(value || '')); } catch { return null; }
}

function isMediaPlaybackPage(value) {
  const url = normalizedUrl(value);
  if (!url || !/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!MEDIA_HOSTS.has(host)) return false;
  return url.pathname === '/watch'
    || url.pathname.startsWith('/shorts/')
    || url.pathname.startsWith('/live/');
}

function pageProcessingPolicy(value) {
  const mediaPlayback = isMediaPlaybackPage(value);
  return {
    mediaPlayback,
    allowDomRemoval: !mediaPlayback,
    allowAutomaticAgentView: !mediaPlayback,
  };
}

module.exports = { isMediaPlaybackPage, pageProcessingPolicy };
