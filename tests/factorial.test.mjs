import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratch } from './helpers/scratch.mjs';
import { execFileSync } from 'node:child_process';
import { arms, balancedOrders, validateSelection, makePrompt, contrast, gate,
  prepare, prepareEvidence } from '../evals/factorial.mjs';
import { anchorAnswer, validateAnchoredGrade } from '../evals/research.mjs';

test('four profiles preserve model, effort and context across workflow changes', () => {
  for (const prefix of ['sol', 'astra']) {
    for (const key of ['model', 'effort', 'context']) {
      assert.equal(arms[`${prefix}-legacy`][key], arms[`${prefix}-infra`][key]);
    }
  }
  assert.equal(arms['astra-infra'].effort, 'low');
  assert.equal(arms['sol-infra'].effort, 'max');
});

test('balanced order puts every arm in every position equally', () => {
  const orders = Object.values(balancedOrders(Array.from({ length: 8 }, (_, i) => String(i))));
  for (const arm of Object.keys(arms)) {
    for (let position = 0; position < 4; position++) {
      assert.equal(orders.filter(order => order[position] === arm).length, 2);
    }
  }
});

test('worker selection cannot invent paths or exceed source-range budget', () => {
  const corpus = { sources: [{ path: 'x.ts' }] };
  assert.equal(validateSelection({ ranges: [{ file: 'x.ts', start: 1, end: 20 }] }, corpus).length, 1);
  for (const range of [
    { file: '../gold.json', start: 1, end: 2 }, { file: 'x.ts', start: '1', end: 2 },
    { file: 'x.ts', start: 1, end: 90 },
  ]) assert.throws(() => validateSelection({ ranges: [range] }, corpus));
});

test('legacy has full eager policy but no packet; infra uses actual preparation and explicit fallback', () => {
  const adapter = { project: 'test', riskTerms: [], gates: ['Keep source truth'] };
  const legacy = makePrompt('Question?', 'legacy', 'FULL_LEGACY_POLICY', adapter, null);
  const infra = makePrompt('Question?', 'infra', 'FULL_LEGACY_POLICY', adapter,
    { accepted: true, packet: { proof: 'EXACT_PACKET' } });
  assert.ok(legacy.includes('FULL_LEGACY_POLICY'));
  assert.ok(!legacy.includes('EXACT_PACKET'));
  assert.ok(!infra.includes('FULL_LEGACY_POLICY'));
  assert.ok(infra.includes('EXACT_PACKET'));
  const fallback = makePrompt('Question?', 'infra', '', adapter, { accepted: false, failure: 'bad ranges' });
  assert.ok(fallback.includes('preparation failed'));
  assert.ok(!fallback.includes('bad ranges'));
});

test('missing or invalid reports stay failed rather than success-shaped fallbacks', () => {
  const reasons = gate({ valid: false, content: '[No completed research answer returned.]' });
  assert.ok(reasons.some(reason => reason.includes('failed')));
  assert.ok(reasons.some(reason => reason.includes('Missing requested Evidence')));
});

test('four-way scoring anchors remain label-bound', () => {
  const maps = Object.fromEntries(['A', 'B', 'C', 'D'].map(label => [label, anchorAnswer(`Answer ${label}`, label).anchors]));
  const raw = Object.fromEntries(['A', 'B', 'C', 'D'].map(label =>
    [label, { criteria: [{ id: 'criterion', score: 2, support: [`${label}:p001`], reason: 'supported' }] }]));
  raw.disputedRubric = [];
  assert.equal(validateAnchoredGrade(raw, { criteria: [{ id: 'criterion' }] }, maps), raw);
  raw.D.criteria[0].support = ['A:p001'];
  assert.throws(() => validateAnchoredGrade(raw, { criteria: [{ id: 'criterion' }] }, maps), /wrong-answer/);
});

test('paired contrasts do not conflate token and credit savings', () => {
  const result = contrast({ totalTokens: 120, credits: 3 }, { totalTokens: 100, credits: 10 });
  assert.equal(result.tokenRatio, 1.2);
  assert.equal(result.creditRatio, 0.3);
});

test('small source tasks take a sealed deterministic packet path with no model charge', async t => {
  const temp = makeScratch('factorial-prepare-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(path.join(repo, '.github'), { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  fs.writeFileSync(path.join(repo, 'source.ts'), 'export const fixture = 7;\n');
  fs.writeFileSync(path.join(repo, '.github/copilot-instructions.md'), 'Preserve fixture correctness.\n');
  fs.writeFileSync(path.join(repo, '.github/agent-budget.json'), JSON.stringify({
    version: 1, project: 'fixture', instructions: ['.github/copilot-instructions.md'],
    riskTerms: [], gates: ['No live changes'],
  }));
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>']);
  const definitions = { version: 1, cases: [{
    id: 'fixture', project: 'fixture', family: 'one', ref: 'HEAD',
    question: 'Investigate this fixture behavior and assess a proposed safe alternative.',
    sources: ['source.ts'], criteria: [1, 2, 3].map(i => ({ id: `rule-${i}`, text: 'Hidden criterion', critical: false })),
  }] };
  const out = path.join(temp, 'study');
  prepare(definitions, { fixture: repo }, out, 100);
  const outcome = await prepareEvidence(out, 'fixture');
  assert.equal(outcome.method, 'direct-packet');
  const preparation = JSON.parse(fs.readFileSync(path.join(out, 'cases/fixture/preparation.json')));
  assert.equal(preparation.usage.credits, 0);
  assert.equal(preparation.packet.sources[0].text, '1: export const fixture = 7;\n2: ');
  assert.ok(!fs.existsSync(path.join(out, 'cases/fixture/evidence-worker')));
  const seal = JSON.parse(fs.readFileSync(path.join(out, 'private/seal.json')));
  assert.equal(Object.keys(seal.profiles).length, 4);
  assert.equal(seal.cases[0].answerOrder.length, 4);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(out, 'cases/fixture/task.json'))).prompt.includes('Hidden criterion'));
  const ledger = JSON.parse(fs.readFileSync(path.join(out, 'ledger.json')));
  assert.equal(ledger.spentCredits, 0);
});
