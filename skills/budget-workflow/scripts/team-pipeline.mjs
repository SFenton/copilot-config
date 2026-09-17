import fs from 'node:fs';
import path from 'node:path';
import {
  SIDE_EFFECT_LEVELS,
  canonicalJson,
  createTriggerReceipt as createSharedTriggerReceipt,
  sha256,
  toolById,
  validateTriggerReceipt as validateSharedTriggerReceipt,
  validateProfile,
} from './workflow.mjs';
import {
  readReleaseMachine,
  verifyReleaseCompletion,
} from './release-machine.mjs';
import {
  createWorkflowCompletionObservation,
  verifyWorkflowCompletionObservation,
} from './continuous-improvement.mjs';
import { USAGE_ACCOUNTING_CATEGORIES } from './evidence/schemas.mjs';
import { LUNA_MEDIUM_DEFAULT_PROFILE } from './model-catalog.mjs';
export { evaluateIntentAcceptanceGate } from './intent-acceptance.mjs';

export const PIPELINE_PHASE_KINDS = new Set([
  'deterministic',
  'research-frontier',
  'spec-planner',
  'medium-coordinator',
  'cheap-worker',
  'medium-review',
  'risk-triggered-frontier-review',
  'deterministic-release',
]);

export const TRUST_TIERS = new Set([
  'provisional-staging',
  'reviewed-application',
  'unattended-application',
]);

export const LEG_STATES = new Set([
  'executed',
  'condition-false',
  'not-run',
  'blocked',
  'failed',
  'unreconciled',
]);

