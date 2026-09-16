#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import { readOpportunityPolicy } from '../skills/budget-workflow/scripts/opportunities.mjs';

const LABELS = new Set([
  'measured',
  'reused',
  'bounded-projection',
  'unavailable',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function datum(value, label, note) {
  assert(LABELS.has(label), `Evidence label invalid: ${label}`);
  return { value, label, note };
}

function leg(id, className, requirement, evidence, state = 'not-run') {
  return {
    id,
    class: className,
    requirement,
    state,
    modelCalls: evidence.label === 'measured' && evidence.value === 0 ? 0 : null,
    credits: null,
    evidence,
  };
}

function topologyLegs(id) {
  const deterministic = datum(
    0,
    'measured',
    'The router, evidence packager, registered commands, receipt verifier, and local deterministic release engine launch no model.',
  );
  const missing = name => datum(
    null,
    'unavailable',
    `No matched end-to-end production evidence exists for the mandatory ${name} leg.`,
  );
  const conditional = name => datum(
    null,
    'bounded-projection',
    `${name} is represented as condition-false unless a named trigger receipt is present; no call was launched in this evaluation.`,
  );
  const common = [
    leg('route', 'planning', 'mandatory', deterministic, 'executed'),
    leg('collect-evidence', 'evidence', 'mandatory', deterministic, 'executed'),
    leg('deterministic-validation', 'deterministic-validation', 'mandatory', deterministic, 'executed'),
    leg('failure-path', 'failure', 'conditional', conditional('Failure'), 'condition-false'),
    leg('fallback-path', 'fallback', 'conditional', conditional('Fallback'), 'condition-false'),
    leg('risk-escalation', 'escalation', 'conditional', conditional('Risk escalation'), 'condition-false'),
    leg('deterministic-release', 'release', 'operator-conditional', conditional('Release'), 'condition-false'),
  ];
  if (id === 'direct-frontier-baseline') {
    return [
      ...common.slice(0, 2),
      leg('frontier-implementation', 'implementation', 'mandatory',
        datum(608.597, 'reused',
          'Sealed v2 baseline total for 120 model calls; it does not isolate planning, validation, or production release.'),
      'executed'),
      common[2],
      leg('frontier-review', 'review', 'included-in-owner', missing('production review')),
      leg('revision', 'revision', 'conditional', conditional('Revision'), 'condition-false'),
      leg('grading', 'grading', 'study-only',
        datum(598.2425, 'reused', 'Sealed Sol high/default judge total for 120 calls; not a production leg.'),
      'executed'),
      ...common.slice(3),
    ];
  }
  if (id === 'research-spec-medium-cheap-review') {
    return [
      ...common.slice(0, 2),
      leg('external-research', 'planning', 'trigger-conditional',
        conditional('External research'), 'condition-false'),
      leg('binding-spec', 'planning', 'trigger-conditional',
        conditional('Binding specification'), 'condition-false'),
      leg('medium-coordination', 'planning', 'mandatory', missing('medium coordination')),
      leg('cheap-implementation', 'implementation', 'bounded-conditional',
        datum(383.86404, 'reused',
          'The sealed challenger total is reused only as historical topology evidence; it is not attributable to the new cheap-worker leg.'),
      'not-run'),
      common[2],
      leg('medium-review', 'review', 'mandatory-if-worker', missing('medium review')),
      leg('one-revision', 'revision', 'conditional', conditional('One reviewer-directed revision'), 'condition-false'),
      leg('grading', 'grading', 'study-only', missing('new-topology grading')),
      ...common.slice(3),
    ];
  }
  if (id === 'medium-owner-cheap-worker-medium-review') {
    return [
      ...common.slice(0, 2),
      leg('medium-coordination', 'planning', 'mandatory', missing('medium coordination')),
      leg('cheap-implementation', 'implementation', 'bounded-conditional',
        datum(383.86404, 'reused',
          'Historical challenger usage is retained but cannot price the new worker plus coordinator/reviewer topology.'),
      'not-run'),
      common[2],
      leg('medium-review', 'review', 'mandatory-if-worker', missing('medium review')),
      leg('one-revision', 'revision', 'conditional', conditional('One reviewer-directed revision'), 'condition-false'),
      leg('grading', 'grading', 'study-only', missing('new-topology grading')),
      ...common.slice(3),
    ];
  }
  return [
    ...common.slice(0, 2),
    leg('medium-owner', 'implementation', 'mandatory', missing('medium owner')),
    common[2],
    leg('self-review', 'review', 'same-medium-owner', missing('medium owner review')),
    leg('revision', 'revision', 'not-applicable', datum(0, 'measured', 'No cheap-worker revision leg exists.'), 'not-run'),
    leg('grading', 'grading', 'study-only', missing('medium-owner grading')),
    ...common.slice(3),
  ];
}

export function evaluateTeamPipelines(config, manifest) {
  assert(config?.version === 1 && config.runStudy === false &&
    config.authorizedModelCalls === 0,
  'Team pipeline evaluation must authorize zero model calls');
  assert(Array.isArray(config.topologies) && config.topologies.length === 4,
    'Exactly four complete topology families required');
  const sealed = config.sealedEvidence;
  assert(sealed.label === 'reused' &&
    sealed.baseline.calls === 120 &&
    sealed.challenger.calls === 120 &&
    sealed.mandatoryJudge.calls === 120,
  'Sealed v2 evidence call counts changed');
  const total = sealed.baseline.credits +
    sealed.challenger.credits +
    sealed.mandatoryJudge.credits;
  const judgeShare = sealed.mandatoryJudge.credits / total;
  const oldCandidateWithJudge = sealed.challenger.credits +
    sealed.mandatoryJudge.credits;
  const oldCostIncrease = oldCandidateWithJudge / sealed.baseline.credits - 1;
  const projects = [];
  for (const item of manifest.cases) {
    const adapter = readAdapter(item.root);
    const policy = readOpportunityPolicy(item.root, adapter);
    assert(policy.version === 3, `${item.id}: version 3 policy required`);
    projects.push({
      id: item.id,
      project: policy.project,
      pipelines: policy.opportunities.map(opportunity => ({
        opportunity: opportunity.id,
        enabled: opportunity.enabled,
        evaluationStatus: opportunity.evaluationStatus,
        casePacketStatus: opportunity.casePacketStatus,
        topology: opportunity.team.topology,
        trustTier: opportunity.team.trustTier,
        coordinator: opportunity.team.coordinator.profile,
        reviewer: opportunity.team.reviewer.profile,
        worker: {
          enabled: opportunity.team.workerCandidate.enabled,
          profile: opportunity.team.workerCandidate.profile,
          evidenceStatus: opportunity.team.workerCandidate.evidenceStatus,
        },
        criticalTriggers: opportunity.conditionalProfiles
          .filter(profile => profile.kind === 'risk-triggered-frontier-review')
          .flatMap(profile => profile.triggerIds),
      })),
    });
  }
  const pipelineCount = projects.reduce((sum, project) =>
    sum + project.pipelines.length, 0);
  assert(pipelineCount > 0, 'At least one project pipeline is required');
  const topologies = config.topologies.map(topology => {
    const legs = topologyLegs(topology.id);
    for (const className of config.requiredLegClasses) {
      assert(legs.some(item => item.class === className),
        `${topology.id}: missing ${className} leg`);
    }
    return {
      ...topology,
      legs,
      expectedProductionSavings: datum(
        null,
        'unavailable',
        'At least one mandatory production model leg lacks matched complete usage and terminal-outcome evidence.',
      ),
      modelCallsLaunched: datum(0, 'measured', 'runStudy=false'),
    };
  });
  return {
    version: 1,
    runStudy: false,
    totals: {
      modelCalls: 0,
    },
    sealedV2: {
      baseline: datum(sealed.baseline, 'reused', sealed.source),
      challenger: datum(sealed.challenger, 'reused', sealed.source),
      mandatoryJudge: datum(sealed.mandatoryJudge, 'reused', sealed.source),
      totalCredits: datum(total, 'reused', 'Sum of all 360 sealed calls.'),
      judgeShare: datum(judgeShare, 'reused', 'Mandatory judge credits divided by all sealed credits.'),
      challengerPlusJudge: datum(oldCandidateWithJudge, 'reused', 'Old challenger plus mandatory judge.'),
      costIncreaseOverBaseline: datum(oldCostIncrease, 'reused',
        'This proves only that the old mandatory-review topology was cost-negative.'),
    },
    topologies,
    projects,
    pipelineCount,
    expectedProductionSavings: null,
    warning: 'No new model calls were launched. Historical challenger usage cannot be relabeled as the new medium/cheap team topology.',
  };
}

if (process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const config = JSON.parse(fs.readFileSync(
      process.argv[2] ?? new URL('./team-pipeline-study.json', import.meta.url),
      'utf8',
    ));
    const manifest = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    console.log(JSON.stringify(evaluateTeamPipelines(config, manifest), null, 2));
  } catch (error) {
    console.error(`team-pipeline-evaluation: ${error.message}`);
    process.exitCode = 1;
  }
}
