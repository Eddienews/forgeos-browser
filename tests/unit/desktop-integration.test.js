'use strict';

/* Gate K — desktop behaviour that takes input from pages and other programs. */
const fs = require('fs');
const path = require('path');
const { shortcutAction, nextZoom, tabTarget, externalUrls, MAX_EXTERNAL_URLS } =
  require('../../src/engine/desktop-integration');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const key = (k, mods = {}) => ({ type: 'keyDown', key: k, ...mods });

module.exports = [
  {
    name: 'standard browser shortcuts map to actions',
    gate: 'K',
    fn(a) {
      const ctrl = { control: true };
      const expected = [
        [key('t', ctrl), 'new-tab'], [key('T', ctrl), 'new-tab'], [key('w', ctrl), 'close-tab'],
        [key('l', ctrl), 'focus-address'], [key('F6'), 'focus-address'], [key('d', { alt: true }), 'focus-address'],
        [key('r', ctrl), 'reload'], [key('F5'), 'reload'],
        [key('ArrowLeft', { alt: true }), 'back'], [key('ArrowRight', { alt: true }), 'forward'],
        [key('Tab', ctrl), 'next-tab'], [key('Tab', { control: true, shift: true }), 'previous-tab'],
        [key('PageDown', ctrl), 'next-tab'], [key('PageUp', ctrl), 'previous-tab'],
        [key('1', ctrl), 'tab-1'], [key('8', ctrl), 'tab-8'], [key('9', ctrl), 'last-tab'],
        [key('=', ctrl), 'zoom-in'], [key('+', { control: true, shift: true }), 'zoom-in'],
        [key('-', ctrl), 'zoom-out'], [key('0', ctrl), 'zoom-reset'],
        [key('F11'), 'fullscreen'], [key('F12'), 'devtools'], [key('I', { control: true, shift: true }), 'devtools'],
        [key('q', ctrl), 'quit'], [key('t', { meta: true }), 'new-tab'],
      ];
      for (const [input, action] of expected) a.strictEqual(shortcutAction(input), action, JSON.stringify(input));
    },
  },
  {
    name: 'ordinary typing and page shortcuts are never taken',
    gate: 'K',
    fn(a) {
      for (const input of [
        key('t'), key('w'), key('T', { shift: true }), key('1'), key('Tab'), key('Tab', { shift: true }),
        key('ArrowLeft'), key('Enter'), key('Backspace'), key(' '), key('F1'), key('F5', { shift: true }),
        key('c', { control: true }), key('v', { control: true }), key('a', { control: true }), key('z', { control: true }),
        key('s', { control: true }), key('t', { control: true, alt: true }), key('ArrowLeft', { alt: true, shift: true }),
        key('t', { control: true, shift: true }), { type: 'keyUp', key: 't', control: true },
        { type: 'keyDown', control: true }, null, undefined, {},
      ]) a.strictEqual(shortcutAction(input), null, JSON.stringify(input));
    },
  },
  {
    name: 'a held key cannot open tabs or cycle endlessly, but may keep zooming',
    gate: 'K',
    fn(a) {
      const held = { control: true, isAutoRepeat: true };
      for (const k of ['t', 'w', 'r', 'q', 'Tab', '1', '0']) a.strictEqual(shortcutAction(key(k, held)), null, k);
      a.strictEqual(shortcutAction(key('=', held)), 'zoom-in');
      a.strictEqual(shortcutAction(key('-', held)), 'zoom-out');
    },
  },
  {
    name: 'zoom stays within 50 to 200 percent and tab targets wrap',
    gate: 'K',
    fn(a) {
      a.strictEqual(nextZoom(100, 'zoom-in'), 110);
      a.strictEqual(nextZoom(200, 'zoom-in'), 200);
      a.strictEqual(nextZoom(50, 'zoom-out'), 50);
      a.strictEqual(nextZoom(170, 'zoom-reset'), 100);
      a.strictEqual(nextZoom(undefined, 'zoom-in'), 110);
      a.strictEqual(nextZoom(9999, 'zoom-out'), 190);
      const ids = [4, 7, 9];
      a.strictEqual(tabTarget('next-tab', ids, 9), 4);
      a.strictEqual(tabTarget('previous-tab', ids, 4), 9);
      a.strictEqual(tabTarget('tab-2', ids, 4), 7);
      a.strictEqual(tabTarget('tab-5', ids, 4), null);
      a.strictEqual(tabTarget('last-tab', ids, 4), 9);
      a.strictEqual(tabTarget('next-tab', [], 1), null);
      a.strictEqual(tabTarget('reload', ids, 4), null);
    },
  },
  {
    name: 'only complete http(s) links are accepted from the command line',
    gate: 'K',
    fn(a) {
      a.deepStrictEqual(externalUrls(['/opt/forge', 'https://site.test/a?b=1', '--flag', 'http://other.test']),
        ['https://site.test/a?b=1', 'http://other.test/']);
      for (const bad of ['file:///etc/passwd', '/etc/passwd', './page.html', 'javascript:alert(1)', 'data:text/html,x',
        'chrome://settings', 'about:blank', '--https://site.test', 'https://user:pw@site.test/', 'https://',
        'site.test', 'ftp://site.test/x', 'https://site.test/\nX', 'https://site.test/ --inspect', '', 42, null])
        a.deepStrictEqual(externalUrls(['exe', bad]), [], String(bad));
      // The executable path itself is never treated as a link.
      a.deepStrictEqual(externalUrls(['https://site.test/']), []);
      a.deepStrictEqual(externalUrls(['exe', 'https://a.test/', 'https://a.test/']), ['https://a.test/'], 'duplicates collapse');
      const many = ['exe', ...Array.from({ length: 30 }, (_, i) => `https://s${i}.test/`)];
      a.strictEqual(externalUrls(many).length, MAX_EXTERNAL_URLS);
      a.deepStrictEqual(externalUrls(null), []);
    },
  },
  {
    name: 'the browser is single-instance and hands external links to human tabs',
    gate: 'K',
    fn(a) {
      const main = read('src/main.js');
      a.match(main, /const HAS_INSTANCE_LOCK = !!SMOKE_RUNTIME_BASE \|\| app\.requestSingleInstanceLock\(\);\s+if \(!HAS_INSTANCE_LOCK\) app\.quit\(\);/);
      a.match(main, /app\.whenReady\(\)\.then\(\(\) => \{\s+if \(!HAS_INSTANCE_LOCK\) return;/);
      a.match(main, /app\.on\('second-instance', \(_event, argv\) => \{[\s\S]{0,200}openExternalUrls\(externalUrls\(argv\)\)/);
      // Links from outside always become a fresh human tab, never the agent tab.
      const open = main.slice(main.indexOf('function openHumanTab(url) {'), main.indexOf('function runShortcut(action) {'));
      a.match(open, /const t = createTab\('about:blank'\);/);
      a.doesNotMatch(open, /agentLease/);
      // Shortcuts reach the main process from the page and from the toolbar.
      a.match(main, /const action = activeTabId === tab\.id \? shortcutAction\(input\) : null;/);
      a.match(main, /chromeWin\.webContents\.on\('before-input-event', \(event, input\) => \{\s+const action = shortcutAction\(input\);/);
      a.match(read('src/preload.js'), /onFocusAddress: \(cb\) => ipcRenderer\.on\('forge:focus-address', \(\) => cb\(\)\)/);
    },
  },
  {
    name: 'the Linux installer is per-user, refuses a running browser, and registers the right window class',
    gate: 'K',
    fn(a) {
      const script = read('scripts/install-linux.sh');
      a.match(script, /^#!\/usr\/bin\/env bash\n/);
      a.match(script, /set -euo pipefail/);
      // Nothing outside the user's home, and no privilege escalation (shebang aside).
      a.doesNotMatch(script.slice(script.indexOf('\n')), /\bsudo\b|\bpkexec\b|\/usr\/|\/opt\/|\/etc\//);
      a.match(script, /ForgeOS Browser is running\. Close it first/);
      a.match(script, /StartupWMClass=forgeos-browser/);
      a.match(script, /MimeType=x-scheme-handler\/http;x-scheme-handler\/https;/);
      a.match(script, /Exec="\$APP_DIR\/ForgeBrowserLab" %U/);
      // Becoming the default browser is opt-in.
      a.match(script, /if \[ "\$MAKE_DEFAULT" = "1" \]; then\s+xdg-settings set default-web-browser/);
      // Uninstall never removes the profile.
      const uninstall = script.slice(script.indexOf('if [ "$MODE" = "uninstall" ]'), script.indexOf('case "$(uname -m)"'));
      a.doesNotMatch(uninstall, /rm[^\n]*\.config/);
      const { PACKAGE_FILES } = require('../../scripts/package-policy');
      for (const file of ['assets/icon.png', 'assets/icon.svg', 'src/engine/desktop-integration.js'])
        a.ok(PACKAGE_FILES.includes(file) && fs.existsSync(path.join(root, file)), file);
      a.match(read('src/main.js'), /winOpts\.icon = path\.join\(APP_ROOT, '\.\.', 'assets', 'icon\.png'\);/);
    },
  },
];
