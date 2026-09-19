/* typesafe-decider.test.js — the Jev-backed step decision, with the network
 * mocked. These tests assert the two things that matter: the questions sent
 * carry the goal and the page (never the key in the body), and the answers are
 * composed into a decision the loop can trust. No real request is ever made. */
'use strict';
const { createTypeSafeDecider, buildQuestions, buildState, composeDecision, paragraphsOf } = require('../../src/engine/typesafe-decider');

const KEY = 'sk-test-key-abcdefghijklmnop';

const snapshot = (over = {}) => ({
  url: 'https://loja.example/produto',
  title: 'Produto',
  text: 'Um parágrafo suficientemente longo para contar como candidato a resposta.\nOutro parágrafo igualmente longo sobre o preço final com frete para São Paulo.',
  elements: [
    { index: 1, kind: 'click', role: 'button', label: 'Ver detalhes', href: '/d', option_value: null },
    { index: 2, kind: 'fill', role: 'textbox', label: 'Buscar', href: null, option_value: null },
    { index: 3, kind: 'select', role: 'combobox', label: 'Estado -> SP', href: null, option_value: 'SP' },
  ],
  below_fold: [],
  ...over,
});

/** A fetch double that records the request and replies with given answers. */
function fakeFetch(answers, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok, status,
      json: async () => ({ model: 'jev-latest', answers }),
    };
  };
  fn.calls = calls;
  return fn;
}

