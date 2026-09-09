import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mineCandidates,
  transitionCandidate,
} from '../skills/budget-workflow/scripts/improvement-candidates.mjs';
import { sha256 } from '../skills/budget-workflow/scripts/workflow.mjs';

function policy(overrides = {}) {
  return {
    project: 'fixture',
    thresholds: {
      minimumSuccessfulWorkflows: 3,
      minimumDistinctSessions: 2,
      minimumStability: 0.8,
      maximumCandidatesPerWorkflow: 1,
      minimumOperationCount: 2,
      maximumSubgraphOperations: 6,
      maximumAnalysisEvents: 10000,
    },
    priorities: [{
      id: 'fixture-operation',
      opportunity: 'fixture',
      class: 'deterministic-tool',
      validators: ['fixture-validator'],
      destination: 'tools',
    }],
    riskClasses: ['production', 'security', 'credential'],
    knownTools: [],
    knownSkills: [],
    promotion: { allowedSideEffects: ['none', 'workspace'] },
    ...overrides,
  };
}

function workflow(index, operations, extra = {}) {
  const workflowId = `workflow-${index}`;
  const sessionId = `session-${index % 2}`;
  const events = operations.map((operation, operationIndex) => ({
    timestamp: new Date(Date.UTC(2026, 8, 9, 0, index, operationIndex)).toISOString(),
    eventHash: sha256(`tool-${index}-${operationIndex}`),
    workflowId,
    sessionId,
    opportunityId: extra.opportunityId ?? 'fixture',
    eventKind: 'post-tool-use',
    operationSignature: operation.signature ?? operation,
    resultClass: 'accepted',
    sideEffectClass: 'none',
    toolId: operation.toolId ?? `tool-${operation}`,
    eligiblePath: true,
    excludedPath: false,
    pathEvidenceComplete: true,
    ...extra.event,
    ...(operation.event ?? {}),
  }));
  events.push({
    timestamp: new Date(Date.UTC(2026, 8, 9, 0, index, 59)).toISOString(),
    eventHash: sha256(`stop-${index}`),
    workflowId,
    sessionId,
    opportunityId: extra.opportunityId ?? 'fixture',
    eventKind: 'agent-stop',
    operationSignature: null,
    resultClass: extra.outcome ?? 'observed',
    sideEffectClass: 'none',
  });
  return events;
}

test('recurring contiguous subgraphs are mined inside different trajectories', () => {
  const events = [
    ...workflow(1, ['prefix-a', 'shared-a', 'shared-b', 'shared-c', 'suffix-a']),
    ...workflow(2, ['prefix-b', 'shared-a', 'shared-b', 'shared-c']),
    ...workflow(3, ['shared-a', 'shared-b', 'shared-c', 'suffix-c']),
  ];
  const result = mineCandidates(events, policy(), { opportunityId: 'fixture' });
  assert.equal(result.decision, 'candidate');
  assert.equal(result.candidate.class, 'deterministic-tool');
  assert.deepEqual(result.candidate.operationSignatures,
    ['shared-a', 'shared-b', 'shared-c']);
  assert.equal(result.candidate.workflowCount, 3);
  assert.equal(result.candidate.sessionCount, 2);
  assert.equal(result.candidate.selectedPriority, 'fixture-operation');
  assert.deepEqual(result.candidate.requiredValidators, ['fixture-validator']);
  assert.equal(result.candidate.destination, 'tools');
});

test('one-off and repeated trivial single operations no-op', () => {
  assert.equal(mineCandidates(workflow(1, ['one']), policy()).decision, 'no-op');
  const repeated = [1, 2, 3].flatMap(index => workflow(index, ['view-only']));
  assert.equal(mineCandidates(repeated, policy()).decision, 'no-op');
});

test('unstable and failed trajectories defer or no-op', () => {
  const unstable = [
    ...workflow(1, ['shared-a', 'shared-b']),
    ...workflow(2, ['shared-a', 'shared-b']),
    ...workflow(3, ['shared-a', 'shared-b']),
    ...workflow(4, ['other-a', 'other-b']),
  ];
  assert.equal(mineCandidates(unstable, policy()).decision, 'deferred');
  const failed = [
    ...workflow(1, ['shared-a', 'shared-b']),
    ...workflow(2, ['shared-a', 'shared-b']),
    ...workflow(3, ['shared-a', 'shared-b'], { outcome: 'failed' }),
  ];
  assert.equal(mineCandidates(failed, policy()).decision, 'no-op');
});

test('registered tools and skills supersede repeated candidates', () => {
  const toolEvents = [1, 2, 3].flatMap(index => workflow(index, [
    { signature: 'shared-a', toolId: 'registered-tool' },
    { signature: 'shared-b', toolId: 'other-tool' },
  ]));
  assert.equal(mineCandidates(toolEvents,
    policy({ knownTools: ['registered-tool'] })).decision, 'superseded');
  const skillEvents = [1, 2, 3].flatMap(index => workflow(index,
    ['shared-a', 'shared-b'], {
      event: { skillId: 'registered-skill', modelBacked: true },
    }));
  assert.equal(mineCandidates(skillEvents,
    policy({ knownSkills: ['registered-skill'] })).decision, 'superseded');
});

