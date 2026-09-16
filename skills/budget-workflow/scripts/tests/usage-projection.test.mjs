import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createIntentAcceptanceUsageRecord,
  normalizeUsageLineage,
  projectIntentAcceptanceCostSet,
  projectResearchCreditReductionSet,
  summarizeUsageLineage,
} from '../usage.mjs';

const FIXTURE = path.join(
  '/home/sfenton/.copilot/skills/budget-workflow/scripts/fixtures',
  'frontier-credit-projection.json',
);
const INTENT_FIXTURE = path.join(
  '/home/sfenton/.copilot/skills/budget-workflow/scripts/fixtures',
  'intent-acceptance-credit-projection.json',
);

test('usage lineage distinguishes deterministic, cheap, frontier, and downstream categories', () => {
  const lineage = normalizeUsageLineage([
    { category: 'deterministic-evidence', actualCredits: 1.2, reservedCredits: null, usageHash: null },
    { category: 'cheap-curation', actualCredits: 0.5, reservedCredits: null, usageHash: null },
    { category: 'sol-research', actualCredits: 2.0, reservedCredits: null, usageHash: null },
    { category: 'astra-research', actualCredits: 0.9, reservedCredits: null, usageHash: null },
    { category: 'research-adjudication', actualCredits: 0.7, reservedCredits: null, usageHash: null },
    { category: 'user-intent-acceptance', actualCredits: 0.4, reservedCredits: null, usageHash: null },
    { category: 'downstream-implementation', actualCredits: 1.1, reservedCredits: null, usageHash: null },
  ]);
  const summary = summarizeUsageLineage(lineage);
  assert.equal(summary.categories['deterministic-evidence'], 1.2);
  assert.equal(summary.categories['astra-research'], 0.9);
  assert.ok(Math.abs(summary.frontierResearchCredits - 3.6) < 1e-9);
  assert.equal(summary.intentAcceptanceCredits, 0.4);
  assert.ok(Math.abs(summary.totalCredits - 6.8) < 1e-9);
});

test('sanitized projection fixture meets target frontier and total credit reductions', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const projection = projectResearchCreditReductionSet(fixture);
  assert.equal(projection.estimated, true);
  assert.equal(projection.scenarios['single-frontier-research'].nonResearchFrontierReduction, 1);
  assert.ok(projection.scenarios['single-frontier-research'].totalCreditReduction >= 0.65);
  assert.ok(projection.assumptions.includes('Sol max/default primary'));
  assert.ok(projection.assumptions.includes('former Sol/Opus tandem baseline'));
  assert.ok(projection.scenarios['tandem-frontier-research'].baseline.categories['astra-research'] > 0);
  assert.ok(projection.scenarios['tandem-frontier-research'].candidate.categories['astra-research'] > 0);
  assert.ok(projection.scenarios['tandem-frontier-research'].totalCreditReduction >= 0.6);
  assert.equal(projection.scenarios['tandem-frontier-research'].estimated, true);
  assert.ok(projection.scenarios['tandem-frontier-research'].assumptions.includes('does not claim observed future savings'));
  assert.equal(
    projection.scenarios['tandem-frontier-research'].qualityParityEvidence,
    'deterministic tandem comparison/adjudication replay with identical packet hashes and strict citation validation',
  );
});

test('intent-acceptance projections stay tool-free, packet-bounded, and explicitly labeled', () => {
  const fixture = JSON.parse(fs.readFileSync(INTENT_FIXTURE, 'utf8'));
  const projection = projectIntentAcceptanceCostSet(fixture);
  assert.equal(projection.scenarios['one-pass-gpt-5-4-selected'].attemptCount, 1);
  assert.equal(projection.scenarios['one-remediation-retry'].attemptCount, 2);
  assert.equal(projection.scenarios['sol-like-observed-1x'].observedMultiplier, 1);
  assert.equal(projection.scenarios['opus-like-observed-15x'].observedMultiplier, 15);
  assert.ok(projection.scenarios['opus-like-observed-15x'].pricingAssumption.includes('Projection only'));
  assert.ok(Object.values(projection.scenarios).every(scenario => scenario.toolCalls === 0));
  assert.ok(Object.values(projection.scenarios).every(scenario => scenario.packetTargetMet === true));
});

test('intent-acceptance usage records capture model, attempts, packet bytes, outcome, and credits', () => {
  const record = createIntentAcceptanceUsageRecord({
    selectedModel: 'gpt-5.4',
    attemptCount: 2,
    packetBytes: 16384,
    outcome: 'missing',
    credits: 1.6,
    projected: true,
    pricingAssumption: 'Projection only: one retry at 1x.',
  });
  assert.equal(record.category, 'user-intent-acceptance');
  assert.equal(record.attemptCount, 2);
  assert.equal(record.packetBytes, 16384);
  assert.equal(record.outcome, 'missing');
  assert.equal(record.credits, 1.6);
});
