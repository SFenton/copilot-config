import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeScratch } from './helpers/scratch.mjs';
import {
  appendSanitizedEvent,
  backfillEvents,
  beginPromptWorkflow,
  createWorkflowCompletionObservation,
  findRoot,
  logicalRepositoryIdentity,
  persistCandidateLedger,
  pruneExpiredEvents,
  readCandidateLedger,
  readEffectiveProjectPolicy,
  readRepositoryEventLedger,
  readRepositoryEvents,
  sanitizeHookEvent,
  validateLearningPolicy,
  verifyWorkflowCompletionObservation,
} from '../skills/budget-workflow/scripts/continuous-improvement.mjs';
import { mineCandidates }
  from '../skills/budget-workflow/scripts/improvement-candidates.mjs';
import { canonicalJson, sha256 }
  from '../skills/budget-workflow/scripts/workflow.mjs';

const script = new URL(
  '../skills/budget-workflow/scripts/continuous-improvement.mjs',
  import.meta.url,
);
const plannerScript = new URL(
  '../skills/budget-workflow/scripts/opportunities.mjs',
  import.meta.url,
);

function policy(project = 'fixture') {
  return {
    version: 1,
    project,
    enabled: true,
    retentionDays: 30,
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
      description: 'Synthetic fixture only.',
      validators: ['fixture-validator'],
      destination: 'tools',
    }],
    destinations: {
      incubation: '.git/copilot-learning',
      tools: '.github/learned-tools',
      skills: '.github/skills',
      fixtures: 'tests/fixtures/learning',
    },
    eligiblePaths: ['src', 'tests'],
    excludedPaths: ['.env', 'secrets'],
    riskClasses: ['production', 'destructive', 'credential', 'security'],
    validators: [{ id: 'fixture-validator', targets: ['fixture-operation'] }],
    knownTools: [],
    knownSkills: [],
    automaticBuild: true,
    automaticPromotion: false,
    continuation: { enabled: true },
    promotion: {
      allowedSideEffects: ['none', 'workspace'],
      requireReplay: true,
      requireProjectValidation: true,
      requireMediumReview: true,
      requirePositiveValue: true,
      requireScopeCheck: true,
      requireRollback: true,
    },
  };
}

function opportunity(id = 'fixture', options = {}) {
  const enabled = options.enabled ?? true;
  return {
    id,
    label: options.label ?? id,
    triggers: options.triggers ?? [id],
    evidence: 'repository',
    enabled,
    evaluationStatus: enabled ? 'provisional' : 'invalidated-disabled',
    casePacketStatus: enabled ? 'provisional' : 'invalidated-disabled',
    skills: [],
    team: {
      id: `${id}-team`,
      topology: 'medium-owner-only',
      trustTier: 'provisional-staging',
      maxRevisions: 1,
      coordinator: {
        role: 'medium-coordinator',
        profile: {
          model: 'claude-sonnet-5',
          effort: 'medium',
          context: 'default',
        },
        evidenceStatus: 'provisional',
      },
      reviewer: {
        role: 'medium-review',
        profile: {
          model: 'claude-sonnet-5',
          effort: 'medium',
          context: 'default',
        },
        evidenceStatus: 'provisional',
      },
      workerCandidate: {
        role: 'cheap-worker',
        enabled: false,
        profile: {
          model: 'gpt-5-mini',
          effort: 'medium',
          context: 'default',
        },
        evidenceStatus: 'disabled',
        authority: 'staging-only',
      },
      repositoryApply: { authority: 'operator', enabled: false },
    },
    conditionalProfiles: [],
    phases: [{
      id: 'coordinate',
      kind: 'medium-coordinator',
      profileRef: 'coordinator',
    }],
    rationale: 'Fixture routing policy.',
  };
}

function opportunityPolicy(opportunities = [opportunity()]) {
  return {
    version: 3,
    project: 'fixture',
    qualification: {
      status: 'provisional',
      minimumUnattendedCases: 30,
      automaticApplication: false,
    },
    triggerCatalog: [{
      id: 'fixture-critical-review',
      category: 'critical-review',
      description: 'Fixture-only critical review trigger.',
    }],
    opportunities,
  };
}

function repository(t) {
  const root = makeScratch('learning-repository-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/item.ts'), 'export {};\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base fixture']);
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/agent-learning.json'),
    JSON.stringify(policy()));
  fs.writeFileSync(path.join(root, '.github/agent-budget.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    learningPolicy: '.github/agent-learning.json',
    opportunityPolicy: '.github/agent-opportunities.json',
    toolRegistry: '.github/agent-tools.json',
    opportunityEvaluation: '.github/opportunity-evaluation.json',
    workerEvaluation: '.github/worker-evaluation.json',
    instructions: ['README.md'],
    riskTerms: [],
    gates: ['fixture'],
  }));
  fs.writeFileSync(path.join(root, '.github/agent-tools.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    tools: [{
      id: 'fixture-validator',
      kind: 'command',
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd: '.',
      timeoutSeconds: 30,
      sideEffect: 'none',
      environment: [],
    }],
  }));
  fs.writeFileSync(path.join(root, '.github/agent-opportunities.json'),
    JSON.stringify(opportunityPolicy()));
  fs.writeFileSync(path.join(root, '.github/opportunity-evaluation.json'),
    JSON.stringify({ qualificationStatus: 'provisional' }));
  fs.writeFileSync(path.join(root, '.github/worker-evaluation.json'),
    JSON.stringify({ qualificationStatus: 'provisional' }));
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'learning policy']);
  return root;
}

function repositoryHash(root) {
  const effective = readEffectiveProjectPolicy(root);
  return logicalRepositoryIdentity(root, effective.adapter.project).repositoryHash;
}

function runHook(root, home, event, payload) {
  return spawnSync(process.execPath, [script.pathname, event], {
    cwd: root,
    env: { ...process.env, COPILOT_HOME: home },
    input: JSON.stringify({ cwd: root, ...payload }),
    encoding: 'utf8',
  });
}

