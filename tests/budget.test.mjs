import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratch, scratchPath } from './helpers/scratch.mjs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { contained, packet, route, audit, hookDecision, evaluate, estimate, readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';

const adapter = { version: 1, project: 'fixture', instructions: ['AGENTS.md'], riskTerms: ['ontology', 'publication'], gates: ['Tests and explicit release approval'] };
const task = { question: 'Find the helper signature', kind: 'lookup', risk: 'low', novel: false, evidenceComplete: true };

function fixture(t) {
  const root = makeScratch('budget-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'sample.ts'), Array.from({ length: 600 }, (_, i) => `const n${i} = ${i};`).join('\n'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Safety first');
  fs.mkdirSync(path.join(root, '.github'));
  fs.writeFileSync(path.join(root, '.github/agent-budget.json'), JSON.stringify(adapter));
  return root;
}

test('routing avoids research and delegation for deterministic low-risk work', () => {
  assert.equal(route({ ...task, deterministic: true }, adapter).tier, 'deterministic');
  assert.equal(route(task, adapter).model, 'gpt-5.4-mini');
  assert.equal(route({ ...task, kind: 'implementation' }, adapter).model, 'hydrafusion');
});

test('novel, unknown, incomplete reasoning and domain risks escalate before cheap flags', () => {
  for (const change of [
    { novel: true }, { risk: 'unknown' }, { risk: 'high' },
    { kind: 'debugging', evidenceComplete: false }, { question: 'Review ontology identity' },
    { question: 'Fix production publication', deterministic: true },
  ]) assert.equal(route({ ...task, ...change }, adapter).tier, 'frontier-research');
  assert.equal(route({ ...task, kind: 'research' }, adapter).tier, 'bounded-research');
  const research = route({ ...task, kind: 'research' }, adapter);
  assert.equal(research.model, 'gpt-6-astra');
  assert.equal(research.effort, 'high');
  assert.equal(research.draftModel, null);
  assert.match(research.researchEntryPoint, /evidence\/research.mjs/);
  assert.equal(research.researchQualification, 'not-promoted');
  assert.equal(research.requiresSourceAdjudication, true);
  assert.equal(route(task, adapter).externalSideEffectsAuthorized, false);
  assert.equal(route(task, adapter).tandem, false);
});

test('route rejects missing facts and invalid types', () => {
  for (const change of [{ risk: undefined }, { novel: 'no' }, { evidenceComplete: null }, { kind: 'guess' }, { deterministic: 'true' }]) {
    assert.throws(() => route({ ...task, ...change }, adapter));
  }
});

test('packet preserves exact evidence with stable full-source hashes', t => {
  const root = fixture(t);
  const result = packet(root, [{ file: 'sample.ts', start: 3, end: 4 }]);
  assert.equal(result.sources[0].text, '3: const n2 = 2;\n4: const n3 = 3;');
  assert.match(result.sources[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result)));
  assert.equal(result.sources[0].sha256, packet(root, [{ file: 'sample.ts', start: 5, end: 7 }]).sources[0].sha256);
  assert.throws(() => packet(root, [{ file: 'sample.ts', start: 1, end: 600 }], 100), /exceeds cap/);
  assert.throws(() => packet(root, [{ file: 'sample.ts', start: 1, end: 900 }]), /exceeds/);
  assert.throws(() => packet(root, [{ file: 'sample.ts', start: 0, end: 4 }]));
});

test('packet rejects traversal, symlink escapes, secrets and binary content', t => {
  const root = fixture(t);
  fs.symlinkSync(scratchPath(), path.join(root, 'escape'));
  assert.throws(() => contained(root, '../'), /escapes/);
  assert.throws(() => contained(root, 'escape'), /escapes/);
  fs.writeFileSync(path.join(root, '.env.development'), 'test');
  assert.throws(() => contained(root, '.env.development'), /Sensitive/);
  fs.writeFileSync(path.join(root, 'binary'), 'a\0b');
  assert.throws(() => packet(root, [{ file: 'binary', start: 1, end: 1 }]), /Binary/);
});

