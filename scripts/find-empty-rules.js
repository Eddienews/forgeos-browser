/* find-empty-rules.js — locate filter lines that parse to an empty match body. */
'use strict';
const fs = require('fs');
for (const f of ['easylist.txt', 'easyprivacy.txt']) {
  for (const line of fs.readFileSync('lists/' + f, 'utf8').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('!') || l.startsWith('#') || l.includes('##')) continue;
    let r = l.startsWith('@@') ? l.slice(2) : l;
    const dollar = r.lastIndexOf('$');
    if (dollar !== -1) r = r.slice(0, dollar);
    let body = r;
    if (body.startsWith('||')) body = body.slice(2).replace(/\^/g, '');
    else if (body.startsWith('|')) body = body.slice(1).replace(/\^/g, '');
    else if (body.startsWith('/') && body.endsWith('/') && body.length > 2) continue;
    else body = body.replace(/\^/g, '').toLowerCase();
    if (body === '') console.log(f + ': ' + JSON.stringify(l));
  }
}