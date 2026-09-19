/* page-snapshot.test.js — the observation model the agent reasons over.
 * One atomic read: page text plus the numbered table of elements it may act on. */
'use strict';
const {
  normalizeSnapshot, fingerprintSnapshot, candidatesByKind,
  elementByIndex, elementCatalogue, describeSnapshot, MAX_ELEMENTS,
} = require('../../src/engine/page-snapshot');

const raw = (over = {}) => ({
  url: 'https://example.com/shop',
  title: 'Shop',
  text: 'Bem-vindo à loja.',
  elements: [
    { index: 1, role: 'button', kind: 'click', label: 'Comprar', href: null },
    { index: 2, role: 'textbox', kind: 'fill', label: 'Buscar produtos', current_value: '' },
    { index: 3, role: 'combobox', kind: 'select', label: 'Estado -> SP', option_value: 'SP' },
  ],
  can_scroll_down: true,
  can_scroll_up: false,
  ...over,
});

module.exports = [
  {
    name: 'normalises a well-formed payload and computes a fingerprint',
    gate: 'L',
    fn: async (assert) => {
      const s = normalizeSnapshot(raw());
      assert.strictEqual(s.url, 'https://example.com/shop');
      assert.strictEqual(s.elements.length, 3);
      assert.strictEqual(s.elements[0].label, 'Comprar');
      assert.strictEqual(s.can_scroll_down, true);
      assert.strictEqual(typeof s.fingerprint, 'string');
      assert.ok(s.fingerprint.length >= 8, 'fingerprint should be a real digest');
    },
  },
  {
    name: 'fingerprint is stable for unchanged content and changes with it',
    gate: 'L',
    fn: async (assert) => {
      const a = normalizeSnapshot(raw());
      const b = normalizeSnapshot(raw());
      assert.strictEqual(a.fingerprint, b.fingerprint, 'identical reads must match');
      const c = normalizeSnapshot(raw({ text: 'Preço: R$ 10' }));
      assert.notStrictEqual(a.fingerprint, c.fingerprint, 'changed text must differ');
      const d = normalizeSnapshot(raw({ elements: [{ index: 9, role: 'button', kind: 'click', label: 'Outro' }] }));
      assert.notStrictEqual(a.fingerprint, d.fingerprint, 'changed elements must differ');
    },
  },
  {
    name: 'malformed payloads never produce a usable element',
    gate: 'L',
    fn: async (assert) => {
      const s = normalizeSnapshot({
        elements: [
          null, 'string', { index: 0 }, { index: -3 }, { index: 'abc' },
          { index: 7, kind: 'nonsense', label: 'ok' },
        ],
      });
      assert.strictEqual(s.elements.length, 1, 'only the element with a valid index survives');
      assert.strictEqual(s.elements[0].index, 7);
      assert.strictEqual(s.elements[0].kind, 'click', 'unknown kind falls back to click');
      // Degenerate input must not throw.
      assert.strictEqual(normalizeSnapshot(null).elements.length, 0);
      assert.strictEqual(normalizeSnapshot(undefined).text, '');
    },
  },
  {
    name: 'element count is bounded and truncation is declared',
    gate: 'L',
    fn: async (assert) => {
      const many = Array.from({ length: MAX_ELEMENTS + 25 }, (_, i) => ({
        index: i + 1, role: 'button', kind: 'click', label: `b${i}`,
      }));
      const s = normalizeSnapshot(raw({ elements: many }));
      assert.strictEqual(s.elements.length, MAX_ELEMENTS);
      assert.strictEqual(s.truncated, true, 'truncation must be visible to the caller');
    },
  },
  {
    name: 'covered controls are reported so a caller knows why the page is bare',
    gate: 'L',
    fn: async (assert) => {
      // Regression: the snapshot used to offer controls that the action would
      // then refuse as "occluded", teaching the model to pick unusable targets.
      const s = normalizeSnapshot(raw({ occluded_count: 7 }));
      assert.strictEqual(s.occluded_count, 7);
      assert.strictEqual(normalizeSnapshot(raw()).occluded_count, 0, 'absent means none');
      assert.strictEqual(normalizeSnapshot(raw({ occluded_count: 'x' })).occluded_count, 0, 'junk is not a count');
    },
  },
  {
    name: 'controls below the fold are reported, not hidden',
    gate: 'L',
    fn: async (assert) => {
      // Regression from a live run: a paginated site whose only way forward was
      // a "Next" link below the fold looked EMPTY to the agent — it scrolled
      // hoping and saw nothing. Off-screen controls are real; they are now named
      // (and kept out of the clickable list, since the action would refuse them).
      const s = normalizeSnapshot(raw({
        below_fold: [{ index: 42, kind: 'click', role: 'button', label: 'Next', href: '/page/2/' }],
      }));
      assert.strictEqual(s.below_fold.length, 1);
      assert.strictEqual(s.below_fold[0].label, 'Next');
      assert.strictEqual(s.below_fold[0].href, '/page/2/');
      // It must NOT be offered as an immediate target.
      assert.strictEqual(s.elements.find((e) => e.index === 42), undefined);
      assert.strictEqual(candidatesByKind(s, 'click').size, 1, 'still only the on-screen one');
      // But the whole-page catalogue knows about it.
      assert.ok(elementCatalogue(s).some((line) => line.includes('Next')));
      // Junk degrades quietly.
      assert.strictEqual(normalizeSnapshot(raw({ below_fold: 'x' })).below_fold.length, 0);
      assert.strictEqual(normalizeSnapshot(raw()).below_fold.length, 0);
    },
  },
  {
    name: 'a degenerate viewport does not empty the catalogue',
    gate: 'L',
    fn: async (assert) => {
      // Regression, found live on a JS-rendered page: the snapshot filters to
      // the viewport as a cheap focus, but a native view that is not laid out
      // reports 0x0 — and then every element failed the position test, leaving
      // the agent blind on a page visibly full of links. Position filtering is
      // an optimisation, so it must yield when the viewport is unusable.
      const s = normalizeSnapshot(raw({ viewport: [0, 0], offscreen_count: 4 }));
      assert.deepStrictEqual(s.viewport, [0, 0]);
      assert.strictEqual(s.offscreen_count, 4);
      assert.strictEqual(s.elements.length, 3, 'elements survive a useless viewport');
      assert.strictEqual(normalizeSnapshot(raw()).viewport, null, 'absent viewport is null, not [0,0]');
      assert.strictEqual(normalizeSnapshot(raw()).offscreen_count, 0);
      assert.deepStrictEqual(normalizeSnapshot(raw({ viewport: [1280, 720] })).viewport, [1280, 720]);
      assert.strictEqual(normalizeSnapshot(raw({ viewport: 'junk' })).viewport, null);
    },
  },
  {
    name: 'candidate selection and index lookup match the element table',
    gate: 'L',
    fn: async (assert) => {
      const s = normalizeSnapshot(raw());
      assert.deepStrictEqual([...candidatesByKind(s, 'click').keys()], [1]);
      assert.deepStrictEqual([...candidatesByKind(s, 'fill').keys()], [2]);
      assert.deepStrictEqual([...candidatesByKind(s, 'select').keys()], [3]);
      assert.strictEqual(elementByIndex(s, 2).label, 'Buscar produtos');
      assert.strictEqual(elementByIndex(s, 999), null);
    },
  },
  {
    name: 'the catalogue is the vocabulary an agent can act on',
    gate: 'L',
    fn: async (assert) => {
      const s = normalizeSnapshot(raw());
      const all = elementCatalogue(s);
      assert.strictEqual(all.length, 3);
      assert.ok(all[0].includes('[1]') && all[0].includes('Comprar'), 'index and label must both appear');
      assert.ok(all[2].includes('value="SP"'), 'select options carry their value');
      assert.strictEqual(elementCatalogue(s, 'fill').length, 1);
      assert.ok(describeSnapshot(s).includes('1 clickable'));
      assert.ok(describeSnapshot(s).includes(s.fingerprint));
    },
  },
];
