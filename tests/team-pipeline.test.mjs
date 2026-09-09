import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createPipelineLegReceipt,
  createTriggerReceipt,
  evaluateTrustTier,
  nextWorkerAttempt,
  pipelineContractHash,
  pipelinePhaseContracts,
  validateMediumAcceptance,
  validateOpportunityPolicyV3,
  validateRepositoryApplyAuthorization,
  validateTriggerReceipt,
  verifyPipelineLegs,
} from '../skills/budget-workflow/scripts/team-pipeline.mjs';
import {
  opportunityPlan,
  executeOpportunityPhase,
} from '../skills/budget-workflow/scripts/opportunities.mjs';
import {
  createReleaseCompletion,
  nextReleaseAction,
  executeReleaseStep,
  releasePlan,
  verifyReleaseCompletion,
  validateReleaseMachineV3,
} from '../skills/budget-workflow/scripts/release-machine.mjs';
import {
  sha256,
  validateToolRegistry,
} from '../skills/budget-workflow/scripts/workflow.mjs';
import { makeScratch } from './helpers/scratch.mjs';

const medium = {
  model: 'claude-sonnet-5',
  effort: 'medium',
  context: 'default',
};
const sensitiveMedium = {
  model: 'gpt-5.6-sol',
  effort: 'medium',
  context: 'default',
};
const cheap = {
  model: 'gpt-5-mini',
  effort: 'medium',
  context: 'default',
};
const critical = {
  model: 'gpt-5.6-sol',
  effort: 'max',
  context: 'long_context',
};
const fixtureContractPolicy = fixturePolicy();
const fixtureContractOpportunity = fixtureContractPolicy.opportunities[0];
const fixturePipelineHash = pipelineContractHash(
  'fixture',
  fixtureContractOpportunity,
  fixtureContractPolicy.toolRegistry,
);
const receiptBinding = {
  workflowId: 'fixture-workflow',
  pipelineHash: fixturePipelineHash,
  repository: '/fixture',
  baseRevision: 'b'.repeat(40),
  scopeHash: 'c'.repeat(64),
};
const expectedFixturePhases = pipelinePhaseContracts(
  fixtureContractOpportunity,
  fixtureContractPolicy.toolRegistry,
);

function pipelineContext(overrides = {}) {
  return {
    pipelineId: 'fixture-known-work',
    teamId: 'fixture-known-work-team',
    project: 'fixture',
    opportunityId: 'known-work',
    ...receiptBinding,
    expectedPhases: expectedFixturePhases,
    workerPhaseId: 'implement-bounded',
    coordinatorPhaseId: 'coordinate',
    reviewPhaseId: 'review-bounded',
    ...overrides,
  };
}

function fixtureRegistry() {
  return validateToolRegistry({
    version: 1,
    project: 'fixture',
    tools: [
      {
        id: 'precheck-fixture',
        kind: 'command',
        argv: [process.execPath, '-e', 'process.stdout.write("prechecked")'],
        cwd: '.',
        timeoutSeconds: 30,
        sideEffect: 'workspace',
        environment: [],
      },
      {
        id: 'check-fixture',
        kind: 'command',
        argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
        cwd: '.',
        timeoutSeconds: 30,
        sideEffect: 'workspace',
        environment: [],
      },
    ],
  }, 'fixture');
}

function fixturePolicy() {
  return {
    version: 3,
    project: 'fixture',
    qualification: {
      status: 'provisional',
      minimumUnattendedCases: 30,
      automaticApplication: false,
    },
    triggerCatalog: [
      {
        id: 'approved-novel-public-research',
        category: 'research',
        description: 'Approved exact public gap.',
      },
      {
        id: 'binding-novel-spec-required',
        category: 'specification',
        description: 'Novel evidence needs a binding spec.',
      },
      {
        id: 'fixture-critical-conflict',
        category: 'critical-review',
        description: 'Deterministic evidence remains contradictory.',
      },
    ],
    opportunities: [{
      id: 'known-work',
      label: 'Known work',
      triggers: ['known work'],
      evidence: 'repository',
      enabled: true,
      evaluationStatus: 'provisional',
      casePacketStatus: 'provisional',
      skills: [],
      team: {
        id: 'fixture-known-work-team',
        topology: 'medium-owner-cheap-worker-medium-review',
        trustTier: 'provisional-staging',
        maxRevisions: 1,
        coordinator: {
          role: 'medium-coordinator',
          profile: medium,
          evidenceStatus: 'provisional',
        },
        reviewer: {
          role: 'medium-review',
          profile: medium,
          evidenceStatus: 'provisional',
        },
        workerCandidate: {
          role: 'cheap-worker',
          enabled: true,
          profile: cheap,
          evidenceStatus: 'provisional',
          currentCases: 3,
          capability: 'fixture-tests',
          sandboxProfile: 'fixture-tests',
          delegationClass: 'test-generation',
          validators: ['check-fixture'],
          authority: 'staging-only',
        },
        repositoryApply: { authority: 'operator', enabled: false },
      },
      conditionalProfiles: [
        {
          id: 'external-research',
          kind: 'research-frontier',
          profile: {
            model: 'gpt-6-astra',
            effort: 'high',
            context: 'default',
          },
          triggerIds: ['approved-novel-public-research'],
          requiresTriggerReceipt: true,
        },
        {
          id: 'binding-spec',
          kind: 'spec-planner',
          profile: {
            model: 'gpt-5.6-sol',
            effort: 'high',
            context: 'default',
          },
          triggerIds: ['binding-novel-spec-required'],
          requiresTriggerReceipt: true,
        },
        {
          id: 'critical-review',
          kind: 'risk-triggered-frontier-review',
          profile: critical,
          triggerIds: ['fixture-critical-conflict'],
          requiresTriggerReceipt: true,
        },
      ],
      phases: [
        {
          id: 'research-if-triggered',
          kind: 'research-frontier',
          profileRef: 'conditional:external-research',
          condition: {
            triggerIds: ['approved-novel-public-research'],
            requiresTriggerReceipt: true,
          },
        },
        {
          id: 'spec-if-triggered',
          kind: 'spec-planner',
          profileRef: 'conditional:binding-spec',
          condition: {
            triggerIds: ['binding-novel-spec-required'],
            requiresTriggerReceipt: true,
          },
        },
        {
          id: 'precheck',
          kind: 'deterministic',
          tool: 'precheck-fixture',
          sideEffect: 'workspace',
        },
        { id: 'coordinate', kind: 'medium-coordinator', profileRef: 'coordinator' },
        {
          id: 'implement-bounded',
          kind: 'cheap-worker',
          profileRef: 'worker-candidate',
          enabled: true,
        },
        {
          id: 'validate',
          kind: 'deterministic',
          tool: 'check-fixture',
          sideEffect: 'workspace',
        },
        { id: 'review-bounded', kind: 'medium-review', profileRef: 'reviewer' },
        {
          id: 'critical-review-if-triggered',
          kind: 'risk-triggered-frontier-review',
          profileRef: 'conditional:critical-review',
          condition: {
            triggerIds: ['fixture-critical-conflict'],
            requiresTriggerReceipt: true,
          },
        },
      ],
      rationale: 'Fixture pipeline.',
    }],
    toolRegistry: fixtureRegistry(),
  };
}

