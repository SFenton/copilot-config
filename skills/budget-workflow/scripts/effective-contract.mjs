import fs from 'node:fs';
import path from 'node:path';
import { AUTOMATIC_ROUTE_ROLE_CATALOG } from './model-catalog.mjs';
import { readReleaseMachine } from './release-machine.mjs';
import { INTENT_ACCEPTANCE_ROLE } from './intent-acceptance.mjs';
import { contained, readAdapter } from './budget.mjs';
import { sha256, validateProfile } from './workflow.mjs';

export const EFFECTIVE_CONTRACT_VERSION = 1;
export const SPARSE_OVERRIDE_RELATIVE_PATH = path.join(
  '.github',
  'budget-contract.override.v1.json',
);
export const ZERO_CONFIG_PROJECT = 'personal-budget-workflow';

const ROLE_KIND_AGENTS = Object.freeze({
  coordinator: ['general-purpose'],
  reviewer: ['code-review', 'general-purpose'],
  explorer: ['explore', 'task'],
  worker: ['task', 'general-purpose'],
});
const STATIC_ROLE_CATALOG = Object.freeze({
  'implementation-coordinator': Object.freeze({
    role: 'implementation-coordinator',
    dispatchKind: 'task',
    authority: 'semantic-coordination',
    profile: Object.freeze({
      model: 'gpt-5.4',
      effort: 'medium',
      context: 'default',
    }),
    agentTypes: ROLE_KIND_AGENTS.coordinator,
    capabilityStatus: 'qualified',
    provenance: Object.freeze({ source: 'static-role-catalog' }),
  }),
  reviewer: Object.freeze({
    role: 'reviewer',
    dispatchKind: 'task',
    authority: 'semantic-review-only',
    profile: Object.freeze({
      model: 'gpt-5.4',
      effort: 'medium',
      context: 'default',
    }),
    agentTypes: ROLE_KIND_AGENTS.reviewer,
    capabilityStatus: 'qualified',
    provenance: Object.freeze({ source: 'static-role-catalog' }),
  }),
  'medium-coordinator': Object.freeze({
    role: 'medium-coordinator',
    dispatchKind: 'task',
    authority: 'semantic-coordination',
    profile: Object.freeze({
      model: 'gpt-5.4',
      effort: 'medium',
      context: 'default',
    }),
    agentTypes: ROLE_KIND_AGENTS.coordinator,
    capabilityStatus: 'qualified',
    provenance: Object.freeze({ source: 'static-role-catalog' }),
  }),
  'medium-review': Object.freeze({
    role: 'medium-review',
    dispatchKind: 'task',
    authority: 'semantic-review-only',
    profile: Object.freeze({
      model: 'gpt-5.4',
      effort: 'medium',
      context: 'default',
    }),
    agentTypes: ROLE_KIND_AGENTS.reviewer,
    capabilityStatus: 'qualified',
    provenance: Object.freeze({ source: 'static-role-catalog' }),
  }),
  'simple-explorer': Object.freeze({
    role: 'simple-explorer',
    dispatchKind: 'task',
    authority: 'bounded-read-only',
    profile: Object.freeze({
      model: 'gpt-5.4-mini',
      effort: 'low',
      context: 'default',
    }),
    agentTypes: ROLE_KIND_AGENTS.explorer,
    capabilityStatus: 'qualified',
    provenance: Object.freeze({ source: 'static-role-catalog' }),
  }),
  'frontier-research': Object.freeze({
    role: 'frontier-research',
    dispatchKind: 'reason-only-leaf',
    authority: 'semantic-research-only',
    profile: Object.freeze({
      model: 'gpt-5.6-sol',
      effort: 'max',
      context: 'default',
    }),
    agentTypes: [],
    capabilityStatus: 'qualified',
    provenance: Object.freeze({ source: 'static-role-catalog' }),
  }),
  'frontier-adjudication': Object.freeze({
    role: 'frontier-adjudication',
    dispatchKind: 'reason-only-leaf',
    authority: 'semantic-review-only',
    profile: Object.freeze({
      model: 'gpt-5.6-sol',
      effort: 'max',
      context: 'default',
    }),
    agentTypes: [],
    capabilityStatus: 'qualified',
    provenance: Object.freeze({ source: 'static-role-catalog' }),
  }),
  'tandem-secondary-research': Object.freeze({
    role: 'tandem-secondary-research',
    dispatchKind: 'reason-only-leaf',
    authority: 'semantic-research-only',
    profile: Object.freeze({
      model: 'gpt-6-astra',
      effort: 'medium',
      context: 'default',
    }),
    agentTypes: [],
    capabilityStatus: 'qualified',
    provenance: Object.freeze({ source: 'static-role-catalog' }),
  }),
});