test('inferred semantic and risk work become non-executing gated skills', () => {
  const semantic = [1, 2, 3].flatMap(index => workflow(index,
    ['shared-a', 'shared-b'], {
      event: { modelBacked: true, modelRole: 'general-purpose' },
    }));
  const semanticResult = mineCandidates(semantic, policy());
  assert.equal(semanticResult.candidate.class, 'reusable-skill');
  assert.equal(semanticResult.candidate.destination, 'skills');
  assert.equal(semanticResult.candidate.executionAuthority, 'none');
  assert.equal(semanticResult.candidate.automaticDeterministicPromotionEligible, false);
  const risky = [1, 2, 3].flatMap(index => workflow(index,
    ['shared-a', 'shared-b'], {
      event: { sideEffectClass: 'external', riskClass: 'production' },
    }));
  const riskResult = mineCandidates(risky, policy());
  assert.equal(riskResult.decision, 'candidate');
  assert.equal(riskResult.candidate.class, 'reusable-skill');
  assert.equal(riskResult.candidate.destination, 'skills');
  assert.equal(riskResult.candidate.reason, 'risk-gated-procedure');
  assert.equal(riskResult.candidate.executionAuthority, 'none');
  assert.deepEqual(riskResult.candidate.requiredGates,
    ['explicit-authorization', 'project-validation', 'medium-review', 'escalation']);
  const excluded = [1, 2, 3].flatMap(index => workflow(index,
    ['shared-a', 'shared-b'], {
      event: { excludedPath: true },
    }));
  assert.equal(mineCandidates(excluded, policy()).reason, 'excluded-path');
  const ineligible = [1, 2, 3].flatMap(index => workflow(index,
    ['shared-a', 'shared-b'], {
      event: { eligiblePath: false },
    }));
  assert.equal(mineCandidates(ineligible, policy()).reason, 'ineligible-path');
});

test('safe repeated subgraph ignores unrelated risky workflow events', () => {
  const events = [1, 2, 3].flatMap(index => workflow(index, [
    {
      signature: `risky-prefix-${index}`,
      toolId: 'external-tool',
      event: { sideEffectClass: 'external', riskClass: 'production' },
    },
    { signature: 'shared-safe-a', toolId: 'safe-a' },
    { signature: 'shared-safe-b', toolId: 'safe-b' },
    {
      signature: `risky-suffix-${index}`,
      toolId: 'edit',
      event: { sideEffectClass: 'workspace', excludedPath: true },
    },
  ]));
  const result = mineCandidates(events, policy());
  assert.equal(result.decision, 'candidate');
  assert.equal(result.candidate.class, 'deterministic-tool');
  assert.deepEqual(result.candidate.operationSignatures,
    ['shared-safe-a', 'shared-safe-b']);
  assert.equal(result.candidate.sideEffectClass, 'none');
  assert.equal(result.candidate.excludedPath, false);
});

test('routing, qualification, opportunity filtering and priority mapping are explicit', () => {
  const priorities = [
    ...policy().priorities,
    {
      id: 'other-priority',
      opportunity: 'other',
      class: 'qualification-fixture',
      validators: ['other-validator'],
      destination: 'fixtures',
    },
  ];
  const routing = [1, 2, 3].flatMap(index => workflow(index,
    ['shared-a', 'shared-b'], { event: { routingMiss: true } }));
  assert.equal(mineCandidates(routing, policy()).candidate.class, 'routing-policy');
  const qualification = [1, 2, 3].flatMap(index => workflow(index,
    ['shared-a', 'shared-b'], { event: { validatorClass: 'missing' } }));
  assert.equal(mineCandidates(qualification, policy()).candidate.class,
    'qualification-fixture');
  const mixed = [
    ...workflow(1, ['fixture-a', 'fixture-b']),
    ...workflow(2, ['fixture-a', 'fixture-b']),
    ...workflow(3, ['fixture-a', 'fixture-b']),
    ...workflow(4, ['other-a', 'other-b'], { opportunityId: 'other' }),
    ...workflow(5, ['other-a', 'other-b'], { opportunityId: 'other' }),
    ...workflow(6, ['other-a', 'other-b'], { opportunityId: 'other' }),
  ];
  const other = mineCandidates(mixed, policy({ priorities }), {
    opportunityId: 'other',
  });
  assert.equal(other.candidate.selectedPriority, 'other-priority');
  assert.equal(other.candidate.destination, 'fixtures');
});

test('ambiguous same-opportunity priorities persist ranked options for selection', () => {
  const priorities = [
    {
      id: 'alpha-priority',
      opportunity: 'fixture',
      class: 'deterministic-tool',
      validators: ['alpha-validator'],
      destination: 'tools',
    },
    {
      id: 'beta-priority',
      opportunity: 'fixture',
      class: 'reusable-skill',
      validators: ['beta-validator'],
      destination: 'skills',
    },
  ];
  const events = [1, 2, 3].flatMap(index =>
    workflow(index, ['shared-a', 'shared-b']));
  const result = mineCandidates(events, policy({ priorities }));
  assert.equal(result.decision, 'candidate');
  assert.equal(result.candidate.selectedPriority, null);
  assert.equal(result.candidate.requiresPrioritySelection, true);
  assert.equal(result.candidate.class, 'no-op');
  assert.deepEqual(result.candidate.priorityOptions.map(option => option.id),
    ['alpha-priority', 'beta-priority']);
});

test('lifecycle transitions are explicit and terminal shortcuts fail', () => {
  const candidate = {
    id: 'candidate-fixture',
    state: 'observed',
    history: [],
  };
  const eligible = transitionCandidate(candidate, 'eligible', sha256('eligible'));
  const incubating = transitionCandidate(eligible, 'incubating', sha256('incubating'));
  const replaying = transitionCandidate(incubating, 'replaying', sha256('replaying'));
  const provisional = transitionCandidate(replaying, 'provisional', sha256('provisional'));
  assert.equal(transitionCandidate(provisional, 'promoted', sha256('promoted')).state,
    'promoted');
  assert.throws(() => transitionCandidate(candidate, 'promoted', sha256('invalid')),
    /Invalid candidate transition/);
});
