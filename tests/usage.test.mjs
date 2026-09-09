import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratch } from './helpers/scratch.mjs';
import {
  ledgerStatus,
  markUnknown,
  normalizeUsage,
  initializeLedger,
  reserve,
  settle,
  summary,
} from '../skills/budget-workflow/scripts/usage.mjs';

test('usage uses disjoint billed categories, counts hidden legs once and rejects missing telemetry', () => {
  const raw = { totalNanoAiu: 1131300000, tokenDetails: {
    input: { tokenCount: 14922 }, cache_read: { tokenCount: 0 },
    cache_write: { tokenCount: 0 }, output: { tokenCount: 27 },
  }, agentMetrics: { duplicate: { totalNanoAiu: 1131300000 } } };
  assert.equal(normalizeUsage(raw).credits, 1.1313);
  assert.equal(normalizeUsage(raw).totalTokens, 14949);
  assert.throws(() => normalizeUsage({ ...raw, totalNanoAiu: undefined }));
  assert.throws(() => normalizeUsage({ ...raw, tokenDetails: {} }));
  assert.equal(normalizeUsage({ totalNanoAiu: 0, totalUserRequests: 0, totalApiDurationMs: 0, modelMetrics: {} }).credits, 0);
  assert.throws(() => normalizeUsage({ totalNanoAiu: 0, modelMetrics: {} }));
});

test('shared ledger reserves across projects, settles overshoot and fails closed on contention', t => {
  const root = makeScratch('budget-ledger-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'ledger.json');
  initializeLedger(file, 100, 10);
  reserve(file, 'ha', 40);
  reserve(file, 'fst', 40);
  assert.throws(() => reserve(file, 'es', 30), /exhausted/);
  assert.throws(() => reserve(file, 'ha', 1), /Duplicate/);
  settle(file, 'ha', 3);
  reserve(file, 'es', 30);
  fs.writeFileSync(`${file}.lock`, '');
  assert.throws(() => settle(file, 'es', 1), /EEXIST/);
  fs.unlinkSync(`${file}.lock`);
  assert.equal(settle(file, 'fst', 120).overBudget, true);
  assert.throws(() => reserve(file, 'new', 30), /exhausted/);
  assert.throws(() => initializeLedger(file, 100, 0), /EEXIST/);
});

test('missing usage remains an unreconciled reservation and blocks savings', t => {
  const root = makeScratch('budget-ledger-unknown-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'ledger.json');
  initializeLedger(file, 100, 5);
  reserve(file, 'missing', 30);
  assert.equal(ledgerStatus(file).savingsEligible, false);
  markUnknown(file, 'missing', 'usage telemetry missing');
  assert.deepEqual(ledgerStatus(file), {
    version: 2,
    month: new Date().toISOString().slice(0, 7),
    limitCredits: 100,
    knownSpentCredits: 5,
    activeReservedCredits: 0,
    unreconciledReservedCredits: 30,
    reservedExposure: 30,
    savingsEligible: false,
  });
  assert.throws(() => reserve(file, 'too-much', 70), /exhausted/);
  settle(file, 'missing', 7);
  assert.equal(ledgerStatus(file).knownSpentCredits, 12);
});

test('usage summary does not call an out-of-scope research run complete', t => {
  const root = makeScratch('usage-summary-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
    code: 0, timedOut: false, toolIsolationVerified: true, scopeVerified: false,
    workspace: root, toolCalls: 2, durationMs: 10,
  }));
  const result = summary([root]);
  assert.equal(result.runs[0].complete, false);
  assert.equal(result.unknownUsageRuns, 1);
  assert.equal(result.creditsLowerBound, 0);
  assert.equal(result.savingsEligible, false);
});