const AUTOMATIC_TASK_ROLE_CATALOG = Object.freeze(
  Object.fromEntries(Object.entries(AUTOMATIC_ROUTE_ROLE_CATALOG)
    .filter(([, contract]) => contract.dispatchKind === 'task')
    .map(([role, contract]) => [role, Object.freeze({
      role,
      dispatchKind: 'task',
      authority: 'bounded-read-only',
      profile: Object.freeze({
        model: contract.profile.model,
        effort: contract.profile.effort,
        context: contract.profile.context,
      }),
      agentTypes: contract.agentTypes,
      capabilityStatus: 'qualified',
      provenance: Object.freeze({ source: 'automatic-route-catalog' }),
    })])),
);

export const DISPATCH_ROLE_CATALOG = Object.freeze({
  ...STATIC_ROLE_CATALOG,
  ...AUTOMATIC_TASK_ROLE_CATALOG,
  [INTENT_ACCEPTANCE_ROLE]: Object.freeze({
    role: INTENT_ACCEPTANCE_ROLE,
    dispatchKind: 'reason-only-leaf',
    authority: 'user-intent-acceptance',
    profile: null,
    agentTypes: [],
    capabilityStatus: 'qualified',
    provenance: Object.freeze({ source: 'intent-acceptance-dispatch' }),
  }),
});

export const SUPPORTED_DISPATCH_ROLES = Object.freeze([
  ...Object.keys(DISPATCH_ROLE_CATALOG),
  'cheap-worker',
]);

function roleTemplate(role) {
  if (role === 'cheap-worker') {
    return {
      agentTypes: ROLE_KIND_AGENTS.worker,
    };
  }
  return DISPATCH_ROLE_CATALOG[role] ?? null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function optionalRegularFile(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
    ? file
    : null;
}

function uniqueStrings(values, label, { allowEmpty = true } = {}) {
  assert(Array.isArray(values), `${label} must be an array`);
  const normalized = [...new Set(values.map(value => {
    assert(typeof value === 'string' && value.trim().length > 0,
      `${label} must contain non-empty strings`);
    return value.trim();
  }))];
  assert(allowEmpty || normalized.length > 0, `${label} must not be empty`);
  return normalized;
}

function maybeAdapter(root) {
  const file = optionalRegularFile(path.join(root, '.github', 'agent-budget.json'));
  return file ? readAdapter(root) : null;
}

function relativeInstruction(root, value, label) {
  assert(typeof value === 'string' && value.trim().length > 0 &&
    !path.isAbsolute(value), `${label} must be a non-empty repository-relative path`);
  contained(root, value.trim());
  return value.trim();
}

function validateSparseOverride(root, value, contractProject) {
  assert(value && typeof value === 'object' && !Array.isArray(value),
    'Sparse override must be a JSON object');
  assert(value.version === 1, 'Sparse override version must be 1');
  assert(value.kind === 'budget-contract-override',
    'Sparse override kind must be budget-contract-override');
  if (value.project !== undefined) {
    assert(typeof value.project === 'string' && value.project.trim().length > 0,
      'Sparse override project must be a non-empty string');
    if (contractProject) {
      assert(value.project.trim() === contractProject,
        'Sparse override project conflicts with the effective contract project');
    }
  }
  const owner = value.owner ?? {};
  assert(owner && typeof owner === 'object' && !Array.isArray(owner),
    'Sparse override owner must be an object');
  const instructions = owner.instructions === undefined
    ? []
    : uniqueStrings(owner.instructions, 'Sparse override owner.instructions')
      .map(item => relativeInstruction(root, item, 'Sparse override owner.instructions entry'));
  const gates = owner.gates === undefined
    ? []
    : uniqueStrings(owner.gates, 'Sparse override owner.gates');
  const roles = value.roles ?? {};
  assert(roles && typeof roles === 'object' && !Array.isArray(roles),
    'Sparse override roles must be an object');
  const normalizedRoles = Object.fromEntries(Object.entries(roles).map(([role, config]) => {
    assert(SUPPORTED_DISPATCH_ROLES.includes(role),
      `Sparse override role is unsupported: ${role}`);
    const template = roleTemplate(role);
    assert(template, `Sparse override role is unsupported: ${role}`);
    assert(config && typeof config === 'object' && !Array.isArray(config),
      `Sparse override ${role} config must be an object`);
    if (config.enabled !== undefined) {
      assert(config.enabled === false,
        `Sparse override ${role} may only disable an existing capability`);
    }
    const agentTypes = config.agentTypes === undefined
      ? undefined
      : uniqueStrings(config.agentTypes, `Sparse override ${role}.agentTypes`, {
          allowEmpty: false,
        });
    if (agentTypes !== undefined) {
      assert(template.agentTypes.length > 0,
        `Sparse override ${role} cannot add task agent bindings`);
      assert(agentTypes.every(type => template.agentTypes.includes(type)),
        `Sparse override ${role}.agentTypes conflict with the base role contract`);
    }
    assert(Object.keys(config).every(key => ['enabled', 'agentTypes'].includes(key)),
      `Sparse override ${role} contains unsupported fields`);
    return [role, {
      enabled: config.enabled ?? undefined,
      agentTypes,
    }];
  }));
  const release = value.release ?? {};
  assert(release && typeof release === 'object' && !Array.isArray(release),
    'Sparse override release must be an object');
  if (release.automated !== undefined) {
    assert(release.automated === false,
      'Sparse override release.automated may only disable automation');
  }
  assert(Object.keys(value).every(key =>
    ['version', 'kind', 'project', 'owner', 'roles', 'release'].includes(key)),
  'Sparse override contains unsupported top-level fields');
  return {
    version: 1,
    kind: 'budget-contract-override',
    project: value.project?.trim() ?? contractProject ?? null,
    owner: { instructions, gates },
    roles: normalizedRoles,
    release: { automated: release.automated ?? undefined },
  };
}

export function readSparseOverride(root) {
  const repositoryRoot = fs.realpathSync(root);
  const file = optionalRegularFile(path.join(repositoryRoot, SPARSE_OVERRIDE_RELATIVE_PATH));
  if (!file) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    file,
    relativePath: SPARSE_OVERRIDE_RELATIVE_PATH,
    override: validateSparseOverride(repositoryRoot, raw, maybeAdapter(repositoryRoot)?.project ?? null),
  };
}

