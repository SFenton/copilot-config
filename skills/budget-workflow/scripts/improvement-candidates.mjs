import { sha256 } from './workflow.mjs';

export const CANDIDATE_CLASSES = new Set([
  'deterministic-tool',
  'reusable-skill',
  'routing-policy',
  'qualification-fixture',
  'no-op',
]);

export const LIFECYCLE_STATES = new Set([
  'observed',
  'eligible',
  'incubating',
  'replaying',
  'provisional',
  'promoted',
  'deferred',
  'rejected',
  'superseded',
  'expired',
]);

const TRANSITIONS = new Map([
  ['observed', new Set(['eligible', 'deferred', 'rejected', 'superseded', 'expired'])],
  ['eligible', new Set(['incubating', 'deferred', 'rejected', 'superseded'])],
  ['incubating', new Set(['replaying', 'deferred', 'rejected'])],
  ['replaying', new Set(['provisional', 'deferred', 'rejected'])],
  ['provisional', new Set(['promoted', 'deferred', 'rejected', 'superseded', 'expired'])],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function transitionCandidate(candidate, state, evidenceHash) {
  assert(LIFECYCLE_STATES.has(candidate.state), 'Unknown current candidate state');
  assert(LIFECYCLE_STATES.has(state), 'Unknown candidate transition state');
  assert(TRANSITIONS.get(candidate.state)?.has(state),
    `Invalid candidate transition: ${candidate.state} -> ${state}`);
  assert(typeof evidenceHash === 'string' && /^[a-f0-9]{64}$/.test(evidenceHash),
    'Candidate transition evidence hash required');
  return {
    ...candidate,
    state,
    history: [
      ...(candidate.history ?? []),
      { from: candidate.state, to: state, evidenceHash },
    ],
  };
}

function workflowGroups(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.workflowId)) groups.set(event.workflowId, []);
    groups.get(event.workflowId).push(event);
  }
  return [...groups.entries()].map(([workflowId, values]) => ({
    workflowId,
    sessionId: values[0]?.sessionId,
    opportunityId: values.map(value => value.opportunityId).find(Boolean) ?? null,
    events: values.sort((left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
      left.eventHash.localeCompare(right.eventHash)),
  }));
}

function successful(workflow) {
  const terminal = workflow.events.filter(event =>
    ['agent-stop', 'session-end', 'workflow-complete'].includes(event.eventKind));
  if (terminal.length === 0) return false;
  if (workflow.events.some(event =>
    ['abnormal-failure', 'failed'].includes(event.resultClass))) return false;
  const final = terminal.at(-1);
  return final.eventKind !== 'session-end' ||
    final.resultClass === 'accepted';
}

function sequenceFor(workflow) {
  return workflow.events
    .filter(event => event.operationSignature)
    .map(event => ({
      signature: event.operationSignature,
      toolId: event.toolId,
      event,
    }));
}

function subgraphs(sequence, minimum, maximum) {
  const output = new Map();
  const cap = Math.min(maximum, sequence.length);
  for (let length = minimum; length <= cap; length += 1) {
    for (let start = 0; start + length <= sequence.length; start += 1) {
      const segment = sequence.slice(start, start + length);
      const sequenceHash = sha256(segment.map(item => item.signature));
      if (!output.has(sequenceHash)) output.set(sequenceHash, { segment, start });
    }
  }
  return output;
}

function priorityOptions(policy, opportunityId, occurrences) {
  const eligible = policy.priorities.filter(priority =>
    priority.opportunity === opportunityId);
  const toolIds = new Set(occurrences.flatMap(occurrence =>
    occurrence.events.map(event => event.toolId).filter(Boolean)));
  return [...eligible].sort((left, right) => {
    const leftScore = left.validators.filter(id => toolIds.has(id)).length;
    const rightScore = right.validators.filter(id => toolIds.has(id)).length;
    return rightScore - leftScore || left.id.localeCompare(right.id);
  }).map(priority => ({
    id: priority.id,
    class: priority.class,
    validators: [...priority.validators].sort(),
    destination: priority.destination,
    score: priority.validators.filter(id => toolIds.has(id)).length,
  }));
}

