import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratch } from './helpers/scratch.mjs';
import { execFileSync } from 'node:child_process';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import {
  executeReleaseStep,
  nextReleaseAction,
  readReleaseMachine,
  releasePlan,
  validateReleaseMachineV2,
  validateReleaseMachineV3,
}
  from '../skills/budget-workflow/scripts/release-machine.mjs';
import { createReceipt, sha256, validateAuthorization }
  from '../skills/budget-workflow/scripts/workflow.mjs';
const manifest = process.env.BUDGET_PROJECT_MANIFEST;

test('all project release machines use disabled version 3 deterministic drivers', {
  skip: !manifest,
}, () => {
  const projects = JSON.parse(fs.readFileSync(manifest, 'utf8')).cases;
  for (const project of projects) {
    const machine = readReleaseMachine(project.root, readAdapter(project.root));
    const plan = releasePlan(machine);
    assert.equal(plan.version, 3);
    assert.equal(plan.enabled, false);
    assert.equal(plan.executable, false);
    assert.notEqual(plan.steps[0].operation, 'authorize');
    assert.ok(plan.steps.every(step => step.executor === 'deterministic'));
    assert.equal(plan.operatorAuthorizationRequired, true);
    assert.equal(plan.reviewer.profile.effort, 'medium');
    assert.equal(plan.reviewer.profile.context, 'default');
    assert.equal(plan.exception.requiresTriggerReceipt, true);
    assert.ok(plan.exception.triggerIds.length > 0);
    assert.ok(plan.steps.some(step => step.operation === 'rollback'));
    assert.ok(machine.toolRegistry.tools.some(tool => tool.kind === 'disabled'));
    for (const step of machine.steps) {
      const tool = machine.toolRegistry.tools.find(item => item.id === step.tool);
      if (['github', 'home-assistant', 'database', 'production', 'destructive']
        .includes(tool.sideEffect)) {
        assert.equal(tool.kind, 'disabled',
          `${machine.project}/${step.id}: consequential project driver must remain disabled`);
      }
    }
    assert.deepEqual(nextReleaseAction(machine, {}), {
      status: 'blocked',
      project: machine.project,
      reason: 'release-machine-disabled',
    });
  }
});

test('version 1 release machines require advisory mode, one leading authorization and rollback-only rollback steps', () => {
  const machine = {
    version: 1,
    project: 'sample',
    advisoryOnly: true,
    executor: null,
    supervisor: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
    exception: { model: 'gpt-5.6-sol', effort: 'max', context: 'long_context' },
    steps: [
      { id: 'authorize', label: 'Authorize', executor: 'supervisor', operation: 'authorize',
        evidence: ['scope'] },
      { id: 'test', label: 'Test', executor: 'deterministic', operation: 'command',
        argv: ['node', '--version'], failure: 'rollback', evidence: ['result'] },
      { id: 'rollback', label: 'Rollback', executor: 'deterministic', operation: 'rollback',
        rollbackOnly: true, evidence: ['restored'] },
      { id: 'verify', label: 'Verify', executor: 'deterministic', operation: 'verify',
        failure: 'escalate', evidence: ['verified'] },
    ],
  };
  assert.equal(nextReleaseAction(machine, {}).status, 'blocked');
});