function releaseCapability(root, adapter) {
  if (!adapter) {
    return {
      status: 'disabled',
      reason: 'release-contract-unresolved',
      machineVersion: null,
      opportunity: null,
      operatorAuthorizationRequired: true,
    };
  }
  if (typeof adapter.releaseMachine !== 'string' || adapter.releaseMachine.length === 0) {
    return {
      status: 'disabled',
      reason: 'release-contract-absent',
      machineVersion: null,
      opportunity: null,
      operatorAuthorizationRequired: true,
    };
  }
  const machine = readReleaseMachine(root, adapter);
  return {
    status: machine.enabled ? 'configured' : 'disabled',
    reason: machine.enabled ? null : 'release-machine-disabled',
    machineVersion: machine.version,
    opportunity: machine.opportunity,
    operatorAuthorizationRequired: machine.operatorAuthorizationRequired === true,
  };
}

function applyOverride(contract, sparse) {
  if (!sparse) return contract;
  const next = structuredClone(contract);
  next.owner.instructions = [...new Set([
    ...next.owner.instructions,
    ...sparse.override.owner.instructions,
  ])];
  next.owner.gates = [...new Set([
    ...next.owner.gates,
    ...sparse.override.owner.gates,
  ])];
  if (sparse.override.release.automated === false) {
    next.capabilities.release.status = 'disabled';
    next.capabilities.release.reason = 'release-disabled-by-override';
  }
  next.constraints.roles = Object.fromEntries(Object.entries(sparse.override.roles));
  next.provenance.sparseOverride = {
    relativePath: sparse.relativePath,
    sha256: sha256(sparse.override),
  };
  return next;
}