function gitFixture(prefix) {
  const root = makeScratch(prefix);
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', 'fixture.txt']);
  execFileSync('git', [
    '-C', root,
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.com',
    'commit', '-qm', 'fixture',
  ]);
  return root;
}

function leg(overrides = {}) {
  return createPipelineLegReceipt({
    ...receiptBinding,
    pipelineId: 'fixture-known-work',
    teamId: 'fixture-known-work-team',
    project: 'fixture',
    opportunityId: 'known-work',
    phaseId: 'coordinate',
    phaseKind: 'medium-coordinator',
    role: 'medium-coordinator',
    trustTier: 'provisional-staging',
    attempt: 1,
    profile: medium,
    authority: 'semantic-coordination',
    configurationEvidence: 'a'.repeat(64),
    usage: {
      state: 'measured',
      modelCalls: 1,
      credits: 1,
    },
    state: 'executed',
    outcome: 'accepted',
    previousReceiptHash: null,
    startedAt: '2026-09-08T00:00:00.000Z',
    completedAt: '2026-09-08T00:00:01.000Z',
    ...overrides,
  });
}

function deterministicLeg(previousReceiptHash, attempt = 1, phaseId = 'validate') {
  const contract = expectedFixturePhases.find(phase => phase.id === phaseId);
  const builtin = contract?.builtin;
  return leg({
    phaseId,
    phaseKind: 'deterministic',
    role: builtin === 'deterministic-router'
      ? 'deterministic-router'
      : builtin === 'bounded-evidence-collector'
        ? 'deterministic-evidence'
        : 'deterministic-tool',
    attempt,
    profile: null,
    authority: 'deterministic-local',
    configurationEvidence: null,
    usage: { state: 'deterministic', modelCalls: 0, credits: 0 },
    toolEvidence: builtin
      ? { builtin }
      : {
          toolId: contract.tool,
          toolHash: contract.toolContract.toolHash,
          sideEffect: contract.toolContract.sideEffect,
          argvHash: contract.toolContract.argvHash,
          exitCode: 0,
        },
    previousReceiptHash,
    outcome: 'accepted',
  });
}

function coordinatorPrefix() {
  const route = deterministicLeg(null, 1, 'route-opportunity');
  const collect = deterministicLeg(route.receiptHash, 1, 'collect-evidence');
  const research = leg({
    phaseId: 'research-if-triggered',
    phaseKind: 'research-frontier',
    role: 'research-frontier',
    profile: {
      model: 'gpt-6-astra',
      effort: 'high',
      context: 'default',
    },
    authority: 'semantic-research-only',
    configurationEvidence: null,
    usage: { state: 'not-run', modelCalls: 0, credits: 0 },
    state: 'condition-false',
    conditionReceipt: { matched: false },
    previousReceiptHash: collect.receiptHash,
    outcome: 'not-run',
  });
  const spec = leg({
    phaseId: 'spec-if-triggered',
    phaseKind: 'spec-planner',
    role: 'spec-planner',
    profile: {
      model: 'gpt-5.6-sol',
      effort: 'high',
      context: 'default',
    },
    authority: 'semantic-specification-only',
    configurationEvidence: null,
    usage: { state: 'not-run', modelCalls: 0, credits: 0 },
    state: 'condition-false',
    conditionReceipt: { matched: false },
    previousReceiptHash: research.receiptHash,
    outcome: 'not-run',
  });
  const precheck = deterministicLeg(spec.receiptHash, 1, 'precheck');
  const coordinator = leg({
    previousReceiptHash: precheck.receiptHash,
    outcome: 'dispatch-approved',
  });
  return [route, collect, research, spec, precheck, coordinator];
}