test('sanitization hashes private payloads, normalizes milliseconds, and infers risk', t => {
  const root = repository(t);
  const secret = 'SECRET_fixture_private_value';
  const record = sanitizeHookEvent('post-tool-use-failure', {
    cwd: root,
    sessionId: 'raw-session-id',
    timestamp: 1788966000000,
    toolName: 'bash',
    toolArgs: {
      command: `curl -H Token:${secret}`,
      env: { TOKEN: secret },
      targetPath: path.join(root, 'secrets/private.ts'),
    },
    result: secret,
    error: secret,
  }, {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'a'.repeat(40),
  });
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /SECRET_fixture_private_value|raw-session-id|curl|-H|Token/);
  assert.equal(record.timestamp, new Date(1788966000000).toISOString());
  assert.equal(record.resultHash, sha256(secret));
  assert.equal(record.resultBytes, Buffer.byteLength(secret));
  assert.equal(record.errorHash, sha256(secret));
  assert.equal(record.errorBytes, Buffer.byteLength(secret));
  assert.equal(record.sideEffectClass, 'external');
  assert.equal(record.riskClass, 'external-or-destructive-command');
  assert.equal(record.commandHash, sha256(`curl -H Token:${secret}`));
  assert.equal(typeof record.commandShapeHash, 'string');
  assert.equal(record.excludedPath, true);
  const mixed = sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'mixed-paths',
    timestamp: 1788966000001,
    toolName: 'edit',
    toolArgs: {
      path: path.join(root, 'src/item.ts'),
      targetPath: path.join(root, 'README.md'),
    },
  }, {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'a'.repeat(40),
  });
  assert.equal(mixed.eligiblePath, false);
  const opaqueEdit = sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'opaque-edit',
    timestamp: 1788966000002,
    toolName: 'apply_patch',
    toolArgs: 'private free-form patch',
  }, {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'a'.repeat(40),
  });
  assert.equal(opaqueEdit.pathEvidenceComplete, false);
  assert.equal(opaqueEdit.eligiblePath, false);

  const nestedResult = 'nested official private result';
  const official = sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'official-result',
    timestamp: 1788966000003,
    toolName: 'view',
    toolArgs: { path: path.join(root, 'src/item.ts') },
    toolResult: { textResultForLlm: nestedResult },
  }, {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'a'.repeat(40),
  });
  assert.equal(official.resultHash, sha256(nestedResult));
  assert.equal(official.resultBytes, Buffer.byteLength(nestedResult));
  assert.doesNotMatch(JSON.stringify(official), /nested official private result/);
});

test('safe local shell commands are distinguishable while unknown commands stay gated', t => {
  const root = repository(t);
  const options = {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'a'.repeat(40),
  };
  const status = sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'commands',
    timestamp: 1788966000000,
    toolName: 'bash',
    toolArgs: { command: 'git status --short' },
  }, options);
  const diff = sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'commands',
    timestamp: 1788966000001,
    toolName: 'bash',
    toolArgs: { command: 'git diff --check' },
  }, options);
  assert.equal(status.sideEffectClass, 'none');
  assert.equal(status.riskClass, null);
  assert.equal(status.eligiblePath, true);
  assert.equal(status.pathEvidenceComplete, true);
  assert.notEqual(status.commandHash, diff.commandHash);
  assert.notEqual(status.commandShapeHash, diff.commandShapeHash);
  assert.notEqual(status.operationSignature, diff.operationSignature);
  const unknown = sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'commands',
    timestamp: 1788966000002,
    toolName: 'bash',
    toolArgs: { command: 'custom-maintenance --all' },
  }, options);
  assert.equal(unknown.sideEffectClass, 'external');
  assert.equal(unknown.riskClass, 'opaque-command');
  assert.equal(unknown.eligiblePath, false);

  const repeated = [];
  for (const index of [1, 2, 3]) {
    const workflowId = `safe-command-workflow-${index}`;
    const sessionId = `safe-command-session-${index % 2}`;
    for (const [offset, command] of [
      [0, 'git status --short'],
      [1, 'git diff --check'],
    ]) {
      repeated.push(sanitizeHookEvent('post-tool-use', {
        cwd: root,
        sessionId,
        timestamp: 1788966010000 + index * 100 + offset,
        toolName: 'bash',
        toolArgs: { command },
      }, {
        ...options,
        workflowId,
        opportunityId: 'fixture',
      }));
    }
    repeated.push(sanitizeHookEvent('agent-stop', {
      cwd: root,
      sessionId,
      timestamp: 1788966010000 + index * 100 + 2,
    }, {
      ...options,
      workflowId,
      opportunityId: 'fixture',
    }));
  }
  const candidate = mineCandidates(repeated, policy(), {
    opportunityId: 'fixture',
  });
  assert.equal(candidate.decision, 'candidate');
  assert.equal(candidate.candidate.class, 'deterministic-tool');
  assert.equal(candidate.candidate.sideEffectClass, 'none');
});

test('three prompts in two sessions create three workflow identities', t => {
  const root = repository(t);
  const home = path.join(root, 'home');
  const first = beginPromptWorkflow(root, {
    sessionId: 'one',
    timestamp: 1788966000000,
    prompt: 'first private prompt',
    opportunityId: 'fixture',
  }, { home, adapter: { project: 'fixture' } });
  const second = beginPromptWorkflow(root, {
    sessionId: 'one',
    timestamp: 1788966001000,
    prompt: 'second private prompt',
    opportunityId: 'fixture',
  }, { home, adapter: { project: 'fixture' } });
  const third = beginPromptWorkflow(root, {
    sessionId: 'two',
    timestamp: 1788966002000,
    prompt: 'third private prompt',
    opportunityId: 'fixture',
  }, { home, adapter: { project: 'fixture' } });
  assert.equal(new Set([first.workflowId, second.workflowId, third.workflowId]).size, 3);
  assert.notEqual(first.promptHash, second.promptHash);
  assert.equal(first.promptBytes, Buffer.byteLength('first private prompt'));
});

test('planner CLI binds the unique recent prompt hash without a session environment', t => {
  const root = repository(t);
  const home = path.join(root, 'home');
  fs.writeFileSync(path.join(root, '.github/agent-opportunities.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    qualification: {
      status: 'provisional',
      caseCountPerOpportunity: 3,
      minimumPromotionCases: 30,
      automaticApplication: false,
    },
    opportunities: [{
      id: 'fixture',
      label: 'Fixture',
      triggers: ['exact planner prompt'],
      strategy: 'deterministic-owner',
      evidence: 'repository',
      primary: { model: 'gpt-5.6-sol', effort: 'medium', context: 'default' },
      skills: [],
      tools: ['fixture-validator'],
      gates: ['fixture'],
      authorization: 'none',
      rationale: 'Fixture.',
    }],
  }));
  const question = 'Use the exact planner prompt';
  const now = Date.now();
  assert.equal(runHook(root, home, 'user-prompt-submitted', {
    sessionId: 'planner-session',
    timestamp: now,
    prompt: question,
  }).status, 0);
  const taskFile = path.join(root, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify({ question }));
  const env = { ...process.env, COPILOT_HOME: home };
  delete env.COPILOT_SESSION_ID;
  const planned = spawnSync(process.execPath,
    [plannerScript.pathname, 'plan', root, taskFile], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).opportunity, 'fixture');
  runHook(root, home, 'post-tool-use', {
    sessionId: 'planner-session',
    timestamp: now + 1,
    toolName: 'view',
    toolArgs: { path: path.join(root, 'src/item.ts') },
  });
  assert.equal(readRepositoryEvents(home, repositoryHash(root)).at(-1).opportunityId,
    'fixture');
});

