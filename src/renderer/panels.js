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
  document.querySelectorAll('#panel-nav button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#panel-nav button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('.sec').forEach((s) => s.classList.add('hidden'));
      $('sec-' + b.dataset.sec).classList.remove('hidden');
    });
  });

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
  function renderDownloads(list) {
    const body = $('d-table').querySelector('tbody');
    body.innerHTML = '';
    for (const d of list) {
      const tr = document.createElement('tr');
      if (d.executable) tr.className = 'exec';
      const cells = [
        d.executable ? d.filename + ' ⚠ unknown executable' : d.filename,
        d.source_domain || '—',
        d.size >= 0 ? (d.size / 1024).toFixed(0) + ' KB' : '—',
        d.content_type || '—',
        d.state,
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

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
    const list = state ? [d, ...(state.downloads || [])].slice(0, 20) : [d];
    renderDownloads(list);
  });

  Promise.all([F.getState(), F.getAgentView()]).then(([s, av]) => {
    state = s; renderPrivacy(s); renderDownloads(s.downloads || []);
    renderAgent(av);
  });
})();