test('normal known work is medium-owned with deterministic routing and no mandatory frontier call', () => {
  const policy = fixturePolicy();
  validateOpportunityPolicyV3(policy, policy.toolRegistry);
  const plan = opportunityPlan({
    question: 'known work',
    opportunity: 'known-work',
  }, policy);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.phases.slice(0, 2).map(phase => phase.builtin), [
    'deterministic-router',
    'bounded-evidence-collector',
  ]);
  assert.equal(plan.phases.some(phase =>
    ['research-frontier', 'spec-planner', 'risk-triggered-frontier-review']
      .includes(phase.kind) && !phase.condition), false);
  assert.equal(plan.team.coordinator.profile.effort, 'medium');
  assert.equal(plan.team.maxRevisions, 1);
  const extraValidator = fixturePolicy();
  extraValidator.opportunities[0].team.workerCandidate.validators.push(
    'precheck-fixture',
  );
  assert.throws(() => validateOpportunityPolicyV3(
    extraValidator,
    extraValidator.toolRegistry,
  ), /validators must exactly match/i);
  const changedEvidence = structuredClone(policy.opportunities[0]);
  changedEvidence.evidence = 'hybrid';
  assert.notEqual(
    pipelineContractHash('fixture', changedEvidence, policy.toolRegistry),
    pipelineContractHash(
      'fixture',
      policy.opportunities[0],
      policy.toolRegistry,
    ),
  );
  const changedSideEffect = structuredClone(policy.opportunities[0]);
  changedSideEffect.phases.find(phase =>
    phase.id === 'precheck').sideEffect = 'none';
  assert.notEqual(
    pipelineContractHash('fixture', changedSideEffect, policy.toolRegistry),
    pipelineContractHash(
      'fixture',
      policy.opportunities[0],
      policy.toolRegistry,
    ),
  );
  const changedToolRegistry = structuredClone(policy.toolRegistry);
  changedToolRegistry.tools.find(tool =>
    tool.id === 'check-fixture').timeoutSeconds += 1;
  assert.notEqual(
    pipelineContractHash(
      'fixture',
      policy.opportunities[0],
      changedToolRegistry,
    ),
    pipelineContractHash(
      'fixture',
      policy.opportunities[0],
      policy.toolRegistry,
    ),
  );
});

