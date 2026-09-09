#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finite(value, label, minimum = 0) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= minimum,
    `${label} must be >= ${minimum}`);
  return value;
}

function legPlan(legs, missingCases, label) {
  assert(Array.isArray(legs) && legs.length > 0, `${label}: legs required`);
  const ids = new Set();
  const rows = legs.map(leg => {
    assert(typeof leg.id === 'string' && leg.id.length > 0 && !ids.has(leg.id),
      `${label}: unique leg id required`);
    ids.add(leg.id);
    assert(typeof leg.model === 'string' && leg.model.length > 0,
      `${label}/${leg.id}: model required`);
    const maxCredits = finite(leg.maxCredits, `${label}/${leg.id}: maxCredits`, 30);
    const maxInputTokens = finite(
      leg.maxInputTokens,
      `${label}/${leg.id}: maxInputTokens`,
      1,
    );
    const maxOutputTokens = finite(
      leg.maxOutputTokens,
      `${label}/${leg.id}: maxOutputTokens`,
      1,
    );
    const expectedCredits = leg.expectedCredits === null ||
      leg.expectedCredits === undefined
      ? null
      : finite(leg.expectedCredits, `${label}/${leg.id}: expectedCredits`);
    assert(expectedCredits === null || expectedCredits <= maxCredits,
      `${label}/${leg.id}: expectedCredits exceeds cap`);
    return {
      ...leg,
      maxCredits,
      maxInputTokens,
      maxOutputTokens,
      expectedCredits,
      calls: missingCases,
      totalMaxCredits: maxCredits * missingCases,
      totalMaxTokens: (maxInputTokens + maxOutputTokens) * missingCases,
    };
  });
  return {
    rows,
    modelCalls: rows.reduce((sum, leg) => sum + leg.calls, 0),
    maximumCredits: rows.reduce((sum, leg) => sum + leg.totalMaxCredits, 0),
    maximumTokens: rows.reduce((sum, leg) => sum + leg.totalMaxTokens, 0),
    expectedCreditsPerCase: rows.every(leg => leg.expectedCredits !== null)
      ? rows.reduce((sum, leg) => sum + leg.expectedCredits, 0)
      : null,
  };
}

