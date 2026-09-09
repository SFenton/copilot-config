#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../skills/budget-workflow/scripts/budget.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function usage(legs, label, expectedIds) {
  assert(Array.isArray(legs) && legs.length > 0, `${label}: all workflow legs required`);
  const ids = new Set();
  let credits = 0;
  let tokens = 0;
  for (const leg of legs) {
    assert(typeof leg.id === 'string' && leg.id.length > 0 && !ids.has(leg.id),
      `${label}: unique leg ids required`);
    ids.add(leg.id);
    assert(leg.usageKnown === true, `${label}/${leg.id}: usage must be known`);
    assert(typeof leg.credits === 'number' && Number.isFinite(leg.credits) &&
      leg.credits >= 0, `${label}/${leg.id}: credits invalid`);
    assert(Number.isInteger(leg.tokens) && leg.tokens >= 0,
      `${label}/${leg.id}: tokens invalid`);
    credits += leg.credits;
    tokens += leg.tokens;
  }
  const legIds = [...ids].sort();
  assert(JSON.stringify(legIds) === JSON.stringify([...expectedIds].sort()),
    `${label}: workflow legs do not match the sealed plan`);
  return { credits, tokens, legIds };
}

export function evaluateCapabilityQualification(data) {
  assert(data && data.version === 1 && typeof data.project === 'string' &&
    typeof data.capability === 'string', 'Capability qualification metadata required');
  assert(Number.isInteger(data.minimumCases) && data.minimumCases >= 30,
    'Capability minimumCases must be at least 30');
  assert(Number.isInteger(data.minimumFamilies) && data.minimumFamilies >= 10,
    'Capability minimumFamilies must be at least 10');
  assert(typeof data.minimumConfidence === 'number' &&
    data.minimumConfidence > 0 && data.minimumConfidence <= 1,
  'Capability minimumConfidence must be in (0, 1]');
  assert(typeof data.confidence === 'number' &&
    data.confidence >= 0 && data.confidence <= 1,
  'Capability confidence must be in [0, 1]');
  assert(typeof data.familyDimensionUsed === 'boolean',
    'Capability familyDimensionUsed must be explicit');
  assert(typeof data.rollbackFaultTested === 'boolean',
    'Capability rollbackFaultTested must be explicit');
  assert(typeof data.completeAllLegAccounting === 'boolean',
    'Capability completeAllLegAccounting must be explicit');
  assert(Array.isArray(data.cases) && data.cases.length > 0,
    'Capability cases required');
  assert(data.requiredLegs && ['baseline', 'candidate'].every(side =>
    Array.isArray(data.requiredLegs[side]) && data.requiredLegs[side].length > 0 &&
    data.requiredLegs[side].every(value => typeof value === 'string' && value.length > 0) &&
    new Set(data.requiredLegs[side]).size === data.requiredLegs[side].length),
  'Sealed baseline and candidate leg inventories required');
  const families = new Set();
  const caseIds = new Set();
  const inputHashes = new Set();
  const reasons = [];
  let allLegUsageKnown = true;
  let baselineCredits = 0;
  let candidateCredits = 0;
  let baselineTokens = 0;
  let candidateTokens = 0;
  const qualityCases = [];
  for (const item of data.cases) {
    assert(typeof item.id === 'string' && typeof item.family === 'string',
      'Case id/family required');
    assert(!caseIds.has(item.id), `Duplicate capability case id: ${item.id}`);
    caseIds.add(item.id);
    assert(typeof item.inputHash === 'string' &&
      /^[a-f0-9]{64}$/.test(item.inputHash),
    `${item.id}: inputHash must be sha256`);
    assert(!inputHashes.has(item.inputHash),
      `${item.id}: duplicate capability input evidence`);
    inputHashes.add(item.inputHash);
    if (item.heldOut !== true) reasons.push(`${item.id}: case is not held out`);
    if (item.independentReview !== true) {
      reasons.push(`${item.id}: independent review is missing`);
    }
    families.add(item.family);
    for (const side of ['baseline', 'candidate']) {
      const result = item[side];
      assert(result && typeof result.terminalOutcome === 'string',
        `${item.id}/${side}: terminal outcome required`);
    }
    if (item.baseline.terminalOutcome !== item.candidate.terminalOutcome) {
      reasons.push(`${item.id}: terminal outcomes differ`);
    }
    let baselineUsage;
    let candidateUsage;
    try {
      baselineUsage = usage(
        item.baseline.legs,
        `${item.id}/baseline`,
        data.requiredLegs.baseline,
      );
      candidateUsage = usage(
        item.candidate.legs,
        `${item.id}/candidate`,
        data.requiredLegs.candidate,
      );
    } catch (error) {
      reasons.push(error.message);
      allLegUsageKnown = false;
      baselineUsage = { credits: 0, tokens: 0 };
      candidateUsage = { credits: 0, tokens: 0 };
    }
    baselineCredits += baselineUsage.credits;
    candidateCredits += candidateUsage.credits;
    baselineTokens += baselineUsage.tokens;
    candidateTokens += candidateUsage.tokens;
    qualityCases.push({
      id: item.id,
      inputHash: item.inputHash,
      heldOut: item.heldOut,
      independentReview: item.independentReview,
      baseline: {
        complete: item.baseline.complete,
        score: item.baseline.score,
        criticalFailure: item.baseline.criticalFailure,
      },
      candidate: {
        complete: item.candidate.complete,
        score: item.candidate.score,
        criticalFailure: item.candidate.criticalFailure,
      },
    });
  }
  if (data.cases.length < data.minimumCases) {
    reasons.push(`Fewer than ${data.minimumCases} capability-matched cases`);
  }
  if (data.familyDimensionUsed && families.size < data.minimumFamilies) {
    reasons.push(`Fewer than ${data.minimumFamilies} independent source families`);
  }
  if (data.confidence < data.minimumConfidence) {
    reasons.push('Confidence gate failed');
  }
  if (!data.rollbackFaultTested) {
    reasons.push('Rollback is not fault-tested');
  }
  if (!data.completeAllLegAccounting) {
    reasons.push('Complete all-leg accounting is missing');
  }
  if (baselineCredits <= 0) {
    reasons.push('Baseline all-leg credits must be positive');
  }
  if (baselineTokens <= 0) {
    reasons.push('Baseline all-leg tokens must be positive');
  }
  const quality = evaluate({
    project: data.project,
    taskClass: data.capability,
    margin: data.margin,
    cases: qualityCases,
  });
  if (!quality.promoted) reasons.push(...quality.reasons.map(reason => `quality: ${reason}`));
  if (baselineCredits > 0 && candidateCredits >= baselineCredits) {
    reasons.push('Complete all-leg credit savings are not positive');
  }
  const promotionEligible = reasons.length === 0;
  return {
    version: 1,
    project: data.project,
    capability: data.capability,
    cases: data.cases.length,
    families: families.size,
    quality,
    allLegUsageKnown,
    baseline: { credits: baselineCredits, tokens: baselineTokens },
    candidate: { credits: candidateCredits, tokens: candidateTokens },
    creditSavings: promotionEligible && baselineCredits > 0
      ? 1 - candidateCredits / baselineCredits : null,
    tokenSavings: promotionEligible && baselineTokens > 0
      ? 1 - candidateTokens / baselineTokens : null,
    promotionEligible,
    savingsPublishable: promotionEligible &&
      baselineCredits > 0 &&
      baselineTokens > 0,
    status: promotionEligible ? 'eligible-for-unattended-application-review' : 'provisional',
    reasons: [...new Set(reasons)],
    warning: 'Eligibility is not automatic application. Independent review must confirm scope, evidence, confidence, rollback and complete all-leg savings.',
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = evaluateCapabilityQualification(
      JSON.parse(fs.readFileSync(process.argv[2], 'utf8')),
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.promotionEligible) process.exitCode = 2;
  } catch (error) {
    console.error(`capability-qualification: ${error.message}`);
    process.exitCode = 1;
  }
}
