/*
 * update-check.js — is a newer ForgeOS Browser release available?
 *
 * A browser left on an old engine is exposed to every vulnerability fixed
 * since, so the browser asks once a day whether a newer release exists and
 * tells the user. It never downloads or installs anything.
 *
 * What leaves the machine: one HTTPS request to the public GitHub API for this
 * project's latest release. It carries no cookie, no identifier, no version
 * and no usage data; GitHub sees the IP address and a fixed User-Agent, as any
 * visit to the project page would show. The user can turn it off.
 *
 * What comes back is untrusted: only a strictly parsed version number is used.
 * The page offered to the user is built here, never taken from the response.
 */
'use strict';

const REPOSITORY = 'Eddienews/forgeos-browser';
const FEED_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 512 * 1024;

function parseVersion(text) {
  const match = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,5})$/.exec(String(text == null ? '' : text).trim());
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(candidate, current) {
  for (let i = 0; i < 3; i += 1) if (candidate[i] !== current[i]) return candidate[i] > current[i];
  return false;
}

/** The only page ever offered: this project's own release page for that version. */
function releasePageUrl(version) {
  const parsed = parseVersion(version);
  return parsed ? `https://github.com/${REPOSITORY}/releases/tag/v${parsed.join('.')}` : null;
}

/**
 * Compare the running version with a release description.
 * @returns {{available: boolean, latest: string|null, url: string|null}}
 */
function assessRelease(currentVersion, release) {
  const none = { available: false, latest: null, url: null };
  const current = parseVersion(currentVersion);
  if (!current || !release || typeof release !== 'object' || release.draft === true || release.prerelease === true) return none;
  const latest = parseVersion(release.tag_name);
  if (!latest) return none;
  const version = latest.join('.');
  return isNewer(latest, current) ? { available: true, latest: version, url: releasePageUrl(version) }
    : { available: false, latest: version, url: null };
}

/**
 * Ask the feed once.
 * @param {{currentVersion: string, fetchImpl?: Function, now?: Function, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, available: boolean, latest: string|null, url: string|null, checkedAt: string, error?: string}>}
 */
async function checkForUpdate({ currentVersion, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 10000 } = {}) {
  const checkedAt = now().toISOString();
  const failed = (error) => ({ ok: false, available: false, latest: null, url: null, checkedAt, error });
  if (typeof fetchImpl !== 'function') return failed('unavailable');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(FEED_URL, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ForgeOS-Browser-update-check' },
      signal: controller ? controller.signal : undefined,
    });
    if (!response || response.status === 404) return { ok: true, available: false, latest: null, url: null, checkedAt };
    if (!response.ok) return failed(`http ${Number(response.status) || 0}`);
    const text = await response.text();
    if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES) return failed('unexpected response');
    let release;
    try { release = JSON.parse(text); } catch { return failed('unexpected response'); }
    return { ok: true, ...assessRelease(currentVersion, release), checkedAt };
  } catch {
    return failed('network');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { REPOSITORY, FEED_URL, CHECK_INTERVAL_MS, parseVersion, assessRelease, releasePageUrl, checkForUpdate };
