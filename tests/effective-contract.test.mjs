import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratch } from './helpers/scratch.mjs';
import {
  SPARSE_OVERRIDE_RELATIVE_PATH,
  createDispatchEffectiveContract,
  expectedTaskContract,
  readEffectiveContract,
} from '../skills/budget-workflow/scripts/effective-contract.mjs';
import { createDispatchManifest } from '../skills/budget-workflow/scripts/routing-enforcement.mjs';
import { sha256 } from '../skills/budget-workflow/scripts/workflow.mjs';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function repo(root, project = 'fixture') {
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'copilot-instructions.md'), '# fixture\n');
  writeJson(path.join(root, '.github', 'agent-budget.json'), {
    version: 1,
    project,
    instructions: ['.github/copilot-instructions.md'],
    riskTerms: ['release'],
    gates: ['Read the contract'],
  });
  return root;
}

function cheapWorkerPlan(overrides = {}) {
  const workerCandidate = {
    role: 'cheap-worker',
    enabled: true,
    profile: {
      model: 'mai-code-1.1-flash',
      effort: 'medium',
      context: 'default',
    },
    evidenceStatus: 'provisional',
    currentCases: 3,
    capability: 'focused-tests',
    sandboxProfile: 'focused-tests',
    delegationClass: 'test-generation',
    validators: ['unit-tests'],
    authority: 'staging-only',
    ...(overrides.workerCandidate ?? {}),
  };
  return {
    status: 'ready',
    opportunity: 'focused-tests',
    planHash: sha256('plan'),
    pipelineHash: sha256('pipeline'),
    team: {
      id: 'fixture-team',
      trustTier: 'provisional-staging',
      maxRevisions: 1,
      workerCandidate,
    },
    ...overrides,
  };
}

test('zero-config contracts allow native owner work while failing closed on delegated and release capabilities', () => {
  const root = makeScratch('effective-contract-zero-');
  const contract = readEffectiveContract(root);
  assert.equal(contract.owner.mode, 'native-rules');
  assert.equal(contract.provenance.source, 'zero-config');
  assert.deepEqual(contract.owner.instructions, []);
  assert.deepEqual(contract.owner.gates, []);
  assert.deepEqual(contract.capabilities.delegatedBoundedWork, {
    status: 'unresolved',
    reason: 'zero-config-explicit-capability-required',
  });
  assert.equal(contract.capabilities.release.status, 'disabled');
  assert.equal(contract.capabilities.release.reason, 'release-contract-unresolved');
});

test('sparse overrides stay monotonic and can only tighten existing role and release contracts', () => {
  const root = repo(makeScratch('effective-contract-override-'));
  fs.writeFileSync(path.join(root, '.github', 'strict.md'), '# strict\n');
  writeJson(path.join(root, SPARSE_OVERRIDE_RELATIVE_PATH), {
    version: 1,
    kind: 'budget-contract-override',
    project: 'fixture',
    owner: {
      instructions: ['.github/strict.md'],
      gates: ['Keep delegated work task-only'],
    },
    roles: {
      'simple-explorer': {
        agentTypes: ['task'],
      },
    },
    release: {
      automated: false,
    },
  });
  const contract = createDispatchEffectiveContract({
    repository: root,
    role: 'simple-explorer',
  });
  assert.deepEqual(contract.owner.instructions.sort(),
    ['.github/copilot-instructions.md', '.github/strict.md']);
  assert.deepEqual(contract.owner.gates.sort(),
    ['Keep delegated work task-only', 'Read the contract']);
  assert.deepEqual(contract.selectedRole.agentTypes, ['task']);
  assert.equal(contract.capabilities.release.reason, 'release-disabled-by-override');

  writeJson(path.join(root, SPARSE_OVERRIDE_RELATIVE_PATH), {
    version: 1,
    kind: 'budget-contract-override',
    project: 'fixture',
    roles: {
      'implementation-coordinator': {
        agentTypes: ['task'],
      },
    },
  });
  assert.throws(() => readEffectiveContract(root), /agentTypes conflict/i);
});

