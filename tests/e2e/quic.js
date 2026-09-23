'use strict';
// Real Electron renderer comparison against one disposable loopback QUIC server.
const { app, BrowserWindow, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentSession } = require('../../src/engine/agent-network-proxy');
const { createPageWebPreferences } = require('../../src/page-web-preferences');

const KEYS = ['udp_packets', 'udp_bytes', 'quic_protocol_negotiated',
  'quic_handshake_completed', 'h3_webtransport_connect',
  'h3_webtransport_accepted', 'h3_datagrams'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validCounts(counts) {
  return counts && KEYS.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0);
}
function agentCountersClosed(afterHuman, afterAgent) {
  return validCounts(afterHuman) && validCounts(afterAgent) &&
    KEYS.every(key => afterAgent[key] - afterHuman[key] === 0);
}
function launchFixture(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FORGE_FIXTURE_PYTHON || 'python',
      ['-u', path.join(__dirname, 'quic-fixture', 'server.py'), directory],
      { cwd: directory, env: { ...process.env, PYTHONPATH: process.env.FORGE_QUIC_SITE || process.env.PYTHONPATH || '' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', done = false;
    const fail = error => { if (!done) { done = true; clearTimeout(timer); child.kill(); reject(error); } };
    const timer = setTimeout(() => fail(new Error('QUIC fixture readiness timed out: ' + errors)), 15000);
    child.on('error', fail);
    child.on('exit', (code, signal) => fail(new Error(`QUIC fixture exited ${code}/${signal}: ${errors}`)));
    child.stderr.on('data', chunk => { errors += chunk.toString().slice(0, 2048); });
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (!output.includes('\n')) return;
      const line = output.slice(0, output.indexOf('\n'));
      let ready;
      try { ready = JSON.parse(line); } catch (error) { fail(error); return; }
      if (ready.ready !== true || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535 ||
          !/^[0-9a-f]{64}$/.test(ready.certificate_sha256_hex)) {
        fail(new Error('Invalid QUIC fixture readiness')); return;
      }
      done = true; clearTimeout(timer); resolve({ child, ready });
    });
  });
}

async function probe(window, port, hash) {
  // The page receives only a public certificate digest and a loopback port.
  return window.webContents.executeJavaScript(`(async () => {
    const result = { secureContext: isSecureContext, webTransportType: typeof WebTransport };
    if (typeof WebTransport !== 'function') return result;
    let transport;
    try {
      transport = new WebTransport('https://127.0.0.1:${port}/fixture', {
        serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(${JSON.stringify([...Buffer.from(hash, 'hex')])}) }]
      });
      await Promise.race([transport.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('ready timeout')), 8000))]);
      result.ready = true;
      const reader = transport.datagrams.readable.getReader();
      const writer = transport.datagrams.writable.getWriter();
      await writer.write(new Uint8Array([7, 8, 9]));
      writer.releaseLock();
      result.datagramSent = true;
      const packet = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('datagram timeout')), 4000))]);
      result.datagramReceived = !packet.done && new TextDecoder().decode(packet.value) === 'ack';
      reader.releaseLock();
    } catch (error) { result.error = String(error); }
    finally { if (transport) transport.close(); }
    return result;
  })()`, true);
}

async function runQuicE2E(record) {
  const scratch = process.env.BH_AGENT_WORKSPACE ||
    path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'cache', 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratch, 'forge-quic-e2e-'));
  let child, humanWindow, agentWindow, lease;
  try {
    const fixture = await launchFixture(directory);
    child = fixture.child;
    const { port, certificate_sha256_hex: hash } = fixture.ready;
    const document = path.join(directory, 'control.html');
    fs.writeFileSync(document, '<!doctype html><title>Loopback QUIC test</title>');
    humanWindow = new BrowserWindow({ show: false,
      webPreferences: createPageWebPreferences({ partition: 'forge-quic-human-' + Date.now() }) });
    await humanWindow.loadFile(document);
    const human = await probe(humanWindow, port, hash);
    await sleep(300);
    const afterHuman = JSON.parse(fs.readFileSync(path.join(directory, 'metrics.json'), 'utf8'));
    const positive = child.exitCode === null && child.signalCode === null &&
      human.secureContext === true && human.webTransportType === 'function' &&
      human.ready === true && human.datagramSent === true && human.datagramReceived === true &&
      validCounts(afterHuman) && afterHuman.udp_packets > 0 &&
      afterHuman.quic_handshake_completed > 0 && afterHuman.h3_webtransport_connect > 0 &&
      afterHuman.h3_webtransport_accepted > 0 && afterHuman.h3_datagrams > 0;
    record('QUIC', 'human WebTransport handshake and datagram positive control', positive,
      JSON.stringify({ human, afterHuman }));
    // Never interpret a zero agent delta without a working positive control.
    if (!positive) throw new Error('QUIC positive control failed');
    lease = await createAgentSession({ session });
    agentWindow = new BrowserWindow({ show: false,
      webPreferences: createPageWebPreferences({ partition: lease.partition }) });
    agentWindow.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    await agentWindow.loadFile(document);
    const agent = await probe(agentWindow, port, hash);
    await sleep(300);
    const afterAgent = JSON.parse(fs.readFileSync(path.join(directory, 'metrics.json'), 'utf8'));
    const resolved = await lease.session.resolveProxy(`https://127.0.0.1:${port}/fixture`);
    const policy = agentWindow.webContents.getWebRTCIPHandlingPolicy();
    const closed = child.exitCode === null && child.signalCode === null &&
      agentCountersClosed(afterHuman, afterAgent) &&
      agent.secureContext === true && agent.webTransportType === 'function' &&
      agent.ready !== true && typeof agent.error === 'string' && agent.error.length > 0 &&
      resolved === `PROXY 127.0.0.1:${lease.port}` && policy === 'disable_non_proxied_udp';
    record('QUIC', 'agent partition has zero UDP/QUIC/H3 fixture deltas', closed,
      JSON.stringify({ agent, afterHuman, afterAgent, resolved, policy }));
  } catch (error) {
    record('QUIC', 'fixture setup and counter verification', false, String(error.stack || error));
  } finally {
    if (humanWindow && !humanWindow.isDestroyed()) humanWindow.destroy();
    if (agentWindow && !agentWindow.isDestroyed()) agentWindow.destroy();
    if (lease) await lease.stop();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => {
        child.once('exit', resolve);
        setTimeout(resolve, 3000);
      });
      child.kill();
      await exited;
    }
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (error) { record('QUIC', 'temporary fixture cleanup', false, String(error)); }
  }
}

module.exports = { runQuicE2E, agentCountersClosed, validCounts };