function classify(occurrences, policy, priority, signatures) {
  const events = occurrences.flatMap(occurrence => occurrence.events);
  const toolNames = [...new Set(events.map(event => event.toolId).filter(Boolean))];
  const fallbackClass = priority?.class ?? 'no-op';
  if (events.some(event => event.excludedPath === true)) {
    return { classification: fallbackClass, state: 'rejected', reason: 'excluded-path' };
  }
  if (events.some(event =>
    event.operationSignature &&
    (event.eligiblePath !== true || event.pathEvidenceComplete !== true))) {
    return { classification: fallbackClass, state: 'rejected', reason: 'ineligible-path' };
  }
  const risky = events.some(event =>
    event.sideEffectClass && !policy.promotion.allowedSideEffects.includes(event.sideEffectClass)) ||
    events.some(event => event.riskClass && policy.riskClasses.includes(event.riskClass));
  if (risky) {
    return {
      classification: 'reusable-skill',
      forcedClass: 'reusable-skill',
      state: 'eligible',
      reason: 'risk-gated-procedure',
      executionAuthority: 'none',
      requiredGates: ['explicit-authorization', 'project-validation', 'medium-review',
        'escalation'],
    };
  }
  if (toolNames.some(id => (policy.knownTools ?? []).includes(id)) ||
    signatures.some(id => (policy.knownTools ?? []).includes(id))) {
    return { classification: 'deterministic-tool', state: 'superseded', reason: 'existing-tool' };
  }
  if (events.some(event => event.skillId &&
    (policy.knownSkills ?? []).includes(event.skillId))) {
    return { classification: 'reusable-skill', state: 'superseded', reason: 'existing-skill' };
  }
  if (events.some(event => event.validatorClass === 'missing')) {
    return { classification: 'qualification-fixture', state: 'eligible', reason: 'missing-validator' };
  }
  if (events.some(event => event.routingMiss === true) ||
    events.filter(event => event.revisionEvent === true).length >= 2) {
    return { classification: 'routing-policy', state: 'eligible', reason: 'repeated-routing-defect' };
  }
  if (events.some(event => event.modelBacked === true ||
    ['medium-coordinator', 'medium-review', 'frontier-review']
      .includes(event.modelRole))) {
    return {
      classification: 'reusable-skill',
      forcedClass: 'reusable-skill',
      state: 'eligible',
      reason: 'semantic-boundary',
      executionAuthority: 'none',
      requiredGates: ['project-validation', 'medium-review', 'escalation'],
    };
  }
  return { classification: fallbackClass, state: 'eligible', reason: 'stable-priority-subgraph' };
}

