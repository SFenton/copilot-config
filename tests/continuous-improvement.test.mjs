import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeScratch } from './helpers/scratch.mjs';
import {
  appendSanitizedEvent,
  beginPromptWorkflow,
  createWorkflowCompletionObservation,
  persistCandidateLedger,
  pruneExpiredEvents,
  readCandidateLedger,
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

function repository(t) {
  const root = makeScratch('learning-repository-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/agent-learning.json'),
    JSON.stringify(policy()));
  fs.writeFileSync(path.join(root, '.github/agent-budget.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    learningPolicy: '.github/agent-learning.json',
    opportunityPolicy: '.github/agent-opportunities.json',
    toolRegistry: '.github/agent-tools.json',
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
  fs.writeFileSync(path.join(root, '.github/agent-opportunities.json'), JSON.stringify({
    version: 3,
    project: 'fixture',
    opportunities: [{
      id: 'fixture',
      team: {
        coordinator: {
          role: 'medium-coordinator',
          profile: { model: 'gpt-5.6-sol', effort: 'medium', context: 'default' },
        },
      },
    }],
  }));
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/item.ts'), 'export {};\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  return root;
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
  assert.equal(readRepositoryEvents(home, sha256(root)).at(-1).opportunityId,
    'fixture');
});

test('planner prompt-hash binding fails closed for duplicate active prompts', t => {
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
  const toolEvents = readRepositoryEvents(home, sha256(root))
    .filter(event => event.eventKind === 'post-tool-use');
  assert.equal(toolEvents.length, 2);
  assert.ok(toolEvents.every(event => event.opportunityId === null));
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
  const candidatesRoot = execFileSync('git', ['-C', root, 'rev-parse', '--git-path',
    'copilot-learning/candidates'], { encoding: 'utf8' }).trim();
  const candidateId = fs.readdirSync(path.resolve(root, candidatesRoot))[0];
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
  const candidate = {
    id: 'candidate-fixture',
    state: 'eligible',
    sourceWorkflowIds: ['workflow-one'],
    selectedPriority: 'fixture-operation',
    requiredValidators: ['fixture-validator'],
    destination: 'tools',
  };
  persistCandidateLedger(root, candidate);
  assert.equal(readCandidateLedger(root, candidate.id).status, 'eligible');
  const file = execFileSync('git', ['-C', root, 'rev-parse', '--git-path',
    `copilot-learning/candidates/${candidate.id}/ledger.json`],
  { encoding: 'utf8' }).trim();
  const ledger = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
  ledger.status = 'forged';
  fs.writeFileSync(path.resolve(root, file), JSON.stringify(ledger));
  assert.throws(() => readCandidateLedger(root, candidate.id), /integrity/);

  const home = path.join(root, 'completion-home');
  const receipt = createWorkflowCompletionObservation({
    workflowId: 'workflow-complete',
    project: 'fixture',
    opportunityId: 'fixture',
    repositoryHash: sha256(root),
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
  const events = readRepositoryEvents(home, sha256(root));
  assert.equal(events.length, 1);
  assert.equal(events[0].eventKind, 'workflow-complete');
  assert.equal(events[0].receiptHash, receipt.receiptHash);
});

test('ambiguous candidate priority must be selected before preparation', t => {
  const root = repository(t);
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
  persistCandidateLedger(root, candidate);
  const before = spawnSync(process.execPath,
    [script.pathname, 'prepare-candidate', root, candidate.id], {
      cwd: root,
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
      encoding: 'utf8',
    });
  assert.equal(prepared.status, 0, prepared.stderr);
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
