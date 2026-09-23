'use strict';
const { BrowserWindow, session } = require('electron');
const http = require('node:http');
const net = require('node:net');
const { createAgentSession, createAgentNetworkProxy } = require('../../src/engine/agent-network-proxy');
const { createPageWebPreferences } = require('../../src/page-web-preferences');
const pause = ms => new Promise(r => setTimeout(r, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

// Synthetic public DNS + test-only socket dial to a local fixture. Production
// never injects resolver/dial; the forbidden endpoint remains a distinct server.
async function runAgentProxyE2E(record) {
  let forbiddenHits = 0;
  const forbidden = http.createServer((_req, res) => { forbiddenHits++; res.end('FORBIDDEN'); });
  await listen(forbidden);
  const forbiddenUrl = `http://127.0.0.1:${forbidden.address().port}/secret`;
  let allowedHits = 0;
  const allowed = http.createServer((req, res) => {
    allowedHits++;
    if (req.url === '/redirect') { res.writeHead(302, { location: forbiddenUrl }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<a id="link" href="${forbiddenUrl}">Next</a>
      <form id="form" method="post" action="${forbiddenUrl}"><button>Send</button></form>
      <button id="js" onclick="location.href='${forbiddenUrl}'">JS navigation</button>
      <img src="${forbiddenUrl}/image">`);
  });
  await listen(allowed);
  const publicIp = '93.184.216.34';
  // A TURN/TCP peer is not an HTTP request. This synthetic listener is the
  // network boundary sentinel: a direct connection is a release-blocking leak.
  let turnTcpHits = 0;
  const turnTcp = net.createServer(socket => { turnTcpHits++; socket.destroy(); });
  await listen(turnTcp);
  let lease, agentWin, humanWin;
  const check = (name) => record('AGENT-PROXY', name, forbiddenHits === 0, `forbidden fixture hits=${forbiddenHits}`);
  try {
    lease = await createAgentSession({ session, proxyFactory: () => createAgentNetworkProxy({
      resolver: async host => host === 'public.test' ? [{ address: publicIp, family: 4 }] : [],
      dial: options => {
        const socket = net.connect({ host: '127.0.0.1', port: allowed.address().port });
        Object.defineProperty(socket, 'remoteAddress', { get: () => options.host });
        return socket;
      },
    }) });
    agentWin = new BrowserWindow({ show: false,
      webPreferences: createPageWebPreferences({ partition: lease.partition }) });
    const wc = agentWin.webContents;
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    record('AGENT-PROXY', 'agent WebRTC disallows non-proxied UDP',
      wc.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp', wc.getWebRTCIPHandlingPolicy());
    record('AGENT-PROXY', 'nonpersistent session, fixed proxy and forced loopback',
      !lease.session.isPersistent() && (await lease.session.resolveProxy(forbiddenUrl)) === `PROXY 127.0.0.1:${lease.port}`,
      `partition=${lease.partition}`);
    await wc.loadURL(forbiddenUrl).catch(() => {});
    const directBody = await wc.executeJavaScript('document.body?.innerText || ""').catch(() => '');
    record('AGENT-PROXY', 'forbidden response body never reaches renderer', !directBody.includes('FORBIDDEN'),
      `visible forbidden bytes=${directBody.includes('FORBIDDEN')}`);
    check('direct navigation denied');
    const base = `http://public.test:${allowed.address().port}`;
    const beforeRedirect = allowedHits;
    await wc.loadURL(`${base}/redirect`).catch(() => {});
    await pause(250);
    record('AGENT-PROXY', 'redirect source reached through pinned proxy', allowedHits > beforeRedirect,
      `source hits=${allowedHits - beforeRedirect}`);
    check('server redirect denied');
    for (const [name, script] of [
      ['link click', "document.querySelector('#link').click()"],
      ['form submit', "document.querySelector('#form').requestSubmit()"],
      ['JS navigation', "document.querySelector('#js').click()"],
    ]) {
      const beforePage = allowedHits;
      await wc.loadURL(`${base}/page`).catch(() => {});
      await pause(200);
      record('AGENT-PROXY', 'allowed page loaded for ' + name,
        allowedHits > beforePage && wc.getURL().startsWith(base),
        `source hits=${allowedHits - beforePage} url=${wc.getURL()}`);

      check('subrequest denied before ' + name);
      let triggered = true;
      await wc.executeJavaScript(script).catch(() => { triggered = false; });
      record('AGENT-PROXY', name + ' triggered', triggered, `triggered=${triggered}`);
      await pause(450);
      check(name + ' denied');
    }
    await wc.loadURL(`${base}/page`);
    const rtcScript = `new Promise(async resolve => {
      let candidateErrors = 0;
      const peer = new RTCPeerConnection({iceServers:[{
        urls:'turn:127.0.0.1:${turnTcp.address().port}?transport=tcp',
        username:'synthetic', credential:'synthetic'
      }]});
      peer.onicecandidateerror = () => { candidateErrors++; };
      peer.createDataChannel('synthetic');
      try { await peer.setLocalDescription(await peer.createOffer()); }
      catch (error) { peer.close(); resolve({ error: String(error) }); return; }
      setTimeout(() => { const state = peer.iceGatheringState; peer.close(); resolve({ state, candidateErrors }); }, 1800);
    })`;
    const rtcProbe = await wc.executeJavaScript(rtcScript);
    await pause(100);
    record('AGENT-TRANSPORT', 'agent WebRTC TURN/TCP cannot directly reach loopback',
      rtcProbe.state === 'complete' && rtcProbe.candidateErrors > 0 && turnTcpHits === 0,
      `direct TCP hits=${turnTcpHits}; probe=${JSON.stringify(rtcProbe)}`);
    await lease.stop();
    let down = false;
    try { await lease.assertReady(); } catch { down = true; }
    record('AGENT-PROXY', 'proxy down refuses agent action preflight', down, `refused=${down}`);
    const downError = await wc.loadURL(forbiddenUrl).then(() => null, e => e);
    record('AGENT-PROXY', 'down proxy navigation errors, not direct', !!downError, String(downError));
    check('proxy down has no direct fallback');
    humanWin = new BrowserWindow({ show: false, webPreferences: createPageWebPreferences({ partition: 'forge-e2e-human-' + Date.now() }) });
    await humanWin.loadURL(forbiddenUrl);
    record('AGENT-PROXY', 'human session navigation remains direct', forbiddenHits === 1, `human fixture hits=${forbiddenHits}`);
    const humanProbe = await humanWin.webContents.executeJavaScript(rtcScript);
    record('AGENT-TRANSPORT', 'human control reaches synthetic TURN/TCP listener',
      humanProbe.state === 'complete' && turnTcpHits > 0,
      `direct TCP hits=${turnTcpHits}; probe=${JSON.stringify(humanProbe)}`);
  } finally {
    if (agentWin) agentWin.destroy();
    if (humanWin) humanWin.destroy();
    if (lease) await lease.stop();
    await close(allowed);
    await close(forbidden);
    await close(turnTcp);
  }
}
module.exports = { runAgentProxyE2E };