test('malformed or conflicting explicit overrides fail closed', () => {
  const root = repo(makeScratch('effective-contract-conflict-'), 'fixture');
  writeJson(path.join(root, SPARSE_OVERRIDE_RELATIVE_PATH), {
    version: 1,
    kind: 'budget-contract-override',
    project: 'other-project',
  });
  assert.throws(() => readEffectiveContract(root), /conflicts with the effective contract project/);

  writeJson(path.join(root, SPARSE_OVERRIDE_RELATIVE_PATH), {
    version: 1,
    kind: 'budget-contract-override',
    project: 'fixture',
    release: {
      automated: true,
    },
  });
  assert.throws(() => readEffectiveContract(root), /may only disable automation/);
});

test('semantic cheap-worker resolution is plan-scoped and qualification-bound', () => {
  const root = repo(makeScratch('effective-contract-worker-'));
  const contract = createDispatchEffectiveContract({
    repository: root,
    role: 'cheap-worker',
    plan: cheapWorkerPlan({
      pipelineHash: sha256('pipeline-a'),
      workerCandidate: {
        profile: {
          model: 'gemini-3.7-flash',
          effort: 'medium',
          context: 'default',
        },
      },
    }),
  });
  assert.equal(contract.selectedRole.role, 'cheap-worker');
  assert.equal(contract.selectedRole.profile.model, 'gemini-3.7-flash');
  assert.equal(contract.selectedRole.authority, 'staging-only');
  assert.equal(contract.selectedRole.qualification.currentCases, 3);
  assert.equal(contract.selectedRole.provenance.pipelineHash, sha256('pipeline-a'));
});

test('cheap-worker dispatch is denied for disabled or zero-case qualifications', () => {
  const root = repo(makeScratch('effective-contract-deny-'));
  assert.throws(() => createDispatchEffectiveContract({
    repository: root,
    role: 'cheap-worker',
    plan: cheapWorkerPlan({
      workerCandidate: {
        enabled: false,
        evidenceStatus: 'disabled',
        currentCases: 0,
      },
    }),
  }), /disabled|qualification cases/);
});

test('zero-config repositories cannot authorize cheap-worker dispatch through the manifest path', () => {
  const root = makeScratch('effective-contract-zero-dispatch-');
  assert.throws(() => createDispatchEffectiveContract({
    repository: root,
    role: 'cheap-worker',
    plan: cheapWorkerPlan(),
  }), /repository-bound effective contract/);
  assert.throws(() => createDispatchManifest({
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workflowId: 'workflow-1',
    promptHash: sha256('delegate focused tests'),
    repository: root,
    scope: ['tests'],
    role: 'cheap-worker',
    agentType: 'task',
    model: 'mai-code-1.1-flash',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['tests'],
    validations: ['node --test tests/example.test.mjs'],
    researchAuthorized: false,
    plan: cheapWorkerPlan(),
  }), /repository-bound effective contract/);
});

test('dispatch enforcement and compliance share the same effective cheap-worker contract', () => {
  const root = repo(makeScratch('effective-contract-parity-'));
  const plan = cheapWorkerPlan({
    pipelineHash: sha256('pipeline-parity'),
  });
  const manifest = createDispatchManifest({
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workflowId: 'workflow-1',
    promptHash: sha256('delegate focused tests'),
    repository: root,
    scope: ['tests'],
    role: 'cheap-worker',
    agentType: 'task',
    model: 'mai-code-1.1-flash',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['tests'],
    validations: ['node --test tests/example.test.mjs'],
    researchAuthorized: false,
    plan,
  });
  const expected = expectedTaskContract(manifest);
  assert.equal(expected.role, manifest.role);
  assert.equal(expected.model, manifest.model);
  assert.equal(expected.effort, manifest.effort);
  assert.equal(expected.context, manifest.context);
  assert.deepEqual(expected.agentTypes, manifest.effectiveContract.selectedRole.agentTypes);
  assert.equal(expected.contractHash, manifest.effectiveContract.contractHash);
});

test('repository contracts without a release machine disable automation without blocking ordinary work', () => {
  const root = repo(makeScratch('effective-contract-release-'));
  const contract = readEffectiveContract(root);
  assert.equal(contract.owner.mode, 'repository-contract');
  assert.equal(contract.capabilities.release.status, 'disabled');
  assert.equal(contract.capabilities.release.reason, 'release-contract-absent');
  assert.equal(contract.owner.gates.includes('Read the contract'), true);
});