export function readEffectiveContract(root, options = {}) {
  const repositoryRoot = fs.realpathSync(root);
  const adapter = maybeAdapter(repositoryRoot);
  const project = adapter?.project ?? String(options.project ?? ZERO_CONFIG_PROJECT);
  const base = {
    version: EFFECTIVE_CONTRACT_VERSION,
    kind: 'effective-contract',
    project,
    repository: repositoryRoot,
    provenance: {
      source: adapter ? 'repository-contract' : 'zero-config',
      adapterPath: adapter ? '.github/agent-budget.json' : null,
      sparseOverride: null,
    },
    owner: {
      mode: adapter ? 'repository-contract' : 'native-rules',
      instructions: adapter?.instructions ?? [],
      gates: adapter?.gates ?? [],
    },
    capabilities: {
      delegatedBoundedWork: {
        status: 'unresolved',
        reason: adapter
          ? 'plan-scoped-capability-required'
          : 'zero-config-explicit-capability-required',
      },
      release: releaseCapability(repositoryRoot, adapter),
    },
    constraints: {
      roles: {},
    },
    unresolved: [],
  };
  if (base.capabilities.delegatedBoundedWork.status !== 'configured') {
    base.unresolved.push(base.capabilities.delegatedBoundedWork.reason);
  }
  if (base.capabilities.release.reason) {
    base.unresolved.push(base.capabilities.release.reason);
  }
  const withOverride = applyOverride(base, readSparseOverride(repositoryRoot));
  const unsigned = {
    ...withOverride,
    unresolved: [...new Set(withOverride.unresolved)].sort(),
  };
  return {
    ...unsigned,
    contractHash: sha256(unsigned),
  };
}

function applyRoleConstraints(roleContract, effectiveContract) {
  const constraint = effectiveContract.constraints.roles[roleContract.role];
  if (!constraint) return roleContract;
  assert(constraint.enabled !== false,
    `Effective contract disables ${roleContract.role}`);
  if (constraint.agentTypes !== undefined) {
    assert(roleContract.agentTypes.length > 0,
      `Effective contract cannot add agent types to ${roleContract.role}`);
    const allowed = constraint.agentTypes.filter(type =>
      roleContract.agentTypes.includes(type));
    assert(allowed.length === constraint.agentTypes.length,
      `Effective contract agentTypes conflict with ${roleContract.role}`);
    return {
      ...roleContract,
      agentTypes: allowed,
      provenance: {
        ...roleContract.provenance,
        sparseOverride: effectiveContract.provenance.sparseOverride?.sha256 ?? null,
      },
    };
  }
  return roleContract;
}

function staticRoleContract(role) {
  if (!Object.hasOwn(DISPATCH_ROLE_CATALOG, role)) return null;
  const contract = DISPATCH_ROLE_CATALOG[role];
  if (contract.profile) validateProfile(contract.profile, `${role} profile`);
  return structuredClone(contract);
}

function cheapWorkerContract(plan) {
  assert(plan && typeof plan === 'object' && !Array.isArray(plan),
    'cheap-worker dispatch requires an exact plan');
  assert(plan.status === 'ready', 'cheap-worker dispatch requires a ready plan');
  const team = plan.team;
  assert(team && typeof team === 'object' && !Array.isArray(team),
    'cheap-worker dispatch requires a team contract');
  const worker = team.workerCandidate;
  assert(worker?.role === 'cheap-worker',
    'cheap-worker dispatch requires a cheap-worker team capability');
  validateProfile(worker.profile, 'cheap-worker profile');
  assert(worker.enabled === true, 'cheap-worker dispatch is disabled for this plan');
  assert(worker.evidenceStatus === 'provisional',
    'cheap-worker dispatch requires provisional worker evidence');
  assert(Number.isInteger(worker.currentCases) && worker.currentCases > 0,
    'cheap-worker dispatch requires one or more valid qualification cases');
  assert(worker.authority === 'staging-only',
    'cheap-worker dispatch requires staging-only worker authority');
  const validators = uniqueStrings(worker.validators ?? [],
    'cheap-worker validators', { allowEmpty: false });
  return {
    role: 'cheap-worker',
    dispatchKind: 'task',
    authority: 'staging-only',
    profile: worker.profile,
    agentTypes: ROLE_KIND_AGENTS.worker,
    capabilityStatus: 'qualified',
    qualification: {
      evidenceStatus: worker.evidenceStatus,
      currentCases: worker.currentCases,
      capability: worker.capability,
      sandboxProfile: worker.sandboxProfile,
      delegationClass: worker.delegationClass,
      validators,
      trustTier: team.trustTier,
      maxRevisions: team.maxRevisions,
    },
    provenance: {
      source: 'opportunity-plan',
      opportunity: plan.opportunity ?? null,
      variant: plan.variant ?? null,
      teamId: team.id ?? null,
      pipelineHash: plan.pipelineHash ?? null,
      planHash: plan.planHash ?? null,
    },
  };
}