test('registered deterministic phases execute without a model launch or model-bound authorization', t => {
  const root = gitFixture('hierarchical-deterministic-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = fixturePolicy();
  const binding = {
    workflowId: 'deterministic-workflow',
    pipelineHash: pipelineContractHash(
      'fixture',
      policy.opportunities[0],
      policy.toolRegistry,
    ),
    repository: fs.realpathSync(root),
    baseRevision: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    scopeHash: 'd'.repeat(64),
  };
  const route = deterministicLeg(null, 1, 'route-opportunity');
  const boundRoute = leg({
    ...route,
    ...binding,
    receiptHash: undefined,
  });
  const collect = leg({
    ...binding,
    phaseId: 'collect-evidence',
    phaseKind: 'deterministic',
    role: 'deterministic-evidence',
    profile: null,
    authority: 'deterministic-local',
    configurationEvidence: null,
    usage: { state: 'deterministic', modelCalls: 0, credits: 0 },
    toolEvidence: { builtin: 'bounded-evidence-collector' },
    previousReceiptHash: boundRoute.receiptHash,
    outcome: 'accepted',
  });
  const research = leg({
    ...binding,
    phaseId: 'research-if-triggered',
    phaseKind: 'research-frontier',
    role: 'research-frontier',
    profile: {
      model: 'gpt-6-astra',
      effort: 'high',
      context: 'default',
    },
    authority: 'semantic-research-only',
    configurationEvidence: null,
    usage: { state: 'not-run', modelCalls: 0, credits: 0 },
    state: 'condition-false',
    conditionReceipt: { matched: false },
    previousReceiptHash: collect.receiptHash,
    outcome: 'not-run',
  });
  const spec = leg({
    ...binding,
    phaseId: 'spec-if-triggered',
    phaseKind: 'spec-planner',
    role: 'spec-planner',
    profile: {
      model: 'gpt-5.6-sol',
      effort: 'high',
      context: 'default',
    },
    authority: 'semantic-specification-only',
    configurationEvidence: null,
    usage: { state: 'not-run', modelCalls: 0, credits: 0 },
    state: 'condition-false',
    conditionReceipt: { matched: false },
    previousReceiptHash: research.receiptHash,
    outcome: 'not-run',
  });
  const receipts = [boundRoute, collect, research, spec];
  const result = executeOpportunityPhase(
    root,
    policy,
    { question: 'known work', opportunity: 'known-work' },
    'precheck',
    null,
    {
      execute: true,
      allowedSideEffects: ['workspace'],
      workflowId: binding.workflowId,
      currentRevision: binding.baseRevision,
      scopeHash: binding.scopeHash,
      beforeStateHash: 'before',
      afterStateHash: 'after',
      receipts,
    },
  );
  assert.equal(result.execution.status, 'accepted');
  assert.deepEqual(result.receipt.usage, {
    state: 'deterministic',
    modelCalls: 0,
    credits: 0,
  });
  assert.equal(result.receipt.profile, null);
  assert.equal(result.receipt.configurationEvidence, null);
  assert.throws(() => executeOpportunityPhase(
    root,
    policy,
    { question: 'known work', opportunity: 'known-work' },
    'validate',
    null,
    {
      execute: true,
      allowedSideEffects: ['workspace'],
      workflowId: binding.workflowId,
      currentRevision: binding.baseRevision,
      scopeHash: binding.scopeHash,
      beforeStateHash: 'before',
      afterStateHash: 'after',
      receipts,
    },
  ), /not the next declared pipeline action/);
});

test('research and critical review require named evidence-bound trigger receipts', () => {
  const preceding = '1'.repeat(64);
  const receipt = createTriggerReceipt({
    project: 'fixture',
    opportunityId: 'known-work',
    triggerId: 'fixture-critical-conflict',
    evidenceHash: '2'.repeat(64),
    precedingReceiptHash: preceding,
    observedAt: '2026-09-08T00:00:00.000Z',
  });
  assert.equal(validateTriggerReceipt(receipt, {
    project: 'fixture',
    opportunityId: 'known-work',
    triggerIds: ['fixture-critical-conflict'],
    precedingReceiptHash: preceding,
  }).receiptHash, receipt.receiptHash);
  assert.throws(() => validateTriggerReceipt(receipt, {
    project: 'fixture',
    opportunityId: 'known-work',
    triggerIds: ['approved-novel-public-research'],
    precedingReceiptHash: preceding,
  }), /allowed trigger/);

  const rootReceipt = createTriggerReceipt({
    project: 'fixture',
    opportunityId: 'known-work',
    triggerId: 'fixture-critical-conflict',
    evidenceHash: '4'.repeat(64),
    precedingReceiptHash: null,
    observedAt: '2026-09-08T00:00:00.000Z',
  });
  const criticalLeg = leg({
    phaseId: 'critical-review-if-triggered',
    phaseKind: 'risk-triggered-frontier-review',
    role: 'risk-triggered-frontier-review',
    profile: critical,
    authority: 'semantic-review-only',
    conditionReceipt: rootReceipt,
    allowedTriggerIds: ['fixture-critical-conflict'],
  });
  assert.equal(criticalLeg.conditionReceipt.receiptHash, rootReceipt.receiptHash);
  assert.throws(() => leg({
    phaseId: 'critical-review-if-triggered',
    phaseKind: 'risk-triggered-frontier-review',
    role: 'risk-triggered-frontier-review',
    profile: critical,
    authority: 'semantic-review-only',
    conditionReceipt: rootReceipt,
    allowedTriggerIds: ['approved-novel-public-research'],
  }), /allowed trigger/);
});

test('one reviewer-directed revision is accepted and a second revision fails closed', () => {
  const prefix = coordinatorPrefix();
  const coordinator = prefix.at(-1);
  const initial = leg({
    phaseId: 'implement-bounded',
    phaseKind: 'cheap-worker',
    role: 'cheap-worker',
    profile: cheap,
    authority: 'staging-only',
    previousReceiptHash: coordinator.receiptHash,
  });
  const firstValidation = deterministicLeg(initial.receiptHash);
  const review = leg({
    phaseId: 'review-bounded',
    phaseKind: 'medium-review',
    role: 'medium-review',
    authority: 'semantic-review-only',
    previousReceiptHash: firstValidation.receiptHash,
    outcome: 'revision-requested',
  });
  const rejectedReview = leg({
    phaseId: 'review-bounded',
    phaseKind: 'medium-review',
    role: 'medium-review',
    authority: 'semantic-review-only',
    previousReceiptHash: firstValidation.receiptHash,
    outcome: 'rejected',
  });
  const rejectedPipeline = verifyPipelineLegs(
    [...prefix, initial, firstValidation, rejectedReview],
    pipelineContext(),
  );
  assert.equal(rejectedPipeline.terminal, true);
  assert.equal(rejectedPipeline.nextPhaseId, null);
  const forgedValidation = {
    ...firstValidation,
    toolEvidence: {
      ...firstValidation.toolEvidence,
      toolHash: '0'.repeat(64),
    },
  };
  delete forgedValidation.receiptHash;
  forgedValidation.receiptHash = sha256(forgedValidation);
  assert.throws(() => verifyPipelineLegs(
    [...prefix, initial, forgedValidation],
    pipelineContext(),
  ), /deterministic tool receipt/i);
  const revision = leg({
    phaseId: 'implement-bounded',
    phaseKind: 'cheap-worker',
    role: 'cheap-worker',
    profile: cheap,
    authority: 'staging-only',
    attempt: 2,
    revisionParent: initial.receiptHash,
    defectReceipt: review.receiptHash,
    previousReceiptHash: review.receiptHash,
  });
  const secondValidation = deterministicLeg(revision.receiptHash, 2);
  const accepted = leg({
    phaseId: 'review-bounded',
    phaseKind: 'medium-review',
    role: 'medium-review',
    authority: 'semantic-review-only',
    attempt: 2,
    previousReceiptHash: secondValidation.receiptHash,
    outcome: 'accepted',
  });
  const verified = verifyPipelineLegs(
    [
      ...prefix,
      initial,
      firstValidation,
      review,
      revision,
      secondValidation,
      accepted,
    ],
    pipelineContext(),
  );
  assert.equal(verified.workerAttempts, 2);
  assert.equal(verified.revisions, 1);
  assert.throws(() => verifyPipelineLegs(
    [
      ...prefix,
      initial,
      firstValidation,
      review,
      revision,
      secondValidation,
      accepted,
    ],
    pipelineContext({ scopeHash: 'e'.repeat(64) }),
  ), /scope mismatch/i);
  assert.deepEqual(nextWorkerAttempt(
    [...prefix, initial, firstValidation, review],
    pipelineContext(),
  ), {
    attempt: 2,
    revisionParent: initial.receiptHash,
    defectReceipt: review.receiptHash,
    previousReceiptHash: review.receiptHash,
    verifiedPipelineReceiptHash: review.receiptHash,
  });

  const secondRequest = leg({
    phaseId: 'review-bounded',
    phaseKind: 'medium-review',
    role: 'medium-review',
    authority: 'semantic-review-only',
    attempt: 2,
    previousReceiptHash: secondValidation.receiptHash,
    outcome: 'revision-requested',
  });
  assert.throws(() => verifyPipelineLegs(
    [
      ...prefix,
      initial,
      firstValidation,
      review,
      revision,
      secondValidation,
      secondRequest,
    ],
    pipelineContext(),
  ), /second reviewer-directed revision/i);

  const duplicateWithoutReview = leg({
    phaseId: 'implement-bounded',
    phaseKind: 'cheap-worker',
    role: 'cheap-worker',
    profile: cheap,
    authority: 'staging-only',
    attempt: 2,
    revisionParent: initial.receiptHash,
    previousReceiptHash: initial.receiptHash,
  });
  assert.throws(() => verifyPipelineLegs(
    [...prefix, initial, duplicateWithoutReview],
    pipelineContext(),
  ), /bound policy|reviewer defect receipt/i);

  const replayedRequest = leg({
    phaseId: 'review-bounded',
    phaseKind: 'medium-review',
    role: 'medium-review',
    authority: 'semantic-review-only',
    attempt: 2,
    previousReceiptHash: accepted.receiptHash,
    outcome: 'revision-requested',
  });
  assert.throws(() => verifyPipelineLegs(
    [
      ...prefix,
      initial,
      firstValidation,
      review,
      revision,
      secondValidation,
      accepted,
      replayedRequest,
    ],
    pipelineContext(),
  ), /bound policy|active worker attempt|already terminal/i);
});

test('initial cheap work requires an immediately preceding coordinator dispatch', () => {
  const prefix = coordinatorPrefix();
  const coordinator = prefix.at(-1);
  assert.deepEqual(nextWorkerAttempt(prefix, pipelineContext()), {
    attempt: 1,
    revisionParent: null,
    defectReceipt: null,
    previousReceiptHash: coordinator.receiptHash,
    verifiedPipelineReceiptHash: coordinator.receiptHash,
  });
  assert.throws(() => nextWorkerAttempt([coordinator], pipelineContext()),
    /chain mismatch|complete accepted pipeline prefix/i);
});

test('all-leg accounting records conditional not-run, failures, fallback and unreconciled usage', () => {
  const conditional = leg({
    phaseId: 'research-if-triggered',
    phaseKind: 'research-frontier',
    role: 'research-frontier',
    profile: {
      model: 'gpt-6-astra',
      effort: 'high',
      context: 'default',
    },
    authority: 'semantic-research-only',
    configurationEvidence: null,
    conditionReceipt: {
      triggerId: 'approved-novel-public-research',
      matched: false,
      evidenceHash: '3'.repeat(64),
    },
    usage: { state: 'not-run', modelCalls: 0, credits: 0 },
    state: 'condition-false',
    outcome: 'not-run',
  });
  assert.equal(conditional.state, 'condition-false');
  assert.equal(conditional.usage.modelCalls, 0);

  const unknown = leg({
    state: 'unreconciled',
    outcome: 'fallback-required',
    usage: {
      state: 'unreconciled',
      modelCalls: 1,
      credits: null,
      reservedCredits: 30,
    },
  });
  assert.equal(unknown.usage.credits, null);
  assert.equal(unknown.usage.reservedCredits, 30);

  const failed = createPipelineLegReceipt({
    ...receiptBinding,
    pipelineId: 'fixture-known-work',
    teamId: 'fixture-known-work-team',
    project: 'fixture',
    opportunityId: 'known-work',
    phaseId: 'validate',
    phaseKind: 'deterministic',
    role: 'deterministic-tool',
    trustTier: 'provisional-staging',
    attempt: 1,
    profile: null,
    authority: 'deterministic-local',
    configurationEvidence: null,
    usage: { state: 'deterministic', modelCalls: 0, credits: 0 },
    state: 'failed',
    outcome: 'fallback',
    toolEvidence: { toolId: 'check-fixture', exitCode: 1 },
    previousReceiptHash: null,
    startedAt: '2026-09-08T00:00:00.000Z',
    completedAt: '2026-09-08T00:00:01.000Z',
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.outcome, 'fallback');
});

test('medium acceptance and operator apply authorization are separate authorities', t => {
  const repository = makeScratch('medium-acceptance-');
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const validation = {
    candidateSha256: '4'.repeat(64),
    evidenceSha256: '5'.repeat(64),
    sourceTreeHash: '6'.repeat(64),
    validatorId: 'check-fixture',
    sandboxProfileId: 'fixture-tests',
  };
  validation.evidenceHash = sha256(validation);
  const staging = {
    version: 2,
    staged: true,
    applied: false,
    workflowId: 'reviewed-application-workflow',
    pipelineHash: '9'.repeat(64),
    verifiedPipelineReceiptHash: '8'.repeat(64),
    jobHash: '7'.repeat(64),
    sandboxReadinessHash: '6'.repeat(64),
    repository,
    baseRevision: 'revision',
    scopeHash: '7'.repeat(64),
    candidateSha256: validation.candidateSha256,
    evidenceSha256: validation.evidenceSha256,
    plan: {
      project: 'fixture',
      opportunityId: 'known-work',
      capability: 'fixture-tests',
      reviewer: sensitiveMedium,
    },
  };
  const acceptance = {
    version: 1,
    kind: 'medium-review-acceptance',
    approvedBy: 'medium-reviewer',
    decision: 'accept-exact-staged-candidate',
    workflowId: staging.workflowId,
    pipelineHash: staging.pipelineHash,
    verifiedPipelineReceiptHash: staging.verifiedPipelineReceiptHash,
    jobHash: staging.jobHash,
    sandboxReadinessHash: staging.sandboxReadinessHash,
    project: 'fixture',
    opportunityId: 'known-work',
    capability: 'fixture-tests',
    repository,
    baseRevision: 'revision',
    scopeHash: staging.scopeHash,
    candidateSha256: staging.candidateSha256,
    evidenceSha256: staging.evidenceSha256,
    validationEvidenceHash: validation.evidenceHash,
    configurationEvidenceHash: '8'.repeat(64),
    reviewer: sensitiveMedium,
    approvedAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-09T00:00:00.000Z',
  };
  assert.equal(validateMediumAcceptance(staging, acceptance, validation, {
    configurationEvidenceHash: acceptance.configurationEvidenceHash,
    now: Date.parse('2026-09-08T01:00:00.000Z'),
  }).accepted, true);
  const authorization = {
    version: 1,
    kind: 'repository-apply-authorization',
    authorizedBy: 'operator',
    workflowId: staging.workflowId,
    pipelineHash: staging.pipelineHash,
    verifiedPipelineReceiptHash: staging.verifiedPipelineReceiptHash,
    jobHash: staging.jobHash,
    sandboxReadinessHash: staging.sandboxReadinessHash,
    project: 'fixture',
    opportunityId: 'known-work',
    capability: 'fixture-tests',
    repository,
    baseRevision: 'revision',
    scopeHash: staging.scopeHash,
    candidateSha256: staging.candidateSha256,
    validationEvidenceHash: validation.evidenceHash,
    issuedAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  assert.equal(validateRepositoryApplyAuthorization(authorization, {
    ...authorization,
    now: Date.parse('2026-09-08T01:00:00.000Z'),
  }).authorized, true);
  assert.notEqual(sha256(acceptance), sha256(authorization));
});

test('reviewed application has no case floor while unattended application enforces every promotion gate', () => {
  const reviewed = evaluateTrustTier({
    requestedTier: 'reviewed-application',
    preValidationPassed: true,
    mediumAcceptanceValid: true,
    repositoryApplyAuthorizationValid: true,
    postValidationPassed: true,
    validationBindingIdentical: true,
    rollbackBound: true,
    matchedHeldOutCases: 1,
  });
  assert.equal(reviewed.allowed, true);
  assert.deepEqual(reviewed.permissions, ['apply-exact-reviewed-artifact']);

  const rejected = evaluateTrustTier({
    requestedTier: 'unattended-application',
    preValidationPassed: true,
    mediumAcceptanceValid: true,
    repositoryApplyAuthorizationValid: true,
    postValidationPassed: true,
    validationBindingIdentical: true,
    rollbackBound: true,
    matchedHeldOutCases: 29,
    familyDimensionUsed: true,
    families: 9,
    independentReview: false,
    confidence: 0.94,
    minimumConfidence: 0.95,
    matchingTerminalOutcomes: false,
    criticalFailures: 1,
    rollbackFaultTested: false,
    completeAllLegSavings: null,
    allUsageReconciled: false,
  });
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.reasons.length >= 8);

  const unattended = evaluateTrustTier({
    requestedTier: 'unattended-application',
    preValidationPassed: true,
    mediumAcceptanceValid: true,
    repositoryApplyAuthorizationValid: true,
    postValidationPassed: true,
    validationBindingIdentical: true,
    rollbackBound: true,
    matchedHeldOutCases: 30,
    familyDimensionUsed: true,
    families: 10,
    independentReview: true,
    confidence: 0.97,
    minimumConfidence: 0.95,
    matchingTerminalOutcomes: true,
    criticalFailures: 0,
    rollbackFaultTested: true,
    completeAllLegSavings: 0.01,
    allUsageReconciled: true,
  });
  assert.equal(unattended.allowed, true);
  assert.ok(unattended.permissions.includes('auto-apply-exact-reviewed-artifact'));
});

test('deterministic release pipeline legs require an accepted machine receipt chain', t => {
  const root = gitFixture('release-pipeline-completion-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { machine, state } = releaseFixture(root, { releaseFails: false });
  const execution = executeReleaseStep(machine, root, state, 'release', {
    execute: true,
    allowedSideEffects: ['workspace'],
    beforeStateHash: 'before',
    afterStateHash: 'after',
  });
  const afterRelease = {
    ...state,
    receipts: [execution.receipt],
  };
  const cleanup = executeReleaseStep(machine, root, afterRelease, 'cleanup', {
    execute: true,
    allowedSideEffects: ['workspace'],
    beforeStateHash: 'after',
    afterStateHash: 'after',
  });
  const completedState = {
    ...state,
    receipts: [execution.receipt, cleanup.receipt],
  };
  const completion = createReleaseCompletion(machine, completedState);
  const originalNow = Date.now;
  Date.now = () => Date.parse('2100-01-01T00:00:00.000Z');
  try {
    assert.equal(
      createReleaseCompletion(machine, completedState).completionHash,
      completion.completionHash,
    );
    assert.equal(
      verifyReleaseCompletion(completion, machine, completedState)
        .completionHash,
      completion.completionHash,
    );
  } finally {
    Date.now = originalNow;
  }
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/agent-budget.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    toolRegistry: '.github/agent-tools.json',
    releaseMachine: '.github/release-machine.json',
  }, null, 2));
  fs.writeFileSync(path.join(root, '.github/agent-tools.json'), JSON.stringify(
    machine.toolRegistry,
    null,
    2,
  ));
  const { toolRegistry, ...machineFile } = machine;
  void toolRegistry;
  fs.writeFileSync(path.join(root, '.github/release-machine.json'), JSON.stringify(
    machineFile,
    null,
    2,
  ));
  const authorizationHash = completion.operatorAuthorizationHash;
  const releaseEvidence = {
    machineEnabled: true,
    terminalStatus: 'accepted',
    releasePlanHash: completion.releasePlanHash,
    finalReleaseReceiptHash: completion.finalReleaseReceiptHash,
  };
  const receipt = createPipelineLegReceipt({
    workflowId: completion.workflowId,
    pipelineHash: '1'.repeat(64),
    pipelineId: 'fixture-release',
    teamId: 'fixture-release-team',
    project: 'fixture',
    opportunityId: 'release',
    repository: completion.repository,
    baseRevision: completion.baseRevision,
    scopeHash: completion.scopeHash,
    phaseId: 'execute-release',
    phaseKind: 'deterministic-release',
    role: 'deterministic-release',
    trustTier: 'provisional-staging',
    attempt: 1,
    profile: null,
    authority: `operator-authorization:${authorizationHash}`,
    authorizationHash,
    configurationEvidence: null,
    usage: { state: 'deterministic', modelCalls: 0, credits: 0 },
    state: 'executed',
    outcome: 'accepted',
    toolEvidence: releaseEvidence,
    previousReceiptHash: null,
    startedAt: '2026-09-08T00:00:00.000Z',
    completedAt: '2026-09-08T00:00:01.000Z',
  });
  const context = {
    workflowId: completion.workflowId,
    pipelineHash: '1'.repeat(64),
    pipelineId: 'fixture-release',
    teamId: 'fixture-release-team',
    project: 'fixture',
    opportunityId: 'release',
    repository: completion.repository,
    baseRevision: completion.baseRevision,
    scopeHash: completion.scopeHash,
    expectedPhases: [{
      id: 'execute-release',
      kind: 'deterministic-release',
      role: 'deterministic-release',
      authority: 'operator-authorization-required',
      profile: null,
      machine: '.github/release-machine.json',
      variant: null,
    }],
  };
  assert.throws(() => verifyPipelineLegs([receipt], context),
    /release verification context|verified accepted machine result/i);
  assert.equal(verifyPipelineLegs([receipt], {
    ...context,
    releaseResults: {
      'execute-release': {
        completion,
        state: completedState,
      },
    },
  }).nextPhaseId, null);
});