module.exports = [
  {
    name: 'questions cover operation, each element kind, and the answer passage',
    gate: 'L',
    fn: async (assert) => {
      const q = buildQuestions(snapshot());
      assert.strictEqual(q.operation.type, 'choice');
      assert.ok(q.operation.criteria.CLICK && q.operation.criteria.DONE, 'the operation space is offered');
      // Every target question also offers "nothing fits": the model's docs are
      // explicit that without it, it picks the closest wrong thing instead.
      assert.ok(q.click_target.criteria['1'], 'the clickable element is offered');
      assert.ok(q.click_target.criteria['(none)'], 'the model may answer that nothing fits');
      assert.ok(q.fill_target.criteria['2'] && q.fill_target.criteria['(none)']);
      assert.ok(q.select_target.criteria['3'] && q.select_target.criteria['(none)']);
      assert.ok(Object.keys(q.answer.criteria).length >= 2, 'answers are picked from the page, never generated');
      assert.ok(q.answer.criteria['(none)'], 'and the model may say no passage answers it');
      assert.strictEqual(q.goal_met.type, 'noul');
      assert.ok(!/\banswer no\b/i.test(q.goal_met.instructions),
        'the noul instruction must not smuggle a negation into a yes/no question');

      // No elements of a kind means no question about that kind.
      const bare = buildQuestions(snapshot({ elements: [] }));
      assert.strictEqual(bare.click_target, undefined);
      assert.strictEqual(bare.fill_target, undefined);
      assert.strictEqual(bare.select_target, undefined);
      assert.ok(bare.operation, 'the operation question always stands');
    },
  },
  {
    name: 'when the model says nothing fits, nothing is clicked',
    gate: 'A2',
    fn: async (assert) => {
      // Live failure this prevents: asked to open the news section, the model
      // was forced to name a control and named the hamburger menu. Given the
      // option to refuse, the refusal is honoured rather than overridden.
      const snap = snapshot();
      const refuses = composeDecision({
        goal_met: { noul: 0.1 },
        operation: { choice: 'CLICK', probabilities: { CLICK: 0.6 }, confidence: 0.8 },
        click_target: { choice: '(none)', confidence: 0.9 },
      }, snap);
      assert.strictEqual(refuses.operation, null, 'a refused target must not become a click');
      assert.ok(/none/.test(refuses.reasoning));

      const refusesAnswer = composeDecision({
        goal_met: { noul: 0.9 },
        operation: { choice: 'CLICK' },
        click_target: { choice: '1' },
        answer: { choice: '(none)' },
      }, snap);
      assert.strictEqual(refusesAnswer.operation, 'DONE');
      assert.strictEqual(refusesAnswer.result, null,
        '(none) must never be read as paragraph 0');
    },
  },
  {
    name: 'the state carries the goal, the page and what was already tried',
    gate: 'L',
    fn: async (assert) => {
      const state = buildState('leia o preço final', snapshot(), [
        { operation: 'CLICK', target: 1, outcome: 'ok', detail: 'clicked 10,10' },
      ]);
      assert.ok(/GOAL: leia o preço final/.test(state));
      assert.ok(/loja\.example/.test(state), 'the URL is part of the state');
      assert.ok(/\[1\] click button: Ver detalhes/.test(state), 'elements are addressable by index');
      assert.ok(/ALREADY TRIED/.test(state) && /CLICK \[1\]/.test(state), 'history discourages repeating a step');
      assert.ok(/suficientemente longo/.test(state), 'the page text is included');
    },
  },
  {
    name: 'an unsure model is not allowed to click',
    gate: 'A2',
    fn: async (assert) => {
      // Regression from live runs: clicks executed on confidences of 0.4-0.6
      // landed on the wrong control (a hamburger menu instead of a news link).
      // Acting on "maybe" is how an agent does damage; refusing is honest.
      const snap = snapshot();
      const doubtful = {
        goal_met: { noul: 0.1 },
        operation: { choice: 'CLICK', probabilities: { CLICK: 0.7 }, confidence: 0.42 },
        click_target: { choice: '1', probabilities: { 1: 0.55 }, confidence: 0.55 },
      };
      const held = composeDecision(doubtful, snap);
      assert.strictEqual(held.operation, null, 'a 0.42 operation must not be executed');
      assert.ok(/not confident enough/.test(held.reasoning));
      assert.ok(/0\.42/.test(held.reasoning) && /0\.55/.test(held.reasoning),
        'the refusal shows the numbers, so hesitation is visible rather than mysterious');

      // The weakest of the two decides, not the strongest.
      const weakTarget = {
        goal_met: { noul: 0.1 },
        operation: { choice: 'CLICK', confidence: 0.9 },
        click_target: { choice: '1', confidence: 0.3 },
      };
      assert.strictEqual(composeDecision(weakTarget, snap).operation, null,
        'a confident operation with an unsure target is still a guess');

      // A confident decision still acts.
      const certain = {
        goal_met: { noul: 0.05 },
        operation: { choice: 'CLICK', confidence: 0.85 },
        click_target: { choice: '1', confidence: 0.9 },
      };
      assert.strictEqual(composeDecision(certain, snap).operation, 'CLICK');

      // A caller may lower the bar deliberately.
      assert.strictEqual(composeDecision(doubtful, snap, { minConfidence: 0.3 }).operation, 'CLICK');
      // Answers without any confidence figure are not blocked by this rule.
      assert.strictEqual(composeDecision({
        goal_met: { noul: 0.1 }, operation: { choice: 'CLICK' }, click_target: { choice: '1' },
      }, snap).operation, 'CLICK');
    },
  },
  {
    name: 'a "possibly answered" verdict does not stop the run',
    gate: 'L',
    fn: async (assert) => {
      // Regression from a live run: asked to read an article, the model saw the
      // subject MENTIONED on a listing page and answered DONE with the page
      // title. A Noul in the middle is "possibly", not "yes".
      const snap = snapshot();
      const midConfidence = {
        goal_met: { type: 'noul', noul: 0.55 },
        operation: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.7 }, confidence: 0.6 },
        click_target: { choice: '1' },
      };
      const decision = composeDecision(midConfidence, snap);
      assert.strictEqual(decision.operation, 'CLICK', 'a 0.55 noul must not end the run');
      assert.strictEqual(decision.target, 1);

      // The bar is explicit and adjustable.
      const { DEFAULT_GOAL_MET_THRESHOLD } = require('../../src/engine/typesafe-decider');
      assert.ok(DEFAULT_GOAL_MET_THRESHOLD > 0.5, 'the default must be above a coin flip');
      assert.strictEqual(composeDecision(midConfidence, snap, { goalMetThreshold: 0.5 }).operation, 'DONE',
        'a caller may lower it deliberately');
      assert.strictEqual(
        composeDecision({ goal_met: { noul: 0.9 }, operation: { choice: 'CLICK' }, click_target: { choice: '1' } }, snap).operation,
        'DONE', 'a confident verdict does end the run');
    },
  },
  {
    name: 'the state tells the model what exists below the fold',
    gate: 'L',
    fn: async (assert) => {
      // Blind scrolling becomes a deliberate step once the model is told that a
      // named control exists below.
      const snap = snapshot({
        below_fold: [{ index: 42, kind: 'click', role: 'button', label: 'Next', href: '/js/page/2/' }],
      });
      const state = buildState('get the next page of quotes', snap, []);
      assert.ok(/BELOW THE FOLD/.test(state), 'the section must be present');
      assert.ok(/\[42\] click button: Next -> \/js\/page\/2\//.test(state), 'with its destination');
      // And it is NOT offered as a click target: the action would refuse it.
      const q = buildQuestions(snap);
      assert.strictEqual(q.click_target === undefined || q.click_target.criteria['42'] === undefined, true,
        'an off-screen control must not be offered as an immediate target');
    },
  },
  {
    name: 'candidates carry the href, and covered controls are disclosed',
    gate: 'L',
    fn: async (assert) => {
      // Regression from a live run on a real site: given twelve similar match
      // buttons the model picked the wrong one, because the label alone cannot
      // tell "BRA v ESP" apart from eleven siblings. The raw href can.
      const snap = snapshot({
        occluded_count: 3,
        elements: [
          { index: 1, kind: 'click', role: 'button', label: 'Quarter-Finals BRA v ESP', href: '/matches/bra-esp', option_value: null },
          { index: 2, kind: 'click', role: 'button', label: 'Quarter-Finals PRK v CAN', href: '/matches/prk-can', option_value: null },
        ],
      });
      const { candidatesFor } = require('../../src/engine/typesafe-decider');
      const clickables = candidatesFor(snap, 'click');
      assert.ok(/matches\/bra-esp/.test(clickables['1']), 'the destination must reach the model');
      assert.ok(/matches\/prk-can/.test(clickables['2']));

      const state = buildState('encontre Brasil x Espanha', snap, []);
      assert.ok(/-> \/matches\/bra-esp/.test(state), 'the state carries destinations too');
      assert.ok(/3 control\(s\).*covered/.test(state), 'covered controls are disclosed, not silently missing');
    },
  },
  {
    name: 'a high goal-met answer wins and the result is picked from the page',
    gate: 'L',
    fn: async (assert) => {
      const snap = snapshot();
      const decision = composeDecision({
        goal_met: { type: 'noul', noul: 0.92 },
        operation: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.6, DONE: 0.3 }, confidence: 0.4 },
        answer: { type: 'choice', choice: '1', probabilities: {}, confidence: 0.9 },
      }, snap);
      assert.strictEqual(decision.operation, 'DONE', 'an answered page must not be clicked further');
      const paragraphs = paragraphsOf(snap.text);
      assert.strictEqual(decision.result, paragraphs[1], 'the result is a passage of the page, not generated text');
      assert.ok(/goal met/.test(decision.reasoning));
    },
  },
  {
    name: 'an operation with its element index becomes an actionable decision',
    gate: 'L',
    fn: async (assert) => {
      const snap = snapshot();
      const click = composeDecision({
        goal_met: { noul: 0.1 },
        operation: { choice: 'CLICK', probabilities: { CLICK: 0.8 }, confidence: 0.7 },
        click_target: { choice: '1', probabilities: { 1: 0.9 }, confidence: 0.9 },
      }, snap);
      assert.strictEqual(click.operation, 'CLICK');
      assert.strictEqual(click.target, 1);

      const select = composeDecision({
        goal_met: { noul: 0.1 },
        operation: { choice: 'SELECT' },
        select_target: { choice: '3' },
      }, snap);
      assert.strictEqual(select.operation, 'SELECT');
      assert.strictEqual(select.target, 3);
      assert.strictEqual(select.option_value, 'SP', 'the option value comes from the element table');

      const scroll = composeDecision({ goal_met: { noul: 0 }, operation: { choice: 'SCROLL_DOWN' } }, snap);
      assert.strictEqual(scroll.operation, 'SCROLL_DOWN');

      const blocked = composeDecision({ goal_met: { noul: 0 }, operation: { choice: 'BLOCKED' } }, snap);
      assert.strictEqual(blocked.operation, 'BLOCKED');
    },
  },
  {
    name: 'unusable model answers never become a blind action',
    gate: 'A2',
    fn: async (assert) => {
      const snap = snapshot();
      // An index that is not on the page.
      const ghost = composeDecision({
        goal_met: { noul: 0 }, operation: { choice: 'CLICK' }, click_target: { choice: '99' },
      }, snap);
      assert.strictEqual(ghost.operation, null, 'a target that does not exist must not be clicked');

      // A word where a number was expected.
      const wordy = composeDecision({
        goal_met: { noul: 0 }, operation: { choice: 'CLICK' }, click_target: { choice: 'the first link' },
      }, snap);
      assert.strictEqual(wordy.operation, null);

      // An operation outside the offered set.
      const invented = composeDecision({ goal_met: { noul: 0 }, operation: { choice: 'TELEPORT' } }, snap);
      assert.strictEqual(invented.operation, null);

      // Typing with no text to type: Jev classifies, it does not generate.
      const emptyType = composeDecision({
        goal_met: { noul: 0 }, operation: { choice: 'TYPE_TEXT' }, fill_target: { choice: '2' },
      }, snap);
      assert.strictEqual(emptyType.operation, null, 'TYPE_TEXT without a value must not run');
      assert.ok(/no text was provided/.test(emptyType.reasoning));

      // Nothing at all.
      assert.strictEqual(composeDecision(null, snap).operation, null);
      assert.strictEqual(composeDecision({}, snap).operation, null);
    },
  },
  {
    name: 'the request carries the state and the questions, and the key only in the header',
    gate: 'A2',
    fn: async (assert) => {
      const fetchImpl = fakeFetch({
        goal_met: { noul: 0.1 },
        operation: { choice: 'DONE' },
        answer: { choice: '0' },
      });
      const decide = createTypeSafeDecider({ apiKey: KEY, fetchImpl });
      const decision = await decide({ snapshot: snapshot(), history: [], step: 1, goal: 'leia o preço' });

      assert.strictEqual(fetchImpl.calls.length, 1, 'one call per step, not one per question');
      const { url, init } = fetchImpl.calls[0];
      assert.strictEqual(url, 'https://api.typesafe.ai/v1/systemone');
      assert.strictEqual(init.method, 'POST');
      assert.strictEqual(init.headers.Authorization, `Bearer ${KEY}`);
      const body = JSON.parse(init.body);
      assert.strictEqual(body.model, 'jev-latest');
      assert.ok(/leia o preço/.test(body.state), 'the goal reaches the model');
      assert.ok(body.questions.operation, 'the questions are sent');
      assert.ok(!JSON.stringify(body).includes(KEY), 'the key must never appear in the body');
      assert.strictEqual(decision.operation, 'DONE');
      assert.strictEqual(decision.provider, 'typesafe');
      assert.ok(Number.isFinite(decision.latencyMs));
    },
  },
  {
    name: 'a failing provider throws so the caller can fall back, and is counted',
    gate: 'A2',
    fn: async (assert) => {
      const calls = [];
      const decide = createTypeSafeDecider({
        apiKey: KEY,
        fetchImpl: fakeFetch({}, { ok: false, status: 401 }),
        onCall: (info) => calls.push(info),
      });
      let threw = null;
      try {
        await decide({ snapshot: snapshot(), history: [], step: 1, goal: 'x' });
      } catch (error) { threw = error; }
      assert.ok(threw, 'a provider failure must surface, not be silently swallowed');
      assert.ok(/401/.test(threw.message));
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].ok, false);

      // A transport failure is the same contract.
      const broken = createTypeSafeDecider({ apiKey: KEY, fetchImpl: async () => { throw new Error('socket hang up'); } });
      let netError = null;
      try { await broken({ snapshot: snapshot(), history: [], step: 1, goal: 'x' }); } catch (e) { netError = e; }
      assert.ok(netError && /socket hang up/.test(netError.message));
    },
  },
  {
    name: 'building a decider without a key is refused at construction',
    gate: 'A2',
    fn: async (assert) => {
      let threw = null;
      try { createTypeSafeDecider({ fetchImpl: async () => ({}) }); } catch (e) { threw = e; }
      assert.ok(threw && /key is required/.test(threw.message));
    },
  },
];