function v2Fixture(root) {
  const tool = (id, script, sideEffect = 'none') => ({
    id,
    kind: 'command',
    argv: [process.execPath, '-e', script],
    cwd: '.',
    timeoutSeconds: 10,
    sideEffect,
    environment: [],
  });
  return validateReleaseMachineV2({
    version: 2,
    project: 'sample',
    opportunity: 'release',
    variant: 'application-release',
    enabled: true,
    supervisor: { model: 'gpt-5.6-luna', effort: 'medium', context: 'default' },
    exception: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
    toolRegistry: {
      version: 1,
      project: 'sample',
      tools: [
        tool('validate-release', 'process.stdout.write("validated")'),
        tool('publish-release', 'process.stdout.write("published")', 'production'),
        tool('verify-release', 'process.stdout.write("verified")'),
        tool('rollback-release', 'process.stdout.write("rolled-back")', 'production'),
        tool('verify-rollback', 'process.stdout.write("rollback-verified")'),
        tool('cleanup-release', 'process.stdout.write("cleaned")'),
      ],
    },
    steps: [
      { id: 'authorize', label: 'Authorize', executor: 'supervisor', operation: 'authorize',
        evidence: ['scope'], failure: 'abnormal' },
      { id: 'validate', label: 'Validate', executor: 'deterministic', operation: 'command',
        tool: 'validate-release', evidence: ['validation'], failure: 'rejected' },
      { id: 'publish', label: 'Publish', executor: 'deterministic', operation: 'github-release',
        tool: 'publish-release', evidence: ['publication'], failure: 'rollback' },
      { id: 'verify', label: 'Verify', executor: 'deterministic', operation: 'verify',
        tool: 'verify-release', evidence: ['verification'], failure: 'rollback' },
      { id: 'rollback', label: 'Rollback', executor: 'deterministic', operation: 'rollback',
        tool: 'rollback-release', rollbackOnly: true,
        rollbackVerificationTool: 'verify-rollback', evidence: ['restored'], failure: 'abnormal' },
      { id: 'cleanup', label: 'Cleanup', executor: 'deterministic', operation: 'cleanup',
        tool: 'cleanup-release', evidence: ['clean'], failure: 'abnormal' },
    ],
  }, 'sample');
}

function v2State(root, machine) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', [
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.com',
      'commit', '-qm', 'fixture',
    ], { cwd: root });
  }
  const currentRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const resolvedConfigurationEvents = [{
    type: 'subagent.configured',
    data: {
      model: machine.supervisor.model,
      reasoningEffort: machine.supervisor.effort,
      contextTier: machine.supervisor.context,
    },
  }];
  const now = Date.parse('2026-09-08T12:00:00.000Z');
  const authorization = {
    version: 1,
    kind: 'frontier-authorization',
    workflowId: 'release-1',
    opportunityId: 'release',
    variant: machine.variant,
    project: 'sample',
    repository: root,
    baseRevision: currentRevision,
    scopeHash: 'a'.repeat(64),
    nonce: 'nonce-1',
    issuedAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-09T00:00:00.000Z',
    resolvedConfigurationEvidenceHash:
      sha256(resolvedConfigurationEvents[0]),
    allowedSideEffect: 'production',
    toolIds: machine.toolRegistry.tools.map(tool => tool.id),
    owner: machine.supervisor,
  };
  const plan = releasePlan(machine);
  const authorizationHash = validateAuthorization(authorization, {
    project: 'sample',
    opportunityId: 'release',
    variant: machine.variant,
    repository: root,
    requiredSideEffect: 'production',
    toolIds: authorization.toolIds,
    now,
  }).hash;
  const receipt = createReceipt({
    workflowId: authorization.workflowId,
    opportunityId: 'release',
    variant: machine.variant,
    stepId: 'authorize',
    executor: 'frontier',
    planHash: plan.planHash,
    authorizationHash,
    status: 'accepted',
    beforeStateHash: 'c'.repeat(64),
    afterStateHash: 'c'.repeat(64),
    startedAt: '2026-09-08T00:00:00.000Z',
    completedAt: '2026-09-08T00:00:01.000Z',
  });
  return {
    authorization,
    receipts: [receipt],
    now,
    currentRevision: authorization.baseRevision,
    scopeHash: authorization.scopeHash,
    resolvedConfigurationEvidenceHash: authorization.resolvedConfigurationEvidenceHash,
    resolvedConfigurationEvents,
  };
}