function releaseFixture(root, options = {}) {
  const {
    releaseFails = true,
    rollbackFails = false,
    verificationFails = false,
  } = options;
  const registry = validateToolRegistry({
    version: 1,
    project: 'fixture',
    tools: [
      {
        id: 'release-fail',
        kind: 'command',
        argv: [process.execPath, '-e',
          releaseFails ? 'process.exit(1)' : 'process.exit(0)'],
        cwd: '.',
        timeoutSeconds: 30,
        sideEffect: 'workspace',
        environment: [],
      },
      {
        id: 'rollback',
        kind: 'command',
        argv: [process.execPath, '-e', rollbackFails ? 'process.exit(1)' : 'process.exit(0)'],
        cwd: '.',
        timeoutSeconds: 30,
        sideEffect: 'workspace',
        environment: [],
      },
      {
        id: 'verify',
        kind: 'command',
        argv: [process.execPath, '-e',
          verificationFails ? 'process.exit(1)' : 'process.exit(0)'],
        cwd: '.',
        timeoutSeconds: 30,
        sideEffect: 'workspace',
        environment: [],
      },
      {
        id: 'cleanup',
        kind: 'command',
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: '.',
        timeoutSeconds: 30,
        sideEffect: 'workspace',
        environment: [],
      },
    ],
  }, 'fixture');
  const machine = validateReleaseMachineV3({
    version: 3,
    project: 'fixture',
    opportunity: 'release',
    enabled: true,
    operatorAuthorizationRequired: true,
    reviewer: {
      role: 'medium-review',
      profile: sensitiveMedium,
      authority: 'review-only',
    },
    exception: {
      role: 'risk-triggered-frontier-review',
      profile: critical,
      triggerIds: ['fixture-release-rollback-conflict'],
      requiresTriggerReceipt: true,
    },
    steps: [
      {
        id: 'release',
        label: 'Release',
        executor: 'deterministic',
        operation: 'command',
        tool: 'release-fail',
        failure: 'rollback',
        evidence: ['release receipt'],
      },
      {
        id: 'rollback',
        label: 'Rollback',
        executor: 'deterministic',
        operation: 'rollback',
        tool: 'rollback',
        rollbackOnly: true,
        rollbackVerificationTool: 'verify',
        failure: 'abnormal',
        evidence: ['rollback receipt'],
      },
      {
        id: 'cleanup',
        label: 'Cleanup',
        executor: 'deterministic',
        operation: 'cleanup',
        tool: 'cleanup',
        failure: 'abnormal',
        evidence: ['cleanup receipt'],
      },
    ],
    toolRegistry: registry,
  }, 'fixture');
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const machinePlan = releasePlan(machine);
  const authorization = {
    version: 1,
    kind: 'operator-authorization',
    authorizedBy: 'operator',
    workflowId: 'release-workflow',
    opportunityId: 'release',
    project: 'fixture',
    repository: root,
    baseRevision: revision,
    scopeHash: '9'.repeat(64),
    nonce: 'nonce',
    issuedAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    allowedSideEffect: 'workspace',
    toolIds: ['release-fail', 'rollback', 'verify', 'cleanup'],
    planHash: machinePlan.planHash,
    toolContractHash: sha256(machinePlan.toolContracts),
  };
  return {
    machine,
    state: {
      currentRevision: revision,
      scopeHash: authorization.scopeHash,
      operatorAuthorization: authorization,
      now: Date.parse('2026-09-08T01:00:00.000Z'),
      receipts: [],
    },
  };
}

