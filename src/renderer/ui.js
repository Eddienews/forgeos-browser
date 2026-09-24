/*
 * ui.js — chrome window behavior: single compact bar (tabs + nav + address),
 * gear menu (mode / forget-on-close / panels / devtools / clear session).
 */
'use strict';

(function () {
  const F = window.forge;
  const $ = (id) => document.getElementById(id);
  document.body.classList.add(`platform-${F.platform || 'unknown'}`);

  let state = null;

  /* ---------------- native page find (chrome only) ---------------- */
  const findBar = $('find-bar');
  const findQuery = $('find-query');
  let findOpen = false;
  function updateFind(status) {
    findOpen = !!status.open;
    findBar.classList.toggle('hidden', !findOpen);
    if (!findOpen) findQuery.value = '';
    $('find-count').textContent = `${status.active || 0} / ${status.matches || 0}`;
  }
  async function openFind() {
    if (await F.findOpen()) {
      findQuery.focus();
      findQuery.select();
    }
  }
  function stepFind(direction) {
    if (!findOpen) { openFind(); return; }
    F.findSearch(findQuery.value, direction);
  }
  findQuery.addEventListener('input', () => F.findSearch(findQuery.value, 'forward'));
  $('find-next').addEventListener('click', () => stepFind('forward'));
  $('find-prev').addEventListener('click', () => stepFind('backward'));
  $('find-close').addEventListener('click', () => F.findClose());
  F.onFindResult(updateFind);
  F.onFindShortcut((action) => {
    if (action === 'open') openFind();
    else stepFind(action === 'previous' ? 'backward' : 'forward');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault(); openFind();
    } else if (e.key === 'F3' && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); stepFind(e.shiftKey ? 'backward' : 'forward');
    } else if (e.key === 'Enter' && document.activeElement === findQuery) {
      e.preventDefault(); stepFind(e.shiftKey ? 'backward' : 'forward');
    } else if (e.key === 'Escape' && findOpen) {
      e.preventDefault(); F.findClose();
    }
  });

  /* ---------------- gear menu ---------------- */
  const gearBtn = $('btn-gear');
  const gearMenu = $('gear-menu');

  function reserveSpaceFor(menu) {
    window.requestAnimationFrame(() => {
      if (!menu || menu.classList.contains('hidden')) return;
      const rect = menu.getBoundingClientRect();
      F.setMenuOpen({
        open: true,
        rightInset: Math.ceil(window.innerWidth - rect.left + 8),
      });
    });
  }

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
    if (opening) reserveSpaceFor(gearMenu);
    else F.setMenuOpen({ open: false });
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
      if (t.containerId) {
        const chip = document.createElement('span');
        chip.className = `container-chip container-${t.containerId}`;
        chip.textContent = { work: 'W', personal: 'P', research: 'R' }[t.containerId] || '?';
        chip.title = `${t.containerId} container`;
        el.appendChild(chip);
      }
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
  for (const btn of document.querySelectorAll('[data-container]')) {
    btn.addEventListener('click', async () => {
      const result = await F.newTab('about:blank', btn.dataset.container);
      if (result && result.error) showToast(result.error);
      else closeMenu();
    });
  }
  $('btn-back').addEventListener('click', () => F.back());
  $('btn-fwd').addEventListener('click', () => F.forward());
  $('btn-reload').addEventListener('click', () => F.reload());
  $('mi-panels').addEventListener('click', () => { closeMenu(); F.togglePanels(); });
  $('mi-notebook').addEventListener('click', () => { closeMenu(); F.togglePanels('notebook'); });
  $('mi-notebook-capture').addEventListener('click', async () => {
    closeMenu();
    try {
      const result = await F.notebook.capture();
      window.alert(result.duplicate ? 'Excerpt already in notebook.' : 'Excerpt saved locally. Open Research notebook to compare or export.');
    } catch (error) { window.alert('Capture refused: ' + error.message); }
  });
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
  $('mode-select').addEventListener('change', async (e) => {
    const select = e.target;
    const previousMode = state && state.mode;
    const nextMode = select.value;
    if (!previousMode || nextMode === previousMode) return;
    if (state.tabs.some(tab => tab.containerId)) {
      showToast('Close named container tabs before changing privacy mode.');
      select.value = previousMode;
      return;
    }
    const hasLoadedPages = state.tabs.some((tab) => tab.url && tab.url !== 'about:blank');
    if (hasLoadedPages && !window.confirm(
      'Changing privacy mode reloads all open pages so the new storage isolation can take effect.\n\n' +
      'Unsaved form entries may be lost. Existing data from the previous mode is not deleted; use Clear session to remove it.',
    )) {
      select.value = previousMode;
      return;
    }
    select.disabled = true;
    try {
      const result = await F.setMode(nextMode);
      if (!result || !result.ok) { select.value = previousMode; showToast(result?.error || 'Mode change refused.'); }
      else closeMenu();
    } catch {
      select.value = previousMode;
    } finally {
      select.disabled = false;
    }
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
  $('set-subs').addEventListener('change', (e) => set('subtitleLangs', e.target.value));
  $('set-zoom').addEventListener('change', (e) => F.setZoom(Number(e.target.value)));

  // Live session counters, refreshed whenever state arrives.
  function renderCounters(s) {
    const el = $('live-counters');
    if (!el || !s || !s.session) return;
    const c = s.session;
    el.textContent = `This session: ${c.ads} ads · ${c.trackers} trackers · ${c.params} params · ${c.allowed} passed`;
  }

  function formatAuditBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return `${Math.round(n)} B`;
    return `${(n / 1024).toFixed(1)} KiB`;
  }

  function renderAuditHealth(s) {
    const el = $('audit-health');
    if (!el) return;
    const audit = s && s.audit;
    el.classList.remove('audit-ok', 'audit-bad');
    if (!audit || !audit.enabled) {
      el.textContent = 'Audit: disabled';
      el.classList.add('audit-bad');
      return;
    }
    if (!audit.healthy) {
      el.textContent = `Audit: attention required${audit.lastErrorCode ? ` · ${audit.lastErrorCode}` : ''}`;
      el.classList.add('audit-bad');
      return;
    }
    const rotation = audit.rotated ? 'rotation active' : 'rotation armed';
    el.textContent = `Audit: active · ${formatAuditBytes(audit.bytes)} / ${formatAuditBytes(audit.maxBytes)} · ${rotation}`;
    el.classList.add('audit-ok');
  }

  /* ---------------- site menu (badge click) ---------------- */
  const siteMenu = $('site-menu');
  const badgeEl = document.querySelector('.badge') || document.getElementById('security-badge');
  let siteMenuOrigin = '';
  function closeSiteMenu() { siteMenu.classList.add('hidden'); siteMenuOrigin = ''; }
  async function openSiteMenu() {
    const info = await F.sitePrivacy();
    if (!info) { closeSiteMenu(); return; }
    siteMenuOrigin = info.origin;
    $('site-menu-host').textContent = info.host;
    $('site-origin').textContent = info.origin;
    $('site-counts').textContent = `This page: ${info.counts.ads} ads · ${info.counts.trackers} trackers · ${info.counts.analytics} analytics`;
    $('site-session-counts').textContent = `Session: ${info.sessionCounts.ads} ads · ${info.sessionCounts.trackers} trackers · ${info.sessionCounts.allowed} passed`;
    $('site-allow-check').checked = info.allowed;
    $('site-cred-check').checked = info.credentialAllowed;
    $('site-result').textContent = info.credentialsGloballyAllowed ? 'Global credential policy is already disabled; this site switch cannot restore it.' : '';
    siteMenu.classList.remove('hidden');
    reserveSpaceFor(siteMenu);
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
  async function changeSiteException(kind, checked, control) {
    control.disabled = true;
    try {
      const info = await F.sitePrivacy();
      if (!info || info.origin !== siteMenuOrigin) throw new Error('Active site changed.');
      const r = await F.siteException(kind, checked);
      if (!r.ok) throw new Error(r.reason || 'Exception not changed.');
      await openSiteMenu();
      refreshBadge();
    } catch (error) {
      control.checked = !checked;
      $('site-result').textContent = String(error.message || error);
    } finally { control.disabled = false; }
  }
  $('site-allow-check').addEventListener('change', (e) => changeSiteException('blocking', e.target.checked, e.target));
  $('site-cred-check').addEventListener('change', (e) => changeSiteException('credentials', e.target.checked, e.target));
  $('site-clear').addEventListener('click', async () => {
    const button = $('site-clear'); button.disabled = true;
    try {
      const info = await F.sitePrivacy();
      if (!info || info.origin !== siteMenuOrigin) throw new Error('Active site changed.');
      const result = await F.siteClear();
      $('site-result').textContent = result.ok ? result.note : result.reason;
    } catch (error) { $('site-result').textContent = String(error.message || error); }
    finally { button.disabled = false; }
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
    const info = await F.sitePrivacy();
    const allowed = !!info?.allowed;
    badgeEl.classList.toggle('friendly', allowed);
    badgeEl.textContent = allowed ? 'FRIENDLY' : (badgeEl.dataset.secure || 'HTTPS');
  }

  // Hydrate controls from persisted settings + yt-dlp status line.
  F.getVersion().then((v) => {
    for (const id of ['ver', 'app-version']) {
      const el = $(id);
      if (el) el.textContent = 'v' + v;
    }
    document.title = `ForgeOS Browser v${v}`;
  }).catch(() => {});
  Promise.all([F.settingsGet(), F.ytdlpStatus()]).then(([s, yt]) => {
    if (s) {
      $('set-blockads').checked = s.blockAds !== false;
      $('set-3pcookies').checked = s.blockThirdPartyCookies !== false;
      $('set-stripparams').checked = s.stripTrackingParams !== false;
      if (s.subtitleLangs) $('set-subs').value = s.subtitleLangs;
    }
    const el = $('ytdlp-status');
    if (!yt) { el.textContent = 'yt-dlp: not found'; return; }
    if (!yt.found) {
      el.textContent = 'yt-dlp: not found — ' + (yt.hint || 'install it and restart');
    } else if (!yt.ready) {
      el.textContent = `yt-dlp found · missing: ${(yt.missing || []).join(', ')}`;
    } else {
      el.textContent = `yt-dlp ready · ${yt.jsRuntime || 'JS runtime'} + FFmpeg`;
    }
  }).catch(() => {});

  /* ---------------- agent inference key (Settings → AI Agent) ----------------
   * The key never comes back into the renderer: we render its STATUS only, and
   * the field is cleared the moment it is saved. A key supplied through the
   * environment is shown but not editable here. */
  function renderAgentKey(st) {
    const statusEl = $('agent-key-status');
    if (!statusEl) return;
    const input = $('agent-key-input');
    const clearBtn = $('mi-agent-key-clear');
    if (!st || !st.configured) {
      statusEl.textContent = 'TypeSafe (Jev): not configured — the offline decider is used';
      statusEl.className = 'menu-hint';
      if (input) { input.disabled = false; input.value = ''; input.placeholder = 'sk-…'; }
      if (clearBtn) clearBtn.disabled = true;
      return;
    }
    statusEl.textContent = `${st.providerLabel || 'TypeSafe'} (Jev): configured ${st.hint || ''}` +
      (st.source === 'env' ? ' · from environment' : '');
    statusEl.className = 'menu-hint key-ok';
    const editable = st.editable !== false;
    if (input) {
      input.value = '';
      input.disabled = !editable;
      input.placeholder = editable ? 'replace key…' : 'set by FORGE_TYPESAFE_API_KEY';
    }
    if (clearBtn) clearBtn.disabled = !editable;
  }

  function refreshAgentKey() {
    return F.agentKeyStatus().then(renderAgentKey).catch(() => {});
  }

  function agentKeyMsg(text, ok) {
    const el = $('agent-key-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'menu-hint ' + (ok ? 'key-ok' : 'key-bad');
  }

  function saveAgentKey() {
    const input = $('agent-key-input');
    const btn = $('mi-agent-key-save');
    const key = input ? input.value.trim() : '';
    if (!key) { agentKeyMsg('Paste a key first.', false); return; }
    if (btn) btn.disabled = true;
    F.agentKeySet('typesafe', key).then((r) => {
      if (btn) btn.disabled = false;
      if (r && r.ok) {
        if (input) input.value = ''; // clear only on success
        agentKeyMsg(`Saved ${r.hint || ''} — /task now decides with Jev.` +
          (r.warning ? ` Note: it ${r.warning}` : ''), true);
        refreshAgentKey();
      } else {
        // Keep what was pasted: nobody should have to retype a key to fix it.
        agentKeyMsg(`Not saved: ${(r && r.reason) || 'unknown error'}.`, false);
      }
    }).catch(() => { if (btn) btn.disabled = false; agentKeyMsg('Could not reach the browser process.', false); });
  }

  const saveKeyBtn = $('mi-agent-key-save');
  if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveAgentKey);
  const keyInput = $('agent-key-input');
  if (keyInput) keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveAgentKey(); });
  const clearKeyBtn = $('mi-agent-key-clear');
  if (clearKeyBtn) clearKeyBtn.addEventListener('click', () => {
    clearKeyBtn.disabled = true;
    F.agentKeyClear().then((r) => {
      clearKeyBtn.disabled = false;
      if (r && r.ok) {
        agentKeyMsg('Key removed — back to the offline decider.', true);
        refreshAgentKey();
      } else {
        agentKeyMsg((r && r.reason) || 'Could not remove the key.', false);
      }
    }).catch(() => { clearKeyBtn.disabled = false; });
  });
  refreshAgentKey();

  /* ---------------- plugins: ⬇ video / ✎ transcript ---------------- */
  // Persistent progress pill (bottom-right): shows while a job runs.
  let progressEl = null;
  let currentJobId = null;
  let pluginBusy = false;
  function showProgress(label) {
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.id = 'plug-progress';
      progressEl.innerHTML = '<div class="pp-head"><span class="pp-label"></span><button class="pp-cancel" type="button">Cancel</button></div><div class="pp-bar"><div class="pp-fill"></div></div>';
      progressEl.querySelector('.pp-cancel').addEventListener('click', async () => {
        if (!currentJobId) return;
        progressEl.querySelector('.pp-cancel').disabled = true;
        progressEl.querySelector('.pp-label').textContent = 'Cancelling…';
        await F.pluginCancel(currentJobId);
      });
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
    currentJobId = null;
    pluginBusy = false;
    if (progressEl) {
      const finishedEl = progressEl;
      progressEl = null;
      finishedEl.classList.remove('show');
      setTimeout(() => finishedEl.remove(), 400);
    }
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
    if (pluginBusy) { showToast('A download job is already running.'); return; }
    const t = state && state.tabs.find((x) => x.id === state.activeTabId);
    if (!t || !/^https?:/i.test(t.url || '')) {
      showToast('Open a video page first.');
      return;
    }
    pluginBusy = true;
    closeMenu();
    showProgress(kind === 'video' ? '⬇ Downloading video…' : '✎ Fetching transcript…');
    setProgress(-1);
    F.plugin(kind).then((r) => {
      if (r && r.state === 'error') { hideProgress(); showToast('⚠ ' + r.error); }
      else if (r && r.state === 'denied') { hideProgress(); showToast('✕ Action denied.'); }
      else if (r && r.state === 'started' && pluginBusy) {
        currentJobId = r.jobId;
        F.togglePanels('downloads');
      }
    }).catch((e) => { hideProgress(); showToast('⚠ ' + String(e)); });
  }
  $('btn-dlvideo').addEventListener('click', () => runPlugin('video'));
  $('btn-transcribe').addEventListener('click', () => runPlugin('transcript'));
  $('btn-downloads').addEventListener('click', () => { closeMenu(); F.togglePanels('downloads'); });

  F.onPluginEvent?.((evt) => {
    if (!evt) return;
    switch (evt.state) {
      case 'running':
        currentJobId = evt.jobId;
        break;
      case 'progress':
        setProgress(evt.pct, [
          `${evt.kind === 'transcript' ? '✎' : '⬇'} ${Math.round(evt.pct)}%`,
          evt.speed,
          evt.eta ? `ETA ${evt.eta}` : null,
        ].filter(Boolean).join(' · '));
        break;
      case 'done':
        hideProgress();
        showToast(evt.kind === 'transcript'
          ? (evt.warning
              ? '✓ Transcript saved; some requested languages were unavailable'
              : '✓ Transcript saved as text — click 📁 to open')
          : '✓ Video saved — click 📁 to open', 6000);
        break;
      case 'error':
        hideProgress();
        showToast('⚠ Failed: ' + evt.error, 6000);
        break;
      case 'denied':
        hideProgress();
        showToast('✕ Denied.');
        break;
      case 'cancelled':
        hideProgress();
        showToast('✕ Download cancelled.');
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
      $('forget-check').disabled = !!t.containerId;
      $('forget-check').title = t.containerId ? 'Shared container data is retained until Clear session' : '';
    }
    $('mode-select').value = s.mode;
    for (const btn of document.querySelectorAll('[data-container]')) btn.disabled = s.mode !== 'standard';
    $('mode-hint').textContent = MODE_HINTS[s.mode] || '';
    renderCounters(s);
    renderAuditHealth(s);
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

  /* Agent-action approval is NOT rendered in this window.
   * The chrome HTML layer is always covered by the native WebContentsView
   * (the page), so an overlay here would be invisible. Instead the main
   * process loads src/renderer/agent-approval.html INTO the active tab when
   * the agent requests a navigation — the human approves/denies there, and
   * the decision returns via the forge-decision:// interception in main. */
})();