test('read hook blocks whole large reads but permits exact edit ranges and instructions', t => {
  const root = fixture(t);
  const input = { toolName: 'view', cwd: root, toolArgs: { path: 'sample.ts' } };
  assert.equal(hookDecision(input).permissionDecision, 'deny');
  for (const view_range of [[1, -1], [1, 600], [0, 10]]) {
    assert.equal(hookDecision({ ...input, toolArgs: { ...input.toolArgs, view_range } }).permissionDecision, 'deny');
  }
  assert.deepEqual(hookDecision({ ...input, toolArgs: { path: 'sample.ts', view_range: [300, 320] } }), {});
  assert.deepEqual(hookDecision({ tool_name: 'Read', cwd: root, tool_input: '{"file_path":"sample.ts","offset":2,"limit":20}' }), {});
  assert.deepEqual(hookDecision({ ...input, toolArgs: { path: 'AGENTS.md' } }), {});
  assert.deepEqual(hookDecision({ toolName: 'bash' }), {});
  assert.deepEqual(hookDecision({ ...input, toolArgs: { path: 'missing' } }), {});
});

test('audit separates always-loaded roots from lazy skills and identifies broken links', t => {
  const root = fixture(t);
  execFileSync('git', ['init', '--quiet', root]);
  fs.mkdirSync(path.join(root, 'skills/example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/example/SKILL.md'), '---\nname: example\n---\nlong_context\n[Broken](missing.md)\n');
  const result = audit(root);
  assert.equal(result.files.find(file => file.file === 'AGENTS.md').loading, 'always');
  assert.equal(result.files.find(file => file.file.endsWith('SKILL.md')).loading, 'on-demand');
  assert.ok(result.findings.some(finding => finding.type === 'missing-link'));
  assert.ok(result.findings.some(finding => finding.type === 'expensive-pin'));
  assert.equal(readAdapter(root).project, 'fixture');
});

const caseRow = (id, score = 1) => ({
  id: String(id), inputHash: crypto.createHash('sha256').update(String(id)).digest('hex'), heldOut: true, independentReview: true,
  baseline: { score: 1, complete: true, criticalFailure: false },
  candidate: { score, complete: true, criticalFailure: false },
});

test('evaluation never promotes smoke evidence or missing/critical outcomes', () => {
  const base = { project: 'fixture', taskClass: 'lookup', margin: 0.05, cases: [caseRow(1)] };
  assert.equal(evaluate(base).promoted, false);
  const many = { ...base, cases: Array.from({ length: 3000 }, (_, i) => caseRow(i)) };
  assert.equal(evaluate(many).promoted, true);
  many.cases[2].candidate.criticalFailure = true;
  assert.equal(evaluate(many).promoted, false);
  delete many.cases[2].candidate;
  assert.equal(evaluate(many).promoted, false);
  assert.throws(() => evaluate({ ...base, cases: [caseRow(1), caseRow(1)] }), /Unique/);
  assert.throws(() => evaluate({ ...base, cases: [caseRow(1), { ...caseRow(1), id: 'different-label' }] }), /Duplicate frozen/);
  assert.throws(() => evaluate({ ...base, margin: 0.8 }));
});

test('cost estimate includes cache, worker, retry and output separately', () => {
  const rates = { input: 10, cached: 1, cacheWrite: 12.5, output: 20 };
  const leg = { count: 1, input: 1000000, cached: 1000000, cacheWrite: 0, output: 1000000, rates };
  const result = estimate({ rateUnit: 'relative', assumptions: 'fixture only', baseline: [leg], candidate: [{ ...leg, count: 2 }] });
  assert.equal(result.baseline.cost, 31);
  assert.equal(result.candidate.cost, 62);
  assert.equal(result.tokenSavings, -1);
  assert.equal(result.costSavings, -1);
  assert.equal(estimate({ rateUnit: 'x', assumptions: 'fixture', baseline: [leg],
    candidate: [{ ...leg, cacheWrite: 1000000 }] }).candidate.cost, 43.5);
  assert.throws(() => estimate({ rateUnit: 'x', assumptions: '', baseline: [{ ...leg, input: -1 }], candidate: [leg] }));
});
