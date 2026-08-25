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
    // Only restore the page when NO menu needs the reserved space.
    const siteOpen = siteMenu && !siteMenu.classList.contains('hidden');
    if (!siteOpen) F.setMenuOpen(false);
  }
  function toggleMenu() {
    const opening = gearMenu.classList.contains('hidden');
    gearMenu.classList.toggle('hidden', !opening);
    gearBtn.classList.toggle('open', opening);
    F.setMenuOpen(opening);
  }
  gearBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => {
    if (!gearMenu.contains(e.target)) closeMenu();
    const sm = document.getElementById('site-menu');
    if (sm && !sm.classList.contains('hidden') && !sm.contains(e.target) && e.target.id !== 'sec-badge') {
      sm.classList.add('hidden');
      F.setMenuOpen(false);
    }
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

  /* ---------------- settings v0.2 ---------------- */
  const set = (key, value) => F.settingsSet({ [key]: value });
  $('set-blockads').addEventListener('change', (e) => set('blockAds', e.target.checked));
  $('set-3pcookies').addEventListener('change', (e) => set('blockThirdPartyCookies', e.target.checked));
  $('set-stripparams').addEventListener('change', (e) => set('stripTrackingParams', e.target.checked));
  $('set-fingerprint').addEventListener('change', (e) => set('fingerprint', e.target.value));
  $('set-subs').addEventListener('change', (e) => set('subtitleLangs', e.target.value));
  $('set-zoom').addEventListener('change', (e) => F.setZoom(Number(e.target.value)));

  // Live session counters, refreshed whenever state arrives.
  function renderCounters(s) {
    const el = $('live-counters');
    if (!el || !s || !s.session) return;
    const c = s.session;
    el.textContent = `This session: ${c.ads} ads · ${c.trackers} trackers · ${c.params} params · ${c.allowed} passed`;
  }

  /* ---------------- site menu (badge click) ---------------- */
  const siteMenu = $('site-menu');
  const badgeEl = document.querySelector('.badge') || document.getElementById('security-badge');
  let siteMenuHost = '';
  function closeSiteMenu() { siteMenu.classList.add('hidden'); }
  async function openSiteMenu() {
    const t = state && state.tabs.find((x) => x.id === state.activeTabId);
    if (!t || !/^https?:/i.test(t.url || '')) return;
    try { siteMenuHost = new URL(t.url).hostname.replace(/^www\./, ''); } catch { return; }
    $('site-menu-host').textContent = siteMenuHost;
    const { allowed } = await F.allowIs(siteMenuHost);
    $('site-allow-check').checked = allowed;
    siteMenu.classList.remove('hidden');
    F.setMenuOpen(true);
    // keep page shrunk until both menus closed
    setTimeout(() => { if (siteMenu.classList.contains('hidden')) F.setMenuOpen(false); }, 0);
  }
  if (badgeEl) {
    badgeEl.style.cursor = 'pointer';
    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation(); // don't let the document click-outside handler fire
      closeMenu();         // close gear if open (without collapsing page)
      openSiteMenu();
    });
  }
  $('site-allow-check').addEventListener('change', async (e) => {
    if (e.target.checked) await F.allowAdd(siteMenuHost);
    else await F.allowRemove(siteMenuHost);
    refreshBadge();
  });

  /* Trust presets: one decision releases a whole provider ecosystem. */
  const PRESET_LABELS = {
    google: 'Google / YouTube / Drive',
    microsoft: 'Microsoft / Outlook',
    apple: 'Apple / iCloud',
    social: 'Redes sociais (FB, X, Insta...)',
  };
  async function renderPresets() {
    // Render into BOTH containers (site menu + gear menu).
    for (const listEl of [document.getElementById('preset-list'), document.getElementById('preset-list-gear')]) {
      if (!listEl) continue;
      try {
        const { available, active } = await F.presetsList();
        listEl.innerHTML = '';
        for (const p of available) {
          const isActive = !!active[p.name];
          const row = document.createElement('label');
          row.className = 'menu-row check';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = isActive;
          cb.addEventListener('change', async () => {
            if (cb.checked) await F.presetApply(p.name);
            else await F.presetRevoke(p.name);
            refreshBadge();
            renderPresets();
          });
          const span = document.createElement('span');
          span.textContent = `${PRESET_LABELS[p.name] || p.name} (${p.hosts})`;
          row.append(cb, span);
          listEl.append(row);
        }
      } catch {}
    }
  }
  renderPresets();
  async function refreshBadge() {
    if (!badgeEl) return;
    const t = state && state.tabs.find((x) => x.id === state.activeTabId);
    if (!t) return;
    let host = '';
    try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch {}
    const { allowed } = host ? await F.allowIs(host) : { allowed: false };
    badgeEl.classList.toggle('friendly', allowed);
    badgeEl.textContent = allowed ? 'FRIENDLY' : (badgeEl.dataset.secure || 'HTTPS');
  }

  // Hydrate controls from persisted settings + yt-dlp status line.
  F.getVersion().then((v) => { const el = $('ver'); if (el) el.textContent = 'v' + v; }).catch(() => {});
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
      if (!badge.classList.contains('friendly')) {
        badge.textContent = t.security.label;
      }
      badge.dataset.secure = t.security.label;
      badge.className = 'badge ' + (t.security.ok ? 'ok' : 'bad') + (badge.classList.contains('friendly') ? ' friendly' : '');
      $('forget-check').checked = t.forget;
    }
    $('mode-select').value = s.mode;
    $('mode-hint').textContent = MODE_HINTS[s.mode] || '';
    renderCounters(s);
    refreshBadge();
  }

  F.onState(applyState);
  bindButtons();
  function bindButtons() { /* reserved for future global shortcuts */ }
  F.getState().then((s) => { if (s) applyState(s); });

  // Refresh the bookmark star whenever the active tab changes. Declared here,
  // AFTER applyState exists (the star block above runs earlier in the file).
  const _applyStateOrig = applyState;
  applyState = function (s) { _applyStateOrig(s); refreshStar(); };
})();