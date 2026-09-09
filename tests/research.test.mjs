import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeScratch } from './helpers/scratch.mjs';
import { prepare, loadCase, validateGrade, regressionUpperBound, projectVerdict,
  anchorAnswer, parseAssessorJson, validateAnchoredGrade } from '../evals/research.mjs';

test('exact one-sided risk bounds use cases/families, not criterion counts', () => {
  assert.equal(regressionUpperBound(0, 0), 1);
  assert.ok(Math.abs(regressionUpperBound(0, 3) - 0.6315968501) < 1e-8);
  assert.ok(regressionUpperBound(0, 58) > 0.05);
  assert.ok(regressionUpperBound(0, 59) < 0.05);
  assert.ok(regressionUpperBound(0, 85, 0.0125) > 0.05);
  assert.ok(regressionUpperBound(0, 86, 0.0125) < 0.05);
  // NIST example's two-sided 90% interval has the same upper tail alpha=.05.
  assert.ok(Math.abs(regressionUpperBound(4, 20) - 0.401029) < 1e-6);
  assert.throws(() => regressionUpperBound(4, 3));
  assert.throws(() => regressionUpperBound(0, 5, 1));
});

test('repeated source families cannot inflate sample size or hide absolute failures', () => {
  const row = { id: 'a', family: 'one', complete: true, referencePass: true, candidatePass: true,
    disagreement: false, disputedRubric: false };
  const result = projectVerdict(Array.from({ length: 100 }, (_, index) => ({ ...row, id: String(index) })));
  assert.equal(result.families, 1);
  assert.equal(result.promoted, false);
  const failed = projectVerdict([{ ...row, referencePass: false, candidatePass: false }]);
  assert.equal(failed.regressions, 0);
  assert.ok(failed.blockers.some(reason => reason.includes('absolute quality')));
});

test('judge grades require every ID, bounded scores and literal answer evidence', () => {
  const item = { criteria: [{ id: 'safety' }] };
  const answers = { A: 'Keep the state fence.', B: 'Remove the fence.' };
  const raw = { A: { criteria: [{ id: 'safety', score: 2, quote: 'Keep the state fence.', reason: 'correct' }] },
    B: { criteria: [{ id: 'safety', score: 0, quote: '', reason: 'unsafe' }] }, disputedRubric: [] };
  assert.equal(validateGrade(raw, item, answers), raw);
  assert.throws(() => validateGrade({ ...raw, A: { criteria: [] } }, item, answers));
  assert.throws(() => validateGrade({ ...raw, A: { criteria: [{ ...raw.A.criteria[0], quote: 'invented' }] } }, item, answers));
  assert.throws(() => validateGrade({ ...raw, A: { criteria: [{ ...raw.A.criteria[0], score: 3 }] } }, item, answers));
});

test('paragraph anchors resolve deterministic original evidence and reject cross-answer references', () => {
  const a = anchorAnswer('# Decision\n\nKeep the fence.\n\nProposed test.', 'A');
  const b = anchorAnswer('Remove it.', 'B');
  assert.equal(a.anchors['A:p002'], 'Keep the fence.');
  const item = { criteria: [{ id: 'safe' }] };
  const grade = { A: { criteria: [{ id: 'safe', score: 2, support: ['A:p002'], reason: 'preserved' }] },
    B: { criteria: [{ id: 'safe', score: 0, support: [], reason: 'unsafe' }] }, disputedRubric: [] };
  assert.equal(validateAnchoredGrade(grade, item, { A: a.anchors, B: b.anchors }), grade);
  const bad = structuredClone(grade);
  bad.A.criteria[0].support = ['B:p001'];
  assert.throws(() => validateAnchoredGrade(bad, item, { A: a.anchors, B: b.anchors }), /wrong-answer/);
  const parsed = parseAssessorJson('```json\n{"ok":true}\n```');
  assert.equal(parsed.fenceNormalized, true);
  assert.equal(parsed.value.ok, true);
  assert.throws(() => parseAssessorJson('Some prose\n```json\n{"ok":true}\n```'));
});

test('prepare seals private criteria separately from source-only solver corpus', t => {
  const temp = makeScratch('research-seal-test-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  fs.writeFileSync(path.join(repo, 'source.txt'), 'safe source\n');
  execFileSync('git', ['-C', repo, 'add', 'source.txt']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const definition = { version: 1, cases: [{ id: 'test-case', project: 'example', family: 'family', ref: 'HEAD',
    question: 'Investigate this sufficiently detailed fixture research question.',
    sources: ['source.txt'], criteria: [1, 2, 3].map(id => ({ id: String(id), text: 'SECRET RUBRIC', critical: true })) }] };
  const out = path.join(temp, 'benchmark');
  prepare(definition, { example: repo }, out, 100);
  const loaded = loadCase(out, 'test-case');
  assert.ok(!loaded.task.prompt.includes('SECRET RUBRIC'));
  assert.ok(!fs.existsSync(path.join(loaded.workspace, 'rubric.json')));
  assert.equal(fs.readFileSync(path.join(loaded.workspace, 'source.txt'), 'utf8'), 'safe source\n');
  const seal = path.join(out, 'private/seal.json');
  fs.writeFileSync(seal, fs.readFileSync(seal, 'utf8').replace('SECRET RUBRIC', 'changed'));
  assert.throws(() => loadCase(out, 'test-case'), /seal changed/);
});