function appendReceipt(machine, state, stepId, status = 'accepted') {
  const plan = releasePlan(machine);
  const authorizationHash = validateAuthorization(state.authorization, {
    project: machine.project,
    opportunityId: machine.opportunity,
    variant: machine.variant,
    repository: state.authorization.repository,
    requiredSideEffect: 'production',
    toolIds: state.authorization.toolIds,
    now: state.now,
  }).hash;
  const step = machine.steps.find(item => item.id === stepId);
  const tool = step.tool
    ? machine.toolRegistry.tools.find(item => item.id === step.tool)
    : null;
  const verificationTool = step.rollbackVerificationTool
    ? machine.toolRegistry.tools.find(item => item.id === step.rollbackVerificationTool)
    : null;
  const receipt = createReceipt({
    workflowId: state.authorization.workflowId,
    opportunityId: machine.opportunity,
    variant: machine.variant,
    stepId,
    executor: step.executor === 'supervisor' ? 'frontier' : 'deterministic',
    planHash: plan.planHash,
    authorizationHash,
    previousReceiptHash: state.receipts.at(-1)?.receiptHash ?? null,
    toolId: step.tool ?? null,
    toolHash: tool ? sha256(tool) : null,
    argvHash: tool?.kind === 'command' ? sha256(tool.argv) :
      tool ? '1'.repeat(64) : null,
    verificationToolId: verificationTool?.id ?? null,
    verificationToolHash: verificationTool
      ? sha256(verificationTool)
      : null,
    verificationArgvHash: verificationTool?.kind === 'command'
      ? sha256(verificationTool.argv)
      : verificationTool ? '2'.repeat(64) : null,
    verificationStatus: verificationTool
      ? status === 'accepted' ? 'accepted' : 'rejected'
      : null,
    verificationExitCode: verificationTool ? status === 'accepted' ? 0 : 1 : null,
    verificationStdoutHash: verificationTool ? sha256('') : null,
    verificationStderrHash: verificationTool ? sha256('') : null,
    status,
    beforeStateHash: 'e'.repeat(64),
    afterStateHash: 'f'.repeat(64),
    startedAt: '2026-09-08T00:00:02.000Z',
    completedAt: '2026-09-08T00:00:03.000Z',
  });
  return { ...state, receipts: [...state.receipts, receipt] };
}