test('release remains deterministic after operator authorization and failed rollback needs a named trigger receipt', t => {
  const root = gitFixture('release-v3-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { machine, state } = releaseFixture(root, { rollbackFails: true });
  assert.throws(() => nextReleaseAction(machine, {
    ...state,
    operatorAuthorization: null,
  }), /Operator authorization/);
  assert.throws(() => nextReleaseAction(machine, {
    ...state,
    now: Date.parse('2020-06-01T00:00:00.000Z'),
    operatorAuthorization: {
      ...state.operatorAuthorization,
      issuedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2021-01-01T00:00:00.000Z',
    },
  }), /not currently valid/);
  const shortWindowAuthorization = {
    ...state.operatorAuthorization,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  };
  assert.equal(nextReleaseAction(machine, {
    ...state,
    operatorAuthorization: shortWindowAuthorization,
  }).status, 'ready');
  assert.throws(() => executeReleaseStep(machine, root, {
    ...state,
    operatorAuthorization: shortWindowAuthorization,
  }, 'release', {
    execute: true,
    allowedSideEffects: ['workspace'],
    beforeStateHash: 'before',
    afterStateHash: 'after',
  }), /window is too short/);
  const changedMachine = structuredClone(machine);
  changedMachine.toolRegistry.tools.find(tool =>
    tool.id === 'release-fail').argv = [
      process.execPath,
      '-e',
      'process.stdout.write("changed")',
    ];
  assert.throws(() => nextReleaseAction(changedMachine, state),
    /plan hash|tool contract hash/i);

  const failed = executeReleaseStep(machine, root, state, 'release', {
    execute: true,
    allowedSideEffects: ['workspace'],
    beforeStateHash: 'before',
    afterStateHash: 'after',
  });
  const rollbackState = { ...state, receipts: [failed.receipt] };
  assert.equal(nextReleaseAction(machine, rollbackState).status, 'rollback');
  const rollback = executeReleaseStep(machine, root, rollbackState, 'rollback', {
    execute: true,
    allowedSideEffects: ['workspace'],
    beforeStateHash: 'before',
    afterStateHash: 'after',
  });
  const cleanupState = {
    ...state,
    receipts: [failed.receipt, rollback.receipt],
  };
  assert.equal(nextReleaseAction(machine, cleanupState).step.id, 'cleanup');
  const cleanup = executeReleaseStep(machine, root, cleanupState, 'cleanup', {
    execute: true,
    allowedSideEffects: ['workspace'],
    beforeStateHash: 'before',
    afterStateHash: 'after',
  });
  const finalState = {
    ...state,
    receipts: [failed.receipt, rollback.receipt, cleanup.receipt],
  };
  const blocked = nextReleaseAction(machine, finalState);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'exception-trigger-receipt-required');

  const triggerReceipt = createTriggerReceipt({
    project: 'fixture',
    opportunityId: 'release',
    triggerId: 'fixture-release-rollback-conflict',
    evidenceHash: sha256({
      failedRelease: failed.receipt.receiptHash,
      failedRollback: rollback.receipt.receiptHash,
    }),
    precedingReceiptHash: cleanup.receipt.receiptHash,
    observedAt: '2026-09-08T01:00:00.000Z',
  });
  const exception = nextReleaseAction(machine, {
    ...finalState,
    triggerReceipt,
  });
  assert.equal(exception.status, 'exception-review-required');
  assert.deepEqual(exception.profile, critical);
});