function planHierarchicalBudget(input) {
  assert(input.runStudy === false && input.authorizedModelCalls === 0,
    'Hierarchical planner must authorize zero model calls without complete evidence');
  const availableCredits = finite(input.availableCredits, 'availableCredits');
  assert(Array.isArray(input.activeReservations ?? []),
    'activeReservations must be an array');
  const activeReservations = (input.activeReservations ?? []).map(reservation => {
    assert(reservation && typeof reservation.id === 'string',
      'Reservation id required');
    assert(['active', 'unreconciled'].includes(reservation.status),
      `${reservation.id}: reservation status invalid`);
    return {
      ...reservation,
      maximumCredits: finite(
        reservation.maximumCredits,
        `${reservation.id}: maximumCredits`,
      ),
    };
  });
  const reservedCredits = activeReservations.reduce((sum, reservation) =>
    sum + reservation.maximumCredits, 0);
  const spendableCredits = Math.max(0, availableCredits - reservedCredits);
  const minimumExpectedSavings = finite(
    input.minimumExpectedSavings,
    'minimumExpectedSavings',
  );
  assert(Array.isArray(input.topologyDefinitions) &&
    input.topologyDefinitions.length === 4,
  'Four complete topology definitions required');
  const topologyIds = new Set();
  for (const topology of input.topologyDefinitions) {
    assert(typeof topology.id === 'string' && !topologyIds.has(topology.id),
      'Unique topology id required');
    topologyIds.add(topology.id);
    assert(Array.isArray(topology.mandatoryProductionLegs) &&
      topology.mandatoryProductionLegs.length > 0,
    `${topology.id}: mandatory production legs required`);
  }
  assert(Array.isArray(input.capabilities) && input.capabilities.length > 0,
    'Capabilities required');
  const capabilities = input.capabilities.map((capability, priority) => {
    assert(typeof capability.id === 'string' && typeof capability.project === 'string',
      'Capability id/project required');
    assert(Number.isInteger(capability.targetCases) && capability.targetCases >= 30,
      `${capability.id}: targetCases must be at least 30`);
    assert(Number.isInteger(capability.currentCases) && capability.currentCases >= 0 &&
      capability.currentCases <= capability.targetCases,
    `${capability.id}: currentCases invalid`);
    assert(topologyIds.has(capability.candidateTopology),
      `${capability.id}: candidate topology invalid`);
    const baseline = capability.productionExpectedCredits?.['direct-frontier-baseline'];
    const candidate = capability.productionExpectedCredits?.[capability.candidateTopology];
    const evidenceComplete = typeof baseline === 'number' &&
      Number.isFinite(baseline) && baseline > 0 &&
      typeof candidate === 'number' && Number.isFinite(candidate) &&
      candidate >= 0;
    const expectedSavings = evidenceComplete ? 1 - candidate / baseline : null;
    const reasons = [];
    if (capability.sandboxQualified !== true) reasons.push('sandbox is not qualified');
    if (!evidenceComplete) {
      reasons.push('complete mandatory production topology evidence is unavailable');
    }
    if (expectedSavings !== null && expectedSavings < minimumExpectedSavings) {
      reasons.push('expected production credit savings is below the minimum');
    }
    return {
      id: capability.id,
      project: capability.project,
      priority,
      candidateTopology: capability.candidateTopology,
      coverage: {
        currentCases: capability.currentCases,
        targetCases: capability.targetCases,
        missingCases: capability.targetCases - capability.currentCases,
        percent: capability.currentCases / capability.targetCases,
      },
      production: {
        baselineExpectedCredits: baseline,
        candidateExpectedCredits: candidate,
        expectedSavings,
        expectedSavingsEligible: expectedSavings !== null &&
          expectedSavings >= minimumExpectedSavings,
      },
      selected: false,
      reasons,
    };
  });
  return {
    version: 2,
    availableCredits,
    activeReservations,
    reservedCredits,
    spendableCredits,
    remainingCredits: spendableCredits,
    minimumExpectedSavings,
    topologyDefinitions: input.topologyDefinitions,
    capabilities,
    candidatePoolTotals: {
      capabilities: capabilities.map(capability => capability.id),
      modelCalls: 0,
      maximumCredits: 0,
      maximumTokens: 0,
    },
    totals: {
      selectedCapabilities: [],
      modelCalls: 0,
      maximumCredits: 0,
      maximumTokens: 0,
    },
    runStudy: false,
    warning: 'No model study is authorized. Every complete team topology retains at least one mandatory production leg with unavailable expected usage.',
  };
}

