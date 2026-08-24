/*
 * ui.js — chrome window behavior: single compact bar (tabs + nav + address),
 * gear menu (mode / forget-on-close / panels / devtools / clear session).
 */
'use strict';

(function () {
  const F = window.forge;
  const $ = (id) => document.getElementById(id);

  let state = null;

  /* ---------------- gear menu ---------------- */
  const gearBtn = $('btn-gear');
  const gearMenu = $('gear-menu');

  function closeMenu() {
    gearMenu.classList.add('hidden');
    gearBtn.classList.remove('open');
  }
  function toggleMenu() {
    const opening = gearMenu.classList.contains('hidden');
    gearMenu.classList.toggle('hidden', !opening);
    gearBtn.classList.toggle('open', opening);
  }
  gearBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => {
    if (!gearMenu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  /* ---------------- tab strip ---------------- */
  function renderTabs() {
    const host = $('tabs');
    host.innerHTML = '';
    if (!state) return;
    for (const t of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === state.activeTabId ? ' active' : '');
      el.title = t.url;
      const title = document.createElement('span');
      title.className = 't-title';
      title.textContent = t.title || t.url || 'blank';
      const x = document.createElement('button');
      x.className = 't-x';
      x.textContent = '×';
      x.addEventListener('click', (e) => { e.stopPropagation(); F.closeTab(t.id); });
      el.appendChild(title);
      el.appendChild(x);
      el.addEventListener('click', () => F.switchTab(t.id));
      host.appendChild(el);
    }
  }

  /* ---------------- actions ---------------- */
  $('btn-newtab').addEventListener('click', () => F.newTab('about:blank'));
  $('btn-back').addEventListener('click', () => F.back());
  $('btn-fwd').addEventListener('click', () => F.forward());
  $('btn-reload').addEventListener('click', () => F.reload());
  $('mi-panels').addEventListener('click', () => { closeMenu(); F.togglePanels(); });
  $('mi-devtools').addEventListener('click', () => { closeMenu(); F.openDevTools(); });
  $('mi-clear').addEventListener('click', async () => {
    closeMenu();
    if (window.confirm('Clear session?\nRemoves: history, cookies, site storage, cache, agent browsing context.')) {
      await F.clearSession();
    }
  });
  $('addr').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && $('addr').value.trim()) {
      await F.navigate($('addr').value.trim());
    }
  });
  $('mode-select').addEventListener('change', (e) => {
    F.setMode(e.target.value);
    closeMenu();
  });
  $('forget-check').addEventListener('change', (e) => F.setForgetOnClose(e.target.checked));

  /* ---------------- bookmark star ---------------- */
  const star = $('btn-star');
  async function refreshStar() {
    const t = state && state.tabs.find((x) => x.id === state.activeTabId);
    if (!t || !/^https?:/i.test(t.url || '')) { star.style.color = ''; star.title = 'Bookmark this page'; return; }
    try {
      const { bookmarked } = await F.bmIs(t.url);
      star.style.color = bookmarked ? 'var(--amber)' : '';
      star.title = bookmarked ? 'Bookmarked — click to remove' : 'Bookmark this page';
    } catch {}
  }
  star.addEventListener('click', async () => {
    const t = state && state.tabs.find((x) => x.id === state.activeTabId);
    if (!t || !/^https?:/i.test(t.url || '')) return;
    const { bookmarked } = await F.bmIs(t.url);
    if (bookmarked) {
      const items = await F.bmList();
      const hit = items.find((b) => b.url === t.url);
      if (hit) await F.bmRemove(hit.id);
      showToast('★ Removed from bookmarks');
    } else {
      await F.bmAdd({ title: t.title, url: t.url });
      showToast('★ Bookmarked', 2500);
    }
    refreshStar();
  });
  // refresh star whenever active tab changes
  const _applyStateOrig = applyState;
  applyState = function (s) { _applyStateOrig(s); refreshStar(); };

  /* ---------------- settings v0.2 ---------------- */
  const set = (key, value) => F.settingsSet({ [key]: value });
  $('set-blockads').addEventListener('change', (e) => set('blockAds', e.target.checked));
  $('set-3pcookies').addEventListener('change', (e) => set('blockThirdPartyCookies', e.target.checked));
  $('set-stripparams').addEventListener('change', (e) => set('stripTrackingParams', e.target.checked));
  $('set-fingerprint').addEventListener('change', (e) => set('fingerprint', e.target.value));
  $('set-subs').addEventListener('change', (e) => set('subtitleLangs', e.target.value));

  // Hydrate controls from persisted settings + yt-dlp status line.
  Promise.all([F.settingsGet(), F.ytdlpStatus()]).then(([s, yt]) => {
    if (s) {
      $('set-blockads').checked = s.blockAds !== false;
      $('set-3pcookies').checked = s.blockThirdPartyCookies !== false;
      $('set-stripparams').checked = s.stripTrackingParams !== false;
      $('set-fingerprint').value = s.fingerprint || 'standard';
      if (s.subtitleLangs) $('set-subs').value = s.subtitleLangs;
    }
    const el = $('ytdlp-status');
    if (!yt) { el.textContent = 'yt-dlp: not found'; return; }
    el.textContent = yt.found
      ? `yt-dlp ✓ ${yt.version || ''}`
      : 'yt-dlp: not found — ' + (yt.hint || '');
  }).catch(() => {});

  /* ---------------- plugins: ⬇ video / ✎ transcript ---------------- */
  // Persistent progress pill (bottom-right): shows while a job runs.
  let progressEl = null;
  function showProgress(label) {
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.id = 'plug-progress';
      progressEl.innerHTML = '<span class="pp-label"></span><div class="pp-bar"><div class="pp-fill"></div></div>';
      document.body.appendChild(progressEl);
    }
    progressEl.querySelector('.pp-label').textContent = label;
    progressEl.classList.add('show');
  }
  function setProgress(pct, label) {
    if (!progressEl) return;
    if (label) progressEl.querySelector('.pp-label').textContent = label;
    progressEl.querySelector('.pp-fill').style.width = (pct >= 0 ? pct : 8) + '%';
    progressEl.querySelector('.pp-fill').classList.toggle('indeterminate', pct < 0);
  }
  function hideProgress() {
    if (progressEl) { progressEl.classList.remove('show'); setTimeout(() => { if (progressEl) progressEl.remove(); progressEl = null; }, 400); }
  }

  const toast = document.createElement('div');
  toast.id = 'plug-toast';
  document.body.appendChild(toast);
  let toastTimer = null;
  function showToast(text, ms = 4000) {
    toast.textContent = text;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
  }

  function runPlugin(kind) {
    const t = state && state.tabs.find((x) => x.id === state.activeTabId);
    if (!t || !/^https?:/i.test(t.url || '')) {
      showToast('Open a video page first.');
      return;
    }
    closeMenu();
    showProgress(kind === 'video' ? '⬇ Downloading video…' : '✎ Fetching transcript…');
    setProgress(-1);
    F.plugin(kind).then((r) => {
      if (r && r.state === 'error') { hideProgress(); showToast('⚠ ' + r.error); }
      else if (r && r.state === 'denied') { hideProgress(); showToast('✕ Action denied.'); }
    }).catch((e) => { hideProgress(); showToast('⚠ ' + String(e)); });
  }
  $('btn-dlvideo').addEventListener('click', () => runPlugin('video'));
  $('btn-transcribe').addEventListener('click', () => runPlugin('transcript'));
  $('btn-downloads').addEventListener('click', () => { closeMenu(); F.openDownloads(); });

  F.onPluginEvent?.((evt) => {
    if (!evt) return;
    switch (evt.state) {
      case 'progress':
        setProgress(evt.pct, `⬇ ${Math.round(evt.pct)}%`);
        break;
      case 'done':
        hideProgress();
        showToast('✓ Saved to downloads/ — click 📁 to open', 6000);
        break;
      case 'error':
        hideProgress();
        showToast('⚠ Failed: ' + evt.error, 6000);
        break;
      case 'denied':
        hideProgress();
        showToast('✕ Denied.');
        break;
      default:
        break;
    }
  });

  const MODE_HINTS = {
    standard: 'Ads + trackers blocked · third-party cookies blocked · persistent first-party cookies allowed.',
    strict: '+ persistent cookies blocked · most third-party resources restricted · per-tab isolated storage.',
    ephemeral: 'Everything temporary · no history kept · session wiped on close. Not anonymous.',
  };

  let applyState = function (s) {
    state = s;
    renderTabs();
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    if (t) {
      if (document.activeElement !== $('addr')) {
        $('addr').value = t.url === 'about:blank' ? '' : t.url;
      }
      $('btn-back').disabled = !t.canGoBack;
      $('btn-fwd').disabled = !t.canGoForward;
      const badge = $('sec-badge');
      badge.textContent = t.security.label;
      badge.className = 'badge ' + (t.security.ok ? 'ok' : 'bad');
      $('forget-check').checked = t.forget;
    }
    $('mode-select').value = s.mode;
    $('mode-hint').textContent = MODE_HINTS[s.mode] || '';
  }

  F.onState(applyState);
  bindButtons();
  function bindButtons() { /* reserved for future global shortcuts */ }
  F.getState().then((s) => { if (s) applyState(s); });
})();