export function resolveRoleContract(
  effectiveContract,
  role,
  options = {},
) {
  assert(effectiveContract?.kind === 'effective-contract',
    'Effective contract required');
  assert(SUPPORTED_DISPATCH_ROLES.includes(role),
    `Unsupported dispatch role: ${role}`);
  const base = role === 'cheap-worker'
    ? cheapWorkerContract(options.plan)
    : staticRoleContract(role);
  assert(base, `Unsupported dispatch role: ${role}`);
  return applyRoleConstraints(base, effectiveContract);
}

export function createDispatchEffectiveContract(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Dispatch effective contract input required');
  const repository = input.repository ? fs.realpathSync(input.repository) : null;
  const effectiveContract = repository
    ? readEffectiveContract(repository, { project: input.project })
    : {
      version: EFFECTIVE_CONTRACT_VERSION,
      kind: 'effective-contract',
      project: String(input.project ?? ZERO_CONFIG_PROJECT),
      repository: null,
      provenance: {
        source: 'zero-config',
        adapterPath: null,
        sparseOverride: null,
      },
      owner: {
        mode: 'native-rules',
        instructions: [],
        gates: [],
      },
      capabilities: {
        delegatedBoundedWork: {
          status: 'unresolved',
          reason: 'zero-config-explicit-capability-required',
        },
        release: {
          status: 'disabled',
          reason: 'release-contract-unresolved',
          machineVersion: null,
          opportunity: null,
          operatorAuthorizationRequired: true,
        },
      },
      constraints: { roles: {} },
      unresolved: [
        'release-contract-unresolved',
        'zero-config-explicit-capability-required',
      ],
      contractHash: null,
    };
  const selectedRole = resolveRoleContract(effectiveContract, input.role, {
    plan: input.plan ?? null,
  });
  if (selectedRole.role === 'cheap-worker') {
    assert(effectiveContract.provenance.source === 'repository-contract',
      'cheap-worker dispatch requires a repository-bound effective contract');
  }
  const delegatedStatus = selectedRole.role === 'cheap-worker'
    ? effectiveContract.provenance.source === 'repository-contract'
      ? 'configured'
      : effectiveContract.capabilities.delegatedBoundedWork.status
    : effectiveContract.capabilities.delegatedBoundedWork.status;
  const unsigned = {
    version: EFFECTIVE_CONTRACT_VERSION,
    kind: 'effective-contract',
    project: effectiveContract.project,
    repository: effectiveContract.repository,
    provenance: effectiveContract.provenance,
    owner: effectiveContract.owner,
    capabilities: {
      ...effectiveContract.capabilities,
      delegatedBoundedWork: {
        status: delegatedStatus,
        reason: delegatedStatus === 'configured'
          ? null
          : effectiveContract.capabilities.delegatedBoundedWork.reason,
      },
    },
    constraints: effectiveContract.constraints,
    unresolved: [...effectiveContract.unresolved],
    selectedRole,
  };
  return {
    ...unsigned,
    contractHash: sha256(unsigned),
  };
}

export function expectedTaskContract(args) {
  const role = typeof args?.role === 'string' ? args.role : null;
  if (!role || !SUPPORTED_DISPATCH_ROLES.includes(role)) return null;
  const effectiveContract = args.effectiveContract?.kind === 'effective-contract'
    ? args.effectiveContract
    : createDispatchEffectiveContract(args);
  const selectedRole = effectiveContract.selectedRole ?? resolveRoleContract(
    effectiveContract,
    role,
    { plan: args.plan ?? null },
  );
  return {
    role,
    dispatchKind: selectedRole.dispatchKind,
    model: selectedRole.profile?.model ?? null,
    effort: selectedRole.profile?.effort ?? null,
    context: selectedRole.profile?.context ?? null,
    agentTypes: selectedRole.agentTypes,
    authority: selectedRole.authority,
    capabilityStatus: selectedRole.capabilityStatus,
    contractHash: effectiveContract.contractHash,
  };
}
