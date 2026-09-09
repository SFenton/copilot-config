import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { armResult, prepare, solve } from '../evals/delegation-study.mjs';
import { makeScratch } from './helpers/scratch.mjs';

test('delegation study seals six independent frozen cases and a shared ledger', t => {
  const output = path.join(makeScratch('delegation-study-'), 'study');
  t.after(() => fs.rmSync(path.dirname(output), { recursive: true, force: true }));
  const result = prepare(output);
  assert.equal(result.cases, 6);
  const seal = JSON.parse(fs.readFileSync(path.join(output, 'seal.json'), 'utf8'));
  assert.equal(new Set(seal.cases.map(item => item.sourceHash)).size, 6);
  assert.deepEqual(Object.keys(seal.arms), ['frontier', 'worker']);
  assert.equal(fs.existsSync(path.join(output, 'ledger.json')), true);
  assert.equal(seal.historicalOnly, true);
  assert.equal(seal.runnable, false);
  for (const item of seal.cases) {
    assert.equal(fs.existsSync(path.join(output, 'fixtures', item.id, '.git')), true);
  }
});

test('legacy delegation study cannot launch model calls', async t => {
  const output = path.join(makeScratch('delegation-disabled-'), 'study');
  t.after(() => fs.rmSync(path.dirname(output), { recursive: true, force: true }));
  prepare(output);
  await assert.rejects(() => solve(output), /historical and non-runnable/);
});

test('delegation study records an explicit worker candidate', t => {
  const output = path.join(makeScratch('delegation-model-'), 'study');
  t.after(() => fs.rmSync(path.dirname(output), { recursive: true, force: true }));
  prepare(output, 'gemini-3.8-flash', 'low');
  const seal = JSON.parse(fs.readFileSync(path.join(output, 'seal.json'), 'utf8'));
  assert.deepEqual(seal.arms.worker, { model: 'gemini-3.8-flash', effort: 'low', context: 'default' });
});

test('failed worker accounting retains usage instead of treating it as zero', t => {
  const output = makeScratch('delegation-failure-');
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const directory = path.join(output, 'runs', 'case', 'worker', 'output');
  fs.mkdirSync(path.join(directory, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'study-error.json'), JSON.stringify({ error: 'isolation failed' }));
  fs.writeFileSync(path.join(directory, 'worker', 'usage.json'), JSON.stringify({
    totalNanoAiu: 125000000,
    tokenDetails: {
      input: { tokenCount: 1000 },
      cache_read: { tokenCount: 20 },
      cache_write: { tokenCount: 30 },
      output: { tokenCount: 40 },
    },
  }));
  fs.writeFileSync(path.join(directory, 'worker', 'result.json'), JSON.stringify({ durationMs: 5000 }));
  assert.deepEqual(armResult(output, 'case', 'worker'), {
    passed: false,
    credits: 0.125,
    tokens: 1090,
    durationMs: 5000,
    usageKnown: true,
    error: 'isolation failed',
  });
});
