/*
 * scripts/update-lists.js — Phase 3: refresh ad/tracker filter lists
 * independently of the application.
 *
 * Fetches EasyList and EasyPrivacy (public research sources) into
 * lists/*.txt in Adblock Plus format. The app's FilterEngine parses these
 * at startup and merges them over the compact bundled domain sets. This is
 * a MANUAL, opt-in, documented operation — run only when you intend to ship
 * refreshed data. No telemetry; the lists are data, not outbound calls.
 *
 *   node scripts/update-lists.js          (fetch both)
 *   node scripts/update-lists.js --dry    (report sizes only)
 *   node scripts/update-lists.js --local  (load existing txt, no network)
 *
 * Note: EasyList is ~100k lines. Running the full fetch downloads several
 * megabytes and prints counts. The prototype works fine without it (bundled
 * compact lists cover the common ad/tracker hosts).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const LIST_DIR = path.join(__dirname, '..', 'lists');
const SOURCES = [
  { name: 'easylist.txt', url: 'https://easylist.to/easylist/easylist.txt' },
  { name: 'easyprivacy.txt', url: 'https://easylist.to/easylist/easyprivacy.txt' },
];

function download(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const code = res.statusCode;
      if (code !== 200) { res.destroy(); return reject(new Error(`HTTP ${code} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeoutMs);
    req.on('error', (e) => reject(e));
  });
}

function countNonComment(text) {
  const lines = text.split('\n');
  return {
    total: lines.length,
    rules: lines.filter((l) => l.trim() && !l.startsWith('!') && !l.startsWith('#')).length,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

async function main() {
  fs.mkdirSync(LIST_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const dryOnly = args.includes('--dry') || args.includes('-d');

  for (const src of SOURCES) {
    const dest = path.join(LIST_DIR, src.name);
    const local = fs.existsSync(dest);
    if (args.includes('--local')) {
      if (!local) { console.log(`SKIP ${src.name} (not present locally)`); continue; }
      const c = countNonComment(fs.readFileSync(dest, 'utf8'));
      console.log(`LOCAL ${src.name}: ${c.total} lines, ${c.rules} rules, ${(c.bytes / 1024).toFixed(0)} KB`);
      continue;
    }
    if (dryOnly) {
      console.log(`DRY  ${src.name}: target ${src.url}`);
      continue;
    }
    try {
      console.log(`FETCH ${src.name} <- ${src.url} ...`);
      const body = await download(src.url);
      fs.writeFileSync(dest, body, 'utf8');
      const c = countNonComment(body);
      console.log(`OK   ${src.name}: ${c.total} lines, ${c.rules} rules, ${(c.bytes / 1024 / 1024).toFixed(2)} MB`);
    } catch (e) {
      console.log(`WARN ${src.name}: could not fetch (${e.message}). The compact bundled lists remain in effect.`);
    }
  }
  console.log('\nDone. Filter lists are read at app startup; restart Forge Browser Lab to load them.');
}

main().catch((e) => { console.error(e); process.exit(1); });