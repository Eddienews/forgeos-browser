/*
 * panels.js — control-center window: privacy dashboard, structured agent
 * view, event log, downloads, and the Phase 25 mock agent demo.
 */
'use strict';

(function () {
  const F = window.forge;
  const $ = (id) => document.getElementById(id);
  let state = null;
  let agentView = null;

  /* ---------------- section switching ---------------- */
  function activateSection(name) {
    const button = document.querySelector(`#panel-nav button[data-sec="${name}"]`);
    const section = $('sec-' + name);
    if (!button || !section) return;
    document.querySelectorAll('#panel-nav button').forEach((x) => x.classList.remove('active'));
    button.classList.add('active');
    document.querySelectorAll('.sec').forEach((s) => s.classList.add('hidden'));
    section.classList.remove('hidden');
  }

  document.querySelectorAll('#panel-nav button').forEach((b) => {
    b.addEventListener('click', () => activateSection(b.dataset.sec));
  });
  F.onPanelSection?.((name) => activateSection(name));

  /* ---------------- privacy dashboard ---------------- */
  function renderPrivacy(s) {
    const c = activeCounts(s);
    $('p-ads').textContent = c.ads;
    $('p-trackers').textContent = c.trackers;
    $('p-thirdparty').textContent = c.thirdParty;
    $('p-cookies').textContent = c.cookies;
    $('p-params').textContent = c.params;
    const inj = agentView && agentView.security ? agentView.security : null;
    $('p-injection').textContent = inj && inj.prompt_injection_detected
      ? inj.prompt_injection_severity + ' (' + inj.prompt_injection_findings.length + ' findings)'
      : 'None';
    $('p-storage').textContent = s.mode === 'standard'
      ? 'First-party only' : (s.mode === 'strict' ? 'Per-tab, session-only' : 'Per-tab, wiped on close');
    $('p-agent').textContent = 'Read-only (gated actions)';
    $('panel-mode').textContent = s.mode;
    if (s.privacyDefaults) {
      $('p-perms').textContent = Object.entries(s.privacyDefaults)
        .map(([k, v]) => k.padEnd(22) + v).join('\n');
    }
  }

  function activeCounts(s) {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t ? t.counts : { ads: 0, trackers: 0, analytics: 0, thirdParty: 0, params: 0, cookies: 0 };
  }

  /* ---------------- agent view ---------------- */
  function renderAgent(av) {
    agentView = av;
    if (!av) return;
    $('a-url').textContent = av.url || '—';
    $('a-title').textContent = av.title || '—';
    $('a-boundary').textContent = 'UNTRUSTED (page content is data, never authority)';
    $('a-auth').textContent = 'NONE';
    const sec = av.security;
    $('a-scan').textContent = sec.prompt_injection_detected
      ? sec.prompt_injection_severity + ' — ' + sec.prompt_injection_findings.map((f) => f.label).slice(0, 3).join('; ')
      : 'None';
    $('a-json').textContent = JSON.stringify(av, null, 2);
  }

  /* ---------------- event log ---------------- */
  function renderLog(payload) {
    if (!payload) return;
    $('e-log').textContent = payload;
  }

  /* ---------------- downloads ---------------- */
  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    const units = ['B', 'KB', 'MB', 'GB'];
    let amount = bytes;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
  }

  function downloadAction(label, action, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener('click', action);
    return button;
  }

  function renderDownloads(list) {
    const host = $('download-list');
    host.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'download-empty';
      empty.textContent = 'No downloads in this session yet.';
      host.appendChild(empty);
      return;
    }
    for (const d of list) {
      const card = document.createElement('article');
      card.className = 'download-card' + (d.executable ? ' exec' : '');

      const top = document.createElement('div');
      top.className = 'download-card-top';
      const name = document.createElement('div');
      name.className = 'download-name';
      name.textContent = (d.filename || (d.pluginKind === 'transcript' ? 'YouTube transcript' : 'Download'))
        + (d.executable ? ' ⚠ unknown executable' : '');
      name.title = d.filename || '';
      const status = document.createElement('span');
      status.className = `download-status state-${d.state || 'unknown'}`;
      status.textContent = d.state || 'unknown';
      top.append(name, status);
      card.appendChild(top);

      const metaParts = [d.source_domain || null];
      const received = formatBytes(d.received);
      const total = formatBytes(d.total) || d.totalLabel || formatBytes(d.size);
      if (received && total && d.state === 'running') metaParts.push(`${received} / ${total}`);
      else if (total) metaParts.push(total);
      if (d.speed) metaParts.push(d.speed);
      if (d.eta) metaParts.push(`ETA ${d.eta}`);
      const meta = document.createElement('div');
      meta.className = 'download-meta';
      meta.textContent = metaParts.filter(Boolean).join(' · ') || 'Preparing download…';
      card.appendChild(meta);

      const pct = Number(d.pct);
      if (Number.isFinite(pct) || d.state === 'running') {
        const progress = document.createElement('div');
        progress.className = 'download-progress';
        const fill = document.createElement('div');
        fill.className = 'download-progress-fill' + (Number.isFinite(pct) ? '' : ' indeterminate');
        fill.style.width = Number.isFinite(pct) ? `${Math.max(0, Math.min(100, pct))}%` : '30%';
        progress.appendChild(fill);
        card.appendChild(progress);
      }

      if (d.error || d.warning) {
        const message = document.createElement('div');
        message.className = d.error ? 'download-message error' : 'download-message warning';
        message.textContent = d.error || d.warning;
        card.appendChild(message);
      }

      const actions = document.createElement('div');
      actions.className = 'download-actions';
      if (d.cancellable) actions.appendChild(downloadAction('Cancel', () => F.downloadCancel(d.id), 'danger'));
      if (d.retryable) actions.appendChild(downloadAction('Retry', () => F.downloadRetry(d.id)));
      if (d.path && d.state === 'completed') {
        if (!d.executable) actions.appendChild(downloadAction('Open', () => F.downloadOpen(d.id)));
        const revealLabel = F.platform === 'darwin' ? 'Show in Finder'
          : F.platform === 'win32' ? 'Show in Explorer'
            : 'Show in folder';
        actions.appendChild(downloadAction(revealLabel, () => F.downloadReveal(d.id)));
      }
      if (actions.childElementCount) card.appendChild(actions);
      host.appendChild(card);
    }
  }
  $('downloads-folder').addEventListener('click', () => F.openDownloads());

  /* ---------------- bookmarks & history ---------------- */
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function fmtWhen(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  async function renderBookmarks() {
    const body = document.querySelector('#bm-table tbody');
    const items = await F.bmList();
    body.innerHTML = '';
    if (!items.length) { body.innerHTML = '<tr><td colspan="3" class="note">No bookmarks yet — press ★ in the toolbar.</td></tr>'; return; }
    for (const b of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(b.title)}</td><td class="mono">${esc(b.url.slice(0, 60))}</td>` +
        `<td><button data-del="${b.id}" title="Remove">✕</button> <button data-go="${esc(b.url)}" title="Open">↗</button></td>`;
      tr.querySelector('[data-del]').addEventListener('click', async () => { await F.bmRemove(b.id); renderBookmarks(); });
      tr.querySelector('[data-go]').addEventListener('click', () => F.navigate(b.url));
      body.appendChild(tr);
    }
  }
  $('bm-refresh') && $('bm-refresh').addEventListener('click', renderBookmarks);

  async function renderHistory() {
    const body = document.querySelector('#h-table tbody');
    const items = await F.histList();
    body.innerHTML = '';
    if (!items.length) { body.innerHTML = '<tr><td colspan="4" class="note">History is empty.</td></tr>'; return; }
    for (const h of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="mono">${esc(fmtWhen(h.visitedAt))}</td><td>${esc(h.title)}</td>` +
        `<td class="mono">${esc(h.url.slice(0, 55))}</td><td><button data-go="${esc(h.url)}" title="Open">↗</button></td>`;
      tr.querySelector('[data-go]').addEventListener('click', () => F.navigate(h.url));
      body.appendChild(tr);
    }
  }
  $('hist-clear') && $('hist-clear').addEventListener('click', async () => { await F.histClear(); renderHistory(); });

  // Re-render when the user opens those sections.
  document.querySelectorAll('#panel-nav button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.sec === 'bookmarks') renderBookmarks();
      if (b.dataset.sec === 'history') renderHistory();
    });
  });

  /* ---------------- mock agent demo (Phase 25) ---------------- */
  function fmt(v) {
    return JSON.stringify(v, null, 2);
  }

  const demos = {
    read: async () => {
      const v = await F.agent.readPage();
      return { action: 'read_page()', verdict: 'ALLOW', reason: 'read-only', data: v && { url: v.url, text: v.text.slice(0, 400) } };
    },
    links: async () => {
      const links = await F.agent.getLinks();
      return { action: 'get_links()', verdict: 'ALLOW', reason: 'read-only', data: links.slice(0, 10) };
    },
    click: async () => {
      const links = await F.agent.getLinks();
      const target = (links || []).find((l) => /^https?:/.test(l.href));
      const selector = 'a[href="' + (target ? target.href : '/') + '"]';
      const v = await F.agent.click(selector);
      return { action: 'click(link #1)', ...v };
    },
    submit: async () => {
      const v = await F.agent.requestAction('SUBMIT_FORM', { url: (state && state.tabs.find((t) => t.id === state.activeTabId) || {}).url });
      const r = { action: 'SUBMIT_FORM', verdict: v.verdict, reason: v.reason };
      if ('humanApproved' in v) r.humanApproved = v.humanApproved;
      return r;
    },
    upload: async () => {
      const v = await F.agent.requestAction('UPLOAD_FILE', { filename: 'notes.txt' });
      const r = { action: 'UPLOAD_FILE', verdict: v.verdict, reason: v.reason };
      if ('humanApproved' in v) r.humanApproved = v.humanApproved;
      return r;
    },
    password: async () => {
      const v = await F.agent.requestAction('ENTER_PASSWORD', {});
      return { action: 'ENTER_PASSWORD', verdict: v.verdict, reason: 'password entry is human-only — never exposed to the agent text context' };
    },
    purchase: async () => {
      const v = await F.agent.requestAction('PURCHASE', { url: 'https://shop.example/checkout' });
      const r = { action: 'PURCHASE', verdict: v.verdict, reason: v.reason };
      if ('humanApproved' in v) r.humanApproved = v.humanApproved;
      return r;
    },
  };

  document.querySelectorAll('.demo-actions button').forEach((b) => {
    b.addEventListener('click', async () => {
      const fn = demos[b.dataset.act];
      if (!fn) return;
      $('d-out').textContent = '… running';
      try {
        const r = await fn();
        $('d-out').textContent = fmt(r);
      } catch (e) {
        $('d-out').textContent = 'error: ' + String(e);
      }
    });
  });

  /* ---------------- wiring: forge events ---------------- */
  F.onState((s) => { state = s; renderPrivacy(s); renderDownloads(s.downloads || []); });
  F.onAgentView(({ agentView: av }) => renderAgent(av));
  F.onLog((payload) => renderLog(payload));
  F.onDownload((d) => {
    const list = state ? (state.downloads || []).filter((item) => item.id !== d.id) : [];
    list.unshift(d);
    if (state) state.downloads = list.slice(0, 20);
    renderDownloads(list.slice(0, 20));
  });

  Promise.all([F.getState(), F.getAgentView()]).then(([s, av]) => {
    state = s; renderPrivacy(s); renderDownloads(s.downloads || []);
    renderAgent(av);
  });
})();
