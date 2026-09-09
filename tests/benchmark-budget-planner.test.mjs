import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planBenchmarkBudget } from '../evals/benchmark-budget-planner.mjs';

const leg = (id, expectedCredits) => ({
  id,
  model: 'gpt-5.6-sol',
  maxCredits: 30,
  maxInputTokens: 1000,
  maxOutputTokens: 100,
  expectedCredits,
});

const base = {
  version: 1,
  availableCredits: 5000,
  minimumExpectedSavings: 0.2,
  capabilities: [{
    id: 'fixture-tests',
    project: 'fixture',
    sandboxQualified: true,
    currentCases: 3,
    targetCases: 30,
    productionBaselineLegs: [leg('owner', 10)],
    productionCandidateLegs: [leg('worker', 2), leg('review', 2)],
    studyLegsPerNewCase: [
      leg('baseline-owner'),
      leg('candidate-worker'),
      leg('candidate-review'),
      leg('judge'),
    ],
  }],
};

test('planner computes exact calls, maximum credits and tokens before a study', () => {
  const result = planBenchmarkBudget(base);
  assert.equal(result.capabilities[0].coverage.missingCases, 27);
  assert.equal(result.capabilities[0].study.modelCalls, 108);
  assert.equal(result.capabilities[0].study.maximumCredits, 3240);
  assert.equal(result.capabilities[0].study.maximumTokens, 118800);
  assert.equal(result.capabilities[0].production.expectedSavings, 0.6);
  assert.equal(result.candidatePoolTotals.maximumCredits, 3240);
  assert.equal(result.runStudy, true);
});

test('planner selects nothing when expected all-leg evidence is incomplete', () => {
  const input = structuredClone(base);
  input.capabilities[0].productionCandidateLegs[1].expectedCredits = null;
  const result = planBenchmarkBudget(input);
  assert.equal(result.runStudy, false);
  assert.deepEqual(result.totals.selectedCapabilities, []);
  assert.ok(result.capabilities[0].reasons.some(reason =>
    /all-leg expected credit evidence is incomplete/.test(reason)));
});

test('planner rejects studies whose worst-case cap exceeds the explicit budget', () => {
  const result = planBenchmarkBudget({ ...base, availableCredits: 300 });
  assert.equal(result.runStudy, false);
  assert.ok(result.capabilities[0].reasons.some(reason =>
    /exceeds the remaining unreserved budget/.test(reason)));
});

test('planner rejects zero-credit baselines with undefined savings', () => {
  const input = structuredClone(base);
  input.capabilities[0].productionBaselineLegs[0].expectedCredits = 0;
  input.capabilities[0].productionCandidateLegs[0].expectedCredits = 0;
  input.capabilities[0].productionCandidateLegs[1].expectedCredits = 0;
  const result = planBenchmarkBudget(input);
  assert.equal(result.runStudy, false);
  assert.equal(result.capabilities[0].production.expectedSavingsEligible, false);
  assert.ok(result.capabilities[0].reasons.some(reason =>
    /baseline credits must be positive/.test(reason)));
});

test('planner subtracts active and unreconciled reservations before selection', () => {
  const result = planBenchmarkBudget({
    ...base,
    activeReservations: [
      { id: 'running-study', status: 'active', maximumCredits: 1000 },
      { id: 'unknown-usage', status: 'unreconciled', maximumCredits: 1000 },
    ],
  });
  assert.equal(result.reservedCredits, 2000);
  assert.equal(result.spendableCredits, 3000);
  assert.equal(result.runStudy, false);
  assert.ok(result.capabilities[0].reasons.some(reason =>
    /remaining unreserved budget/.test(reason)));
});

test('planner allocates the aggregate budget in declared priority order', () => {
  const second = structuredClone(base.capabilities[0]);
  second.id = 'second-tests';
  const result = planBenchmarkBudget({
    ...base,
    capabilities: [base.capabilities[0], second],
  });
  assert.deepEqual(result.totals.selectedCapabilities, ['fixture-tests']);
  assert.equal(result.capabilities[1].selected, false);
  assert.ok(result.capabilities[1].reasons.some(reason =>
    /remaining unreserved budget/.test(reason)));
  assert.equal(result.remainingCredits, 1760);
});

test('hierarchical planner authorizes zero calls while any mandatory topology leg is unavailable', () => {
  const input = JSON.parse(fs.readFileSync(
    new URL('../evals/capability-study-budget.json', import.meta.url),
    'utf8',
  ));
  const result = planBenchmarkBudget(input);
  assert.equal(result.version, 2);
  assert.equal(result.runStudy, false);
  assert.equal(result.totals.modelCalls, 0);
  assert.equal(result.candidatePoolTotals.modelCalls, 0);
  assert.ok(result.capabilities.every(capability =>
    capability.production.expectedSavings === null &&
    capability.reasons.includes(
      'complete mandatory production topology evidence is unavailable',
    )));
});