test('duplicate planner binding fails closed while exact opportunity hints remain', t => {
  const root = repository(t);
  const home = path.join(root, 'home');
  fs.writeFileSync(path.join(root, '.github/agent-opportunities.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    qualification: {
      status: 'provisional',
      caseCountPerOpportunity: 3,
      minimumPromotionCases: 30,
      automaticApplication: false,
    },
    opportunities: [{
      id: 'fixture',
      label: 'Fixture',
      triggers: ['duplicate planner prompt'],
      strategy: 'deterministic-owner',
      evidence: 'repository',
      primary: { model: 'gpt-5.6-sol', effort: 'medium', context: 'default' },
      skills: [],
      tools: ['fixture-validator'],
      gates: ['fixture'],
      authorization: 'none',
      rationale: 'Fixture.',
    }],
  }));
  const question = 'Use the duplicate planner prompt';
  const now = Date.now();
  for (const sessionId of ['duplicate-one', 'duplicate-two']) {
    runHook(root, home, 'user-prompt-submitted', {
      sessionId,
      timestamp: now,
      prompt: question,
    });
  }
  const taskFile = path.join(root, 'task-duplicate.json');
  fs.writeFileSync(taskFile, JSON.stringify({ question }));
  const env = { ...process.env, COPILOT_HOME: home };
  delete env.COPILOT_SESSION_ID;
  const planned = spawnSync(process.execPath,
    [plannerScript.pathname, 'plan', root, taskFile], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  assert.equal(planned.status, 0, planned.stderr);
  for (const sessionId of ['duplicate-one', 'duplicate-two']) {
    runHook(root, home, 'post-tool-use', {
      sessionId,
      timestamp: now + 1,
      toolName: 'view',
      toolArgs: { path: path.join(root, 'src/item.ts') },
    });
  }
  const toolEvents = readRepositoryEvents(home, repositoryHash(root))
    .filter(event => event.eventKind === 'post-tool-use');
  assert.equal(toolEvents.length, 2);
  assert.ok(toolEvents.every(event => event.opportunityId === 'fixture'));
});

