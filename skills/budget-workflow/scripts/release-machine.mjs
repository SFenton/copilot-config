#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contained, readAdapter } from './budget.mjs';
import {
  SIDE_EFFECT_LEVELS,
  createReceipt,
  validateTriggerReceipt,
  resolvedConfiguration,
  runRegisteredTool,
  sha256,
  toolById,
  validateAuthorization,
  validateOperatorAuthorization,
  validateProfile,
  validateToolRegistry,
  verifyReceiptChain,
} from './workflow.mjs';

const EXECUTORS = new Set(['deterministic', 'supervisor']);
const OPERATIONS = new Set([
  'authorize', 'command', 'git-release', 'github-release', 'deploy',
  'verify', 'cleanup', 'rollback',
]);
const V2_FAILURES = new Set(['rejected', 'blocked', 'abnormal']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function profile(value, label) {
  assert(value && typeof value === 'object' && typeof value.model === 'string',
    `${label} profile required`);
  assert(['low', 'medium', 'high', 'max'].includes(value.effort), `${label} effort invalid`);
  assert(['default', 'long_context'].includes(value.context), `${label} context invalid`);
}

export function readReleaseMachine(root, adapter = readAdapter(root)) {
  assert(typeof adapter.releaseMachine === 'string', 'Adapter releaseMachine required');
  const file = contained(root, adapter.releaseMachine);
  const machine = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (machine.version === 3) {
    assert(typeof adapter.toolRegistry === 'string',
      'Release machine v3 requires an adapter toolRegistry');
    const registry = validateToolRegistry(
      JSON.parse(fs.readFileSync(contained(root, adapter.toolRegistry), 'utf8')),
      adapter.project,
    );
    return validateReleaseMachineV3({ ...machine, toolRegistry: registry }, adapter.project);
  }
  if (machine.version === 2) {
    assert(typeof adapter.toolRegistry === 'string', 'Release machine v2 requires an adapter toolRegistry');
    const registry = validateToolRegistry(
      JSON.parse(fs.readFileSync(contained(root, adapter.toolRegistry), 'utf8')),
      adapter.project,
    );
    return validateReleaseMachineV2({ ...machine, toolRegistry: registry }, adapter.project);
  }
  assert(machine.version === 1 && machine.project === adapter.project,
    'Release machine version/project mismatch');
  assert(machine.advisoryOnly === true,
    'Version 1 release machines must be advisoryOnly until executable tools and evidence-bound receipts are available');
  assert(machine.executor === null, 'Advisory release machines cannot declare a model executor');
  profile(machine.supervisor, 'supervisor');
  profile(machine.exception, 'exception');
  assert(Array.isArray(machine.steps) && machine.steps.length >= 4, 'Release steps required');
  const ids = new Set();
  for (const step of machine.steps) {
    assert(step && typeof step.id === 'string' &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.id) && !ids.has(step.id),
    'Release step IDs must be unique kebab-case');
    ids.add(step.id);
    assert(typeof step.label === 'string' && step.label, `${step.id}: label required`);
    assert(EXECUTORS.has(step.executor), `${step.id}: executor invalid`);
    assert(OPERATIONS.has(step.operation), `${step.id}: operation invalid`);
    assert(Array.isArray(step.evidence) && step.evidence.length > 0 &&
      step.evidence.every(value => typeof value === 'string' && value),
    `${step.id}: evidence required`);
    if (step.operation === 'authorize') {
      assert(step.executor === 'supervisor', `${step.id}: authorization requires the supervisor`);
    } else {
      assert(step.executor === 'deterministic', `${step.id}: advisory routine steps must be deterministic`);
    }
    if (step.operation === 'command') {
      assert(Array.isArray(step.argv) && step.argv.length > 0 &&
        step.argv.every(value => typeof value === 'string' && value),
      `${step.id}: command argv required`);
    } else {
      assert(step.argv === undefined, `${step.id}: argv is command-only`);
    }
    if (step.operation === 'rollback') {
      assert(step.rollbackOnly === true, `${step.id}: every rollback step must be rollbackOnly`);
    } else {
      assert(step.rollbackOnly === undefined, `${step.id}: rollbackOnly is valid only for rollback steps`);
    }
    if (step.failure !== undefined) {
      assert(step.failure === 'escalate' || typeof step.failure === 'string',
        `${step.id}: failure target invalid`);
    }
    assert(machine.steps[0].operation === 'authorize' && machine.steps[0].executor === 'supervisor',
      'The first release step must be supervisor authorization');
    assert(machine.steps.slice(1).every(step => step.operation !== 'authorize'),
      'Release machines may contain only one authorization step');
  }
  for (const step of machine.steps) {
    if (step.failure && step.failure !== 'escalate') {
      assert(ids.has(step.failure), `${step.id}: unknown failure target`);
      const target = machine.steps.find(item => item.id === step.failure);
      assert(target.operation === 'rollback' && target.rollbackOnly === true,
        `${step.id}: failure target must be rollback-only`);
    }
  }
  return machine;
}