const CONDITIONAL_KINDS = new Set([
  'research-frontier',
  'spec-planner',
  'risk-triggered-frontier-review',
]);
const MODEL_KINDS = new Set([
  ...CONDITIONAL_KINDS,
  'medium-coordinator',
  'cheap-worker',
  'medium-review',
]);
const MEDIUM_MODELS = new Set([LUNA_MEDIUM_DEFAULT_PROFILE.model]);
const CHEAP_MODELS = new Set([
  'gpt-5-mini',
  'gpt-5.4-mini',
  'gemini-3.7-flash',
  'mai-code-1.1-flash',
]);
const TOPOLOGIES = new Set([
  'research-spec-medium-cheap-review',
  'medium-owner-cheap-worker-medium-review',
  'medium-owner-only',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function usageCategoryForPhase(phaseKind) {
  const category = {
    deterministic: 'deterministic-evidence',
    'deterministic-release': 'deterministic-evidence',
    'research-frontier': 'sol-research',
    'risk-triggered-frontier-review': 'research-adjudication',
    'spec-planner': 'cheap-curation',
    'medium-coordinator': 'downstream-implementation',
    'cheap-worker': 'downstream-implementation',
    'medium-review': 'downstream-implementation',
  }[phaseKind];
  assert(USAGE_ACCOUNTING_CATEGORIES.includes(category),
    'Pipeline phase usage category is invalid');
  return category;
}

function kebab(value, label) {
  assert(typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
    `${label} must be kebab-case`);
}

function invalidated(value) {
  return typeof value === 'string' && value.startsWith('invalidated');
}

function profileFor(opportunity, reference) {
  if (reference === 'coordinator') return opportunity.team.coordinator.profile;
  if (reference === 'reviewer') return opportunity.team.reviewer.profile;
  if (reference === 'worker-candidate') return opportunity.team.workerCandidate.profile;
  if (reference?.startsWith('conditional:')) {
    const id = reference.slice('conditional:'.length);
    return opportunity.conditionalProfiles.find(item => item.id === id)?.profile;
  }
  return null;
}

export function pipelinePhaseContracts(opportunity, registry, variant = null) {
  const contractFor = phase => {
    if (phase.kind === 'deterministic') {
      const tool = phase.tool ? toolById(registry, phase.tool) : null;
      return {
        id: phase.id,
        kind: phase.kind,
        role: phase.builtin === 'deterministic-router'
          ? 'deterministic-router'
          : phase.builtin === 'bounded-evidence-collector'
            ? 'deterministic-evidence'
            : 'deterministic-tool',
        authority: 'deterministic-local',
        profile: null,
        tool: phase.tool ?? null,
        builtin: phase.builtin ?? null,
        sideEffect: phase.sideEffect ?? 'none',
        toolContract: tool
          ? {
              id: tool.id,
              kind: tool.kind,
              sideEffect: tool.sideEffect,
              toolHash: sha256(tool),
              argvHash: tool.kind === 'command' ? sha256(tool.argv) : null,
            }
          : null,
      };
    }
    if (phase.kind === 'deterministic-release') {
      return {
        id: phase.id,
        kind: phase.kind,
        role: 'deterministic-release',
        authority: 'operator-authorization-required',
        profile: null,
        machine: phase.machine,
        variant: phase.variant ?? null,
        sideEffect: phase.sideEffect ?? null,
        operatorAuthorizationRequired:
          phase.operatorAuthorizationRequired === true,
      };
    }
    const definitions = {
      'research-frontier': ['research-frontier', 'semantic-research-only'],
      'spec-planner': ['spec-planner', 'semantic-specification-only'],
      'medium-coordinator': ['medium-coordinator', 'semantic-coordination'],
      'cheap-worker': ['cheap-worker', 'staging-only'],
      'medium-review': ['medium-review', 'semantic-review-only'],
      'risk-triggered-frontier-review': [
        'risk-triggered-frontier-review',
        'semantic-review-only',
      ],
    };
    const [role, authority] = definitions[phase.kind];
    return {
      id: phase.id,
      kind: phase.kind,
      role,
      authority,
      profile: profileFor(opportunity, phase.profileRef),
      condition: phase.condition ?? null,
    };
  };
  return [
    contractFor({
      id: 'route-opportunity',
      kind: 'deterministic',
      builtin: 'deterministic-router',
    }),
    contractFor({
      id: 'collect-evidence',
      kind: 'deterministic',
      builtin: 'bounded-evidence-collector',
    }),
    ...opportunity.phases
      .filter(phase => !phase.variant || phase.variant === variant)
      .map(contractFor),
  ];
}

export function pipelineContractHash(
  project,
  opportunity,
  registry,
  variant = null,
) {
  const selectedOpportunity = {
    ...opportunity,
    phases: opportunity.phases.filter(phase =>
      !phase.variant || phase.variant === variant),
  };
  return sha256({
    version: 3,
    project,
    variant,
    opportunity: selectedOpportunity,
    phaseContracts: pipelinePhaseContracts(opportunity, registry, variant),
  });
}

function validateCondition(profile, triggerIds, label, triggerCatalog) {
  assert(profile.requiresTriggerReceipt === true,
    `${label}: conditional profile requires a trigger receipt`);
  assert(Array.isArray(triggerIds) && triggerIds.length > 0,
    `${label}: concrete trigger ids required`);
  for (const id of triggerIds) {
    kebab(id, `${label}: trigger id`);
    assert(triggerCatalog.has(id), `${label}: unknown trigger ${id}`);
  }
}

function packetStatus(packet, opportunityId) {
  if (!packet) return null;
  if (invalidated(packet.qualificationStatus)) return packet.qualificationStatus;
  return packet.opportunities?.find(item => item.id === opportunityId)?.qualificationStatus ?? null;
}

export function validateOpportunityPolicyV3(
  policy,
  registry,
  evidence = {},
) {
  assert(policy && policy.version === 3 && policy.project === registry.project,
    'Opportunity v3 policy version/project mismatch');
  assert(policy.qualification?.status === 'provisional' ||
    policy.qualification?.status === 'qualified',
  'Opportunity v3 qualification status required');
  assert(policy.qualification.automaticApplication === false,
    'Opportunity policy cannot grant automatic application');
  assert(policy.qualification.minimumUnattendedCases >= 30,
    'Unattended application requires at least 30 held-out cases');
  assert(Array.isArray(policy.triggerCatalog) && policy.triggerCatalog.length > 0,
    'Opportunity v3 trigger catalog required');
  const triggerCatalog = new Map();
  for (const trigger of policy.triggerCatalog) {
    kebab(trigger.id, 'Trigger id');
    assert(!triggerCatalog.has(trigger.id), `Duplicate trigger id: ${trigger.id}`);
    assert(typeof trigger.description === 'string' && trigger.description.trim(),
      `${trigger.id}: trigger description required`);
    assert(['research', 'specification', 'critical-review'].includes(trigger.category),
      `${trigger.id}: trigger category invalid`);
    triggerCatalog.set(trigger.id, trigger);
  }
  assert(Array.isArray(policy.opportunities) && policy.opportunities.length > 0,
    'Opportunity v3 list required');
  const ids = new Set();
  for (const opportunity of policy.opportunities) {
    kebab(opportunity.id, 'Opportunity id');
    assert(!ids.has(opportunity.id), `Duplicate opportunity id: ${opportunity.id}`);
    ids.add(opportunity.id);
    assert(typeof opportunity.label === 'string' && opportunity.label.trim(),
      `${opportunity.id}: label required`);
    assert(typeof opportunity.enabled === 'boolean', `${opportunity.id}: enabled required`);
    assert(Array.isArray(opportunity.triggers) && opportunity.triggers.length > 0 &&
      opportunity.triggers.every(value => typeof value === 'string' && value.trim()),
    `${opportunity.id}: routing triggers required`);
    assert(['repository', 'external', 'hybrid', 'runtime'].includes(opportunity.evidence),
      `${opportunity.id}: evidence mode invalid`);
    assert(typeof opportunity.evaluationStatus === 'string' &&
      opportunity.evaluationStatus.length > 0,
    `${opportunity.id}: evaluationStatus required`);
    assert(typeof opportunity.casePacketStatus === 'string' &&
      opportunity.casePacketStatus.length > 0,
    `${opportunity.id}: casePacketStatus required`);
    if (opportunity.variants !== undefined) {
      assert(Array.isArray(opportunity.variants) && opportunity.variants.length >= 2 &&
        opportunity.variants.every(value =>
          typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)),
      `${opportunity.id}: variants must contain at least two kebab-case values`);
    }
    const observedPacketStatus = packetStatus(evidence.opportunityPacket, opportunity.id);
    if (invalidated(observedPacketStatus)) {
      assert(!opportunity.enabled,
        `${opportunity.id}: invalidated case packet must disable the opportunity`);
      assert(invalidated(opportunity.casePacketStatus),
        `${opportunity.id}: case packet invalidation must propagate into policy`);
    }
    if (invalidated(opportunity.evaluationStatus) ||
      invalidated(opportunity.casePacketStatus)) {
      assert(!opportunity.enabled,
        `${opportunity.id}: invalidated opportunities must be disabled`);
    }

    const team = opportunity.team;
    assert(team && typeof team === 'object' && !Array.isArray(team),
      `${opportunity.id}: team required`);
    kebab(team.id, `${opportunity.id}: team id`);
    assert(TOPOLOGIES.has(team.topology), `${opportunity.id}: topology invalid`);
    assert(TRUST_TIERS.has(team.trustTier), `${opportunity.id}: trust tier invalid`);
    assert(team.maxRevisions === 1, `${opportunity.id}: exactly one revision is required`);
    assert(team.coordinator?.role === 'medium-coordinator',
      `${opportunity.id}: medium coordinator required`);
    validateProfile(team.coordinator.profile, `${opportunity.id}: coordinator`);
    assert(MEDIUM_MODELS.has(team.coordinator.profile.model) &&
      team.coordinator.profile.effort === 'medium' &&
      team.coordinator.profile.context === 'default',
    `${opportunity.id}: coordinator must be a project-qualified medium/default profile`);
    assert(['provisional', 'qualified'].includes(team.coordinator.evidenceStatus),
      `${opportunity.id}: coordinator evidence status invalid`);
    assert(team.reviewer?.role === 'medium-review',
      `${opportunity.id}: medium reviewer required`);
    validateProfile(team.reviewer.profile, `${opportunity.id}: reviewer`);
    assert(MEDIUM_MODELS.has(team.reviewer.profile.model) &&
      team.reviewer.profile.effort === 'medium' &&
      team.reviewer.profile.context === 'default',
    `${opportunity.id}: reviewer must be a project-qualified medium/default profile`);
    assert(['provisional', 'qualified'].includes(team.reviewer.evidenceStatus),
      `${opportunity.id}: reviewer evidence status invalid`);
    const worker = team.workerCandidate;
    assert(worker?.role === 'cheap-worker' && typeof worker.enabled === 'boolean',
      `${opportunity.id}: cheap worker candidate required`);
    validateProfile(worker.profile, `${opportunity.id}: worker candidate`);
    assert(CHEAP_MODELS.has(worker.profile.model) &&
      worker.profile.context === 'default',
    `${opportunity.id}: worker must use an implemented cheap/default profile`);
    assert(['provisional', 'invalidated', 'disabled'].includes(worker.evidenceStatus),
      `${opportunity.id}: worker evidence status invalid`);
    assert(worker.authority === 'staging-only',
      `${opportunity.id}: cheap worker authority must be staging-only`);
    if (worker.enabled) {
      assert(team.topology !== 'medium-owner-only',
        `${opportunity.id}: enabled worker requires a worker topology`);
      kebab(worker.capability, `${opportunity.id}: worker capability`);
      kebab(worker.sandboxProfile, `${opportunity.id}: worker sandbox`);
      kebab(worker.delegationClass, `${opportunity.id}: worker delegation class`);
      assert(Array.isArray(worker.validators) && worker.validators.length > 0,
        `${opportunity.id}: worker validators required`);
      worker.validators.forEach(id => toolById(registry, id));
      assert(!invalidated(worker.evidenceStatus) && worker.evidenceStatus !== 'disabled',
        `${opportunity.id}: invalidated worker cannot be enabled`);
      assert(Number.isInteger(worker.currentCases) && worker.currentCases > 0,
        `${opportunity.id}: enabled worker needs valid cases`);
    }
    if (invalidated(evidence.workerPacket?.qualificationStatus)) {
      assert(!worker.enabled,
        `${opportunity.id}: invalidated worker packet must disable cheap work`);
    }
    assert(team.repositoryApply?.authority === 'operator' &&
      typeof team.repositoryApply.enabled === 'boolean',
    `${opportunity.id}: repository apply must be separately operator-authorized`);
    assert(team.repositoryApply.enabled === false,
      `${opportunity.id}: repository apply remains disabled in project policy`);

    assert(Array.isArray(opportunity.conditionalProfiles),
      `${opportunity.id}: conditional profiles required`);
    const conditionalIds = new Set();
    for (const conditional of opportunity.conditionalProfiles) {
      kebab(conditional.id, `${opportunity.id}: conditional id`);
      assert(!conditionalIds.has(conditional.id),
        `${opportunity.id}: duplicate conditional profile ${conditional.id}`);
      conditionalIds.add(conditional.id);
      assert(CONDITIONAL_KINDS.has(conditional.kind),
        `${opportunity.id}/${conditional.id}: conditional kind invalid`);
      validateProfile(conditional.profile,
        `${opportunity.id}/${conditional.id}: conditional profile`);
      validateCondition(
        conditional,
        conditional.triggerIds,
        `${opportunity.id}/${conditional.id}`,
        triggerCatalog,
      );
      if (conditional.kind === 'research-frontier') {
        assert(conditional.profile.model === 'gpt-5.6-sol' &&
          conditional.profile.effort === 'high' &&
          conditional.profile.context === 'default',
        `${opportunity.id}/${conditional.id}: external research profile invalid`);
      }
      if (conditional.kind === 'spec-planner') {
        assert(conditional.profile.model === LUNA_MEDIUM_DEFAULT_PROFILE.model &&
          conditional.profile.effort === LUNA_MEDIUM_DEFAULT_PROFILE.effort &&
          conditional.profile.context === LUNA_MEDIUM_DEFAULT_PROFILE.context,
        `${opportunity.id}/${conditional.id}: spec planner must be gpt-5.6-luna medium/default`);
      }
      if (conditional.kind === 'risk-triggered-frontier-review') {
        assert(conditional.profile.model === 'gpt-5.6-sol' &&
          conditional.profile.effort === 'high' &&
          conditional.profile.context === 'default',
        `${opportunity.id}/${conditional.id}: critical diagnostics must use receipt-bound Sol research only`);
      } else {
        assert(!(conditional.profile.model === 'gpt-5.6-sol' &&
          conditional.profile.effort === 'max' &&
          conditional.profile.context === 'long_context'),
        `${opportunity.id}/${conditional.id}: max/long frontier residency is not allowed`);
      }
    }

    assert(Array.isArray(opportunity.phases) && opportunity.phases.length > 0,
      `${opportunity.id}: phases required`);
    const phaseIds = new Set();
    let coordinatorCount = 0;
    let workerCount = 0;
    let reviewCount = 0;
    let coordinatorIndex = -1;
    let workerIndex = -1;
    let reviewIndex = -1;
    for (const [phaseIndex, phase] of opportunity.phases.entries()) {
      kebab(phase.id, `${opportunity.id}: phase id`);
      assert(!phaseIds.has(phase.id),
        `${opportunity.id}: duplicate phase ${phase.id}`);
      phaseIds.add(phase.id);
      assert(PIPELINE_PHASE_KINDS.has(phase.kind),
        `${opportunity.id}/${phase.id}: phase kind invalid`);
      if (phase.variant !== undefined) {
        assert(opportunity.variants?.includes(phase.variant),
          `${opportunity.id}/${phase.id}: unknown phase variant`);
      }
      if (phase.kind === 'deterministic') {
        assert(typeof phase.tool === 'string',
          `${opportunity.id}/${phase.id}: deterministic tool required`);
        const tool = toolById(registry, phase.tool);
        assert(tool.sideEffect === phase.sideEffect,
          `${opportunity.id}/${phase.id}: phase/tool side effect mismatch`);
        assert(phase.profileRef === undefined,
          `${opportunity.id}/${phase.id}: deterministic phase cannot use a model`);
      } else if (phase.kind === 'deterministic-release') {
        assert(typeof phase.machine === 'string' && !path.isAbsolute(phase.machine),
          `${opportunity.id}/${phase.id}: release machine path required`);
        assert(phase.operatorAuthorizationRequired === true,
          `${opportunity.id}/${phase.id}: deterministic release requires operator authorization`);
        assert(phase.sideEffect === undefined ||
          ['github', 'home-assistant', 'database', 'production', 'destructive']
            .includes(phase.sideEffect),
        `${opportunity.id}/${phase.id}: deterministic release side effect invalid`);
      } else {
        const resolved = profileFor(opportunity, phase.profileRef);
        assert(resolved, `${opportunity.id}/${phase.id}: profileRef invalid`);
        if (CONDITIONAL_KINDS.has(phase.kind)) {
          const id = phase.profileRef.slice('conditional:'.length);
          const conditional = opportunity.conditionalProfiles.find(item => item.id === id);
          assert(conditional?.kind === phase.kind,
            `${opportunity.id}/${phase.id}: conditional profile kind mismatch`);
          assert(phase.condition?.requiresTriggerReceipt === true &&
            canonicalJson(phase.condition.triggerIds) ===
              canonicalJson(conditional.triggerIds),
          `${opportunity.id}/${phase.id}: condition must match the profile trigger ids`);
        } else {
          assert(phase.condition === undefined,
            `${opportunity.id}/${phase.id}: mandatory model phase cannot declare a condition`);
        }
        if (phase.kind === 'medium-coordinator') {
          coordinatorCount += 1;
          coordinatorIndex = phaseIndex;
        }
        if (phase.kind === 'cheap-worker') {
          workerCount += 1;
          workerIndex = phaseIndex;
          assert(phase.enabled === worker.enabled,
            `${opportunity.id}/${phase.id}: worker phase enablement mismatch`);
        }
        if (phase.kind === 'medium-review') {
          reviewCount += 1;
          reviewIndex = phaseIndex;
        }
      }
    }
    assert(coordinatorCount === 1,
      `${opportunity.id}: exactly one medium coordinator phase required`);
    assert(workerCount <= 1 && reviewCount <= 1,
      `${opportunity.id}: at most one worker and reviewer phase allowed`);
    assert(workerCount === reviewCount,
      `${opportunity.id}: cheap worker and medium review phases must be paired`);
    if (workerCount === 1) {
      const validationPhases = opportunity.phases.slice(
        workerIndex + 1,
        reviewIndex,
      );
      const validatorIndexes = validationPhases
        .map((phase, offset) => ({
          phase,
          index: workerIndex + 1 + offset,
        }))
        .filter(({ phase }) => phase.kind === 'deterministic')
        .map(({ index }) => index);
      assert(coordinatorIndex < workerIndex,
        `${opportunity.id}: coordinator must approve dispatch before cheap work`);
      assert(validationPhases.length > 0 &&
        validationPhases.every(phase => phase.kind === 'deterministic') &&
        canonicalJson(validationPhases.map(phase => phase.tool).sort()) ===
          canonicalJson([...worker.validators].sort()) &&
        validatorIndexes.every(index => index > workerIndex && index < reviewIndex),
      `${opportunity.id}: worker validators must exactly match deterministic phases before medium review`);
    }
    assert(!opportunity.phases.some(phase =>
      ['research-frontier', 'spec-planner', 'risk-triggered-frontier-review']
        .includes(phase.kind) && phase.condition === undefined),
    `${opportunity.id}: frontier phases must be trigger-conditional`);
  }
  return policy;
}

export const createTriggerReceipt = createSharedTriggerReceipt;
export const validateTriggerReceipt = validateSharedTriggerReceipt;

function validateUsage(usage, phaseKind, state) {
  assert(usage && typeof usage === 'object' && !Array.isArray(usage),
    'Leg usage state required');
  if (!MODEL_KINDS.has(phaseKind)) {
    assert(usage.state === 'deterministic' && usage.modelCalls === 0 &&
      usage.credits === 0, 'Deterministic legs must record zero model usage');
    return;
  }
  if (state === 'condition-false' || state === 'not-run' || state === 'blocked') {
    assert(usage.state === 'not-run' && usage.modelCalls === 0 &&
      usage.credits === 0, 'Non-run model legs must record explicit zero calls');
    return;
  }
  if (usage.state === 'measured') {
    assert(Number.isInteger(usage.modelCalls) && usage.modelCalls >= 1 &&
      typeof usage.credits === 'number' && usage.credits >= 0,
    'Measured model usage is invalid');
    return;
  }
  assert(usage.state === 'unreconciled' &&
    Number.isInteger(usage.modelCalls) && usage.modelCalls >= 1 &&
    usage.credits === null &&
    typeof usage.reservedCredits === 'number' && usage.reservedCredits > 0,
  'Missing model usage must remain an unreconciled reservation');
}

function releaseMachineForPipeline(context, expected) {
  assert(typeof expected.machine === 'string' &&
    !path.isAbsolute(expected.machine),
  'Deterministic release phase has no bound machine path');
  const root = fs.realpathSync(context.repository);
  const adapter = JSON.parse(fs.readFileSync(
    path.join(root, '.github/agent-budget.json'),
    'utf8',
  ));
  assert(adapter.version === 1 &&
    adapter.project === context.project &&
    typeof adapter.toolRegistry === 'string',
  'Pipeline repository release adapter is invalid');
  return readReleaseMachine(root, {
    ...adapter,
    releaseMachine: expected.machine,
  });
}

export function createPipelineLegReceipt(input) {
  assert(PIPELINE_PHASE_KINDS.has(input.phaseKind), 'Pipeline leg phase kind invalid');
  assert(LEG_STATES.has(input.state), 'Pipeline leg state invalid');
  assert(TRUST_TIERS.has(input.trustTier), 'Pipeline leg trust tier invalid');
  assert(Number.isInteger(input.attempt) && input.attempt >= 1,
    'Pipeline leg attempt required');
  validateUsage(input.usage, input.phaseKind, input.state);
  if (MODEL_KINDS.has(input.phaseKind) && !['condition-false', 'not-run', 'blocked']
    .includes(input.state)) {
    validateProfile(input.profile, 'Pipeline leg profile');
    assert(typeof input.configurationEvidence === 'string' &&
      /^[a-f0-9]{64}$/.test(input.configurationEvidence),
    'Executed model leg requires configuration evidence');
  } else if (!MODEL_KINDS.has(input.phaseKind)) {
    assert(input.profile === null && input.configurationEvidence === null,
      'Deterministic legs cannot carry model configuration');
  }
  if (CONDITIONAL_KINDS.has(input.phaseKind)) {
    assert(input.conditionReceipt && typeof input.conditionReceipt === 'object',
      'Conditional leg requires a condition receipt');
    if (['executed', 'failed', 'unreconciled'].includes(input.state)) {
      assert(Array.isArray(input.allowedTriggerIds) &&
        input.allowedTriggerIds.length > 0,
      'Executed conditional leg requires allowed trigger ids');
      validateTriggerReceipt(input.conditionReceipt, {
        project: input.project,
        opportunityId: input.opportunityId,
        triggerIds: input.allowedTriggerIds,
        precedingReceiptHash: input.previousReceiptHash ?? null,
      });
    }
  }
  if (input.phaseKind === 'deterministic-release') {
    assert(typeof input.authority === 'string' &&
      input.authority === `operator-authorization:${input.authorizationHash}` &&
      typeof input.authorizationHash === 'string' &&
      /^[a-f0-9]{64}$/.test(input.authorizationHash),
    'Deterministic release requires separate operator authorization');
    assert(input.toolEvidence?.machineEnabled === true &&
      input.toolEvidence?.terminalStatus === 'accepted' &&
      /^[a-f0-9]{64}$/.test(input.toolEvidence?.releasePlanHash ?? '') &&
      /^[a-f0-9]{64}$/.test(
        input.toolEvidence?.finalReleaseReceiptHash ?? '',
      ),
    'Deterministic release requires an accepted machine receipt chain');
  } else {
    assert(input.authorizationHash === undefined ||
      input.authorizationHash === null,
    'Non-release pipeline legs cannot carry side-effect authorization');
  }
  if (input.phaseKind === 'cheap-worker') {
    assert(input.authority === 'staging-only',
      'Cheap worker authority must be staging-only');
  }
  const receipt = {
    version: 1,
    kind: 'team-pipeline-leg',
    workflowId: input.workflowId,
    pipelineHash: input.pipelineHash,
    pipelineId: input.pipelineId,
    teamId: input.teamId,
    project: input.project,
    opportunityId: input.opportunityId,
    repository: input.repository,
    baseRevision: input.baseRevision,
    scopeHash: input.scopeHash,
    phaseId: input.phaseId,
    phaseKind: input.phaseKind,
    role: input.role,
    trustTier: input.trustTier,
    attempt: input.attempt,
    revisionParent: input.revisionParent ?? null,
    defectReceipt: input.defectReceipt ?? null,
    conditionReceipt: input.conditionReceipt ?? null,
    profile: input.profile ?? null,
    authority: input.authority,
    authorizationHash: input.authorizationHash ?? null,
    configurationEvidence: input.configurationEvidence ?? null,
    usage: input.usage,
    usageCategory: input.usageCategory ?? usageCategoryForPhase(input.phaseKind),
    usageLineage: input.usageLineage ?? [],
    state: input.state,
    outcome: input.outcome ?? null,
    durationMs: input.durationMs ?? null,
    toolEvidence: input.toolEvidence ?? null,
    previousReceiptHash: input.previousReceiptHash ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
  for (const key of [
    'workflowId', 'pipelineHash', 'pipelineId', 'teamId', 'project', 'opportunityId',
    'repository', 'baseRevision', 'scopeHash', 'phaseId', 'role', 'authority',
    'startedAt', 'completedAt',
  ]) {
    assert(typeof receipt[key] === 'string' && receipt[key].length > 0,
      `Pipeline leg ${key} required`);
  }
  assert(path.isAbsolute(receipt.repository),
    'Pipeline leg repository must be absolute');
  assert(/^[a-f0-9]{64}$/.test(receipt.pipelineHash),
    'Pipeline leg policy hash is invalid');
  assert(/^[a-f0-9]{40,64}$/.test(receipt.baseRevision),
    'Pipeline leg base revision is invalid');
  assert(/^[a-f0-9]{64}$/.test(receipt.scopeHash),
    'Pipeline leg scope hash is invalid');
  if (!MODEL_KINDS.has(receipt.phaseKind) && receipt.state === 'executed') {
    assert(receipt.toolEvidence && typeof receipt.toolEvidence === 'object',
      'Executed deterministic leg requires tool or builtin evidence');
  }
  return { ...receipt, receiptHash: sha256(receipt) };
}

export function verifyPipelineLegs(receipts, context) {
  assert(Array.isArray(receipts), 'Pipeline receipts required');
  assert(Array.isArray(context.expectedPhases) &&
    context.expectedPhases.length > 0,
  'Bound pipeline phase contract required');
  let previous = null;
  let cursor = 0;
  let activeAttempt = 1;
  let workerAttempts = 0;
  let revisionRequests = 0;
  let lastDefectReceipt = null;
  let firstWorkerReceipt = null;
  let workerCycleClosed = false;
  let terminal = false;
  const workerIndex = context.expectedPhases.findIndex(phase =>
    phase.kind === 'cheap-worker');
  for (const receipt of receipts) {
    assert(!terminal, 'Pipeline receipt exists after a terminal leg');
    const { receiptHash, ...unsigned } = receipt;
    assert(receiptHash === sha256(unsigned), 'Pipeline receipt hash mismatch');
    assert(receipt.pipelineId === context.pipelineId &&
      receipt.teamId === context.teamId &&
      receipt.project === context.project &&
      receipt.opportunityId === context.opportunityId &&
      receipt.workflowId === context.workflowId &&
      receipt.pipelineHash === context.pipelineHash &&
      receipt.repository === context.repository &&
      receipt.baseRevision === context.baseRevision &&
      receipt.scopeHash === context.scopeHash,
    'Pipeline receipt scope mismatch');
    assert(receipt.previousReceiptHash === previous, 'Pipeline receipt chain mismatch');
    const expected = context.expectedPhases[cursor];
    assert(expected &&
      receipt.phaseId === expected.id &&
      receipt.phaseKind === expected.kind,
    'Pipeline receipt order differs from the bound policy');
    const authorityMatches = expected.kind === 'deterministic-release'
      ? receipt.authority.startsWith('operator-authorization:')
      : receipt.authority === expected.authority;
    assert(receipt.role === expected.role &&
      authorityMatches &&
      canonicalJson(receipt.profile) === canonicalJson(expected.profile),
    'Pipeline receipt role, authority or profile differs from policy');
    assert(receipt.usageCategory === usageCategoryForPhase(receipt.phaseKind),
      'Pipeline receipt usage category differs from policy');
    assert(receipt.attempt === activeAttempt,
      'Pipeline receipt attempt differs from the active cycle');
    if (receipt.phaseKind === 'deterministic') {
      if (expected.builtin) {
        assert(receipt.toolEvidence?.builtin === expected.builtin,
          'Deterministic builtin receipt differs from policy');
      } else {
        assert(receipt.toolEvidence?.toolId === expected.tool &&
          receipt.toolEvidence?.toolHash === expected.toolContract?.toolHash &&
          receipt.toolEvidence?.sideEffect ===
            expected.toolContract?.sideEffect,
        'Deterministic tool receipt differs from policy');
        if (expected.toolContract?.argvHash !== null) {
          assert(receipt.toolEvidence?.argvHash ===
            expected.toolContract.argvHash,
          'Deterministic command receipt argv differs from policy');
        }

      }
    }
    if (receipt.phaseKind === 'deterministic-release') {
      const releaseResult = context.releaseResults?.[receipt.phaseId];
      assert(typeof receipt.authorizationHash === 'string' &&
        /^[a-f0-9]{64}$/.test(receipt.authorizationHash) &&
        receipt.authority ===
          `operator-authorization:${receipt.authorizationHash}`,
      'Deterministic release receipt authorization binding is invalid');
      assert(releaseResult?.completion &&
        releaseResult.state,
      'Deterministic release verification context is incomplete');
      const machine = releaseMachineForPipeline(context, expected);
      const completion = verifyReleaseCompletion(
        releaseResult.completion,
        machine,
        releaseResult.state,
      );
      assert(
        completion.project === context.project &&
        completion.opportunityId === context.opportunityId &&
        completion.variant === (expected.variant ?? null) &&
        completion.workflowId === context.workflowId &&
        fs.realpathSync(completion.repository) ===
          fs.realpathSync(context.repository) &&
        completion.baseRevision === context.baseRevision &&
        completion.scopeHash === context.scopeHash &&
        receipt.authorizationHash === completion.operatorAuthorizationHash &&
        receipt.toolEvidence?.machineEnabled === true &&
        receipt.toolEvidence?.terminalStatus === 'accepted' &&
        receipt.toolEvidence?.releasePlanHash ===
          completion.releasePlanHash &&
        receipt.toolEvidence?.finalReleaseReceiptHash ===
          completion.finalReleaseReceiptHash,
      'Deterministic release leg lacks a verified accepted machine result');
    } else {
      assert(receipt.authorizationHash === null,
        'Non-release pipeline receipt carries side-effect authorization');
    }
    if (CONDITIONAL_KINDS.has(receipt.phaseKind)) {
      assert(['executed', 'condition-false', 'not-run', 'failed',
        'blocked', 'unreconciled'].includes(receipt.state),
      'Conditional pipeline receipt state is invalid');
      if (['executed', 'failed', 'unreconciled'].includes(receipt.state)) {
        validateTriggerReceipt(receipt.conditionReceipt, {
          project: receipt.project,
          opportunityId: receipt.opportunityId,
          triggerIds: expected.condition?.triggerIds ?? [],
          precedingReceiptHash: previous,
        });
      } else {
        assert(receipt.conditionReceipt?.matched === false,
          'Skipped conditional phase requires an explicit false condition receipt');
      }
    } else {
      assert(['executed', 'failed', 'blocked', 'unreconciled']
        .includes(receipt.state),
      'Mandatory pipeline receipt cannot be skipped');
    }
    if (receipt.phaseKind === 'cheap-worker' && receipt.state === 'executed') {
      assert(!workerCycleClosed, 'Worker cycle is already terminal');
      workerAttempts += 1;
      assert(workerAttempts <= 2, 'A second revision is forbidden');
      assert(receipt.attempt === workerAttempts,
        'Worker attempts must be recorded as separate ordered legs');
      if (workerAttempts === 1) {
        assert(receipt.revisionParent === null && receipt.defectReceipt === null,
          'Initial worker output cannot have a revision parent');
        firstWorkerReceipt = receipt.receiptHash;
      } else {
        assert(lastDefectReceipt !== null &&
          receipt.previousReceiptHash === lastDefectReceipt &&
          receipt.revisionParent === firstWorkerReceipt &&
          receipt.defectReceipt === lastDefectReceipt,
        'The single revision must bind the exact reviewer defect receipt');
      }
    }
    let semanticTerminal = false;
    if (receipt.phaseKind === 'medium-review') {
      assert(!workerCycleClosed && workerAttempts >= 1 &&
        receipt.attempt === workerAttempts,
      'Medium review must match the active worker attempt');
      assert(['accepted', 'revision-requested', 'rejected', 'blocked', 'failed']
        .includes(receipt.outcome),
      'Medium review outcome is invalid');
      if (receipt.outcome === 'revision-requested') {
        revisionRequests += 1;
        assert(revisionRequests <= 1 && workerAttempts === 1,
          'A second reviewer-directed revision fails closed');
        lastDefectReceipt = receipt.receiptHash;
        assert(workerIndex >= 0, 'Revision requested without a worker phase');
        cursor = workerIndex;
        activeAttempt = 2;
      } else {
        workerCycleClosed = true;
        cursor += 1;
        semanticTerminal = receipt.outcome !== 'accepted';
      }
    } else {
      cursor += 1;
      if (receipt.state === 'executed') {
        if (receipt.phaseKind === 'medium-coordinator') {
          semanticTerminal = !['accepted', 'dispatch-approved']
            .includes(receipt.outcome);
        } else if (receipt.phaseKind === 'cheap-worker') {
          semanticTerminal = !['accepted', 'staged']
            .includes(receipt.outcome);
        } else {
          semanticTerminal = receipt.outcome !== 'accepted';
        }
      }
    }
    if (['failed', 'blocked', 'unreconciled'].includes(receipt.state)) {
      terminal = true;
    }
    if (semanticTerminal) terminal = true;
    previous = receipt.receiptHash;
  }
  const next = terminal ? null : context.expectedPhases[cursor] ?? null;
  return {
    valid: true,
    lastReceiptHash: previous,
    workerAttempts,
    revisions: Math.max(0, workerAttempts - 1),
    activeAttempt,
    terminal,
    nextPhaseId: next?.id ?? null,
    nextPhaseKind: next?.kind ?? null,
  };
}

export function observePipelineCompletion(receipts, context, input) {
  const verified = verifyPipelineLegs(receipts, context);
  const finalReceipt = receipts.at(-1);
  assert(verified.lastReceiptHash && finalReceipt,
    'Learning observation requires pipeline receipt evidence');
  return createWorkflowCompletionObservation({
    workflowId: context.workflowId,
    project: context.project,
    opportunityId: context.opportunityId,
    repositoryHash: sha256(fs.realpathSync(context.repository)),
    pipelineHash: context.pipelineHash,
    verifiedPipelineReceiptHash: verified.lastReceiptHash,
    traceHash: input.traceHash,
    transcriptMetadataHash: input.transcriptMetadataHash ?? null,
    usageHash: input.usageHash,
    outcome: input.outcome ?? finalReceipt.outcome ??
      (verified.terminal ? finalReceipt.state : 'accepted'),
    candidateId: input.candidateId ?? null,
    candidateState: input.candidateState ?? 'observed',
    observedAt: input.observedAt,
  });
}

export function nextWorkerAttempt(receipts, context) {
  const verified = verifyPipelineLegs(receipts, context);
  const workers = receipts.filter(receipt =>
    receipt.phaseKind === 'cheap-worker' && receipt.state === 'executed');
  const previous = receipts.at(-1) ?? null;
  if (workers.length === 0) {
    assert(verified.nextPhaseId === context.workerPhaseId,
    'Initial cheap work requires the complete accepted pipeline prefix');
    assert(previous?.phaseKind === 'medium-coordinator' &&
      previous.phaseId === context.coordinatorPhaseId &&
      previous.state === 'executed' &&
      ['accepted', 'dispatch-approved'].includes(previous.outcome),
    'Initial cheap work requires an immediately preceding coordinator dispatch receipt');
    return {
      attempt: 1,
      revisionParent: null,
      defectReceipt: null,
      previousReceiptHash: previous.receiptHash,
      verifiedPipelineReceiptHash: verified.lastReceiptHash,
    };
  }
  assert(workers.length === 1 &&
    verified.nextPhaseId === context.workerPhaseId &&
    previous?.phaseKind === 'medium-review' &&
    previous.phaseId === context.reviewPhaseId &&
    previous.state === 'executed' &&
    previous.outcome === 'revision-requested',
  'Additional cheap work requires the one immediately preceding reviewer revision request');
  return {
    attempt: 2,
    revisionParent: workers[0].receiptHash,
    defectReceipt: previous.receiptHash,
    previousReceiptHash: previous.receiptHash,
    verifiedPipelineReceiptHash: verified.lastReceiptHash,
  };
}

export function validateMediumAcceptance(stagingReceipt, acceptance, validationReceipt, expected) {
  assert(acceptance?.version === 1 &&
    acceptance.kind === 'medium-review-acceptance',
  'Medium reviewer acceptance required');
  assert(acceptance.decision === 'accept-exact-staged-candidate',
    'Medium acceptance decision is not exact');
  assert(acceptance.approvedBy === 'medium-reviewer',
    'Only the authorized medium reviewer may accept a staged candidate');
  for (const key of [
    'workflowId', 'pipelineHash', 'verifiedPipelineReceiptHash', 'jobHash',
    'sandboxReadinessHash',
    'project', 'opportunityId', 'capability', 'repository', 'baseRevision',
    'scopeHash', 'candidateSha256', 'evidenceSha256',
    'validationEvidenceHash', 'configurationEvidenceHash', 'approvedAt',
    'expiresAt',
  ]) {
    assert(typeof acceptance[key] === 'string' && acceptance[key].length > 0,
      `Medium acceptance ${key} required`);
  }
  assert(acceptance.project === stagingReceipt.plan.project &&
    acceptance.opportunityId === stagingReceipt.plan.opportunityId &&
    acceptance.capability === stagingReceipt.plan.capability,
  'Medium acceptance pipeline scope mismatch');
  assert(fs.realpathSync(acceptance.repository) ===
    fs.realpathSync(stagingReceipt.repository),
  'Medium acceptance repository mismatch');
  assert(acceptance.baseRevision === stagingReceipt.baseRevision &&
    acceptance.workflowId === stagingReceipt.workflowId &&
    acceptance.pipelineHash === stagingReceipt.pipelineHash &&
    acceptance.verifiedPipelineReceiptHash ===
      stagingReceipt.verifiedPipelineReceiptHash &&
    acceptance.jobHash === stagingReceipt.jobHash &&
    acceptance.sandboxReadinessHash === stagingReceipt.sandboxReadinessHash &&
    acceptance.scopeHash === stagingReceipt.scopeHash &&
    acceptance.candidateSha256 === stagingReceipt.candidateSha256 &&
    acceptance.evidenceSha256 === stagingReceipt.evidenceSha256,
  'Medium acceptance staged evidence mismatch');
  assert(acceptance.validationEvidenceHash === validationReceipt.evidenceHash,
    'Medium acceptance validation receipt mismatch');
  validateProfile(acceptance.reviewer, 'Medium acceptance reviewer');
  assert(canonicalJson(acceptance.reviewer) ===
    canonicalJson(stagingReceipt.plan.reviewer),
  'Medium acceptance reviewer profile mismatch');
  assert(acceptance.configurationEvidenceHash ===
    expected.configurationEvidenceHash,
  'Medium acceptance configuration evidence mismatch');
  const approved = Date.parse(acceptance.approvedAt);
  const expires = Date.parse(acceptance.expiresAt);
  const now = expected.now ?? Date.now();
  assert(Number.isFinite(approved) && Number.isFinite(expires) &&
    approved <= now && expires > now,
  'Medium acceptance is not currently valid');
  return { accepted: true, acceptanceHash: sha256(acceptance) };
}

export function validateRepositoryApplyAuthorization(authorization, context) {
  assert(authorization?.version === 1 &&
    authorization.kind === 'repository-apply-authorization',
  'Repository apply authorization required');
  assert(authorization.authorizedBy === 'operator',
    'Repository apply authorization must come from the operator');
  for (const key of [
    'workflowId', 'pipelineHash', 'verifiedPipelineReceiptHash', 'jobHash',
    'sandboxReadinessHash',
    'project', 'opportunityId', 'capability', 'repository', 'baseRevision',
    'scopeHash', 'candidateSha256', 'validationEvidenceHash', 'issuedAt',
    'expiresAt',
  ]) {
    assert(typeof authorization[key] === 'string' && authorization[key].length > 0,
      `Repository apply authorization ${key} required`);
    if (context[key] !== undefined) {
      assert(authorization[key] === context[key],
        `Repository apply authorization ${key} mismatch`);
    }
  }
  assert(fs.realpathSync(authorization.repository) ===
    fs.realpathSync(context.repository),
  'Repository apply authorization repository mismatch');
  const issued = Date.parse(authorization.issuedAt);
  const expires = Date.parse(authorization.expiresAt);
  const now = context.now ?? Date.now();
  assert(Number.isFinite(issued) && Number.isFinite(expires) &&
    issued <= now && expires > now,
  'Repository apply authorization is not currently valid');
  return { authorized: true, authorizationHash: sha256(authorization) };
}

export function evaluateTrustTier(input) {
  assert(TRUST_TIERS.has(input.requestedTier), 'Requested trust tier invalid');
  if (input.requestedTier === 'provisional-staging') {
    return {
      allowed: true,
      tier: 'provisional-staging',
      permissions: ['stage-untrusted-artifact'],
      reasons: [],
    };
  }
  const reasons = [];
  if (input.preValidationPassed !== true) reasons.push('isolated deterministic pre-validation missing');
  if (input.mediumAcceptanceValid !== true) reasons.push('authorized medium acceptance missing');
  if (input.repositoryApplyAuthorizationValid !== true) {
    reasons.push('separate repository-apply authorization missing');
  }
  if (input.postValidationPassed !== true) reasons.push('identical post-apply validation missing');
  if (input.validationBindingIdentical !== true) {
    reasons.push('pre/post validation or rollback binding differs');
  }
  if (input.rollbackBound !== true) reasons.push('exact rollback binding missing');
  if (input.requestedTier === 'unattended-application') {
    if (!Number.isInteger(input.matchedHeldOutCases) || input.matchedHeldOutCases < 30) {
      reasons.push('fewer than 30 matched held-out cases');
    }
    if (input.familyDimensionUsed === true &&
      (!Number.isInteger(input.families) || input.families < 10)) {
      reasons.push('fewer than 10 matched families');
    }
    if (input.independentReview !== true) reasons.push('independent review missing');
    if (typeof input.confidence !== 'number' ||
      typeof input.minimumConfidence !== 'number' ||
      input.confidence < input.minimumConfidence) {
      reasons.push('confidence gate failed');
    }
    if (input.matchingTerminalOutcomes !== true) reasons.push('terminal outcomes differ');
    if (input.criticalFailures !== 0) reasons.push('critical failures are nonzero');
    if (input.rollbackFaultTested !== true) reasons.push('rollback is not fault-tested');
    if (typeof input.completeAllLegSavings !== 'number' ||
      input.completeAllLegSavings <= 0) {
      reasons.push('positive complete all-leg savings are unavailable');
    }
    if (input.allUsageReconciled !== true) reasons.push('all-leg usage is unreconciled');
  }
  return {
    allowed: reasons.length === 0,
    tier: input.requestedTier,
    permissions: reasons.length === 0
      ? input.requestedTier === 'unattended-application'
        ? ['apply-exact-reviewed-artifact', 'auto-apply-exact-reviewed-artifact']
        : ['apply-exact-reviewed-artifact']
      : [],
    reasons,
  };
}

export function requiredPipelineSideEffect(opportunity, registry) {
  return opportunity.phases.reduce((highest, phase) => {
    if (phase.kind === 'deterministic') {
      const effect = toolById(registry, phase.tool).sideEffect;
      return SIDE_EFFECT_LEVELS[effect] > SIDE_EFFECT_LEVELS[highest]
        ? effect : highest;
    }

    if (phase.kind === 'deterministic-release') {
      const effect = phase.sideEffect ?? 'production';
      return SIDE_EFFECT_LEVELS[effect] > SIDE_EFFECT_LEVELS[highest]
        ? effect : highest;
    }
    return highest;
  }, 'none');
}

export {
  createWorkflowCompletionObservation,
  verifyWorkflowCompletionObservation,
};