test('official hook CLI blocks once with top-level camelCase output and exit zero', t => {
  const root = repository(t);
  const home = path.join(root, 'home');
  const workflows = [
    { sessionId: 'session-one', prompt: 'one', timestamp: 1788966000000 },
    { sessionId: 'session-one', prompt: 'two', timestamp: 1788966010000 },
    { sessionId: 'session-two', prompt: 'three', timestamp: 1788966020000 },
  ];
  let blocked;
  for (const [index, workflow] of workflows.entries()) {
    const prompt = runHook(root, home, 'user-prompt-submitted', {
      ...workflow,
    });
    assert.equal(prompt.status, 0);
    assert.equal(prompt.stdout, '{}');
    const planFile = path.join(root, `plan-${index}.json`);
    fs.writeFileSync(planFile, JSON.stringify({
      version: 3,
      project: 'fixture',
      opportunity: 'fixture',
      status: 'ready',
      enabled: true,
      pipelineHash: sha256(`pipeline-${index}`),
    }));
    const binding = spawnSync(process.execPath, [
      script.pathname,
      'bind-workflow',
      root,
      workflow.sessionId,
      'fixture',
      planFile,
    ], {
      cwd: root,
      env: { ...process.env, COPILOT_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(binding.status, 0, binding.stderr);
    assert.equal(JSON.parse(binding.stdout).opportunityId, 'fixture');
    for (const [toolName, offset] of [['view', 1], ['glob', 2]]) {
      const tool = runHook(root, home, 'post-tool-use', {
        sessionId: workflow.sessionId,
        timestamp: workflow.timestamp + offset,
        toolName,
        toolArgs: toolName === 'view'
          ? { path: path.join(root, 'src/item.ts') }
          : { pattern: '*.ts', paths: path.join(root, 'src') },
        result: 'private result',
      });
      assert.equal(tool.status, 0);
      assert.equal(tool.stdout, '{}');
    }
    const stop = runHook(root, home, 'agent-stop', {
      sessionId: workflow.sessionId,
      timestamp: workflow.timestamp + 3,
    });
    assert.equal(stop.status, 0);
    if (index < 2) assert.equal(stop.stdout, '{}');
    else blocked = JSON.parse(stop.stdout);
  }
  assert.deepEqual(Object.keys(blocked).sort(), ['decision', 'reason']);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /prepare-candidate/);
  assert.match(blocked.reason, /medium-coordinator/);
  assert.doesNotMatch(JSON.stringify(blocked), /hookSpecificOutput/);
  const candidatesRoot = path.join(home, 'learning', repositoryHash(root), 'candidates');
  const candidateId = fs.readdirSync(candidatesRoot)[0];
  const prepare = spawnSync(process.execPath,
    [script.pathname, 'prepare-candidate', root, candidateId], {
      cwd: root,
      env: { ...process.env, COPILOT_HOME: home },
      encoding: 'utf8',
    });
  assert.equal(prepare.status, 0, prepare.stderr);
  const prepared = JSON.parse(prepare.stdout);
  assert.equal(prepared.ledger.status, 'incubating');
  assert.equal(fs.statSync(path.join(prepared.directory, 'BUILD.md')).isFile(), true);
  const evidenceUnsigned = {
    version: 1,
    kind: 'candidate-project-validation',
    candidateId,
    passed: true,
    validatorIds: ['fixture-validator'],
  };
  const evidenceFile = path.join(root, 'validation-receipt.json');
  fs.writeFileSync(evidenceFile, JSON.stringify({
    ...evidenceUnsigned,
    evidenceHash: sha256(evidenceUnsigned),
  }));
  const recorded = spawnSync(process.execPath, [
    script.pathname,
    'record-evidence',
    root,
    candidateId,
    'project-validation',
    evidenceFile,
  ], {
    cwd: root,
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(JSON.parse(recorded.stdout).evidence['project-validation'],
    sha256(evidenceUnsigned));

  const forcedPrompt = runHook(root, home, 'user-prompt-submitted', {
    sessionId: 'session-two',
    timestamp: 1788966030000,
    prompt: blocked.reason,
  });
  assert.equal(forcedPrompt.status, 0);
  const forcedStop = runHook(root, home, 'agent-stop', {
    sessionId: 'session-two',
    timestamp: 1788966031000,
  });
  assert.equal(forcedStop.status, 0);
  assert.equal(forcedStop.stdout, '{}');
  const guarded = runHook(root, home, 'agent-stop', {
    sessionId: 'session-two',
    timestamp: 1788966032000,
    stop_hook_active: true,
  });
  assert.equal(guarded.status, 0);
  assert.equal(guarded.stdout, '{}');
});

test('disabled opportunity plans cannot bind or trigger incubation', t => {
  const root = repository(t);
  const home = path.join(root, 'home');
  runHook(root, home, 'user-prompt-submitted', {
    sessionId: 'disabled',
    timestamp: 1788966000000,
    prompt: 'disabled workflow',
  });
  const planFile = path.join(root, 'disabled-plan.json');
  fs.writeFileSync(planFile, JSON.stringify({
    version: 3,
    project: 'fixture',
    opportunity: 'fixture',
    status: 'disabled',
    enabled: false,
  }));
  const binding = spawnSync(process.execPath, [
    script.pathname,
    'bind-workflow',
    root,
    'disabled',
    'fixture',
    planFile,
  ], {
    cwd: root,
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(binding.status, 1);
  assert.match(binding.stderr, /ready enabled/);
});

test('no reusable opportunity remains a silent successful no-op', t => {
  const root = repository(t);
  const home = path.join(root, 'home');
  runHook(root, home, 'user-prompt-submitted', {
    sessionId: 'one',
    timestamp: 1788966000000,
    prompt: 'one-off',
  });
  runHook(root, home, 'post-tool-use', {
    sessionId: 'one',
    timestamp: 1788966000001,
    toolName: 'view',
    toolArgs: { path: path.join(root, 'src/item.ts') },
  });
  const stop = runHook(root, home, 'agent-stop', {
    sessionId: 'one',
    timestamp: 1788966000002,
  });
  assert.equal(stop.status, 0);
  assert.equal(stop.stdout, '{}');
});

test('sessionEnd reasons distinguish accepted, rejected and failed outcomes', t => {
  const root = repository(t);
  const base = {
    cwd: root,
    sessionId: 'outcomes',
    timestamp: 1788966000000,
  };
  const options = {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'b'.repeat(40),
  };
  assert.equal(sanitizeHookEvent('session-end',
    { ...base, reason: 'completed' }, options).resultClass, 'accepted');
  assert.equal(sanitizeHookEvent('session-end',
    { ...base, reason: 'user_cancelled' }, options).resultClass, 'rejected');
  assert.equal(sanitizeHookEvent('session-end',
    { ...base, reason: 'timeout' }, options).resultClass, 'failed');
});

test('task and subagent events infer model-backed work without options', t => {
  const root = repository(t);
  const options = {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'c'.repeat(40),
  };
  const taskEvent = sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'models',
    timestamp: 1788966000000,
    toolName: 'task',
    toolArgs: { agent_type: 'general-purpose' },
  }, options);
  assert.equal(taskEvent.modelBacked, true);
  assert.equal(taskEvent.modelRole, 'general-purpose');
  const subagent = sanitizeHookEvent('subagent-stop', {
    cwd: root,
    sessionId: 'models',
    timestamp: 1788966000001,
    response: 'private response',
  }, options);
  assert.equal(subagent.modelBacked, true);
  assert.equal(subagent.responseHash, sha256('private response'));
});

test('tampered hashes or parent links fail closed for mining', t => {
  const root = repository(t);
  const home = path.join(root, 'home');
  const first = sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'integrity',
    timestamp: 1788966000000,
    toolName: 'view',
    toolArgs: { path: path.join(root, 'src/item.ts') },
  }, {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'd'.repeat(40),
  });
  const file = appendSanitizedEvent(home, first);
  const second = { ...first, timestamp: new Date(1788966001000).toISOString() };
  second.eventHash = sha256(Object.fromEntries(Object.entries(second)
    .filter(([key]) => key !== 'eventHash')));
  appendSanitizedEvent(home, second);
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  records[1].parentEventHash = '0'.repeat(64);
  fs.writeFileSync(file, `${records.map(canonicalJson).join('\n')}\n`);
  const ledger = readRepositoryEventLedger(home, first.repositoryHash, 100);
  assert.equal(ledger.valid, false);
  assert.equal(ledger.events.length, 0);
  let previous = null;
  const rebound = records.map(record => {
    const { eventHash: ignored, ...base } = record;
    void ignored;
    const unsigned = {
      ...base,
      repositoryHash: sha256('forged-repository'),
      parentEventHash: previous,
    };
    const event = { ...unsigned, eventHash: sha256(unsigned) };
    previous = event.eventHash;
    return event;
  });
  fs.writeFileSync(file, `${rebound.map(canonicalJson).join('\n')}\n`);
  assert.equal(readRepositoryEventLedger(home, first.repositoryHash, 100).valid,
    false);
});

test('retention pruning rechains retained events', t => {
  const root = repository(t);
  const home = path.join(root, 'home');
  const options = {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'e'.repeat(40),
  };
  appendSanitizedEvent(home, sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'retention',
    timestamp: '2026-01-01T00:00:00.000Z',
    toolName: 'view',
    toolArgs: { path: path.join(root, 'src/item.ts') },
  }, options));
  const current = sanitizeHookEvent('agent-stop', {
    cwd: root,
    sessionId: 'retention',
    timestamp: '2026-09-09T00:00:00.000Z',
  }, options);
  appendSanitizedEvent(home, current);
  assert.equal(pruneExpiredEvents(home, current.repositoryHash, 30,
    Date.parse('2026-09-10T00:00:00.000Z')), 1);
  const retained = readRepositoryEvents(home, current.repositoryHash);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].parentEventHash, null);
});