export function validateReleaseMachineV2(machine, project = machine?.project) {
  assert(machine && machine.version === 2 && machine.project === project,
    'Release machine v2 version/project mismatch');
  assert(typeof machine.enabled === 'boolean', 'Release machine v2 enabled flag required');
  assert(typeof machine.opportunity === 'string' && machine.opportunity.length > 0,
    'Release machine v2 opportunity required');
  profile(machine.supervisor, 'supervisor');
  profile(machine.exception, 'exception');
  validateToolRegistry(machine.toolRegistry, project);
  assert(Array.isArray(machine.steps) && machine.steps.length >= 4,
    'Release machine v2 steps required');
  const ids = new Set();
  for (const [index, step] of machine.steps.entries()) {
    assert(step && typeof step.id === 'string' &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.id) && !ids.has(step.id),
    'Release machine v2 step IDs must be unique kebab-case');
    ids.add(step.id);
    assert(typeof step.label === 'string' && step.label, `${step.id}: label required`);
    assert(['deterministic', 'supervisor'].includes(step.executor),
      `${step.id}: executor invalid`);
    assert(OPERATIONS.has(step.operation), `${step.id}: operation invalid`);
    assert(Array.isArray(step.evidence) && step.evidence.length > 0,
      `${step.id}: evidence required`);
    if (index === 0) {
      assert(step.operation === 'authorize' && step.executor === 'supervisor',
        'Release machine v2 must begin with supervisor authorization');
      assert(step.tool === undefined, `${step.id}: authorization cannot execute a tool`);
    } else {
      assert(step.operation !== 'authorize' && step.executor === 'deterministic',
        `${step.id}: routine steps must be deterministic`);
      assert(typeof step.tool === 'string', `${step.id}: registered tool required`);
      toolById(machine.toolRegistry, step.tool);
    }
    if (step.operation === 'rollback') {
      assert(step.rollbackOnly === true, `${step.id}: rollback must be rollbackOnly`);
      assert(typeof step.rollbackVerificationTool === 'string',
        `${step.id}: rollback verification tool required`);
      toolById(machine.toolRegistry, step.rollbackVerificationTool);
    } else {
      assert(step.rollbackOnly === undefined,
        `${step.id}: rollbackOnly is valid only for rollback steps`);
      assert(step.rollbackVerificationTool === undefined,
        `${step.id}: rollback verification is rollback-only`);
    }
    if (step.failure !== undefined) {
      assert(V2_FAILURES.has(step.failure) || typeof step.failure === 'string',
        `${step.id}: failure target invalid`);
    }
    if (index > 0) {
      assert(typeof step.failure === 'string', `${step.id}: explicit failure transition required`);
      if (step.operation === 'cleanup') {
        assert(step.failure === 'abnormal', `${step.id}: cleanup failure must be abnormal`);
      }
    }
  }
  for (const [index, step] of machine.steps.entries()) {
    if (step.failure && !V2_FAILURES.has(step.failure)) {
      const targetIndex = machine.steps.findIndex(item => item.id === step.failure);
      assert(targetIndex > index, `${step.id}: rollback target must follow the failed step`);
      const target = machine.steps[targetIndex];
      assert(target.operation === 'rollback' && target.rollbackOnly === true,
        `${step.id}: failure target must be rollback-only`);
    }
    if (['deploy', 'github-release'].includes(step.operation)) {
      assert(machine.steps.slice(index + 1).some(item =>
        !item.rollbackOnly && item.operation === 'verify'),
      `${step.id}: publish/deploy requires a later verification step`);
    }
  }
  assert(machine.steps.some(step => step.operation === 'cleanup' && !step.rollbackOnly),
    'Release machine v2 requires unconditional cleanup');
  if (machine.enabled) {
    assert(machine.supervisor.model === 'gpt-5.6-sol',
      'Enabled release machine supervisor must be GPT-5.6 Sol');
    assert(machine.exception.model === 'gpt-5.6-sol' &&
      machine.exception.effort === 'max' &&
      machine.exception.context === 'long_context',
    'Enabled release machine exception profile must be Sol max/long_context');
    const tools = machineToolIds(machine).map(id => toolById(machine.toolRegistry, id));
    assert(tools.every(tool => tool.kind !== 'disabled'),
      'Enabled release machine cannot reference disabled tools');
    if (tools.some(tool => tool.kind === 'fake-driver')) {
      assert(machine.fakeOnly === true && tools.every(tool =>
        tool.kind === 'fake-driver'), 'Enabled fake release machine must be explicitly fakeOnly');
    }
  }
  return machine;
}

