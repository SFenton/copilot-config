import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { evaluateCapabilityQualification }
  from '../evals/capability-qualification.mjs';

function cases(count, change = value => value) {
  return Array.from({ length: count }, (_, index) => change({
    id: `case-${index}`,
    family: `family-${index % 10}`,
    inputHash: crypto.createHash('sha256').update(`case-${index}`).digest('hex'),
    heldOut: true,
    independentReview: true,
    baseline: {
      complete: true,
      score: 0,
      criticalFailure: false,
      terminalOutcome: 'accepted',
      legs: [
        { id: 'owner', usageKnown: true, credits: 10, tokens: 1000 },
      ],
    },
    candidate: {
      complete: true,
      score: 1,
      criticalFailure: false,
      terminalOutcome: 'accepted',
      legs: [
        { id: 'preparation', usageKnown: true, credits: 0, tokens: 0 },
        { id: 'worker', usageKnown: true, credits: 1, tokens: 500 },
        { id: 'review', usageKnown: true, credits: 1, tokens: 200 },
      ],
    },
  }, index));
}

const base = {
  version: 1,
  project: 'fixture',
  capability: 'fixture-tests',
  minimumCases: 30,
  minimumFamilies: 10,
  familyDimensionUsed: true,
  minimumConfidence: 0.95,
  confidence: 0.97,
  rollbackFaultTested: true,
  completeAllLegAccounting: true,
  margin: 0.05,
  requiredLegs: {
    baseline: ['owner'],
    candidate: ['preparation', 'worker', 'review'],
  },
};

test('qualification requires 30 matched cases, independent families and every workflow leg', () => {
  const result = evaluateCapabilityQualification({ ...base, cases: cases(30) });
  assert.equal(result.promotionEligible, true);
  assert.equal(result.savingsPublishable, true);
  assert.equal(result.cases, 30);
  assert.equal(result.families, 10);
  assert.equal(result.creditSavings, 0.8);
});

test('three-case evidence remains provisional and cannot publish savings', () => {
  const result = evaluateCapabilityQualification({ ...base, cases: cases(3) });
  assert.equal(result.promotionEligible, false);
  assert.equal(result.savingsPublishable, false);
  assert.equal(result.creditSavings, null);
  assert.ok(result.reasons.some(reason => /Fewer than 30/.test(reason)));
});

test('missing failed-leg usage or differing terminal outcomes blocks qualification', () => {
  const missing = evaluateCapabilityQualification({
    ...base,
    cases: cases(30, (item, index) => index === 0 ? {
      ...item,
      candidate: {
        ...item.candidate,
        legs: [{ id: 'failed-worker', usageKnown: false, credits: 0, tokens: 0 }],
      },
    } : item),
  });
  assert.equal(missing.promotionEligible, false);
  assert.equal(missing.allLegUsageKnown, false);

  const mismatch = evaluateCapabilityQualification({
    ...base,
    cases: cases(30, (item, index) => index === 0 ? {
      ...item,
      candidate: { ...item.candidate, terminalOutcome: 'rejected' },
    } : item),
  });
  assert.equal(mismatch.promotionEligible, false);
  assert.ok(mismatch.reasons.some(reason => /terminal outcomes differ/.test(reason)));
});

test('duplicate, non-held-out and unreviewed cases cannot inflate qualification', () => {
  const duplicated = cases(30);
  duplicated[1] = {
    ...duplicated[1],
    inputHash: duplicated[0].inputHash,
  };
  assert.throws(() => evaluateCapabilityQualification({
    ...base,
    cases: duplicated,
  }), /duplicate capability input evidence/);

  const unreviewed = evaluateCapabilityQualification({
    ...base,
    cases: cases(30, (item, index) => index === 0
      ? { ...item, heldOut: false, independentReview: false }
      : item),
  });
  assert.equal(unreviewed.promotionEligible, false);
  assert.ok(unreviewed.reasons.some(reason => /not held out/.test(reason)));
  assert.ok(unreviewed.reasons.some(reason => /independent review/.test(reason)));
});

test('zero-credit baselines cannot publish undefined savings', () => {
  const result = evaluateCapabilityQualification({
    ...base,
    cases: cases(30, item => ({
      ...item,
      baseline: {
        ...item.baseline,
        legs: [{ id: 'owner', usageKnown: true, credits: 0, tokens: 0 }],
      },
    })),
  });
  assert.equal(result.promotionEligible, false);
  assert.equal(result.savingsPublishable, false);
  assert.equal(result.creditSavings, null);
  assert.ok(result.reasons.some(reason => /credits must be positive/.test(reason)));
});

test('unattended qualification fails closed on confidence, rollback, or nonpositive all-leg savings', () => {
  const result = evaluateCapabilityQualification({
    ...base,
    confidence: 0.9,
    rollbackFaultTested: false,
    cases: cases(30, item => ({
      ...item,
      candidate: {
        ...item.candidate,
        legs: [
          { id: 'preparation', usageKnown: true, credits: 0, tokens: 0 },
          { id: 'worker', usageKnown: true, credits: 8, tokens: 500 },
          { id: 'review', usageKnown: true, credits: 2, tokens: 200 },
        ],
      },
    })),
  });
  assert.equal(result.promotionEligible, false);
  assert.ok(result.reasons.includes('Confidence gate failed'));
  assert.ok(result.reasons.includes('Rollback is not fault-tested'));
  assert.ok(result.reasons.includes('Complete all-leg credit savings are not positive'));
});