test('bounded analysis verifies thousands of sanitized events', t => {
  const root = repository(t);
  const home = path.join(root, 'home');
  const sample = sanitizeHookEvent('post-tool-use', {
    cwd: root,
    sessionId: 'large',
    timestamp: 1788966000000,
    toolName: 'view',
    toolArgs: { path: path.join(root, 'src/item.ts') },
  }, {
    root,
    policy: policy(),
    adapter: { project: 'fixture' },
    revision: 'f'.repeat(40),
  });
  const directory = path.join(home, 'learning', sample.repositoryHash, 'events');
  fs.mkdirSync(directory, { recursive: true });
  let previous = null;
  const lines = [];
  for (let index = 0; index < 3000; index += 1) {
    const { eventHash: ignored, ...base } = sample;
    void ignored;
    const unsigned = {
      ...base,
      timestamp: new Date(1788966000000 + index).toISOString(),
      parentEventHash: previous,
    };
    const event = { ...unsigned, eventHash: sha256(unsigned) };
    previous = event.eventHash;
    lines.push(canonicalJson(event));
  }
  fs.writeFileSync(path.join(directory, `${sample.sessionId}.jsonl`),
    `${lines.join('\n')}\n`);
  const started = Date.now();
  const ledger = readRepositoryEventLedger(home, sample.repositoryHash, 5000);
  assert.equal(ledger.valid, true);
  assert.equal(ledger.events.length, 3000);
  assert.ok(Date.now() - started < 2000);
  assert.equal(readRepositoryEventLedger(home, sample.repositoryHash, 2000).reason,
    'analysis-event-cap-exceeded');
});

test('candidate ledger and workflow completion persist with integrity', t => {
  const root = repository(t);
  const candidateHome = path.join(root, 'candidate-home');
  const candidate = {
    id: 'candidate-fixture',
    state: 'eligible',
    sourceWorkflowIds: ['workflow-one'],
    selectedPriority: 'fixture-operation',
    requiredValidators: ['fixture-validator'],
    destination: 'tools',
  };
  persistCandidateLedger(root, candidate, {}, { home: candidateHome });
  assert.equal(readCandidateLedger(root, candidate.id, {
    home: candidateHome,
  }).status, 'eligible');
  const file = path.join(candidateHome, 'learning', repositoryHash(root), 'candidates',
    candidate.id, 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  ledger.status = 'forged';
  fs.writeFileSync(file, JSON.stringify(ledger));
  assert.throws(() => readCandidateLedger(root, candidate.id, {
    home: candidateHome,
  }), /integrity/);

  const home = path.join(root, 'completion-home');
  const receipt = createWorkflowCompletionObservation({
    workflowId: 'workflow-complete',
    project: 'fixture',
    opportunityId: 'fixture',
    repositoryHash: repositoryHash(root),
    pipelineHash: sha256('pipeline'),
    verifiedPipelineReceiptHash: sha256('receipt'),
    traceHash: sha256('trace'),
    usageHash: sha256('usage'),
    outcome: 'accepted',
    observedAt: 1788966000000,
  });
  assert.equal(verifyWorkflowCompletionObservation(receipt, receipt), receipt);
  const receiptFile = path.join(root, 'completion.json');
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const result = spawnSync(process.execPath,
    [script.pathname, 'record-completion', root, receiptFile], {
      cwd: root,
      env: { ...process.env, COPILOT_HOME: home },
      encoding: 'utf8',
    });
  assert.equal(result.status, 0, result.stderr);
  const events = readRepositoryEvents(home, repositoryHash(root));
  assert.equal(events.length, 1);
  assert.equal(events[0].eventKind, 'workflow-complete');
  assert.equal(events[0].receiptHash, receipt.receiptHash);
});

test('ambiguous candidate priority must be selected before preparation', t => {
  const root = repository(t);
  const home = path.join(root, 'priority-home');
  const candidate = {
    id: 'candidate-priority',
    state: 'eligible',
    sourceWorkflowIds: ['workflow-one'],
    selectedPriority: null,
    priorityOptions: [
      {
        id: 'first-priority',
        class: 'deterministic-tool',
        validators: ['fixture-validator'],
        destination: 'tools',
        score: 0,
      },
      {
        id: 'second-priority',
        class: 'reusable-skill',
        validators: ['fixture-validator'],
        destination: 'skills',
        score: 0,
      },
    ],
    requiresPrioritySelection: true,
    requiredValidators: [],
    destination: null,
    class: 'no-op',
    forcedClass: null,
    sideEffectClass: 'none',
    operationSignatures: [sha256('one'), sha256('two')],
    evidenceHash: sha256('candidate-priority'),
  };
  persistCandidateLedger(root, candidate, {}, { home });
  const before = spawnSync(process.execPath,
    [script.pathname, 'prepare-candidate', root, candidate.id], {
      cwd: root,
      env: { ...process.env, COPILOT_HOME: home },
      encoding: 'utf8',
    });
  assert.equal(before.status, 1);
  assert.match(before.stderr, /priority must be explicitly selected/);
  const selected = spawnSync(process.execPath, [
    script.pathname,
    'select-priority',
    root,
    candidate.id,
    'second-priority',
  ], {
    cwd: root,
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(selected.status, 0, selected.stderr);
  const ledger = JSON.parse(selected.stdout);
  assert.equal(ledger.candidate.selectedPriority, 'second-priority');
  assert.equal(ledger.candidate.class, 'reusable-skill');
  assert.equal(ledger.candidate.destination, 'skills');
  const prepared = spawnSync(process.execPath,
    [script.pathname, 'prepare-candidate', root, candidate.id], {
      cwd: root,
      env: { ...process.env, COPILOT_HOME: home },
      encoding: 'utf8',
    });
  assert.equal(prepared.status, 0, prepared.stderr);
});

test('old branches load the unique valid default-ref learning policy', t => {
  const root = repository(t);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin',
    'https://example.invalid/fixture/default-ref.git']);
  const policyRevision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/main',
    policyRevision]);
  const alternate = JSON.parse(fs.readFileSync(
    path.join(root, '.github/agent-learning.json'), 'utf8',
  ));
  alternate.retentionDays = 31;
  fs.writeFileSync(path.join(root, '.github/agent-learning.json'),
    JSON.stringify(alternate));
  execFileSync('git', ['-C', root, 'add', '.github/agent-learning.json']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'alternate default']);
  execFileSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/master',
    'HEAD']);
  execFileSync('git', ['-C', root, 'symbolic-ref', 'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main']);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'old-branch',
    `${policyRevision}^`]);
  assert.equal(fs.existsSync(path.join(root, '.github/agent-budget.json')), false);
  assert.equal(findRoot(path.join(root, 'src')), root);
  const effective = readEffectiveProjectPolicy(root);
  assert.equal(effective.adapter.project, 'fixture');
  assert.equal(effective.source.kind, 'git-ref');
  assert.equal(effective.source.ref, 'origin/main');
  assert.equal(effective.source.revision, policyRevision);
  assert.equal(effective.opportunityPolicy.version, 3);
  assert.equal(effective.toolRegistry.project, 'fixture');
  assert.equal(effective.opportunityEvaluationPacket.qualificationStatus,
    'provisional');
  assert.equal(effective.workerEvaluationPacket.qualificationStatus,
    'provisional');
  const event = sanitizeHookEvent('user-prompt-submitted', {
    cwd: root,
    sessionId: 'old',
    timestamp: 1788966000000,
    prompt: 'private',
  }, { root });
  assert.equal(event.policySourceRef, 'origin/main');
  assert.equal(event.policySourceRevision, policyRevision);
  assert.doesNotMatch(JSON.stringify(event), /eligiblePaths|minimumSuccessfulWorkflows/);

  const home = path.join(root, 'old-branch-home');
  const question = 'Run the fixture routing workflow';
  const now = Date.now();
  assert.equal(runHook(root, home, 'user-prompt-submitted', {
    sessionId: 'old-branch-session',
    timestamp: now,
    prompt: question,
  }).status, 0);
  const validated = spawnSync(process.execPath, [
    plannerScript.pathname, 'validate', root,
  ], {
    cwd: root,
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).version, 3);
  const taskFile = path.join(root, 'old-task.json');
  fs.writeFileSync(taskFile, JSON.stringify({ question }));
  const env = { ...process.env, COPILOT_HOME: home };
  delete env.COPILOT_SESSION_ID;
  const planned = spawnSync(process.execPath, [
    plannerScript.pathname, 'plan', root, taskFile,
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).opportunity, 'fixture');
  runHook(root, home, 'post-tool-use', {
    sessionId: 'old-branch-session',
    timestamp: now + 1,
    toolName: 'view',
    toolArgs: { path: path.join(root, 'src/item.ts') },
  });
  assert.equal(readRepositoryEvents(home, repositoryHash(root)).at(-1).opportunityId,
    'fixture');
});