export function validateReleaseMachineV3(machine, project = machine?.project) {
  assert(machine && machine.version === 3 && machine.project === project,
    'Release machine v3 version/project mismatch');
  assert(typeof machine.enabled === 'boolean', 'Release machine v3 enabled flag required');
  assert(machine.operatorAuthorizationRequired === true,
    'Release machine v3 requires explicit operator authorization');
  assert(typeof machine.opportunity === 'string' && machine.opportunity.length > 0,
    'Release machine v3 opportunity required');
  assert(machine.reviewer?.role === 'medium-review' &&
    machine.reviewer.authority === 'review-only',
  'Release machine v3 medium reviewer contract required');
  validateProfile(machine.reviewer.profile, 'release reviewer');
  assert(['claude-sonnet-5', 'gpt-5.6-sol'].includes(machine.reviewer.profile.model) &&
    machine.reviewer.profile.effort === 'medium' &&
    machine.reviewer.profile.context === 'default',
  'Release machine reviewer must be medium/default');
  assert(machine.exception?.role === 'risk-triggered-frontier-review' &&
    machine.exception.requiresTriggerReceipt === true,
  'Release machine v3 exception must be trigger-gated');
  validateProfile(machine.exception.profile, 'release exception');
  assert(machine.exception.profile.model === 'gpt-5.6-sol' &&
    machine.exception.profile.effort === 'max' &&
    machine.exception.profile.context === 'long_context',
  'Release machine exception must be Sol max/long_context');
  assert(Array.isArray(machine.exception.triggerIds) &&
    machine.exception.triggerIds.length > 0 &&
    machine.exception.triggerIds.every(id =>
      typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)),
  'Release machine exception requires concrete trigger ids');
  validateToolRegistry(machine.toolRegistry, project);
  assert(Array.isArray(machine.steps) && machine.steps.length >= 3,
    'Release machine v3 steps required');
  const ids = new Set();
  for (const [index, step] of machine.steps.entries()) {
    assert(step && typeof step.id === 'string' &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.id) && !ids.has(step.id),
    'Release machine v3 step IDs must be unique kebab-case');
    ids.add(step.id);
    assert(typeof step.label === 'string' && step.label, `${step.id}: label required`);
    assert(step.executor === 'deterministic',
      `${step.id}: release execution must be deterministic`);
    assert(step.operation !== 'authorize' && OPERATIONS.has(step.operation),
      `${step.id}: operation invalid`);
    assert(typeof step.tool === 'string', `${step.id}: registered tool required`);
    toolById(machine.toolRegistry, step.tool);
    assert(Array.isArray(step.evidence) && step.evidence.length > 0,
      `${step.id}: evidence required`);
    if (step.operation === 'rollback') {
      assert(step.rollbackOnly === true, `${step.id}: rollback must be rollbackOnly`);
      assert(typeof step.rollbackVerificationTool === 'string',
        `${step.id}: rollback verification tool required`);
      toolById(machine.toolRegistry, step.rollbackVerificationTool);
    } else {
      assert(step.rollbackOnly === undefined,
        `${step.id}: rollbackOnly is valid only for rollback steps`);
      assert(step.rollbackVerificationTool === undefined,
        `${step.id}: rollback verification is rollback-only`);
    }
    assert(typeof step.failure === 'string', `${step.id}: explicit failure transition required`);
    if (step.operation === 'cleanup') {
      assert(step.failure === 'abnormal', `${step.id}: cleanup failure must be abnormal`);
    }
    if (index === 0) {
      assert(['command', 'verify'].includes(step.operation),
        'Release machine v3 starts with deterministic validation, not a model authorization step');
    }
  }
  for (const [index, step] of machine.steps.entries()) {
    if (step.failure && !V2_FAILURES.has(step.failure)) {
      const targetIndex = machine.steps.findIndex(item => item.id === step.failure);
      assert(targetIndex > index, `${step.id}: rollback target must follow the failed step`);
      const target = machine.steps[targetIndex];
      assert(target.operation === 'rollback' && target.rollbackOnly === true,
        `${step.id}: failure target must be rollback-only`);
    }
    if (['deploy', 'github-release'].includes(step.operation)) {
      assert(machine.steps.slice(index + 1).some(item =>
        !item.rollbackOnly && item.operation === 'verify'),
      `${step.id}: publish/deploy requires a later verification step`);
    }
  }
  assert(machine.steps.some(step => step.operation === 'cleanup' && !step.rollbackOnly),
    'Release machine v3 requires unconditional cleanup');
  const cleanupSteps = machine.steps.filter(step =>
    step.operation === 'cleanup' && !step.rollbackOnly);
  assert(cleanupSteps.length === 1 &&
    machine.steps.at(-1)?.id === cleanupSteps[0].id,
  'Release machine v3 requires exactly one terminal cleanup step');
  if (machine.enabled) {
    const tools = machineToolIds(machine).map(id => toolById(machine.toolRegistry, id));
    assert(tools.every(tool => tool.kind !== 'disabled'),
      'Enabled release machine cannot reference disabled tools');
    const allFake = tools.every(tool => tool.kind === 'fake-driver');
    assert((machine.fakeOnly === true) === allFake,
      'Enabled release machine fakeOnly must exactly match its tool contracts');
  }
  return machine;
}