export function planBenchmarkBudget(input) {
  if (input?.version === 2) return planHierarchicalBudget(input);
  assert(input && input.version === 1, 'Benchmark budget plan version required');
  const availableCredits = finite(input.availableCredits, 'availableCredits');
  assert(Array.isArray(input.activeReservations ?? []),
    'activeReservations must be an array');
  const activeReservations = (input.activeReservations ?? []).map(reservation => {
    assert(reservation && typeof reservation.id === 'string' &&
      reservation.id.length > 0, 'Reservation id required');
    assert(['active', 'unreconciled'].includes(reservation.status),
      `${reservation.id}: reservation status invalid`);
    return {
      ...reservation,
      maximumCredits: finite(
        reservation.maximumCredits,
        `${reservation.id}: maximumCredits`,
      ),
    };
  });
  assert(new Set(activeReservations.map(item => item.id)).size ===
    activeReservations.length, 'Reservation ids must be unique');
  const reservedCredits = activeReservations.reduce((sum, reservation) =>
    sum + reservation.maximumCredits, 0);
  const spendableCredits = Math.max(0, availableCredits - reservedCredits);
  const minimumExpectedSavings = finite(
    input.minimumExpectedSavings,
    'minimumExpectedSavings',
  );
  assert(minimumExpectedSavings > 0 && minimumExpectedSavings < 1,
    'minimumExpectedSavings must be between zero and one');
  assert(Array.isArray(input.capabilities) && input.capabilities.length > 0,
    'Capabilities required');
  const capabilities = input.capabilities.map((capability, priority) => {
    assert(typeof capability.id === 'string' && typeof capability.project === 'string',
      'Capability id/project required');
    assert(Number.isInteger(capability.targetCases) && capability.targetCases >= 30,
      `${capability.id}: targetCases must be at least 30`);
    assert(Number.isInteger(capability.currentCases) && capability.currentCases >= 0 &&
      capability.currentCases <= capability.targetCases,
    `${capability.id}: currentCases invalid`);
    const missingCases = capability.targetCases - capability.currentCases;
    const baseline = legPlan(
      capability.productionBaselineLegs,
      1,
      `${capability.id}/production-baseline`,
    );
    const candidate = legPlan(
      capability.productionCandidateLegs,
      1,
      `${capability.id}/production-candidate`,
    );
    const study = legPlan(
      capability.studyLegsPerNewCase,
      missingCases,
      `${capability.id}/study`,
    );
    const expectedEvidenceComplete = baseline.expectedCreditsPerCase !== null &&
      candidate.expectedCreditsPerCase !== null;
    const expectedSavings = expectedEvidenceComplete &&
      baseline.expectedCreditsPerCase > 0
      ? 1 - candidate.expectedCreditsPerCase / baseline.expectedCreditsPerCase
      : null;
    const reasons = [];
    if (capability.sandboxQualified !== true) reasons.push('sandbox is not qualified');
    if (missingCases === 0) reasons.push('case target is already complete');
    if (!expectedEvidenceComplete) reasons.push('all-leg expected credit evidence is incomplete');
    if (expectedEvidenceComplete && baseline.expectedCreditsPerCase <= 0) {
      reasons.push('expected production baseline credits must be positive');
    }
    if (expectedSavings !== null && expectedSavings < minimumExpectedSavings) {
      reasons.push('expected production credit savings is below the minimum');
    }
    return {
      id: capability.id,
      project: capability.project,
      priority,
      coverage: {
        currentCases: capability.currentCases,
        targetCases: capability.targetCases,
        missingCases,
        percent: capability.targetCases === 0
          ? 1 : capability.currentCases / capability.targetCases,
      },
      production: {
        baseline,
        candidate,
        expectedSavings,
        expectedSavingsEligible: expectedSavings !== null &&
          expectedSavings >= minimumExpectedSavings,
      },
      study,
      selected: false,
      reasons,
    };
  });
  let remainingCredits = spendableCredits;
  for (const capability of capabilities) {
    const otherwiseEligible = capability.reasons.length === 0 &&
      capability.production.expectedSavings !== null &&
      capability.production.expectedSavings >= minimumExpectedSavings;
    if (!otherwiseEligible) continue;
    if (capability.study.maximumCredits > remainingCredits) {
      capability.reasons.push(
        'worst-case study credit cap exceeds the remaining unreserved budget',
      );
      continue;
    }
    capability.selected = true;
    remainingCredits -= capability.study.maximumCredits;
  }
  const selected = capabilities.filter(capability => capability.selected);
  const candidatePoolTotals = {
    capabilities: capabilities.map(capability => capability.id),
    modelCalls: capabilities.reduce((sum, capability) =>
      sum + capability.study.modelCalls, 0),
    maximumCredits: capabilities.reduce((sum, capability) =>
      sum + capability.study.maximumCredits, 0),
    maximumTokens: capabilities.reduce((sum, capability) =>
      sum + capability.study.maximumTokens, 0),
  };
  const totals = {
    selectedCapabilities: selected.map(capability => capability.id),
    modelCalls: selected.reduce((sum, capability) =>
      sum + capability.study.modelCalls, 0),
    maximumCredits: selected.reduce((sum, capability) =>
      sum + capability.study.maximumCredits, 0),
    maximumTokens: selected.reduce((sum, capability) =>
      sum + capability.study.maximumTokens, 0),
  };
  return {
    version: 1,
    availableCredits,
    activeReservations,
    reservedCredits,
    spendableCredits,
    remainingCredits,
    minimumExpectedSavings,
    capabilities,
    candidatePoolTotals,
    totals,
    runStudy: selected.length > 0 && totals.maximumCredits <= spendableCredits,
    warning: selected.length
      ? 'Selected capabilities still require frontier approval before model calls.'
      : 'No model study is authorized. Collect missing all-leg production cost evidence or change the explicit budget before reconsidering.',
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify(planBenchmarkBudget(
      JSON.parse(fs.readFileSync(process.argv[2], 'utf8')),
    ), null, 2));
  } catch (error) {
    console.error(`benchmark-budget-planner: ${error.message}`);
    process.exitCode = 1;
  }
}
