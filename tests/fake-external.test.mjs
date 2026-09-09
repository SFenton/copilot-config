import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeScratch } from './helpers/scratch.mjs';
import {
  FAKE_DRIVER_CLASSES,
} from '../skills/budget-workflow/scripts/fake-external.mjs';
import {
  runRegisteredTool,
  sha256,
  validateToolRegistry,
} from '../skills/budget-workflow/scripts/workflow.mjs';

const effect = driverClass => ({
  'github-pr': 'github',
  'github-release': 'github',
  'github-workflow': 'github',
  'home-assistant': 'home-assistant',
  'hacs-verification': 'production',
  'production-deploy': 'production',
  'database-capture': 'database',
  rollback: 'production',
})[driverClass];

const configurationEvents = owner => [{
  type: 'subagent.configured',
  data: {
    model: owner.model,
    reasoningEffort: owner.effort,
    contextTier: owner.context,
  },
}];

function authorization(root, driverClass, toolId) {
  const owner = { model: 'gpt-5.6-sol', effort: 'max', context: 'long_context' };
  return {
    version: 1,
    kind: 'frontier-authorization',
    workflowId: `fake-${driverClass}`,
    opportunityId: 'fake-external',
    project: 'fixture',
    repository: root,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    scopeHash: 'a'.repeat(64),
    nonce: driverClass,
    issuedAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-09T00:00:00.000Z',
    resolvedConfigurationEvidenceHash: sha256(configurationEvents(owner)[0]),
    allowedSideEffect: effect(driverClass),
    toolIds: [toolId],
    owner,
  };
}

function initializeRepository(root) {
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.com',
    'commit', '-qm', 'fixture',
  ], { cwd: root });
}

for (const driverClass of FAKE_DRIVER_CLASSES) {
  test(`${driverClass} fake driver binds authorization and exposes rejection and abnormal failure`, t => {
    const root = makeScratch('fake-external-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    initializeRepository(root);
    const tool = {
      id: `${driverClass}-execute`,
      kind: 'fake-driver',
      fakeOnly: true,
      driverClass,
      action: 'execute',
      sideEffect: effect(driverClass),
      environment: [],
    };
    validateToolRegistry({ version: 1, project: 'fixture', tools: [tool] });
    const auth = authorization(root, driverClass, tool.id);
    const state = {};
    const common = {
      execute: true,
      fakeAdapter: true,
      fakeState: state,
      allowedSideEffects: [tool.sideEffect],
      authorization: auth,
      project: 'fixture',
      opportunityId: 'fake-external',
      now: Date.parse('2026-09-08T12:00:00.000Z'),
      expectedOwner: auth.owner,
      currentRevision: auth.baseRevision,
      scopeHash: auth.scopeHash,
      resolvedConfigurationEvidenceHash: auth.resolvedConfigurationEvidenceHash,
      resolvedConfigurationEvents: configurationEvents(auth.owner),
    };
    assert.equal(runRegisteredTool(root, tool, common).status, 'accepted');
    assert.equal(runRegisteredTool(root, tool, {
      ...common,
      fakeScenario: 'reject',
    }).status, 'rejected');
    assert.equal(runRegisteredTool(root, tool, {
      ...common,
      fakeScenario: 'abnormal',
    }).status, 'abnormal');
    assert.throws(() => runRegisteredTool(root, tool, {
      ...common,
      authorization: { ...auth, toolIds: [] },
    }), /omits required tools/);
    assert.throws(() => runRegisteredTool(root, tool, {
      ...common,
      scopeHash: 'c'.repeat(64),
    }), /scope hash mismatch/);
  });
}

test('fake rollback, verification and cleanup mutate only in-memory state', t => {
  const root = makeScratch('fake-rollback-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeRepository(root);
  const tools = [
    ['deploy', 'production-deploy', 'execute'],
    ['verify', 'production-deploy', 'verify'],
    ['rollback', 'production-deploy', 'rollback'],
    ['cleanup', 'rollback', 'cleanup'],
  ].map(([id, driverClass, action]) => ({
    id,
    kind: 'fake-driver',
    fakeOnly: true,
    driverClass,
    action,
    sideEffect: 'production',
    environment: [],
  }));
  validateToolRegistry({ version: 1, project: 'fixture', tools });
  const auth = {
    ...authorization(root, 'production-deploy', 'deploy'),
    toolIds: tools.map(tool => tool.id),
  };
  const state = {};
  for (const tool of tools) {
    const result = runRegisteredTool(root, tool, {
      execute: true,
      fakeAdapter: true,
      fakeState: state,
      allowedSideEffects: ['production'],
      authorization: auth,
      project: 'fixture',
      opportunityId: 'fake-external',
      now: Date.parse('2026-09-08T12:00:00.000Z'),
      expectedOwner: auth.owner,
      currentRevision: auth.baseRevision,
      scopeHash: auth.scopeHash,
      resolvedConfigurationEvidenceHash: auth.resolvedConfigurationEvidenceHash,
      resolvedConfigurationEvents: configurationEvents(auth.owner),
    });
    assert.equal(result.status, 'accepted');
  }
  assert.equal(state.resources['production-deploy'], 'rolled-back');
  assert.equal(state.cleaned, true);
  assert.equal(execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }), '');
});