test('current valid policy takes precedence over conflicting fallback refs', t => {
  const root = repository(t);
  const initialSourceHash = readEffectiveProjectPolicy(root).source.sourceHash;
  const fallbackRevision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/main',
    fallbackRevision]);
  const current = JSON.parse(fs.readFileSync(
    path.join(root, '.github/agent-learning.json'), 'utf8',
  ));
  current.retentionDays = 45;
  fs.writeFileSync(path.join(root, '.github/agent-learning.json'),
    JSON.stringify(current));
  const currentOpportunity = opportunityPolicy([
    opportunity('current-route', { triggers: ['current route'] }),
  ]);
  fs.writeFileSync(path.join(root, '.github/agent-opportunities.json'),
    JSON.stringify(currentOpportunity));
  fs.writeFileSync(path.join(root, '.github/worker-evaluation.json'),
    JSON.stringify({
      qualificationStatus: 'provisional',
      evidenceRevision: 2,
    }));
  const effective = readEffectiveProjectPolicy(root);
  assert.equal(effective.source.kind, 'worktree');
  assert.equal(effective.policy.retentionDays, 45);
  assert.equal(effective.workerEvaluationPacket.evidenceRevision, 2);
  assert.notEqual(effective.source.sourceHash, initialSourceHash);
  const taskFile = path.join(root, 'current-task.json');
  fs.writeFileSync(taskFile, JSON.stringify({ question: 'Use the current route' }));
  const planned = spawnSync(process.execPath, [
    plannerScript.pathname, 'plan', root, taskFile,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).opportunity, 'current-route');
});

test('invalid and ambiguous fallback policy sources fail closed', t => {
  const ambiguous = repository(t);
  const mainRevision = execFileSync('git', ['-C', ambiguous, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', ambiguous, 'update-ref', 'refs/remotes/origin/main',
    mainRevision]);
  const changed = JSON.parse(fs.readFileSync(
    path.join(ambiguous, '.github/agent-learning.json'), 'utf8',
  ));
  changed.retentionDays = 31;
  fs.writeFileSync(path.join(ambiguous, '.github/agent-learning.json'),
    JSON.stringify(changed));
  execFileSync('git', ['-C', ambiguous, 'add', '.github/agent-learning.json']);
  execFileSync('git', ['-C', ambiguous, 'commit', '-qm', 'different policy']);
  const masterRevision = execFileSync('git', ['-C', ambiguous, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', ambiguous, 'update-ref', 'refs/remotes/origin/master',
    masterRevision]);
  execFileSync('git', ['-C', ambiguous, 'checkout', '-q', '-b', 'old-ambiguous',
    `${mainRevision}^`]);
  assert.throws(() => readEffectiveProjectPolicy(ambiguous), /ambiguous/);
  const plannerValidation = spawnSync(process.execPath, [
    plannerScript.pathname, 'validate', ambiguous,
  ], { cwd: ambiguous, encoding: 'utf8' });
  assert.equal(plannerValidation.status, 1);
  assert.match(plannerValidation.stderr, /ambiguous/);

  const invalid = repository(t);
  const adapter = JSON.parse(fs.readFileSync(
    path.join(invalid, '.github/agent-budget.json'), 'utf8',
  ));
  delete adapter.learningPolicy;
  fs.writeFileSync(path.join(invalid, '.github/agent-budget.json'),
    JSON.stringify(adapter));
  execFileSync('git', ['-C', invalid, 'add', '.github/agent-budget.json']);
  execFileSync('git', ['-C', invalid, 'commit', '-qm', 'invalid fallback']);
  const invalidRevision = execFileSync('git', ['-C', invalid, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', invalid, 'update-ref', 'refs/remotes/origin/main',
    invalidRevision]);
  execFileSync('git', ['-C', invalid, 'checkout', '-q', '-b', 'old-invalid',
    'HEAD^^']);
  assert.throws(() => readEffectiveProjectPolicy(invalid), /no valid/);
});

