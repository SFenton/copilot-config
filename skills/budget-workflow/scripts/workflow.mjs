import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FAKE_DRIVER_CLASSES,
  runFakeExternalDriver,
} from './fake-external.mjs';

export const EXECUTOR_KINDS = new Set(['deterministic', 'bounded-model', 'frontier']);
export const TERMINAL_STATES = new Set([
  'accepted',
  'rejected',
  'blocked',
  'semantic-gap',
  'abnormal',
]);
export const SIDE_EFFECT_LEVELS = Object.freeze({
  none: 0,
  workspace: 1,
  'local-container': 2,
  github: 3,
  'home-assistant': 4,
  database: 4,
  production: 5,
  destructive: 6,
});

export const SUPPORTED_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-opus-4.6',
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'gpt-5.5',
  'mai-code-1.1-flash',
  'mai-code-1-flash-picker',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'grok-4.5',
]);
const EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const CONTEXTS = new Set(['default', 'long_context']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonicalValue(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value))
    .digest('hex');
}

export function createTriggerReceipt(input) {
  assert(typeof input.triggerId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.triggerId),
  'Trigger receipt id must be kebab-case');
  const receipt = {
    version: 1,
    kind: 'trigger-receipt',
    project: input.project,
    opportunityId: input.opportunityId,
    triggerId: input.triggerId,
    evidenceHash: input.evidenceHash,
    precedingReceiptHash: input.precedingReceiptHash ?? null,
    observedAt: input.observedAt,
  };
  for (const key of ['project', 'opportunityId', 'evidenceHash', 'observedAt']) {
    assert(typeof receipt[key] === 'string' && receipt[key].length > 0,
      `Trigger receipt ${key} required`);
  }
  assert(/^[a-f0-9]{64}$/.test(receipt.evidenceHash),
    'Trigger receipt evidence hash invalid');
  if (receipt.precedingReceiptHash !== null) {
    assert(/^[a-f0-9]{64}$/.test(receipt.precedingReceiptHash),
      'Trigger receipt preceding hash invalid');
  }
  return { ...receipt, receiptHash: sha256(receipt) };
}

export function validateTriggerReceipt(receipt, context) {
  assert(receipt?.kind === 'trigger-receipt', 'Trigger receipt required');
  assert(receipt.project === context.project &&
    receipt.opportunityId === context.opportunityId,
  'Trigger receipt scope mismatch');
  assert(context.triggerIds.includes(receipt.triggerId),
    'Trigger receipt does not match an allowed trigger');
  assert(receipt.precedingReceiptHash === (context.precedingReceiptHash ?? null),
    'Trigger receipt is not bound to the preceding pipeline evidence');
  const { receiptHash, ...unsigned } = receipt;
  assert(receiptHash === sha256(unsigned), 'Trigger receipt hash mismatch');
  return receipt;
}