test('failed rollback verification remains receipted and reaches cleanup', t => {
  const root = gitFixture('release-v3-verification-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { machine, state } = releaseFixture(root, { verificationFails: true });
  const failed = executeReleaseStep(machine, root, state, 'release', {
    execute: true,
    allowedSideEffects: ['workspace'],
    beforeStateHash: 'before',
    afterStateHash: 'after',
  });
  const rollbackState = { ...state, receipts: [failed.receipt] };
  const rollback = executeReleaseStep(machine, root, rollbackState, 'rollback', {
    execute: true,
    allowedSideEffects: ['workspace'],
    beforeStateHash: 'before',
    afterStateHash: 'after',
  });
  assert.equal(rollback.receipt.status, 'abnormal');
  assert.equal(rollback.receipt.verificationStatus, 'rejected');
  const forgedRollback = {
    ...rollback.receipt,
    verificationArgvHash: '0'.repeat(64),
  };
  delete forgedRollback.evidenceHash;
  delete forgedRollback.receiptHash;
  forgedRollback.evidenceHash = sha256(forgedRollback);
  forgedRollback.receiptHash = sha256({
    ...forgedRollback,
    receiptHash: undefined,
  });
  assert.throws(() => nextReleaseAction(machine, {
    ...state,
    receipts: [failed.receipt, forgedRollback],
  }), /verification argv/i);
  const cleanupState = {
    ...state,
    receipts: [failed.receipt, rollback.receipt],
  };
  assert.equal(nextReleaseAction(machine, cleanupState).step.id, 'cleanup');
});