export function releasePlan(machine) {
  if (machine.version === 3) {
    const plan = {
      version: 3,
      project: machine.project,
      opportunity: machine.opportunity,
      variant: machine.variant ?? null,
      enabled: machine.enabled,
      fakeOnly: machine.fakeOnly === true,
      executable: machine.enabled && machineToolIds(machine).every(id =>
        toolById(machine.toolRegistry, id).kind !== 'disabled'),
      operatorAuthorizationRequired: true,
      reviewer: machine.reviewer,
      exception: machine.exception,
      toolContracts: machineToolContracts(machine),
      steps: machine.steps.map(({ rollbackVerificationTool, ...step }) => ({
        ...step,
        ...(rollbackVerificationTool ? { rollbackVerificationTool } : {}),
      })),
    };
    return { ...plan, planHash: sha256(plan) };
  }
  if (machine.version === 2) {
    const plan = {
      version: 2,
      project: machine.project,
      opportunity: machine.opportunity,
      variant: machine.variant ?? null,
      enabled: machine.enabled,
      fakeOnly: machine.fakeOnly === true,
      executable: machine.enabled && machineToolIds(machine).every(id =>
        toolById(machine.toolRegistry, id).kind !== 'disabled'),
      supervisor: machine.supervisor,
      exception: machine.exception,
      toolContracts: machineToolContracts(machine),
      steps: machine.steps.map(({ rollbackVerificationTool, ...step }) => ({
        ...step,
        ...(rollbackVerificationTool ? { rollbackVerificationTool } : {}),
      })),
    };
    return { ...plan, planHash: sha256(plan) };
  }
  return {
    version: 1,
    project: machine.project,
    advisoryOnly: true,
    executable: false,
    supervisor: machine.supervisor,
    exception: machine.exception,
    policy: 'Version 1 is advisory-only. Existing project release contracts remain frontier-owned until a version 2 deterministic executor binds authorization, tools, validators, receipts, rollback and cleanup.',
    steps: machine.steps,
  };
}

function machineToolIds(machine) {
  return [...new Set(machine.steps.flatMap(step => [
    step.tool,
    step.rollbackVerificationTool,
  ]).filter(Boolean))];
}

function machineToolContracts(machine) {
  return machineToolIds(machine)
    .sort()
    .map(id => {
      const tool = toolById(machine.toolRegistry, id);
      return {
        id,
        toolHash: sha256(tool),
      };
    });
}

function machineRequiredSideEffect(machine) {
  return machineToolIds(machine).reduce((highest, id) => {
    const effect = toolById(machine.toolRegistry, id).sideEffect;
    return SIDE_EFFECT_LEVELS[effect] > SIDE_EFFECT_LEVELS[highest] ? effect : highest;
  }, 'none');
}

function assertReleaseExecutionWindow(machine, step, authorization) {
  const stepIndex = machine.steps.findIndex(item => item.id === step.id);
  const tools = machine.steps.slice(stepIndex).flatMap(item => [
    toolById(machine.toolRegistry, item.tool),
    item.rollbackVerificationTool
      ? toolById(machine.toolRegistry, item.rollbackVerificationTool)
      : null,
  ]).filter(Boolean);
  const requiredMs = tools.reduce((total, tool) =>
    total + (tool.timeoutSeconds ?? 0) * 1000, 1000);
  const remainingMs = Date.parse(authorization.expiresAt) - Date.now();
  assert(remainingMs >= requiredMs,
    'Operator authorization window is too short for the registered release step');
}

function criticalException(machine, state, failedStep, instruction) {
  const precedingReceiptHash = state.receipts?.at(-1)?.receiptHash ?? null;
  if (!state.triggerReceipt) {
    return {
      status: 'blocked',
      project: machine.project,
      failedStep,
      reason: 'exception-trigger-receipt-required',
      requiredTriggerIds: machine.exception.triggerIds,
      instruction: 'Create an evidence-bound project trigger receipt before launching critical frontier review.',
    };
  }
  const triggerReceipt = validateTriggerReceipt(state.triggerReceipt, {
    project: machine.project,
    opportunityId: machine.opportunity,
    triggerIds: machine.exception.triggerIds,
    precedingReceiptHash,
  });
  return {
    status: 'exception-review-required',
    project: machine.project,
    failedStep,
    profile: machine.exception.profile,
    triggerReceiptHash: triggerReceipt.receiptHash,
    instruction,
  };
}

function cleanupAction(machine, receiptById, terminal, state = {}) {
  const cleanup = machine.steps.find(step => step.operation === 'cleanup' && !step.rollbackOnly);
  const receipt = receiptById.get(cleanup.id);
  if (!receipt) return { status: 'ready', step: cleanup, profile: null, pendingTerminal: terminal };
  if (receipt.status !== 'accepted') {
    if (machine.version === 3) {
      return criticalException(
        machine,
        state,
        cleanup.id,
        'Release cleanup failed. Preserve every receipt and review only the evidenced cleanup conflict.',
      );
    }
    return {
      status: 'abnormal',
      failedStep: cleanup.id,
      profile: machine.version === 3 ? machine.exception.profile : machine.exception,
      instruction: 'Release cleanup failed; preserve all evidence and diagnose only this failure.',
    };
  }
  return terminal;
}

