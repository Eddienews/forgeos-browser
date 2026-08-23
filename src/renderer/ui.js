/*
 * ui.js — chrome window behavior: tab strip, address bar, mode select,
 * security badge, forget-on-close, control-center panel, clear session.
 */
'use strict';

(function () {
  const F = window.forge;
  const $ = (id) => document.getElementById(id);

  let state = null;

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

  /* ---------------- toolbar ---------------- */
  function bindButtons() {
    $('btn-newtab').addEventListener('click', () => F.newTab('about:blank'));
    $('btn-back').addEventListener('click', () => F.back());
    $('btn-fwd').addEventListener('click', () => F.forward());
    $('btn-reload').addEventListener('click', () => F.reload());
    $('btn-panels').addEventListener('click', () => F.togglePanels());
    $('btn-clear').addEventListener('click', async () => {
      if (window.confirm('Clear session?\nRemoves: history, cookies, site storage, cache, agent browsing context.')) {
        await F.clearSession();
      }
    });
    $('addr').addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && $('addr').value.trim()) {
        await F.navigate($('addr').value.trim());
      }
    });
    $('mode-select').addEventListener('change', (e) => F.setMode(e.target.value));
    $('forget-check').addEventListener('change', (e) => F.setForgetOnClose(e.target.checked));
  }

  function applyState(s) {
    state = s;
    renderTabs();
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    if (t) {
      $('addr').value = t.url === 'about:blank' ? '' : t.url;
      $('btn-back').disabled = !t.canGoBack;
      $('btn-fwd').disabled = !t.canGoForward;
      const badge = $('sec-badge');
      badge.textContent = t.security.label;
      badge.className = 'badge ' + (t.security.ok ? 'ok' : 'bad');
      $('forget-check').checked = t.forget;
    }
    $('mode-select').value = s.mode;
    $('modemeta').textContent = 'MODE — ' + s.modeSummary;
  }

  F.onState(applyState);
  bindButtons();
  F.getState().then((s) => { if (s) applyState(s); });
})();