test('logical repository identity and ledgers are shared only by the same repository', t => {
  const main = repository(t);
  execFileSync('git', ['-C', main, 'remote', 'add', 'origin',
    'https://token:private@example.invalid/Fixture/Shared.git']);
  const linked = `${main}-linked`;
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'linked', linked]);
  const unrelated = repository(t);
  execFileSync('git', ['-C', unrelated, 'remote', 'add', 'origin',
    'git@example.invalid:fixture/unrelated.git']);
  assert.equal(repositoryHash(main), repositoryHash(linked));
  assert.notEqual(repositoryHash(main), repositoryHash(unrelated));

  const home = path.join(main, 'shared-home');
  for (const [root, sessionId, prompt] of [
    [main, 'main-session', 'main prompt'],
    [linked, 'linked-session', 'linked prompt'],
  ]) {
    const workflow = beginPromptWorkflow(root, {
      sessionId,
      timestamp: 1788966000000,
      prompt,
    }, { home });
    appendSanitizedEvent(home, sanitizeHookEvent('user-prompt-submitted', {
      cwd: root,
      sessionId,
      timestamp: 1788966000000,
      prompt,
    }, { root, home, workflowState: workflow }));
  }
  assert.equal(readRepositoryEvents(home, repositoryHash(main)).length, 2);
  assert.equal(readRepositoryEvents(home, repositoryHash(unrelated)).length, 0);

  const shared = {
    id: 'candidate-shared',
    state: 'eligible',
    project: 'fixture',
    opportunityId: 'fixture',
    selectedPriority: 'fixture-operation',
    requiredValidators: ['fixture-validator'],
    destination: 'tools',
    class: 'deterministic-tool',
    sequenceHash: sha256(['one', 'two']),
    operationSignatures: ['one', 'two'],
    sourceWorkflowIds: ['workflow-one'],
    sideEffectClass: 'none',
    evidenceHash: sha256('shared'),
    history: [],
  };
  persistCandidateLedger(main, shared, {}, { home });
  assert.equal(readCandidateLedger(linked, shared.id, { home }).candidate.id,
    shared.id);
  assert.throws(() => readCandidateLedger(unrelated, shared.id, { home }),
    /ENOENT/);
});