export function mineCandidates(events, policy, options = {}) {
  const allComplete = workflowGroups(events).filter(successful);
  const complete = options.opportunityId
    ? allComplete.filter(workflow => workflow.opportunityId === options.opportunityId)
    : allComplete.filter(workflow => workflow.opportunityId !== null);
  if (complete.length === 0) {
    return {
      decision: 'no-op',
      candidate: null,
      reason: options.opportunityId
        ? 'no-successful-workflows-for-opportunity'
        : 'no-successful-opportunity-workflows',
    };
  }
  const byOpportunity = new Map();
  for (const workflow of complete) {
    if (!byOpportunity.has(workflow.opportunityId)) {
      byOpportunity.set(workflow.opportunityId, []);
    }
    byOpportunity.get(workflow.opportunityId).push(workflow);
  }
  const ranked = [];
  const minimum = policy.thresholds.minimumOperationCount;
  const maximum = policy.thresholds.maximumSubgraphOperations;
  for (const [opportunityId, workflows] of byOpportunity) {
    const candidates = new Map();
    for (const workflow of workflows) {
      for (const [sequenceHash, occurrence] of subgraphs(
        sequenceFor(workflow), minimum, maximum,
      )) {
        if (!candidates.has(sequenceHash)) {
          candidates.set(sequenceHash, { sequenceHash, segment: occurrence.segment,
            occurrences: [] });
        }
        candidates.get(sequenceHash).occurrences.push({
          workflow,
          start: occurrence.start,
          events: occurrence.segment.map(item => item.event),
        });
      }
    }
    for (const candidate of candidates.values()) {
      const distinctWorkflows = new Map(candidate.occurrences.map(occurrence =>
        [occurrence.workflow.workflowId, occurrence]));
      const matchingOccurrences = [...distinctWorkflows.values()];
      const matching = matchingOccurrences.map(occurrence => occurrence.workflow);
      const stability = matching.length / workflows.length;
      ranked.push({
        ...candidate,
        opportunityId,
        matching,
        matchingOccurrences,
        occurrenceCount: matching.length,
        distinctSessions: new Set(matching.map(workflow => workflow.sessionId)).size,
        stability,
        length: candidate.segment.length,
        value: candidate.segment.filter(item =>
          item.event.modelBacked === true).length + candidate.segment.length,
      });
    }
  }
  ranked.sort((left, right) =>
    right.occurrenceCount - left.occurrenceCount ||
    right.stability - left.stability ||
    right.length - left.length ||
    right.value - left.value ||
    left.sequenceHash.localeCompare(right.sequenceHash));
  const threshold = policy.thresholds;
  const recurrent = ranked.filter(item =>
    item.occurrenceCount >= threshold.minimumSuccessfulWorkflows &&
    item.distinctSessions >= threshold.minimumDistinctSessions);
  if (recurrent.length === 0) {
    return {
      decision: 'no-op',
      candidate: null,
      reason: 'recurrence-threshold-not-met',
    };
  }
  const stable = recurrent.filter(item =>
    item.stability >= threshold.minimumStability);
  if (stable.length === 0) {
    return {
      decision: 'deferred',
      candidate: {
        id: `candidate-${recurrent[0].sequenceHash.slice(0, 16)}`,
        class: 'no-op',
        state: 'deferred',
        reason: 'unstable-subgraph',
        history: [],
      },
      reason: 'unstable-subgraph',
    };
  }
  const best = stable[0];
  const rankedPriorities = priorityOptions(policy, best.opportunityId,
    best.matchingOccurrences);
  if (rankedPriorities.length === 0) {
    return {
      decision: 'no-op',
      candidate: null,
      reason: 'no-priority-for-opportunity',
    };
  }
  const highestScore = rankedPriorities[0].score;
  const tiedPriorities = rankedPriorities.filter(option => option.score === highestScore);
  const priority = tiedPriorities.length === 1 ? tiedPriorities[0] : null;
  const signatures = best.segment.map(item => item.signature);
  const classification = classify(best.matchingOccurrences, policy, priority, signatures);
  const requiresPrioritySelection = priority === null;
  const candidate = {
    version: 1,
    id: `candidate-${best.sequenceHash.slice(0, 16)}`,
    project: policy.project,
    opportunityId: best.opportunityId,
    selectedPriority: priority?.id ?? null,
    priorityOptions: rankedPriorities,
    requiresPrioritySelection,
    requiredValidators: priority?.validators ?? [],
    destination: classification.forcedClass === 'reusable-skill'
      ? 'skills'
      : priority?.destination ?? null,
    class: classification.classification,
    forcedClass: classification.forcedClass ?? null,
    state: classification.state,
    reason: classification.reason,
    sequenceHash: best.sequenceHash,
    operationSignatures: signatures,
    toolIds: best.segment.map(item => item.toolId),
    workflowCount: best.occurrenceCount,
    sessionCount: best.distinctSessions,
    stability: best.stability,
    sideEffectClass: best.matchingOccurrences.flatMap(occurrence => occurrence.events)
      .map(event => event.sideEffectClass)
      .filter(Boolean)
      .sort()
      .at(-1) ?? 'none',
    excludedPath: best.matchingOccurrences.some(occurrence =>
      occurrence.events.some(event => event.excludedPath === true)),
    executionAuthority: classification.executionAuthority ??
      (classification.classification === 'reusable-skill' ? 'none' : 'candidate-artifact'),
    requiredGates: classification.requiredGates ?? [],
    automaticDeterministicPromotionEligible:
      classification.classification === 'deterministic-tool' &&
      requiresPrioritySelection === false,
    sourceWorkflowIds: best.matching.map(workflow => workflow.workflowId).sort(),
    evidenceHash: sha256({
      opportunityId: best.opportunityId,
      priority: priority?.id ?? null,
      priorityOptions: rankedPriorities,
      sequenceHash: best.sequenceHash,
      workflows: best.matching.map(workflow => workflow.workflowId).sort(),
    }),
    history: [],
  };
  return {
    decision: classification.state === 'eligible' ? 'candidate' : classification.state,
    candidate,
    reason: classification.reason,
  };
}