test('version 2 executes only registered deterministic steps after frontier authorization', t => {
  const root = makeScratch('release-v2-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const machine = v2Fixture(root);
  const state = v2State(root, machine);
  assert.equal(nextReleaseAction(machine, state).step.id, 'validate');
  assert.throws(() => nextReleaseAction(machine, {
    ...state,
    resolvedConfigurationEvents: [{
      ...state.resolvedConfigurationEvents[0],
      data: {
        ...state.resolvedConfigurationEvents[0].data,
        reasoningEffort: 'high',
      },
    }],
  }), /effort mismatch/);
  const result = executeReleaseStep(machine, root, state, 'validate', {
    execute: true,
    allowedSideEffects: ['none', 'production'],
    beforeStateHash: 'd'.repeat(64),
    afterStateHash: 'd'.repeat(64),
  });
  assert.equal(result.execution.stdout, 'validated');
  const changedToolMachine = structuredClone(machine);
  changedToolMachine.toolRegistry.tools.find(tool =>
    tool.id === 'validate-release').timeoutSeconds += 1;
  assert.notEqual(
    releasePlan(changedToolMachine).planHash,
    releasePlan(machine).planHash,
  );
  assert.throws(() => nextReleaseAction(changedToolMachine, {
    ...state,
    receipts: [...state.receipts, result.receipt],
  }), /plan mismatch|tool contract/i);
  const wrongToolContract = {
    ...result.receipt,
    toolHash: '0'.repeat(64),
  };
  delete wrongToolContract.evidenceHash;
  delete wrongToolContract.receiptHash;
  wrongToolContract.evidenceHash = sha256(wrongToolContract);
  wrongToolContract.receiptHash = sha256({
    ...wrongToolContract,
    receiptHash: undefined,
  });
  assert.throws(() => nextReleaseAction(machine, {
    ...state,
    receipts: [...state.receipts, wrongToolContract],
  }), /tool contract/i);
  const next = nextReleaseAction(machine, {
    ...state,
    receipts: [...state.receipts, result.receipt],
  });
  assert.equal(next.step.id, 'publish');
  const semanticallyForged = {
    ...result.receipt,
    executor: 'frontier',
  };
  delete semanticallyForged.evidenceHash;
  delete semanticallyForged.receiptHash;
  semanticallyForged.evidenceHash = sha256(semanticallyForged);
  semanticallyForged.receiptHash = sha256({
    ...semanticallyForged,
    receiptHash: undefined,
  });
  assert.throws(() => nextReleaseAction(machine, {
    ...state,
    receipts: [...state.receipts, semanticallyForged],
  }), /executor does not match/);
  assert.throws(() => nextReleaseAction(machine, {
    ...state,
    receipts: [{ ...state.receipts[0], evidenceHash: '0'.repeat(64) }],
  }), /evidence hash/);
});

test('enabled release machines reject cheap supervisors and disabled tools', t => {
  const root = makeScratch('release-v2-enable-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const machine = v2Fixture(root);
  assert.throws(() => validateReleaseMachineV2({
    ...machine,
    supervisor: { model: 'gpt-5-mini', effort: 'medium', context: 'default' },
  }, 'sample'), /gpt-5\.6-luna medium\/default/i);
  const disabled = {
    id: 'disabled-publish',
    kind: 'disabled',
    reason: 'not implemented',
    sideEffect: 'production',
    environment: [],
  };
  assert.throws(() => validateReleaseMachineV2({
    ...machine,
    toolRegistry: {
      ...machine.toolRegistry,
      tools: [...machine.toolRegistry.tools, disabled],
    },
    steps: machine.steps.map(step =>
      step.id === 'publish' ? { ...step, tool: disabled.id } : step),
  }, 'sample'), /cannot reference disabled tools/);
});

test('enabled version 3 fake machines execute without command timeouts', t => {
  const root = makeScratch('release-v3-fake-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.com',
    'commit', '-qm', 'fixture',
  ], { cwd: root });
  const fakeTool = (id, action) => ({
    id,
    kind: 'fake-driver',
    fakeOnly: true,
    driverClass: 'production-deploy',
    action,
    sideEffect: 'production',
    environment: [],
  });
  const machine = validateReleaseMachineV3({
    version: 3,
    project: 'sample',
    opportunity: 'release',
    enabled: true,
    fakeOnly: true,
    operatorAuthorizationRequired: true,
    reviewer: {
      role: 'medium-review',
      profile: {
        model: 'gpt-5.6-luna',
        effort: 'medium',
        context: 'default',
      },
      authority: 'review-only',
    },
    exception: {
      role: 'research-frontier',
      profile: {
        model: 'gpt-5.6-sol',
        effort: 'high',
        context: 'default',
      },
      triggerIds: ['sample-release-conflict'],
      requiresTriggerReceipt: true,
    },
    toolRegistry: {
      version: 1,
      project: 'sample',
      tools: [
        fakeTool('preflight', 'execute'),
        fakeTool('deploy', 'execute'),
        fakeTool('verify', 'verify'),
        fakeTool('rollback', 'rollback'),
        fakeTool('cleanup', 'cleanup'),
      ],
    },
    steps: [
      {
        id: 'preflight',
        label: 'Preflight',
        executor: 'deterministic',
        operation: 'command',
        tool: 'preflight',
        failure: 'blocked',
        evidence: ['preflight receipt'],
      },
      {
        id: 'deploy',
        label: 'Deploy',
        executor: 'deterministic',
        operation: 'deploy',
        tool: 'deploy',
        failure: 'rollback',
        evidence: ['deploy receipt'],
      },
      {
        id: 'verify',
        label: 'Verify',
        executor: 'deterministic',
        operation: 'verify',
        tool: 'verify',
        failure: 'rollback',
        evidence: ['verify receipt'],
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
  }, 'sample');
  const commandBacked = structuredClone(machine);
  commandBacked.toolRegistry.tools = commandBacked.toolRegistry.tools.map(tool => ({
    id: tool.id,
    kind: 'command',
    argv: [process.execPath, '-e', 'process.exit(0)'],
    cwd: '.',
    timeoutSeconds: 30,
    sideEffect: tool.sideEffect,
    environment: [],
  }));
  assert.throws(() => validateReleaseMachineV3(commandBacked, 'sample'),
    /fakeOnly must exactly match/i);
  const misplacedCleanup = structuredClone(machine);
  misplacedCleanup.steps = [
    misplacedCleanup.steps[0],
    misplacedCleanup.steps.at(-1),
    ...misplacedCleanup.steps.slice(1, -1),
  ];
  assert.throws(() => validateReleaseMachineV3(
    misplacedCleanup,
    'sample',
  ), /terminal cleanup/i);
  const plan = releasePlan(machine);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const operatorAuthorization = {
    version: 1,
    kind: 'operator-authorization',
    authorizedBy: 'operator',
    workflowId: 'fake-release',
    opportunityId: 'release',
    project: 'sample',
    repository: root,
    baseRevision: revision,
    scopeHash: 'a'.repeat(64),
    nonce: 'fake-release',
    issuedAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    allowedSideEffect: 'production',
    toolIds: ['preflight', 'deploy', 'verify', 'rollback', 'cleanup'],
    planHash: plan.planHash,
    toolContractHash: sha256(plan.toolContracts),
  };
  const result = executeReleaseStep(machine, root, {
    currentRevision: revision,
    scopeHash: operatorAuthorization.scopeHash,
    operatorAuthorization,
    receipts: [],
  }, 'preflight', {
    execute: true,
    fakeAdapter: true,
    fakeState: {},
    allowedSideEffects: ['production'],
    beforeStateHash: 'b'.repeat(64),
    afterStateHash: 'b'.repeat(64),
  });
  assert.equal(result.execution.status, 'accepted');

  const authorizationEnvironment = [
    'RELEASE_AUTHORIZED_REPOSITORY',
    'RELEASE_AUTHORIZED_WORKFLOW_ID',
    'RELEASE_AUTHORIZED_BASE_REVISION',
    'RELEASE_AUTHORIZED_SCOPE_HASH',
    'RELEASE_AUTHORIZED_VARIANT',
    'RELEASE_AUTHORIZED_PLAN_HASH',
    'RELEASE_AUTHORIZATION_HASH',
  ];
  const commandMachineInput = structuredClone(machine);
  delete commandMachineInput.fakeOnly;
  commandMachineInput.toolRegistry.tools =
    commandMachineInput.toolRegistry.tools.map(tool => ({
      id: tool.id,
      kind: 'command',
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("RELEASE_AUTH")))))',
      ],
      cwd: '.',
      timeoutSeconds: 30,
      sideEffect: 'none',
      environment: authorizationEnvironment,
    }));
  const commandMachine = validateReleaseMachineV3(
    commandMachineInput,
    'sample',
  );
  const commandPlan = releasePlan(commandMachine);
  const commandAuthorization = {
    ...operatorAuthorization,
    toolIds: commandMachine.toolRegistry.tools.map(tool => tool.id),
    planHash: commandPlan.planHash,
    toolContractHash: sha256(commandPlan.toolContracts),
  };
  const commandResult = executeReleaseStep(commandMachine, root, {
    currentRevision: revision,
    scopeHash: commandAuthorization.scopeHash,
    operatorAuthorization: commandAuthorization,
    receipts: [],
  }, 'preflight', {
    execute: true,
    allowedSideEffects: ['none'],
    beforeStateHash: 'b'.repeat(64),
    afterStateHash: 'b'.repeat(64),
  });
  const trusted = JSON.parse(commandResult.execution.stdout);
  assert.equal(trusted.RELEASE_AUTHORIZED_REPOSITORY, root);
  assert.equal(trusted.RELEASE_AUTHORIZED_BASE_REVISION, revision);
  assert.equal(
    trusted.RELEASE_AUTHORIZED_SCOPE_HASH,
    commandAuthorization.scopeHash,
  );
  assert.equal(
    trusted.RELEASE_AUTHORIZED_PLAN_HASH,
    commandPlan.planHash,
  );
  assert.equal(
    trusted.RELEASE_AUTHORIZED_VARIANT,
    'none',
  );
  assert.equal(
    trusted.RELEASE_AUTHORIZED_WORKFLOW_ID,
    commandAuthorization.workflowId,
  );
});