test('incubation binds a candidate to one worktree until matching tree evidence', t => {
  const main = repository(t);
  execFileSync('git', ['-C', main, 'remote', 'add', 'origin',
    'https://example.invalid/fixture/incubation.git']);
  const linked = `${main}-incubation-linked`;
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b',
    'incubation-linked', linked]);
  const home = path.join(main, 'incubation-home');
  const candidate = {
    id: 'candidate-incubation',
    state: 'eligible',
    project: 'fixture',
    opportunityId: 'fixture',
    selectedPriority: 'fixture-operation',
    requiredValidators: ['fixture-validator'],
    destination: 'tools',
    class: 'deterministic-tool',
    sequenceHash: sha256(['one', 'two']),
    operationSignatures: ['one', 'two'],
    sourceWorkflowIds: ['workflow-one'],
    sideEffectClass: 'none',
    evidenceHash: sha256('incubation'),
    history: [],
  };
  persistCandidateLedger(main, candidate, {}, { home });
  const prepared = spawnSync(process.execPath, [
    script.pathname, 'prepare-candidate', main, candidate.id,
  ], {
    cwd: main,
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const ledger = readCandidateLedger(linked, candidate.id, { home });
  assert.equal(ledger.incubationBinding.revision,
    execFileSync('git', ['-C', main, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim());

  const integrationUnsigned = {
    version: 1,
    kind: 'candidate-integration',
    candidateId: candidate.id,
    integrated: true,
  };
  const integrationFile = path.join(linked, 'integration.json');
  fs.writeFileSync(integrationFile, JSON.stringify({
    ...integrationUnsigned,
    evidenceHash: sha256(integrationUnsigned),
  }));
  const rejected = spawnSync(process.execPath, [
    script.pathname, 'record-evidence', linked, candidate.id,
    'integration', integrationFile,
  ], {
    cwd: linked,
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /another worktree/);

  const scopeUnsigned = {
    version: 1,
    kind: 'candidate-scope-tree',
    candidateId: candidate.id,
    scopeHash: sha256('scope'),
    treeHash: ledger.incubationBinding.treeHash,
  };
  const scopeFile = path.join(linked, 'scope.json');
  fs.writeFileSync(scopeFile, JSON.stringify({
    ...scopeUnsigned,
    evidenceHash: sha256(scopeUnsigned),
  }));
  const accepted = spawnSync(process.execPath, [
    script.pathname, 'record-evidence', linked, candidate.id,
    'scope-tree', scopeFile,
  ], {
    cwd: linked,
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).validatedWorktrees.length, 1);
});

test('event backfill is private, idempotent, turn-mapped and opportunity hinted', t => {
  const root = repository(t);
  const opportunityFile = path.join(root, '.github/agent-opportunities.json');
  fs.writeFileSync(opportunityFile, JSON.stringify({
    version: 1,
    project: 'fixture',
    opportunities: [{
      id: 'fixture',
      triggers: ['exact backfill trigger'],
    }],
  }));
  const home = path.join(root, 'backfill-home');
  const secret = 'BACKFILL_PRIVATE_SECRET';
  const eventsFile = path.join(root, 'events.jsonl');
  const events = [
    { id: 'start', type: 'session.start', timestamp: 1788966000000,
      data: { context: { cwd: root, gitRoot: root }, repository: 'fixture' } },
    { id: 'prompt', type: 'user.message', timestamp: 1788966000001,
      data: { cwd: root, sessionId: 'raw-private-session', turnId: 'turn-one',
        content: `Use the exact backfill trigger ${secret}` } },
    { id: 'tool-start', type: 'tool.execution_start', timestamp: 1788966000002,
      data: { cwd: root, turnId: 'turn-one', toolCallId: 'call-one',
        toolName: 'view', arguments: { path: path.join(root, 'src/item.ts'),
          private: secret } } },
    { id: 'tool-complete', type: 'tool.execution_complete', timestamp: 1788966000003,
      data: { cwd: root, turnId: 'turn-one', toolCallId: 'call-one',
        success: true, result: secret } },
    { id: 'skill', type: 'skill.invoked', timestamp: 1788966000004,
      data: { cwd: root, turnId: 'turn-one', skillName: `private-${secret}` } },
    { id: 'turn-end', type: 'assistant.turn_end', timestamp: 1788966000005,
      data: { cwd: root, turnId: 'turn-one', success: true, summary: secret } },
    { id: 'complete', type: 'session.task_complete', timestamp: 1788966000006,
      data: { cwd: root, success: true, summary: secret } },
    { id: 'shutdown', type: 'session.shutdown', timestamp: 1788966000007,
      data: { cwd: root, success: false, reason: 'crash', summary: secret } },
  ];
  fs.writeFileSync(eventsFile, `${events.map(JSON.stringify).join('\n')}\n`);
  const first = backfillEvents(root, eventsFile, { home });
  assert.equal(first.processed, 8);
  assert.equal(first.imported, 6);
  assert.equal(first.classifications.prompts, 1);
  assert.equal(first.classifications.tools, 1);
  assert.equal(first.classifications.skills, 1);
  assert.equal(first.classifications.terminals, 3);
  const ledger = readRepositoryEvents(home, repositoryHash(root));
  assert.equal(ledger.length, 6);
  assert.ok(ledger.every(event => event.opportunityId === 'fixture'));
  const tool = ledger.find(event => event.eventKind === 'post-tool-use' &&
    event.toolId === 'view');
  assert.equal(tool.workflowId, ledger[0].workflowId);
  assert.equal(tool.resultHash, sha256(secret));
  assert.ok(ledger.some(event =>
    event.skillIdentityHash === sha256(`private-${secret}`)));
  assert.ok(ledger.some(event => event.resultClass === 'failed'));
  const persisted = fs.readdirSync(path.join(home, 'learning'), {
    recursive: true,
  }).filter(name => typeof name === 'string' &&
    (name.endsWith('.json') || name.endsWith('.jsonl')))
    .map(name => fs.readFileSync(path.join(home, 'learning', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(persisted,
    /BACKFILL_PRIVATE_SECRET|raw-private-session|exact backfill trigger|summary/);
  fs.writeFileSync(eventsFile,
    `${events.map(event => ` ${JSON.stringify(event)} `).join('\n')}\n`);
  const rerun = spawnSync(process.execPath, [
    script.pathname, 'backfill-events', root, eventsFile,
  ], {
    cwd: root,
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });

  assert.equal(rerun.status, 0, rerun.stderr);
  const second = JSON.parse(rerun.stdout);
  assert.equal(second.imported, 0);
  assert.equal(second.deduplicated, 8);
  assert.equal(readRepositoryEvents(home, repositoryHash(root)).length, 6);
});

test('event backfill accepts only enabled privacy-safe opportunity overrides', t => {
  const root = repository(t);
  fs.writeFileSync(path.join(root, '.github/agent-opportunities.json'),
    JSON.stringify(opportunityPolicy([
      opportunity('operator-route', { triggers: ['exact operator route'] }),
      opportunity('exact-route', { triggers: ['unique exact route'] }),
      opportunity('disabled-route', {
        enabled: false,
        triggers: ['disabled route'],
      }),
    ])));
  const home = path.join(root, 'override-home');
  const eventsFile = path.join(root, 'override-events.jsonl');
  const secret = 'OPERATOR_PRIVATE_CLASSIFICATION';
  const events = [
    {
      id: 'override-start',
      type: 'session.start',
      timestamp: 1788966000000,
      data: { context: { cwd: root, gitRoot: root } },
    },
    {
      id: 'override-prompt',
      type: 'user.message',
      timestamp: 1788966000001,
      data: {
        cwd: root,
        sessionId: 'private-override-session',
        turnId: 'override-turn',
        content: `No exact routing phrase is present ${secret}`,
      },
    },
    {
      id: 'override-end',
      type: 'assistant.turn_end',
      timestamp: 1788966000002,
      data: {
        cwd: root,
        turnId: 'override-turn',
        success: true,
      },
    },
    {
      id: 'exact-prompt',
      type: 'user.message',
      timestamp: 1788966000003,
      data: {
        cwd: root,
        sessionId: 'private-override-session',
        turnId: 'exact-turn',
        content: 'Use the unique exact route',
      },
    },
    {
      id: 'exact-end',
      type: 'assistant.turn_end',
      timestamp: 1788966000004,
      data: {
        cwd: root,
        turnId: 'exact-turn',
        success: true,
      },
    },
  ];
  fs.writeFileSync(eventsFile, `${events.map(JSON.stringify).join('\n')}\n`);
  const first = backfillEvents(root, eventsFile, {
    home,
    opportunity: 'operator-route',
  });
  assert.equal(first.imported, 4);
  const ledger = readRepositoryEvents(home, repositoryHash(root));
  assert.equal(ledger.length, 4);
  const supplied = ledger.filter(event =>
    event.opportunityClassificationSupplied === true);
  assert.equal(supplied.length, 2);
  assert.ok(supplied.every(event => event.opportunityId === 'operator-route'));
  assert.ok(supplied.every(event =>
    /^[a-f0-9]{64}$/.test(event.opportunityClassificationHash)));
  const exact = ledger.filter(event =>
    event.opportunityClassificationSupplied === false);
  assert.equal(exact.length, 2);
  assert.ok(exact.every(event => event.opportunityId === 'exact-route'));
  assert.ok(exact.every(event => event.opportunityClassificationHash === null));
  const persisted = fs.readdirSync(path.join(home, 'learning'), {
    recursive: true,
  }).filter(name => typeof name === 'string' &&
    (name.endsWith('.json') || name.endsWith('.jsonl')))
    .map(name => fs.readFileSync(path.join(home, 'learning', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(persisted,
    /OPERATOR_PRIVATE_CLASSIFICATION|private-override-session/);

  const rerun = spawnSync(process.execPath, [
    script.pathname,
    'backfill-events',
    root,
    eventsFile,
    '--opportunity',
    'operator-route',
  ], {
    cwd: root,
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).imported, 0);
  assert.equal(readRepositoryEvents(home, repositoryHash(root)).length, 4);

  for (const id of ['unknown-route', 'disabled-route']) {
    const rejected = spawnSync(process.execPath, [
      script.pathname,
      'backfill-events',
      root,
      eventsFile,
      '--opportunity',
      id,
    ], {
      cwd: root,
      env: { ...process.env, COPILOT_HOME: path.join(root, `${id}-home`) },
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr,
      id === 'unknown-route' ? /unknown/ : /disabled/);
  }
});

test('learning policy and installed hook enforce automatic build without promotion', () => {
  const validated = validateLearningPolicy(policy(), 'fixture');
  assert.equal(validated.automaticBuild, true);
  assert.equal(validated.automaticPromotion, false);
  assert.throws(() => validateLearningPolicy({
    ...policy(),
    automaticPromotion: true,
  }, 'fixture'), /Automatic promotion remains disabled/);
  const hook = JSON.parse(fs.readFileSync(new URL(
    '../hooks/continuous-improvement.json',
    import.meta.url,
  ), 'utf8'));
  assert.deepEqual(Object.keys(hook.hooks).sort(), [
    'agentStop',
    'postToolUse',
    'postToolUseFailure',
    'sessionEnd',
    'subagentStop',
    'userPromptSubmitted',
  ]);
  for (const entries of Object.values(hook.hooks)) {
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'command');
    assert.match(entries[0].bash, /continuous-improvement\.mjs/);
  }
});