function validateReleaseReceiptState(machine, receiptById) {
  const normal = machine.steps.filter(step => !step.rollbackOnly && step.operation !== 'cleanup');
  let missing = false;
  let failedStep = null;
  for (const step of normal) {
    const receipt = receiptById.get(step.id);
    if (!receipt) {
      missing = true;
      continue;
    }
    assert(!missing, `Receipt exists after an incomplete earlier step: ${step.id}`);
    assert(!failedStep, `Receipt exists after failed step ${failedStep?.id ?? 'unknown'}: ${step.id}`);
    if (receipt.status !== 'accepted') failedStep = step;
  }
  for (const rollback of machine.steps.filter(step => step.rollbackOnly)) {
    const receipt = receiptById.get(rollback.id);
    if (!receipt) continue;
    assert(failedStep && failedStep.failure === rollback.id,
      `Rollback receipt is not justified by the failed path: ${rollback.id}`);
  }
  const cleanup = machine.steps.find(step => step.operation === 'cleanup' && !step.rollbackOnly);
  if (receiptById.has(cleanup.id)) {
    const normalComplete = normal.every(step => receiptById.get(step.id)?.status === 'accepted');
    const failedReceipt = failedStep ? receiptById.get(failedStep.id) : null;
    const rollbackReceipt = failedStep?.failure && !V2_FAILURES.has(failedStep.failure)
      ? receiptById.get(failedStep.failure)
      : null;
    const rollbackComplete = failedStep?.failure &&
      !V2_FAILURES.has(failedStep.failure) &&
      rollbackReceipt?.status === 'accepted';
    const abnormalPath = failedReceipt?.status === 'abnormal' ||
      rollbackReceipt && rollbackReceipt.status !== 'accepted';
    assert(normalComplete || failedStep && (
      V2_FAILURES.has(failedStep.failure) || rollbackComplete || abnormalPath
    ), 'Cleanup receipt is not justified by a terminal path');
  }
}

function nextReleaseActionV2(machine, state) {
  if (!machine.enabled) {
    return {
      status: 'blocked',
      project: machine.project,
      reason: 'release-machine-disabled',
    };
  }
  assert(typeof state.currentRevision === 'string' &&
    typeof state.scopeHash === 'string' &&
    typeof state.resolvedConfigurationEvidenceHash === 'string',
  'Enabled release state requires current revision, scope and resolved configuration evidence');
  const resolved = resolvedConfiguration(
    state.resolvedConfigurationEvents,
    machine.supervisor,
  );
  assert(resolved.evidenceHash === state.resolvedConfigurationEvidenceHash,
    'Release resolved configuration evidence mismatch');
  const plan = releasePlan(machine);
  const authorization = validateAuthorization(state.authorization, {
    project: machine.project,
    opportunityId: machine.opportunity,
    variant: machine.variant,
    repository: state.authorization?.repository,
    requiredSideEffect: machineRequiredSideEffect(machine),
    toolIds: machineToolIds(machine),
    now: machine.version === 3 ? undefined : state.now,
    expectedOwner: machine.supervisor,
    expectedBaseRevision: state.currentRevision,
    expectedScopeHash: state.scopeHash,
    expectedResolvedConfigurationEvidenceHash: state.resolvedConfigurationEvidenceHash,
  });
  const receipts = Array.isArray(state.receipts) ? state.receipts : [];
  verifyReceiptChain(receipts, {
    workflowId: state.authorization.workflowId,
    opportunityId: machine.opportunity,
    variant: machine.variant,
    planHash: plan.planHash,
    authorizationHash: authorization.hash,
    stepIds: machine.steps.map(step => step.id),
    steps: machine.steps,
    registry: machine.toolRegistry,
  });
  const receiptById = new Map(receipts.map(receipt => [receipt.stepId, receipt]));
  validateReleaseReceiptState(machine, receiptById);
  for (const step of machine.steps.filter(item => !item.rollbackOnly)) {
    const receipt = receiptById.get(step.id);
    if (!receipt) {
      return {
        status: 'ready',
        step,
        profile: step.executor === 'supervisor' ? machine.supervisor : null,
      };
    }
    if (receipt.status === 'accepted') continue;
    if (receipt.status === 'abnormal' || step.failure === 'abnormal') {
      return cleanupAction(machine, receiptById, {
        status: 'abnormal',
        project: machine.project,
        failedStep: step.id,
        profile: machine.exception,
        instruction: 'The deterministic release contract failed abnormally. Preserve authorization, receipts and rollback evidence.',
      });
    }
    if (receipt.status === 'blocked' || step.failure === 'blocked') {
      return cleanupAction(machine, receiptById, {
        status: 'blocked',
        project: machine.project,
        failedStep: step.id,
      });
    }
    if (step.failure && !V2_FAILURES.has(step.failure)) {
      const rollback = machine.steps.find(item => item.id === step.failure);
      const rollbackReceipt = receiptById.get(rollback.id);
      if (!rollbackReceipt) {
        return { status: 'rollback', failedStep: step.id, step: rollback, profile: null };
      }
      if (rollbackReceipt.status !== 'accepted') {
        return cleanupAction(machine, receiptById, {
          status: 'abnormal',
          project: machine.project,
          failedStep: rollback.id,
          profile: machine.exception,
          instruction: 'Release rollback or rollback verification failed.',
        });
      }
      return cleanupAction(machine, receiptById, {
        status: 'rejected',
        project: machine.project,
        failedStep: step.id,
        rollbackStep: rollback.id,
      });
    }
    return cleanupAction(machine, receiptById, {
      status: 'rejected',
      project: machine.project,
      failedStep: step.id,
    });
  }
  return { status: 'accepted', project: machine.project };
}