test('version 2 rejects prefabricated rollback receipts and cleans rejected paths', t => {
  const root = makeScratch('release-v2-state-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const machine = v2Fixture(root);
  const initial = v2State(root, machine);
  const prefabricated = appendReceipt(machine, initial, 'rollback');
  assert.throws(() => nextReleaseAction(machine, prefabricated), /Rollback receipt|incomplete earlier/);

  const failed = appendReceipt(machine, initial, 'validate', 'rejected');
  const cleanup = nextReleaseAction(machine, failed);
  assert.equal(cleanup.step.id, 'cleanup');
  const cleaned = appendReceipt(machine, failed, 'cleanup');
  assert.deepEqual(nextReleaseAction(machine, cleaned), {
    status: 'rejected',
    project: 'sample',
    failedStep: 'validate',
  });
});

test('fake external release faults route through rollback, cleanup and abnormal terminal states', t => {
    const root = makeScratch('release-fake-state-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fakeTool = (id, driverClass, action) => ({
      id,
      kind: 'fake-driver',
      fakeOnly: true,
      driverClass,
      action,
      sideEffect: 'production',
      environment: [],
    });
    const machine = validateReleaseMachineV2({
      version: 2,
      project: 'sample',
      opportunity: 'release',
      enabled: true,
      fakeOnly: true,
      supervisor: { model: 'gpt-5.6-luna', effort: 'medium', context: 'default' },
      exception: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
      toolRegistry: {
        version: 1,
        project: 'sample',
        tools: [
          fakeTool('deploy', 'production-deploy', 'execute'),
          fakeTool('verify', 'production-deploy', 'verify'),
          fakeTool('rollback', 'production-deploy', 'rollback'),
          fakeTool('cleanup', 'rollback', 'cleanup'),
        ],
      },
      steps: [
        { id: 'authorize', label: 'Authorize', executor: 'supervisor', operation: 'authorize',
          evidence: ['scope'], failure: 'abnormal' },
        { id: 'deploy', label: 'Deploy', executor: 'deterministic', operation: 'deploy',
          tool: 'deploy', evidence: ['deployment'], failure: 'rollback' },
        { id: 'verify', label: 'Verify', executor: 'deterministic', operation: 'verify',
          tool: 'verify', evidence: ['health'], failure: 'rollback' },
        { id: 'rollback', label: 'Rollback', executor: 'deterministic', operation: 'rollback',
          tool: 'rollback', rollbackOnly: true, rollbackVerificationTool: 'verify',
          evidence: ['restored'], failure: 'abnormal' },
        { id: 'cleanup', label: 'Cleanup', executor: 'deterministic', operation: 'cleanup',
          tool: 'cleanup', evidence: ['clean'], failure: 'abnormal' },
      ],
    }, 'sample');

    let state = v2State(root, machine);
    const fakeState = {};
    const rejected = executeReleaseStep(machine, root, state, 'deploy', {
      execute: true,
      fakeAdapter: true,
      fakeState,
      fakeScenarios: { deploy: 'reject' },
      allowedSideEffects: ['production'],
      beforeStateHash: 'a'.repeat(64),
      afterStateHash: 'a'.repeat(64),
    });
    state = { ...state, receipts: [...state.receipts, rejected.receipt] };
    assert.equal(nextReleaseAction(machine, state).status, 'rollback');
    const rolledBack = executeReleaseStep(machine, root, state, 'rollback', {
      execute: true,
      fakeAdapter: true,
      fakeState,
      allowedSideEffects: ['production'],
      beforeStateHash: 'a'.repeat(64),
      afterStateHash: 'a'.repeat(64),
    });
    state = { ...state, receipts: [...state.receipts, rolledBack.receipt] };
    assert.equal(nextReleaseAction(machine, state).step.id, 'cleanup');
    const cleaned = executeReleaseStep(machine, root, state, 'cleanup', {
      execute: true,
      fakeAdapter: true,
      fakeState,
      allowedSideEffects: ['production'],
      beforeStateHash: 'a'.repeat(64),
      afterStateHash: 'a'.repeat(64),
    });
    state = { ...state, receipts: [...state.receipts, cleaned.receipt] };
    assert.equal(nextReleaseAction(machine, state).status, 'rejected');
    assert.equal(fakeState.resources['production-deploy'], 'rolled-back');
    assert.equal(fakeState.cleaned, true);

    let abnormalState = v2State(root, machine);
    const abnormalFakeState = {};
    const abnormal = executeReleaseStep(machine, root, abnormalState, 'deploy', {
      execute: true,
      fakeAdapter: true,
      fakeState: abnormalFakeState,
      fakeScenarios: { deploy: 'abnormal' },
      allowedSideEffects: ['production'],
      beforeStateHash: 'a'.repeat(64),
      afterStateHash: 'a'.repeat(64),
    });
    abnormalState = {
      ...abnormalState,
      receipts: [...abnormalState.receipts, abnormal.receipt],
    };
    assert.equal(nextReleaseAction(machine, abnormalState).step.id, 'cleanup');
    const abnormalCleanup = executeReleaseStep(machine, root, abnormalState, 'cleanup', {
      execute: true,
      fakeAdapter: true,
      fakeState: abnormalFakeState,
      allowedSideEffects: ['production'],
      beforeStateHash: 'a'.repeat(64),
      afterStateHash: 'a'.repeat(64),
    });
    abnormalState = {
      ...abnormalState,
      receipts: [...abnormalState.receipts, abnormalCleanup.receipt],
    };
    assert.equal(nextReleaseAction(machine, abnormalState).status, 'abnormal');
    assert.equal(abnormalFakeState.cleaned, true);
});