export function validateProfile(value, label = 'model') {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} profile required`);
  assert(SUPPORTED_MODELS.has(value.model), `${label} model unsupported`);
  assert(EFFORTS.has(value.effort), `${label} effort unsupported`);
  assert(CONTEXTS.has(value.context), `${label} context unsupported`);
  return value;
}

function kebab(value, label) {
  assert(typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
    `${label} must be kebab-case`);
}

export function validateToolRegistry(registry, project = registry?.project) {
  assert(registry && registry.version === 1 && registry.project === project,
    'Tool registry version/project mismatch');
  assert(Array.isArray(registry.tools) && registry.tools.length > 0, 'Tool registry requires tools');
  const ids = new Set();
  for (const tool of registry.tools) {
    kebab(tool.id, 'Tool id');
    assert(!ids.has(tool.id), `Duplicate tool id: ${tool.id}`);
    ids.add(tool.id);
    assert(['command', 'disabled', 'fake-driver'].includes(tool.kind),
      `${tool.id}: unsupported tool kind`);
    if (tool.kind === 'command') {
      assert(Array.isArray(tool.argv) && tool.argv.length > 0 &&
        tool.argv.every(value => typeof value === 'string' && value.length > 0),
      `${tool.id}: command argv required`);
      assert(typeof tool.cwd === 'string' && tool.cwd.length > 0 && !path.isAbsolute(tool.cwd) &&
        !tool.cwd.split(/[\\/]/).includes('..'), `${tool.id}: safe relative cwd required`);
      assert(Number.isInteger(tool.timeoutSeconds) && tool.timeoutSeconds >= 1 &&
        tool.timeoutSeconds <= 3600, `${tool.id}: timeout must be 1-3600 seconds`);
    } else if (tool.kind === 'disabled') {
      assert(typeof tool.reason === 'string' && tool.reason.length > 0,
        `${tool.id}: disabled reason required`);
      assert(tool.argv === undefined && tool.cwd === undefined &&
        tool.timeoutSeconds === undefined, `${tool.id}: disabled tools cannot declare execution fields`);
    } else {
      assert(tool.fakeOnly === true, `${tool.id}: fake drivers must be fakeOnly`);
      assert(FAKE_DRIVER_CLASSES.has(tool.driverClass),
        `${tool.id}: fake driver class unsupported`);
      assert(['execute', 'verify', 'rollback', 'cleanup'].includes(tool.action),
        `${tool.id}: fake driver action unsupported`);
      assert(tool.argv === undefined && tool.cwd === undefined &&
        tool.timeoutSeconds === undefined, `${tool.id}: fake drivers cannot declare command fields`);
    }
    assert(Object.hasOwn(SIDE_EFFECT_LEVELS, tool.sideEffect),
      `${tool.id}: unsupported side effect`);
    assert(Array.isArray(tool.environment ?? []) && (tool.environment ?? []).every(value =>
      typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)),
    `${tool.id}: environment names must be explicit`);
  }
  return registry;
}

export function toolById(registry, id) {
  const tool = registry.tools.find(item => item.id === id);
  assert(tool, `Unknown registered tool: ${id}`);
  return tool;
}

export function validateOpportunityPolicyV2(policy, registry) {
  assert(policy && policy.version === 2 && policy.project === registry.project,
    'Opportunity v2 policy version/project mismatch');
  assert(policy.qualification?.status === 'provisional' ||
    policy.qualification?.status === 'promoted', 'Opportunity qualification status required');
  assert(policy.qualification.automaticApplication === false,
    'Opportunity policy cannot enable automatic application');
  if (policy.qualification.status === 'provisional') {
    assert(Number.isInteger(policy.qualification.minimumPromotionCases) &&
      policy.qualification.minimumPromotionCases >= 30,
    'Provisional opportunity policy requires at least 30 promotion cases');
  }
  assert(Array.isArray(policy.opportunities) && policy.opportunities.length > 0,
    'Opportunity v2 list required');
  const ids = new Set();
  for (const opportunity of policy.opportunities) {
    kebab(opportunity.id, 'Opportunity id');
    assert(!ids.has(opportunity.id), `Duplicate opportunity id: ${opportunity.id}`);
    ids.add(opportunity.id);
    assert(typeof opportunity.label === 'string' && opportunity.label.length > 0,
      `${opportunity.id}: label required`);
    assert(Array.isArray(opportunity.triggers) && opportunity.triggers.length > 0 &&
      opportunity.triggers.every(value => typeof value === 'string' && value.trim()),
    `${opportunity.id}: triggers required`);
    validateProfile(opportunity.semanticOwner, `${opportunity.id}: semantic owner`);
    if (opportunity.escalation !== undefined) {
      validateProfile(opportunity.escalation, `${opportunity.id}: escalation`);
      if (opportunity.escalationTriggers !== undefined) {
        assert(Array.isArray(opportunity.escalationTriggers) &&
          opportunity.escalationTriggers.length > 0 &&
          opportunity.escalationTriggers.every(value => typeof value === 'string' && value.length > 0),
        `${opportunity.id}: escalation triggers must be non-empty strings`);
      }
    }
    assert(Array.isArray(opportunity.skills ?? []) &&
      (opportunity.skills ?? []).every(value => typeof value === 'string'),
    `${opportunity.id}: skills must be strings`);
    assert(Array.isArray(opportunity.phases) && opportunity.phases.length > 0,
      `${opportunity.id}: phases required`);
    assert(opportunity.phases.some(phase => phase.executor === 'frontier'),
      `${opportunity.id}: frontier semantic phase required`);
    if (opportunity.variants !== undefined) {
      assert(Array.isArray(opportunity.variants) && opportunity.variants.length >= 2 &&
        opportunity.variants.every(value =>
          typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)),
      `${opportunity.id}: variants must contain at least two kebab-case values`);
    }
    const phaseIds = new Set();
    for (const phase of opportunity.phases) {
      kebab(phase.id, `${opportunity.id}: phase id`);
      assert(!phaseIds.has(phase.id), `${opportunity.id}: duplicate phase ${phase.id}`);
      phaseIds.add(phase.id);
      assert(EXECUTOR_KINDS.has(phase.executor),
        `${opportunity.id}/${phase.id}: executor unsupported`);
      assert(Object.hasOwn(SIDE_EFFECT_LEVELS, phase.sideEffect),
        `${opportunity.id}/${phase.id}: sideEffect required`);
      if (phase.variant !== undefined) {
        assert(opportunity.variants?.includes(phase.variant),
          `${opportunity.id}/${phase.id}: unknown phase variant`);
      }
      if (phase.executor === 'deterministic') {
        assert(typeof phase.tool === 'string', `${opportunity.id}/${phase.id}: tool required`);
        assert(toolById(registry, phase.tool).sideEffect === phase.sideEffect,
          `${opportunity.id}/${phase.id}: phase/tool side effect mismatch`);
        assert(phase.profile === undefined, `${opportunity.id}/${phase.id}: deterministic phase cannot use a model`);
      } else if (phase.executor === 'bounded-model') {
        validateProfile(phase.profile, `${opportunity.id}/${phase.id}`);
        kebab(phase.capability, `${opportunity.id}/${phase.id}: capability`);
        kebab(phase.sandboxProfile,
          `${opportunity.id}/${phase.id}: sandbox profile`);
        assert(phase.tool === undefined, `${opportunity.id}/${phase.id}: bounded model cannot execute a tool`);
      } else {
        if (phase.profile !== undefined) validateProfile(phase.profile,
          `${opportunity.id}/${phase.id}`);
        assert(phase.tool === undefined, `${opportunity.id}/${phase.id}: frontier phase cannot execute a registered tool directly`);
      }
      assert(Array.isArray(phase.validators ?? []) &&
        (phase.validators ?? []).every(id => {
          toolById(registry, id);
          return true;
        }), `${opportunity.id}/${phase.id}: validators must be registered tools`);
      const transitions = phase.transitions ?? {};
      for (const key of ['accepted', 'rejected', 'blocked', 'abnormal']) {
        const target = transitions[key];
        if (target !== undefined) {
          assert(typeof target === 'string' && (TERMINAL_STATES.has(target) || phaseIds.has(target) ||
            opportunity.phases.some(item => item.id === target)),
          `${opportunity.id}/${phase.id}: invalid ${key} transition`);
        }
      }
    }
    for (const [index, phase] of opportunity.phases.entries()) {
      if (phase.executor !== 'deterministic' ||
        SIDE_EFFECT_LEVELS[phase.sideEffect] <= SIDE_EFFECT_LEVELS['local-container']) continue;
      assert(opportunity.phases.slice(0, index).some(previous =>
        previous.executor === 'frontier' &&
        SIDE_EFFECT_LEVELS[previous.sideEffect] >= SIDE_EFFECT_LEVELS[phase.sideEffect] &&
        (!phase.variant || !previous.variant || previous.variant === phase.variant)),
      `${opportunity.id}/${phase.id}: consequential deterministic work requires prior frontier authorization`);
    }
  }
  return policy;
}

export function requiredSideEffect(opportunity, registry) {
  return opportunity.phases.reduce((highest, phase) => {
    const effect = phase.sideEffect;
    return SIDE_EFFECT_LEVELS[effect] > SIDE_EFFECT_LEVELS[highest] ? effect : highest;
  }, 'none');
}

export function validateAuthorization(authorization, context) {
  assert(authorization && authorization.version === 1 &&
    authorization.kind === 'frontier-authorization', 'Frontier authorization required');
  const allowedKeys = new Set([
    'version',
    'kind',
    'workflowId',
    'opportunityId',
    'variant',
    'project',
    'repository',
    'baseRevision',
    'scopeHash',
    'nonce',
    'issuedAt',
    'expiresAt',
    'resolvedConfigurationEvidenceHash',
    'allowedSideEffect',
    'toolIds',
    'owner',
  ]);
  assert(Object.keys(authorization).every(key => allowedKeys.has(key)),
    'Frontier authorization contains unsupported fields');
  for (const key of ['workflowId', 'opportunityId', 'project', 'repository', 'baseRevision',
    'scopeHash', 'nonce', 'issuedAt', 'expiresAt', 'resolvedConfigurationEvidenceHash']) {
    assert(typeof authorization[key] === 'string' && authorization[key].length > 0,
      `Authorization ${key} required`);
  }

  assert(authorization.project === context.project, 'Authorization project mismatch');
  assert(authorization.opportunityId === context.opportunityId,
    'Authorization opportunity mismatch');
  if (context.variant !== undefined && context.variant !== null) {
    assert(authorization.variant === context.variant, 'Authorization variant mismatch');
  }
  assert(fs.realpathSync(authorization.repository) === fs.realpathSync(context.repository),
    'Authorization repository mismatch');
  assert(/^[a-f0-9]{64}$/.test(authorization.scopeHash), 'Authorization scopeHash invalid');
  assert(/^[a-f0-9]{64}$/.test(authorization.resolvedConfigurationEvidenceHash),
    'Resolved configuration evidence hash invalid');
  assert(Object.hasOwn(SIDE_EFFECT_LEVELS, authorization.allowedSideEffect),
    'Authorization side effect invalid');
  assert(SIDE_EFFECT_LEVELS[authorization.allowedSideEffect] >=
    SIDE_EFFECT_LEVELS[context.requiredSideEffect], 'Authorization side effect is too weak');
  assert(Array.isArray(authorization.toolIds) &&
    context.toolIds.every(id => authorization.toolIds.includes(id)),
  'Authorization omits required tools');
  validateProfile(authorization.owner, 'Authorization owner');
  if (context.expectedOwner) {
    validateProfile(context.expectedOwner, 'Expected authorization owner');
    assert(canonicalJson(authorization.owner) === canonicalJson(context.expectedOwner),
      'Authorization owner mismatch');
  }
  if (context.expectedBaseRevision !== undefined) {
    assert(authorization.baseRevision === context.expectedBaseRevision,
      'Authorization base revision mismatch');
  }
  if (context.expectedScopeHash !== undefined) {
    assert(authorization.scopeHash === context.expectedScopeHash,
      'Authorization scope hash mismatch');
  }
  if (context.expectedResolvedConfigurationEvidenceHash !== undefined) {
    assert(authorization.resolvedConfigurationEvidenceHash ===
      context.expectedResolvedConfigurationEvidenceHash,
    'Authorization resolved configuration evidence mismatch');
  }
  const issued = Date.parse(authorization.issuedAt);
  const expires = Date.parse(authorization.expiresAt);
  const now = context.now ?? Date.now();
  assert(Number.isFinite(issued) && Number.isFinite(expires) && issued <= now && expires > now,
    'Authorization is not currently valid');
  return {
    value: authorization,
    hash: sha256(authorization),
  };
}

export function validateOperatorAuthorization(authorization, context) {
  assert(authorization && authorization.version === 1 &&
    authorization.kind === 'operator-authorization',
  'Operator authorization required');
  const allowedKeys = new Set([
    'version',
    'kind',
    'authorizedBy',
    'workflowId',
    'opportunityId',
    'variant',
    'project',
    'repository',
    'baseRevision',
    'scopeHash',
    'nonce',
    'issuedAt',
    'expiresAt',
    'allowedSideEffect',
    'toolIds',
    'planHash',
    'toolContractHash',
  ]);
  assert(Object.keys(authorization).every(key => allowedKeys.has(key)),
    'Operator authorization contains unsupported fields');
  assert(authorization.authorizedBy === 'operator',
    'Only the operator may authorize side effects');
  for (const key of [
    'workflowId', 'opportunityId', 'project', 'repository', 'baseRevision',
    'scopeHash', 'nonce', 'issuedAt', 'expiresAt',
  ]) {
    assert(typeof authorization[key] === 'string' && authorization[key].length > 0,
      `Operator authorization ${key} required`);
  }
  assert(authorization.project === context.project,
    'Operator authorization project mismatch');
  assert(authorization.opportunityId === context.opportunityId,
    'Operator authorization opportunity mismatch');
  if (context.variant !== undefined && context.variant !== null) {
    assert(authorization.variant === context.variant,
      'Operator authorization variant mismatch');
  }
  assert(fs.realpathSync(authorization.repository) ===
    fs.realpathSync(context.repository),
  'Operator authorization repository mismatch');
  assert(authorization.baseRevision === context.expectedBaseRevision,
    'Operator authorization base revision mismatch');
  assert(authorization.scopeHash === context.expectedScopeHash,
    'Operator authorization scope hash mismatch');
  assert(Object.hasOwn(SIDE_EFFECT_LEVELS, authorization.allowedSideEffect),
    'Operator authorization side effect invalid');
  assert(SIDE_EFFECT_LEVELS[authorization.allowedSideEffect] >=
    SIDE_EFFECT_LEVELS[context.requiredSideEffect],
  'Operator authorization side effect is too weak');
  assert(Array.isArray(authorization.toolIds) &&
    context.toolIds.every(id => authorization.toolIds.includes(id)),
  'Operator authorization omits required tools');
  if (context.expectedPlanHash !== undefined) {
    assert(authorization.planHash === context.expectedPlanHash,
      'Operator authorization plan hash mismatch');
  }
  if (context.expectedToolContractHash !== undefined) {
    assert(authorization.toolContractHash ===
      context.expectedToolContractHash,
    'Operator authorization tool contract hash mismatch');
  }
  const issued = Date.parse(authorization.issuedAt);
  const expires = Date.parse(authorization.expiresAt);
  const now = context.now ?? Date.now();
  assert(Number.isFinite(issued) && Number.isFinite(expires) &&
    issued <= now && expires > now,
  'Operator authorization is not currently valid');
  return {
    value: authorization,
    hash: sha256(authorization),
  };
}

function safeCwd(root, relative) {
  const base = fs.realpathSync(root);
  const target = fs.realpathSync(path.resolve(base, relative));
  const resolved = path.relative(base, target);
  assert(resolved !== '..' && !resolved.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(resolved), 'Tool cwd escapes repository');
  return target;
}

export function runRegisteredTool(root, tool, options = {}) {
  assert(options.execute === true, 'Explicit deterministic execute=true required');
  assert(tool.kind !== 'disabled', `Registered tool is disabled: ${tool.id}`);
  assert(tool.kind === 'command' || options.fakeAdapter === true,
    `Fake driver requires fakeAdapter=true: ${tool.id}`);
  const allowed = new Set(options.allowedSideEffects ?? ['none']);
  assert(allowed.has(tool.sideEffect), `Side effect not enabled for this execution: ${tool.sideEffect}`);
  if (SIDE_EFFECT_LEVELS[tool.sideEffect] > SIDE_EFFECT_LEVELS['local-container']) {
    if (options.operatorAuthorization) {
      validateOperatorAuthorization(options.operatorAuthorization, {
        project: options.project,
        opportunityId: options.opportunityId,
        variant: options.variant,
        repository: root,
        requiredSideEffect: tool.sideEffect,
        toolIds: [tool.id],
        now: options.now,
        expectedBaseRevision: options.currentRevision,
        expectedScopeHash: options.scopeHash,
      });
    } else {
      assert(options.expectedOwner && options.currentRevision &&
        options.scopeHash && options.resolvedConfigurationEvidenceHash,
      'External tool execution requires operator authorization or a legacy frontier authorization');
      const resolved = resolvedConfiguration(
        options.resolvedConfigurationEvents,
        options.expectedOwner,
      );
      assert(resolved.evidenceHash === options.resolvedConfigurationEvidenceHash,
        'Consequential tool resolved configuration evidence mismatch');
      validateAuthorization(options.authorization, {
        project: options.project,
        opportunityId: options.opportunityId,
        variant: options.variant,
        repository: root,
        requiredSideEffect: tool.sideEffect,
        toolIds: [tool.id],
        now: options.now,
        expectedOwner: options.expectedOwner,
        expectedBaseRevision: options.currentRevision,
        expectedScopeHash: options.scopeHash,
        expectedResolvedConfigurationEvidenceHash: options.resolvedConfigurationEvidenceHash,
      });
    }
    assert(options.currentRevision && options.scopeHash,
      'External tool execution requires exact revision and scope');
    const revision = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert(revision.status === 0 &&
      revision.stdout.trim() === options.currentRevision,
    'Consequential tool authorization revision does not match the repository');
  }
  if (tool.kind === 'fake-driver') {
    const startedAt = new Date().toISOString();
    const result = runFakeExternalDriver(tool, options.fakeState, options.fakeScenario);
    return {
      toolId: tool.id,
      argvHash: sha256({
        driverClass: tool.driverClass,
        action: tool.action,
        scenario: options.fakeScenario ?? 'success',
      }),
      ...result,
      signal: null,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
  const env = {};
  for (const name of ['PATH', 'SystemRoot']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of tool.environment ?? []) {
    if (name.startsWith('RELEASE_AUTHORIZED_') ||
        name === 'RELEASE_AUTHORIZATION_HASH') continue;
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(options.trustedEnvironment ?? {})) {
    if (!(tool.environment ?? []).includes(name)) continue;
    assert(typeof value === 'string' && value.length > 0,
      `Trusted environment value is invalid: ${name}`);
    env[name] = value;
  }
  const startedAt = new Date().toISOString();
  const result = spawnSync(tool.argv[0], tool.argv.slice(1), {
    cwd: safeCwd(root, tool.cwd),
    env,
    encoding: 'utf8',
    timeout: tool.timeoutSeconds * 1000,
    maxBuffer: 2_000_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completedAt = new Date().toISOString();
  return {
    toolId: tool.id,
    argvHash: sha256(tool.argv),
    status: result.status === 0 && !result.error ? 'accepted' : 'rejected',
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    startedAt,
    completedAt,
  };
}

export function createReceipt(input) {
  const receipt = {
    version: 1,
    workflowId: input.workflowId,
    opportunityId: input.opportunityId,
    variant: input.variant ?? null,
    stepId: input.stepId,
    executor: input.executor,
    planHash: input.planHash,
    authorizationHash: input.authorizationHash,
    previousReceiptHash: input.previousReceiptHash ?? null,
    toolId: input.toolId ?? null,
    toolHash: input.toolHash ?? null,
    argvHash: input.argvHash ?? null,
    verificationToolId: input.verificationToolId ?? null,
    verificationToolHash: input.verificationToolHash ?? null,
    verificationArgvHash: input.verificationArgvHash ?? null,
    verificationStatus: input.verificationStatus ?? null,
    verificationExitCode: input.verificationExitCode ?? null,
    verificationStdoutHash: input.verificationStdoutHash ?? null,
    verificationStderrHash: input.verificationStderrHash ?? null,
    status: input.status,
    exitCode: input.exitCode ?? null,
    stdoutHash: sha256(input.stdout ?? ''),
    stderrHash: sha256(input.stderr ?? ''),
    beforeStateHash: input.beforeStateHash,
    afterStateHash: input.afterStateHash,
    artifacts: input.artifacts ?? [],
    usage: input.usage ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
  assert(EXECUTOR_KINDS.has(receipt.executor), 'Receipt executor invalid');
  assert(TERMINAL_STATES.has(receipt.status), 'Receipt status invalid');
  for (const key of ['workflowId', 'opportunityId', 'stepId', 'planHash',
    'authorizationHash', 'beforeStateHash', 'afterStateHash', 'startedAt', 'completedAt']) {
    assert(typeof receipt[key] === 'string' && receipt[key].length > 0,
      `Receipt ${key} required`);
  }
  receipt.evidenceHash = sha256(receipt);
  receipt.receiptHash = sha256({ ...receipt, receiptHash: undefined });
  return receipt;
}

export function verifyReceiptChain(receipts, context) {
  assert(Array.isArray(receipts), 'Receipt list required');
  const order = new Map(context.stepIds.map((id, index) => [id, index]));
  let previous = null;
  let lastIndex = -1;
  const seen = new Set();
  const expectedSteps = new Map((context.steps ?? []).map(step => [step.id, step]));
  for (const receipt of receipts) {
    assert(receipt.workflowId === context.workflowId, 'Receipt workflow mismatch');
    assert(receipt.opportunityId === context.opportunityId, 'Receipt opportunity mismatch');
    assert(receipt.variant === (context.variant ?? null), 'Receipt variant mismatch');
    assert(receipt.planHash === context.planHash, 'Receipt plan mismatch');
    assert(receipt.authorizationHash === context.authorizationHash,
      'Receipt authorization mismatch');
    assert(order.has(receipt.stepId) && !seen.has(receipt.stepId), 'Unknown or duplicate receipt step');
    const index = order.get(receipt.stepId);
    assert(index > lastIndex, 'Receipt steps are out of order');
    assert(receipt.previousReceiptHash === previous, 'Receipt chain mismatch');
    const expectedEvidence = sha256(Object.fromEntries(Object.entries(receipt)
      .filter(([key]) => !['receiptHash', 'evidenceHash'].includes(key))));
    assert(receipt.evidenceHash === expectedEvidence, 'Receipt evidence hash mismatch');
    assert(receipt.receiptHash === sha256({ ...receipt, receiptHash: undefined }),
      'Receipt hash mismatch');
    if (expectedSteps.size > 0) {
      const step = expectedSteps.get(receipt.stepId);
      assert(step, `Receipt step is absent from the expected plan: ${receipt.stepId}`);
      const expectedExecutor = step.executor === 'supervisor'
        ? 'frontier'
        : step.executor;
      assert(receipt.executor === expectedExecutor, 'Receipt executor does not match the step');
      if (expectedExecutor !== 'deterministic') {
        assert(receipt.toolId === null &&
          receipt.toolHash === null &&
          receipt.argvHash === null,
          'Frontier and bounded-model receipts must be tool-free');
      } else {
        assert(receipt.toolId === step.tool, 'Receipt tool does not match the step');
        const tool = toolById(context.registry, step.tool);
        assert(receipt.toolHash === sha256(tool),
          'Receipt tool contract does not match the registry');
        if (tool.kind === 'command') {
          assert(receipt.argvHash === sha256(tool.argv),
            'Receipt argv does not match the registered command');
        } else {
          assert(typeof receipt.argvHash === 'string' && /^[a-f0-9]{64}$/.test(receipt.argvHash),
            'Non-command receipt execution hash required');
        }
      }
      if (step.operation === 'rollback') {
        const verificationFields = [
          receipt.verificationToolId,
          receipt.verificationToolHash,
          receipt.verificationArgvHash,
          receipt.verificationStatus,
          receipt.verificationExitCode,
          receipt.verificationStdoutHash,
          receipt.verificationStderrHash,
        ];
        const verificationAttempted = verificationFields.some(value => value !== null);
        if (verificationAttempted) {
          assert(receipt.verificationToolId === step.rollbackVerificationTool,
            'Rollback verification tool mismatch');
          assert(typeof receipt.verificationArgvHash === 'string' &&
            /^[a-f0-9]{64}$/.test(receipt.verificationArgvHash),
          'Rollback verification execution hash required');
          const verificationTool = toolById(
            context.registry,
            step.rollbackVerificationTool,
          );
          assert(receipt.verificationToolHash === sha256(verificationTool),
            'Rollback verification tool contract does not match the registry');
          if (verificationTool.kind === 'command') {
            assert(receipt.verificationArgvHash === sha256(verificationTool.argv),
              'Rollback verification argv does not match the registered command');
          }
          assert(['accepted', 'rejected', 'blocked', 'abnormal']
            .includes(receipt.verificationStatus),
          'Rollback verification status invalid');
          assert(receipt.verificationExitCode === null ||
            Number.isInteger(receipt.verificationExitCode),
          'Rollback verification exit code invalid');
          assert(typeof receipt.verificationStdoutHash === 'string' &&
            /^[a-f0-9]{64}$/.test(receipt.verificationStdoutHash) &&
            typeof receipt.verificationStderrHash === 'string' &&
            /^[a-f0-9]{64}$/.test(receipt.verificationStderrHash),
          'Rollback verification output hashes required');
          if (receipt.status === 'accepted') {
            assert(receipt.verificationStatus === 'accepted',
              'Accepted rollback requires accepted verification');
          } else {
            assert(receipt.verificationStatus !== 'accepted',
              'Failed rollback verification must not be recorded as accepted');
          }
        } else {
          assert(receipt.status !== 'accepted',
            'Accepted rollback requires verification evidence');
        }
      } else {
        assert(receipt.verificationToolId === null &&
          receipt.verificationToolHash === null &&
          receipt.verificationArgvHash === null &&
          receipt.verificationStatus === null &&
          receipt.verificationExitCode === null &&
          receipt.verificationStdoutHash === null &&
          receipt.verificationStderrHash === null,
        'Verification receipt fields are rollback-only');
      }
    }
    previous = receipt.receiptHash;
    lastIndex = index;
    seen.add(receipt.stepId);
  }
  return { valid: true, lastReceiptHash: previous };
}

export function resolvedConfiguration(events, expected) {
  const configured = events.filter(event => event.type === 'subagent.configured');
  assert(configured.length === 1, 'Exactly one subagent.configured event required');
  const data = configured[0].data ?? {};
  const resolved = {
    model: data.model,
    effort: data.reasoningEffort,
    context: data.contextTier,
  };
  assert(resolved.model === expected.model, 'Resolved model mismatch');
  assert(resolved.effort === expected.effort, 'Resolved reasoning effort mismatch');
  assert(resolved.context === expected.context, 'Resolved context tier mismatch');
  return {
    ...resolved,
    evidenceHash: sha256(configured[0]),
  };
}