function nextReleaseActionV3(machine, state) {
  if (!machine.enabled) {
    return {
      status: 'blocked',
      project: machine.project,
      reason: 'release-machine-disabled',
    };
  }
  assert(typeof state.currentRevision === 'string' &&
    typeof state.scopeHash === 'string',
  'Enabled release state requires current revision and scope');
  const plan = releasePlan(machine);
  const authorization = validateOperatorAuthorization(state.operatorAuthorization, {
    project: machine.project,
    opportunityId: machine.opportunity,
    variant: machine.variant,
    repository: state.operatorAuthorization?.repository,
    requiredSideEffect: machineRequiredSideEffect(machine),
    toolIds: machineToolIds(machine),
    expectedBaseRevision: state.currentRevision,
    expectedScopeHash: state.scopeHash,
    expectedPlanHash: plan.planHash,
    expectedToolContractHash: sha256(plan.toolContracts),
  });
  const actualRevision = execFileSync('git', ['-C',
    state.operatorAuthorization.repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert(actualRevision === state.currentRevision,
    'Operator release authorization revision does not match the repository');
  const receipts = Array.isArray(state.receipts) ? state.receipts : [];
  verifyReceiptChain(receipts, {
    workflowId: state.operatorAuthorization.workflowId,
    opportunityId: machine.opportunity,
    variant: machine.variant,
    planHash: plan.planHash,
    authorizationHash: authorization.hash,
    stepIds: machine.steps.map(step => step.id),
    steps: machine.steps,
    registry: machine.toolRegistry,
  });
  const receiptById = new Map(receipts.map(receipt => [receipt.stepId, receipt]));
  validateReleaseReceiptState(machine, receiptById);
  for (const step of machine.steps.filter(item => !item.rollbackOnly)) {
    const receipt = receiptById.get(step.id);
    if (!receipt) {
      return { status: 'ready', step, profile: null };
    }
    if (receipt.status === 'accepted') continue;
    if (receipt.status === 'blocked' || step.failure === 'blocked') {
      return cleanupAction(machine, receiptById, {
        status: 'blocked',
        project: machine.project,
        failedStep: step.id,
      }, state);
    }
    if (receipt.status === 'abnormal' || step.failure === 'abnormal') {
      return cleanupAction(machine, receiptById,
        criticalException(
          machine,
          state,
          step.id,
          'The deterministic release contract failed abnormally. Review only the evidenced project trigger.',
        ),
        state);
    }
    if (step.failure && !V2_FAILURES.has(step.failure)) {
      const rollback = machine.steps.find(item => item.id === step.failure);
      const rollbackReceipt = receiptById.get(rollback.id);
      if (!rollbackReceipt) {
        return { status: 'rollback', failedStep: step.id, step: rollback, profile: null };
      }
      if (rollbackReceipt.status !== 'accepted') {
        return cleanupAction(machine, receiptById,
          criticalException(
            machine,
            state,
            rollback.id,
            'Rollback or rollback verification failed. Critical review requires the named project trigger receipt.',
          ),
          state);
      }
      return cleanupAction(machine, receiptById, {
        status: 'rejected',
        project: machine.project,
        failedStep: step.id,
        rollbackStep: rollback.id,
      }, state);
    }
    return cleanupAction(machine, receiptById, {
      status: 'rejected',
      project: machine.project,
      failedStep: step.id,
    }, state);
  }
  return { status: 'accepted', project: machine.project };
}

export function nextReleaseAction(machine, state = {}) {
  assert(state && typeof state === 'object' && !Array.isArray(state), 'Release state required');
  if (machine.version === 3) return nextReleaseActionV3(machine, state);
  if (machine.version === 2) return nextReleaseActionV2(machine, state);
  if (machine.advisoryOnly === true) {
    return {
      status: 'blocked',
      project: machine.project,
      reason: 'version-1-advisory-only',
      instruction: 'Use the existing frontier-owned project release contract. This machine cannot authorize or execute release work.',
    };
  }
  const receipts = Array.isArray(state.receipts) ? state.receipts : [];
  const receiptById = new Map();
  for (const receipt of receipts) {
    assert(machine.steps.some(step => step.id === receipt.step), `Unknown receipt step: ${receipt.step}`);
    assert(['success', 'failed'].includes(receipt.status), `${receipt.step}: receipt status invalid`);
    assert(!receiptById.has(receipt.step), `${receipt.step}: duplicate receipt`);
    assert(typeof receipt.evidenceHash === 'string' && /^[a-f0-9]{64}$/.test(receipt.evidenceHash),
      `${receipt.step}: evidenceHash required`);
    receiptById.set(receipt.step, receipt);
  }
  for (const step of machine.steps) {
    if (step.rollbackOnly) continue;
    const receipt = receiptById.get(step.id);
    if (!receipt) {
      return {
        status: 'ready',
        step,
        profile: step.executor === 'supervisor' ? machine.supervisor : null,
      };
    }
    if (receipt.status === 'failed') {
      if (step.failure === 'escalate' || !step.failure) {
        return {
          status: 'escalate',
          failedStep: step.id,
          profile: machine.exception,
          instruction: 'The deterministic path failed without a safe predefined rollback. Diagnose only this failure and preserve all release authorization gates.',
        };
      }
      const rollback = machine.steps.find(item => item.id === step.failure);
      const rollbackReceipt = receiptById.get(rollback.id);
      if (!rollbackReceipt) {
        return { status: 'rollback', failedStep: step.id, step: rollback, profile: null };
      }
      return rollbackReceipt.status === 'success'
        ? { status: 'blocked', failedStep: step.id, rollbackStep: rollback.id }
        : { status: 'escalate', failedStep: rollback.id, profile: machine.exception };
    }
  }
  return { status: 'complete', project: machine.project };
}

function releaseCompletionEvidence(machine, state) {
  assert(machine.version === 3 && machine.enabled === true,
    'Historical release verification requires an enabled version 3 machine');
  const plan = releasePlan(machine);
  const receipts = Array.isArray(state.receipts) ? state.receipts : [];
  assert(receipts.length > 0,
    'Historical release verification requires machine receipts');
  const authorization = validateOperatorAuthorization(
    state.operatorAuthorization,
    {
      project: machine.project,
      opportunityId: machine.opportunity,
      variant: machine.variant,
      repository: state.operatorAuthorization?.repository,
      requiredSideEffect: machineRequiredSideEffect(machine),
      toolIds: machineToolIds(machine),
      now: Date.parse(receipts[0].startedAt),
      expectedBaseRevision: state.currentRevision,
      expectedScopeHash: state.scopeHash,
      expectedPlanHash: plan.planHash,
      expectedToolContractHash: sha256(plan.toolContracts),
    },
  );
  verifyReceiptChain(receipts, {
    workflowId: state.operatorAuthorization.workflowId,
    opportunityId: machine.opportunity,
    variant: machine.variant,
    planHash: plan.planHash,
    authorizationHash: authorization.hash,
    stepIds: machine.steps.map(step => step.id),
    steps: machine.steps,
    registry: machine.toolRegistry,
  });
  const receiptById = new Map(receipts.map(receipt =>
    [receipt.stepId, receipt]));
  validateReleaseReceiptState(machine, receiptById);
  assert(machine.steps.filter(step => !step.rollbackOnly)
    .every(step => receiptById.get(step.id)?.status === 'accepted'),
  'Historical release receipts do not prove an accepted terminal state');
  const issuedAt = Date.parse(state.operatorAuthorization.issuedAt);
  const expiresAt = Date.parse(state.operatorAuthorization.expiresAt);
  for (const receipt of receipts) {
    const startedAt = Date.parse(receipt.startedAt);
    const completedAt = Date.parse(receipt.completedAt);
    assert(Number.isFinite(startedAt) && Number.isFinite(completedAt) &&
      startedAt >= issuedAt && completedAt <= expiresAt &&
      completedAt >= startedAt,
    'Historical release receipt falls outside operator authorization');
  }
  const expected = {
    version: 1,
    kind: 'release-machine-completion',
    project: machine.project,
    opportunityId: machine.opportunity,
    variant: machine.variant ?? null,
    workflowId: state.operatorAuthorization.workflowId,
    repository: state.operatorAuthorization.repository,
    baseRevision: state.currentRevision,
    scopeHash: state.scopeHash,
    machineEnabled: true,
    terminalStatus: 'accepted',
    releasePlanHash: plan.planHash,
    toolContractHash: sha256(plan.toolContracts),
    operatorAuthorizationHash: authorization.hash,
    finalReleaseReceiptHash: receipts.at(-1).receiptHash,
    receiptCount: receipts.length,
  };
  return expected;
}

export function createReleaseCompletion(machine, state) {
  const completion = releaseCompletionEvidence(machine, state);
  return { ...completion, completionHash: sha256(completion) };
}

export function verifyReleaseCompletion(completion, machine, state) {
  assert(completion?.kind === 'release-machine-completion',
    'Release machine completion receipt required');
  const { completionHash, ...unsigned } = completion;
  assert(completionHash === sha256(unsigned),
    'Release machine completion hash mismatch');
  const expected = releaseCompletionEvidence(machine, state);
  assert(completionHash === sha256(expected),
    'Release machine completion differs from the verified historical state');
  return completion;
}

export function executeReleaseStep(machine, root, state, stepId, options = {}) {
  assert([2, 3].includes(machine.version),
    'Release execution requires a version 2 or 3 machine');
  const next = nextReleaseAction(machine, state);
  assert(['ready', 'rollback'].includes(next.status) && next.step.id === stepId,
    `Release step is not ready: ${stepId}`);
  const step = next.step;
  assert(step.executor === 'deterministic', 'Supervisor authorization is not command-executable');
  assert(machine.fakeOnly === true
    ? options.fakeAdapter === true
    : options.fakeAdapter !== true,
  'Release fake-adapter mode does not match the machine contract');
  const plan = releasePlan(machine);
  const authorization = machine.version === 3
    ? validateOperatorAuthorization(state.operatorAuthorization, {
        project: machine.project,
        opportunityId: machine.opportunity,
        variant: machine.variant,
        repository: root,
        requiredSideEffect: machineRequiredSideEffect(machine),
        toolIds: machineToolIds(machine),
        expectedBaseRevision: state.currentRevision,
        expectedScopeHash: state.scopeHash,
        expectedPlanHash: plan.planHash,
        expectedToolContractHash: sha256(plan.toolContracts),
      })
    : validateAuthorization(state.authorization, {
        project: machine.project,
        opportunityId: machine.opportunity,
        variant: machine.variant,
        repository: root,
        requiredSideEffect: machineRequiredSideEffect(machine),
        toolIds: machineToolIds(machine),
        now: machine.version === 3 ? undefined : state.now,
        expectedOwner: machine.supervisor,
        expectedBaseRevision: state.currentRevision,
        expectedScopeHash: state.scopeHash,
        expectedResolvedConfigurationEvidenceHash: state.resolvedConfigurationEvidenceHash,
      });
  if (machine.version === 3) {
    assertReleaseExecutionWindow(machine, step, state.operatorAuthorization);
  }
  const execution = runRegisteredTool(root, toolById(machine.toolRegistry, step.tool), {
    execute: options.execute,
    allowedSideEffects: options.allowedSideEffects,
    authorization: state.authorization,
    operatorAuthorization: state.operatorAuthorization,
    project: machine.project,
    opportunityId: machine.opportunity,
    variant: machine.variant,
    now: machine.version === 3 ? undefined : state.now,
    fakeAdapter: options.fakeAdapter,
    fakeState: options.fakeState,
    fakeScenario: options.fakeScenarios?.[step.id],
    expectedOwner: machine.supervisor,
    currentRevision: state.currentRevision,
    scopeHash: state.scopeHash,
    resolvedConfigurationEvidenceHash: state.resolvedConfigurationEvidenceHash,
    resolvedConfigurationEvents: state.resolvedConfigurationEvents,
  });
  let status = execution.status;
  let verification = null;
  if (status === 'accepted' && step.operation === 'rollback') {
    verification = runRegisteredTool(
      root,
      toolById(machine.toolRegistry, step.rollbackVerificationTool),
      {
        execute: options.execute,
        allowedSideEffects: options.allowedSideEffects,
        authorization: state.authorization,
        operatorAuthorization: state.operatorAuthorization,
        project: machine.project,
        opportunityId: machine.opportunity,
        variant: machine.variant,
        now: state.now,
        fakeAdapter: options.fakeAdapter,
        fakeState: options.fakeState,
        fakeScenario: options.fakeScenarios?.[`${step.id}:verify`],
        expectedOwner: machine.supervisor,
        currentRevision: state.currentRevision,
        scopeHash: state.scopeHash,
        resolvedConfigurationEvidenceHash: state.resolvedConfigurationEvidenceHash,
        resolvedConfigurationEvents: state.resolvedConfigurationEvents,
      },
    );
    if (verification.status !== 'accepted') status = 'abnormal';
  }
  const previousReceiptHash = state.receipts?.at(-1)?.receiptHash ?? null;
  return {
    receipt: createReceipt({
      workflowId: (state.operatorAuthorization ?? state.authorization).workflowId,
      opportunityId: machine.opportunity,
      variant: machine.variant,
      stepId: step.id,
      executor: 'deterministic',
      planHash: plan.planHash,
      authorizationHash: authorization.hash,
      previousReceiptHash,
      toolId: execution.toolId,
      toolHash: sha256(toolById(machine.toolRegistry, step.tool)),
      argvHash: execution.argvHash,
      verificationToolId: verification?.toolId ?? null,
      verificationToolHash: verification
        ? sha256(toolById(
            machine.toolRegistry,
            step.rollbackVerificationTool,
          ))
        : null,
      verificationArgvHash: verification?.argvHash ?? null,
      verificationStatus: verification?.status ?? null,
      verificationExitCode: verification?.exitCode ?? null,
      verificationStdoutHash: verification ? sha256(verification.stdout ?? '') : null,
      verificationStderrHash: verification ? sha256(verification.stderr ?? '') : null,
      status,
      exitCode: execution.exitCode,
      stdout: `${execution.stdout}${verification?.stdout ?? ''}`,
      stderr: `${execution.stderr}${verification?.stderr ?? ''}`,
      beforeStateHash: options.beforeStateHash,
      afterStateHash: options.afterStateHash,
      artifacts: options.artifacts ?? [],
      startedAt: execution.startedAt,
      completedAt: verification?.completedAt ?? execution.completedAt,
    }),
    execution,
    rollbackVerification: verification,
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, root, stateFile, stepId, executionFile] = process.argv.slice(2);
    const machine = readReleaseMachine(root);
    if (command === 'validate') console.log(JSON.stringify(machine, null, 2));
    else if (command === 'plan') console.log(JSON.stringify(releasePlan(machine), null, 2));
    else if (command === 'next') {
      assert(stateFile, 'State file required');
      console.log(JSON.stringify(nextReleaseAction(
        machine,
        JSON.parse(fs.readFileSync(stateFile, 'utf8')),
      ), null, 2));
    } else if (command === 'execute') {
      assert(stateFile && stepId && executionFile,
        'Execute requires STATE.json, STEP_ID and EXECUTION.json');
      console.log(JSON.stringify(executeReleaseStep(
        machine,
        root,
        JSON.parse(fs.readFileSync(stateFile, 'utf8')),
        stepId,
        JSON.parse(fs.readFileSync(executionFile, 'utf8')),
      ), null, 2));
    } else {
      throw new Error('Usage: release-machine.mjs validate|plan ROOT | next ROOT STATE.json | execute ROOT STATE.json STEP_ID EXECUTION.json');
    }
  } catch (error) {
    console.error(`release-machine: ${error.message}`);
    process.exitCode = 1;
  }
}
