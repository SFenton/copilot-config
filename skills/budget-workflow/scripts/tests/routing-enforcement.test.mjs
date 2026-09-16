import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authorizeIntentAcceptanceReceipt,
  authorizeOperatorOverride,
  authorizeResearchReceipt,
  clearSessionState,
  createBoundReasonOnlyLeafRequest,
  createDispatchManifest,
  effectiveRoutingMode,
  hookDecision,
  manifestFromActivePrompt,
  projectedFrontierReduction,
  promptStartState,
  resolveSessionProfile,
  routingStatus,
  routingStatusCurrent,
  setRoutingMode,
  writeControlArtifactCurrent,
} from '../routing-enforcement.mjs';
import { validateReleaseMachineV3 } from '../release-machine.mjs';
import { validateOpportunityPolicyV3 } from '../team-pipeline.mjs';
import { planHistoryQuery } from '../evidence/history.mjs';
import {
  createEvidencePacketReceipt,
  createTandemPairReceipt,
  buildFrozenEvidencePacket,
  sha256,
} from '../evidence/schemas.mjs';
import { buildIntentAcceptancePacket } from '../intent-acceptance.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const ROUTING_SCRIPT = fileURLToPath(new URL('../routing-enforcement.mjs', import.meta.url));
const SCRIPT_DIR = path.dirname(ROUTING_SCRIPT);
const RESEARCH_SCRIPT = path.join(SCRIPT_DIR, 'evidence', 'research.mjs');
const RUN_LEAF_SCRIPT = path.join(SCRIPT_DIR, 'run-leaf.mjs');
const OPPORTUNITIES_SCRIPT = path.join(SCRIPT_DIR, 'opportunities.mjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSessionEvents(home, sessionId, model, effort = 'medium', context = 'default') {
  const file = path.join(home, 'session-state', sessionId, 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const events = [
    {
      type: 'session.start',
      data: {
        sessionId,
        selectedModel: model,
        reasoningEffort: effort,
        contextTier: context,
      },
    },
  ];
  fs.writeFileSync(file, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}

function appendSessionEvent(home, sessionId, event) {
  const file = path.join(home, 'session-state', sessionId, 'events.jsonl');
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function fileMode(file) {
  return fs.statSync(file).mode & 0o777;
}

function assertPrivateMode(file, expected) {
  if (process.platform !== 'win32') assert.equal(fileMode(file), expected);
}

function makeRepo(root, project = 'test-project') {
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.mkdirSync(path.join(root, 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'copilot-instructions.md'), '# test\n');
  fs.writeFileSync(path.join(root, 'api', 'example.ts'), 'export const value = 1;\n');
  writeJson(path.join(root, '.github', 'agent-budget.json'), {
    version: 1,
    project,
    instructions: ['.github/copilot-instructions.md'],
    riskTerms: ['risk'],
    gates: ['gate'],
  });
}

function makeToolRegistry(project = 'test-project') {
  return {
    version: 1,
    project,
    tools: [
      {
        id: 'unit-tests',
        kind: 'command',
        argv: ['npm', 'test'],
        cwd: '.',
        timeoutSeconds: 30,
        sideEffect: 'workspace',
        environment: [],
      },
      {
        id: 'release-disabled',
        kind: 'disabled',
        reason: 'disabled',
        sideEffect: 'production',
        environment: [],
      },
    ],
  };
}

function cheapWorkerPlan(overrides = {}) {
  const worker = {
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
  const plan = {
    status: 'ready',
    opportunity: 'focused-tests',
    planHash: overrides.planHash ?? sha256('plan'),
    pipelineHash: overrides.pipelineHash ?? sha256('pipeline'),
    variant: overrides.variant ?? null,
    team: {
      id: 'team',
      trustTier: 'provisional-staging',
      maxRevisions: 1,
      workerCandidate: worker,
      ...(overrides.team ?? {}),
    },
  };
  return { ...plan, ...overrides, team: plan.team };
}

const AUTOMATIC_TASK_IDENTITIES = Object.freeze({
  'history-reader': {
    name: 'automatic-history-reader',
    description: 'Run the exact automatic history lookup',
    model: 'gpt-5.4-mini',
    effort: 'low',
    context: 'default',
  },
  'history-auditor': {
    name: 'automatic-history-auditor',
    description: 'Run the exact automatic history audit',
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
  },
  'host-diagnostics-reader': {
    name: 'automatic-host-diagnostics-reader',
    description: 'Run the exact read-only host diagnostics route',
    model: 'gpt-5.4-mini',
    effort: 'low',
    context: 'default',
  },
  'repository-reader': {
    name: 'automatic-repository-reader',
    description: 'Inspect the current repository with exact read-only tools',
    model: 'gpt-5.4-mini',
    effort: 'low',
    context: 'default',
  },
  'external-evidence-reader': {
    name: 'automatic-external-evidence-reader',
    description: 'Collect exact read-only external evidence',
    model: 'gpt-5.4-mini',
    effort: 'low',
    context: 'default',
  },
  'evidence-curator': {
    name: 'automatic-evidence-curator',
    description: 'Prepare the exact bounded tandem evidence packet',
    model: 'gpt-5.4-mini',
    effort: 'low',
    context: 'default',
  },
});

function automaticTaskArgs(role, prompt, overrides = {}) {
  const profile = AUTOMATIC_TASK_IDENTITIES[role];
  assert(profile, `Unknown automatic task role: ${role}`);
  return {
    name: profile.name,
    description: profile.description,
    prompt,
    model: profile.model,
    agent_type: 'general-purpose',
    context_tier: profile.context,
    reasoning_effort: profile.effort,
    ...overrides,
  };
}

function automaticChildPayload({ sessionId, parentSessionId, parentState, role, prompt, agentId = 'auto-child-1' }) {
  const profile = AUTOMATIC_TASK_IDENTITIES[role];
  assert(profile, `Unknown automatic child role: ${role}`);
  return {
    sessionId,
    prompt,
    selectedModel: profile.model,
    reasoningEffort: profile.effort,
    contextTier: profile.context,
    parentSessionId,
    parentWorkflowId: parentState.workflowId,
    parentPromptHash: parentState.promptHash,
    agentId,
  };
}

function makePacket({
  workflowId,
  promptHash,
  mode = 'repository',
  scope = ['api'],
  repositoryRoot = null,
  baseRevision = 'abc123',
  policyHash = sha256('policy'),
  createdAt = new Date().toISOString(),
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
} = {}) {
  return buildFrozenEvidencePacket({
    workflowId,
    promptHash,
    question: 'How should the validator behave?',
    mode,
    scope,
    repository: mode === 'external' || mode === 'history'
      ? null
      : {
        root: repositoryRoot,
        baseRevision,
        policyHash,
      },
    sourceCatalog: [{
      id: mode === 'history' ? 'h_hs_01' : 'r_api',
      kind: mode === 'history' ? 'history' : 'repository',
      ...(mode === 'history'
        ? {
          templateId: 'recent-sessions',
          sessionRef: 'hs_01',
          summary: 'Earlier validation session',
          occurredAt: new Date().toISOString(),
          queryHash: sha256('select'),
        }
        : {
          path: 'api/example.ts',
          start: 1,
          end: 1,
          sha256: sha256('export const value = 1;\n'),
          openedAt: new Date().toISOString(),
          completeUnit: true,
        }),
    }],
    excerpts: [{
      sourceId: mode === 'history' ? 'h_hs_01' : 'r_api',
      citation: mode === 'history'
        ? {
          kind: 'history',
          sessionRef: 'hs_01',
          templateId: 'recent-sessions',
          snippetId: 'h_hs_01:summary',
        }
        : {
          kind: 'repository',
          path: 'api/example.ts',
          start: 1,
          end: 1,
        },
      text: mode === 'history'
        ? 'Summary: earlier validation approach'
        : '1: export const value = 1;',
      textHash: mode === 'history'
        ? sha256('Summary: earlier validation approach')
        : sha256('1: export const value = 1;'),
    }],
    createdAt,
    expiresAt,
  });
}

function makeFrontierRequest({ home, repo, sessionId, role = 'frontier-research', tandem = false }) {
  const state = promptStartState({
    sessionId,
    prompt: tandem ? '/tandem-research compare approaches' : 'receipt-bound packet research',
    intent: {
      researchMode: 'repository',
      tandemRequested: tandem,
    },
  }, { home });
  const packet = makePacket({
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    repositoryRoot: repo,
  });
  const packetReceipt = createEvidencePacketReceipt(packet);
  const frontierReceipt = authorizeResearchReceipt({
    sessionId,
    promptHash: state.promptHash,
    role,
    evidencePacket: packet,
    evidencePacketReceiptHash: packetReceipt.receiptHash,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { home });
  return { state, packet, packetReceipt, frontierReceipt };
}

function registerCurrentChildAgent({
  home,
  repo,
  parentSessionId,
  childSessionId,
  agentId = 'child-agent-1',
}) {
  writeSessionEvents(home, parentSessionId, 'gpt-5.6-sol', 'max');
  const parentState = promptStartState({
    sessionId: parentSessionId,
    prompt: 'delegate bounded worker',
  }, { home });
  const created = manifestFromActivePrompt({
    sessionId: parentSessionId,
    repository: repo,
    scope: ['api'],
    role: 'cheap-worker',
    agentType: 'task',
    model: 'mai-code-1.1-flash',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['repository-read', 'tests'],
    validations: ['node --test api/example.test.mjs'],
    researchAuthorized: false,
    taskPromptBody: 'Run the exact bounded worker plan.',
    plan: cheapWorkerPlan(),
  }, { home });
  const childState = promptStartState({
    sessionId: childSessionId,
    prompt: created.taskPrompt,
    selectedModel: 'mai-code-1.1-flash',
    reasoningEffort: 'medium',
    contextTier: 'default',
    parentSessionId,
    parentWorkflowId: created.dispatchManifest.workflowId,
    parentPromptHash: created.dispatchManifest.promptHash,
    dispatchManifestHash: created.dispatchManifest.manifestHash,
    agentId,
  }, { home });
  return { parentState, childState, created, agentId };
}

function makeIntentAcceptancePacket({ workflowId, sessionId, promptHash }) {
  return buildIntentAcceptancePacket({
    policyVersion: 'test-policy',
    requirementsManifest: {
      workflowId,
      sessionId,
      promptHash,
      taskMetadata: {
        hasImplementation: true,
        changeClass: 'substantive',
        riskLevel: 'medium',
        surfaceCount: 2,
        repositoryCount: 1,
        uxOrRuntimeBehavior: true,
        safetySensitive: false,
        releaseBound: false,
        deterministicEvidenceSufficient: true,
      },
      scope: ['api', 'tests'],
      requirements: [
        {
          id: 'cover-routing-trust',
          exactText: 'Caller identity must come only from the trusted host hook envelope.',
          displayText: 'Envelope-bound caller identity',
          priority: 'must',
          acceptance: 'Bound helper calls use only the host session envelope.',
          successCondition: true,
        },
        {
          id: 'cover-agent-privacy',
          exactText: 'write_agent targets must stay within current child visibility.',
          displayText: 'Registered child-only messaging',
          priority: 'must',
          acceptance: 'Only registered current children or scope children are allowed.',
          successCondition: true,
        },
      ],
      exclusions: [],
      nonGoals: [],
    },
    selectedProfile: { model: 'gpt-5.4', effort: 'medium', context: 'default' },
    implementationRefs: [
      { id: 'routing-runtime', kind: 'code', label: 'Routing runtime update' },
      { id: 'routing-tests', kind: 'test', label: 'Routing regression updates' },
    ],
    evidenceRefs: [
      { id: 'policy-tests', kind: 'test', summary: 'Routing tests cover envelope and agent policy' },
      { id: 'runtime-observation', kind: 'runtime-observation', summary: 'Hook fixtures confirm protected decisions' },
    ],
    reviewRefs: [
      { id: 'review-acceptance', kind: 'review-acceptance', summary: 'Independent GPT-5.4 review accepted the remediation' },
    ],
    coverageMatrix: [
      {
        requirementId: 'cover-routing-trust',
        implementationIds: ['routing-runtime'],
        evidenceIds: ['policy-tests'],
        summary: 'Helper routing is bound to the host envelope session ID.',
      },
      {
        requirementId: 'cover-agent-privacy',
        implementationIds: ['routing-runtime', 'routing-tests'],
        evidenceIds: ['policy-tests', 'runtime-observation'],
        summary: 'write_agent is limited to current children only.',
      },
    ],
    changeSummary: 'Final routing remediation closes trust, privacy, and durability gaps.',
    reviewAcceptance: {
      role: 'independent-gpt-5.4-review',
      reviewerProfile: { model: 'gpt-5.4', effort: 'medium', context: 'default' },
      acceptanceRefId: 'review-acceptance',
      resolvedFindingRefIds: [],
    },
    knownLimitations: [],
    baseRevision: 'a'.repeat(40),
    baseTreeHash: 'b'.repeat(40),
    acceptedRevision: 'c'.repeat(40),
    acceptedTreeHash: 'd'.repeat(40),
  });
}

test('frontier root sessions deny direct repository/sql/web/edit/shell/browser work', () => {
  const home = makeTempDir('routing-home-');
  const sessionId = '10101010-1010-4010-8010-101010101010';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId, prompt: 'work on repo' }, { home });

  const payload = {
    sessionId,
    cwd: '/tmp',
    toolCalls: [
      { id: 'view', name: 'view', args: { path: '/tmp/file.ts', view_range: [1, 20] } },
      { id: 'rg', name: 'rg', args: { pattern: 'x', paths: ['/tmp'] } },
      { id: 'edit', name: 'apply_patch', args: {} },
      { id: 'sql', name: 'session_store_sql', args: { query: 'select 1' } },
      { id: 'web-search', name: 'web_search', args: { query: 'latest' } },
      { id: 'web-fetch', name: 'web_fetch', args: { url: 'https://example.com' } },
      { id: 'bash', name: 'bash', args: { command: 'npm test' } },
      { id: 'browser', name: 'browser_navigate', args: { url: 'http://localhost' } },
    ],
  };
  const result = hookDecision(payload, { home });
  assert.equal(Object.keys(result).length, 8);
  for (const decision of Object.values(result)) {
    assert.equal(decision.permissionDecision, 'deny');
  }
});

test('protected frontier roots retain control-plane tools but keep data-plane denied', () => {
  const home = makeTempDir('routing-home-');
  const sessionId = 'abcde123-0000-4000-8000-000000000001';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({
    sessionId,
    prompt: '/tandem-research route the packet',
    intent: { researchMode: 'repository', tandemRequested: true },
  }, { home });

  const allowed = hookDecision({
    sessionId,
    cwd: '/tmp',
    toolCalls: [
      { id: 'skill', name: 'skill', args: { skill: 'tandem-research' } },
      { id: 'list-agents', name: 'list_agents', args: {} },
      { id: 'read-agent', name: 'read_agent', args: { agent_id: 'agent-1' } },
      { id: 'write-agent', name: 'write_agent', args: { scope: 'children', message: 'continue' } },
      { id: 'ask-user', name: 'ask_user', args: { prompt: 'ignored' } },
      { id: 'task-complete', name: 'task_complete', args: { summary: 'done' } },
      { id: 'sql', name: 'sql', args: { query: 'select 1', description: 'List todos' } },
      { id: 'schedule-list', name: 'manage_schedule', args: { action: 'list' } },
      { id: 'schedule-stop', name: 'manage_schedule', args: { action: 'stop', id: 7 } },
    ],
  }, { home });
  assert.deepEqual(allowed, {});

  const denied = hookDecision({
    sessionId,
    cwd: '/tmp',
    toolCalls: [
      { id: 'history-sql', name: 'session_store_sql', args: { query: 'select 1' } },
      { id: 'view', name: 'view', args: { path: '/tmp/file.ts', view_range: [1, 1] } },
      { id: 'bash', name: 'bash', args: { command: 'echo nope' } },
      { id: 'schedule-create', name: 'manage_schedule', args: { action: 'create', interval: '5m', prompt: 'nope' } },
    ],
  }, { home });
  assert.equal(Object.keys(denied).length, 4);
  assert.equal(denied['history-sql'].permissionDecision, 'deny');
  assert.equal(denied.view.permissionDecision, 'deny');
  assert.equal(denied.bash.permissionDecision, 'deny');
  assert.match(denied['schedule-create'].permissionDecisionReason, /operator override/);
});

test('non-frontier sessions keep exact-read guard but allow bounded local reads', () => {
  const home = makeTempDir('routing-home-');
  const sessionId = '20202020-2020-4020-8020-202020202020';
  const file = path.join(home, 'big.txt');
  fs.writeFileSync(file, `${Array.from({ length: 420 }, (_, index) => `line ${index + 1}`).join('\n')}\n`);
  writeSessionEvents(home, sessionId, 'gpt-5.4-mini', 'low');
  promptStartState({ sessionId, prompt: 'inspect' }, { home });

  const allowed = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'view',
    toolArgs: { path: file, view_range: [1, 20] },
  }, { home });
  assert.deepEqual(allowed, {});

  const denied = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'view',
    toolArgs: { path: file },
  }, { home });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /exact view_range/);
});

test('hook payloads accept snake_case session, prompt, and intent fields', () => {
  const home = makeTempDir('routing-home-');
  const sessionId = '30303030-3030-4030-8030-303030303030';
  const file = path.join(home, 'small.txt');
  fs.writeFileSync(file, 'ok\n');
  const eventsFile = path.join(home, 'session-state', sessionId, 'events.jsonl');
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.writeFileSync(eventsFile, [
    JSON.stringify({
      type: 'session.start',
      data: {
        sessionId,
        selected_model: 'gpt-5.4-mini',
        reasoning_effort: 'low',
        context_tier: 'default',
      },
    }),
  ].join('\n') + '\n');

  const state = promptStartState({
    session_id: sessionId,
    user_prompt: 'inspect the file',
    intent: {
      history_requested: true,
      packet_workflow_version: 2,
    },
  }, { home });
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.intent.historyRequested, true);

  const decision = hookDecision({
    session_id: sessionId,
    cwd: home,
    tool_name: 'view',
    tool_input: { path: file, view_range: [1, 1] },
  }, { home });
  assert.deepEqual(decision, {});
});

test('status and manifest-from-active-prompt expose only active hashes and create child prompts', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'festival-score-tracker');
  const sessionId = 'abcde123-0000-4000-8000-000000000002';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  const state = promptStartState({
    sessionId,
    prompt: 'route exact worker without leaking raw prompt text',
  }, { home });

  const status = routingStatus({ sessionId }, { home });
  assert.equal(status.active.workflowId, state.workflowId);
  assert.equal(status.active.promptHash, state.promptHash);
  assert.equal(status.active.classification, 'protected-root');
  assert.equal(JSON.stringify(status).includes('route exact worker without leaking raw prompt text'), false);

  const created = manifestFromActivePrompt({
    sessionId,
    repository: repo,
    scope: ['api'],
    role: 'cheap-worker',
    agentType: 'task',
    model: 'mai-code-1.1-flash',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['repository-read', 'tests'],
    validations: ['node --test tests/example.test.mjs'],
    researchAuthorized: false,
    taskPromptBody: 'Run the exact bounded validator tests.',
    plan: cheapWorkerPlan(),
  }, { home });
  assert.equal(created.dispatchManifest.workflowId, state.workflowId);
  assert.match(created.taskPrompt, /budget-dispatch-manifest/);
  assert.match(created.taskPrompt, /budget-child-activation/);
  assert.equal(created.taskPrompt.includes('route exact worker without leaking raw prompt text'), false);
});

test('automatic reader routes accept exact direct tasks and activate scoped children without inline manifests', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'test-project');

  const historySessionId = 'ababab12-0000-4000-8000-000000000001';
  writeSessionEvents(home, historySessionId, 'gpt-5.6-sol', 'max');
  const historyState = promptStartState({
    sessionId: historySessionId,
    cwd: repo,
    prompt: 'Check the "Optimize Vacuum UI Elements" session.',
  }, { home });
  const historyStatus = routingStatusCurrent({ sessionId: historySessionId }, { home });
  assert.equal(historyStatus.active.automaticRoute.role, 'history-reader');
  const historyPrompt = 'Summarize the bounded named-session history findings only.';
  const historyPlan = planHistoryQuery({
    workflowId: historyState.workflowId,
    promptHash: historyState.promptHash,
    question: 'Automatic bounded history lookup',
    templateId: 'named-session-lookup',
    source: 'cloud',
    sessionLabel: 'Optimize Vacuum UI Elements',
    lookbackDays: 30,
    limit: 5,
  });
  assert.deepEqual(hookDecision({
    sessionId: historySessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('history-reader', historyPrompt),
  }, { home }), {});
  const historyChildSessionId = 'ababab12-0000-4000-8000-000000000011';
  const historyChildState = promptStartState(automaticChildPayload({
    sessionId: historyChildSessionId,
    parentSessionId: historySessionId,
    parentState: historyState,
    role: 'history-reader',
    prompt: historyPrompt,
  }), { home });
  assert.equal(historyChildState.classification, 'subagent-active');
  assert.equal(historyChildState.profileSource, 'automatic-route-activation');
  assert.deepEqual(hookDecision({
    sessionId: historyChildSessionId,
    cwd: repo,
    toolName: 'session_store_sql',
    toolArgs: {
      description: 'History lookup',
      query: historyPlan.query,
    },
  }, { home }), {});
  const deniedHistoryQuery = hookDecision({
    sessionId: historyChildSessionId,
    cwd: repo,
    toolName: 'session_store_sql',
    toolArgs: {
      description: 'History lookup',
      query: 'SELECT id FROM sessions LIMIT 1',
    },
  }, { home });
  assert.equal(deniedHistoryQuery.permissionDecision, 'deny');

  const auditSessionId = 'ababab12-0000-4000-8000-000000000002';
  writeSessionEvents(home, auditSessionId, 'gpt-5.6-sol', 'max');
  const auditState = promptStartState({
    sessionId: auditSessionId,
    cwd: repo,
    prompt: 'Provide broad routing and cost history audit attribution.',
  }, { home });
  assert.equal(routingStatusCurrent({ sessionId: auditSessionId }, { home }).active.automaticRoute.role,
    'history-auditor');
  assert.deepEqual(hookDecision({
    sessionId: auditSessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('history-auditor', 'Audit the bounded routing and cost history only.'),
  }, { home }), {});
  const auditChildSessionId = 'ababab12-0000-4000-8000-000000000012';
  const auditChildState = promptStartState(automaticChildPayload({
    sessionId: auditChildSessionId,
    parentSessionId: auditSessionId,
    parentState: auditState,
    role: 'history-auditor',
    prompt: 'Audit the bounded routing and cost history only.',
  }), { home });
  assert.equal(auditChildState.classification, 'subagent-active');
  assert.equal(auditChildState.model, 'gpt-5.4');

  const hostSessionId = 'ababab12-0000-4000-8000-000000000003';
  writeSessionEvents(home, hostSessionId, 'gpt-5.6-sol', 'max');
  const hostState = promptStartState({
    sessionId: hostSessionId,
    cwd: repo,
    prompt: 'Why is swap filled up right now?',
  }, { home });
  assert.equal(routingStatusCurrent({ sessionId: hostSessionId }, { home }).active.automaticRoute.role,
    'host-diagnostics-reader');
  const hostPrompt = 'Run only the exact read-only diagnostics and summarize swap pressure.';
  assert.deepEqual(hookDecision({
    sessionId: hostSessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('host-diagnostics-reader', hostPrompt),
  }, { home }), {});
  const hostChildSessionId = 'ababab12-0000-4000-8000-000000000013';
  const hostChildState = promptStartState(automaticChildPayload({
    sessionId: hostChildSessionId,
    parentSessionId: hostSessionId,
    parentState: hostState,
    role: 'host-diagnostics-reader',
    prompt: hostPrompt,
  }), { home });
  assert.equal(hostChildState.classification, 'subagent-active');
  assert.deepEqual(hookDecision({
    sessionId: hostChildSessionId,
    cwd: repo,
    toolName: 'bash',
    toolArgs: { command: 'uptime' },
  }, { home }), {});
  const deniedHostShell = hookDecision({
    sessionId: hostChildSessionId,
    cwd: repo,
    toolName: 'bash',
    toolArgs: { command: 'echo nope' },
  }, { home });
  assert.equal(deniedHostShell.permissionDecision, 'deny');

  const repoSessionId = 'ababab12-0000-4000-8000-000000000004';
  writeSessionEvents(home, repoSessionId, 'gpt-5.6-sol', 'max');
  const repoState = promptStartState({
    sessionId: repoSessionId,
    cwd: repo,
    prompt: 'Inspect the repo for the validator implementation.',
  }, { home });
  assert.equal(routingStatusCurrent({ sessionId: repoSessionId }, { home }).active.automaticRoute.role,
    'repository-reader');
  const repoPrompt = 'Inspect the repository read-only and summarize the validator implementation.';
  assert.deepEqual(hookDecision({
    sessionId: repoSessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('repository-reader', repoPrompt),
  }, { home }), {});
  const repoChildSessionId = 'ababab12-0000-4000-8000-000000000014';
  const repoChildState = promptStartState(automaticChildPayload({
    sessionId: repoChildSessionId,
    parentSessionId: repoSessionId,
    parentState: repoState,
    role: 'repository-reader',
    prompt: repoPrompt,
  }), { home });
  assert.equal(repoChildState.classification, 'subagent-active');
  assert.deepEqual(hookDecision({
    sessionId: repoChildSessionId,
    cwd: repo,
    toolName: 'view',
    toolArgs: { path: path.join(repo, 'api', 'example.ts'), view_range: [1, 1] },
  }, { home }), {});
  const deniedRepoShell = hookDecision({
    sessionId: repoChildSessionId,
    cwd: repo,
    toolName: 'bash',
    toolArgs: { command: 'uptime' },
  }, { home });
  assert.equal(deniedRepoShell.permissionDecision, 'deny');

  const externalSessionId = 'ababab12-0000-4000-8000-000000000005';
  writeSessionEvents(home, externalSessionId, 'gpt-5.6-sol', 'max');
  const externalState = promptStartState({
    sessionId: externalSessionId,
    cwd: repo,
    prompt: 'Research GitHub sources and browser evidence for this change.',
  }, { home });
  assert.equal(routingStatusCurrent({ sessionId: externalSessionId }, { home }).active.automaticRoute.role,
    'external-evidence-reader');
  const externalPrompt = 'Collect exact read-only external evidence only.';
  assert.deepEqual(hookDecision({
    sessionId: externalSessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('external-evidence-reader', externalPrompt),
  }, { home }), {});
  const externalChildSessionId = 'ababab12-0000-4000-8000-000000000015';
  const externalChildState = promptStartState(automaticChildPayload({
    sessionId: externalChildSessionId,
    parentSessionId: externalSessionId,
    parentState: externalState,
    role: 'external-evidence-reader',
    prompt: externalPrompt,
  }), { home });
  assert.equal(externalChildState.classification, 'subagent-active');
  assert.deepEqual(hookDecision({
    sessionId: externalChildSessionId,
    cwd: repo,
    toolName: 'web_fetch',
    toolArgs: { url: 'https://example.com' },
  }, { home }), {});
  const deniedExternalRepoRead = hookDecision({
    sessionId: externalChildSessionId,
    cwd: repo,
    toolName: 'view',
    toolArgs: { path: path.join(repo, 'api', 'example.ts'), view_range: [1, 1] },
  }, { home });
  assert.equal(deniedExternalRepoRead.permissionDecision, 'deny');
});

test('automatic route task acceptance rejects wrong, second, stale, cross-session, and prompt-mismatched calls', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'test-project');

  const sessionId = 'ababab12-0000-4000-8000-000000000021';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  const state = promptStartState({
    sessionId,
    cwd: repo,
    prompt: 'Check the "Optimize Vacuum UI Elements" session.',
  }, { home });

  const taskPrompt = 'Summarize the bounded named-session history findings only.';
  const wrongModel = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('history-reader', taskPrompt, { model: 'gpt-5.4' }),
  }, { home });
  assert.equal(wrongModel.permissionDecision, 'deny');
  assert.match(wrongModel.permissionDecisionReason, /automatic route task pins/i);

  assert.deepEqual(hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('history-reader', taskPrompt),
  }, { home }), {});

  const secondUse = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('history-reader', taskPrompt),
  }, { home });
  assert.equal(secondUse.permissionDecision, 'deny');
  assert.match(secondUse.permissionDecisionReason, /already consumed/i);

  const mismatchedChildSessionId = 'ababab12-0000-4000-8000-000000000022';
  const mismatchedChildState = promptStartState(automaticChildPayload({
    sessionId: mismatchedChildSessionId,
    parentSessionId: sessionId,
    parentState: state,
    role: 'history-reader',
    prompt: 'Different child prompt that should not activate.',
  }), { home });
  assert.equal(mismatchedChildState.classification, 'subagent-unresolved');
  const mismatchedChildUse = hookDecision({
    sessionId: mismatchedChildSessionId,
    cwd: repo,
    toolName: 'session_store_sql',
    toolArgs: { description: 'History lookup', query: 'SELECT 1' },
  }, { home });
  assert.equal(mismatchedChildUse.permissionDecision, 'deny');

  const crossSessionId = 'ababab12-0000-4000-8000-000000000023';
  writeSessionEvents(home, crossSessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId: crossSessionId, cwd: repo, prompt: 'plain protected root' }, { home });
  const crossSession = hookDecision({
    sessionId: crossSessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('history-reader', taskPrompt),
  }, { home });
  assert.equal(crossSession.permissionDecision, 'deny');
  assert.match(crossSession.permissionDecisionReason, /budget-dispatch-manifest/);

  clearSessionState(sessionId, { home });
  const staleState = promptStartState({
    sessionId,
    cwd: repo,
    prompt: 'plain protected root after resume',
  }, { home });
  assert.equal(staleState.workflowId === state.workflowId, false);
  const stale = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('history-reader', taskPrompt),
  }, { home });
  assert.equal(stale.permissionDecision, 'deny');
  assert.match(stale.permissionDecisionReason, /budget-dispatch-manifest/);
});

test('cli docs, vote_memory, trusted tandem skill metadata, and retired dispatch-current route safely', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'test-project');

  const docsSessionId = 'ababab12-0000-4000-8000-000000000006';
  writeSessionEvents(home, docsSessionId, 'gpt-5.6-sol', 'max');
  promptStartState({
    sessionId: docsSessionId,
    cwd: repo,
    prompt: 'What can Copilot CLI do?',
  }, { home   });

  const lifecycleHome = makeTempDir('routing-home-');
  const lifecycleRepo = makeTempDir('routing-repo-');
  makeRepo(lifecycleRepo, 'test-project');
  execFileSync('git', ['init', '-q', lifecycleRepo]);
  const lifecycleSessionId = '59595959-5959-4959-8959-595959595959';

  const start = spawnSync(process.execPath, [ROUTING_SCRIPT, 'prompt-start'], {
    cwd: lifecycleRepo,
    env: { ...process.env, COPILOT_HOME: lifecycleHome },
    input: JSON.stringify({
      cwd: lifecycleRepo,
      sessionId: lifecycleSessionId,
      prompt: 'start advisory lifecycle only',
      selectedModel: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      contextTier: 'default',
    }),
    encoding: 'utf8',
  });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).sessionId, lifecycleSessionId);

  const sessionDir = path.join(lifecycleHome, 'session-state', lifecycleSessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), '{"type":');
  fs.writeFileSync(path.join(sessionDir, 'usage.json'), '{"totalNanoAiu":');

  const end = spawnSync(process.execPath, [ROUTING_SCRIPT, 'session-end'], {
    cwd: lifecycleRepo,
    env: { ...process.env, COPILOT_HOME: lifecycleHome },
    input: JSON.stringify({
      cwd: lifecycleRepo,
      sessionId: lifecycleSessionId,
      reason: 'completed',
    }),
    encoding: 'utf8',
  });
  assert.equal(end.status, 0, end.stderr);
  const lifecycleResult = JSON.parse(end.stdout);
  assert.equal(lifecycleResult.recorded, true);
  assert.equal(lifecycleResult.complianceRecorded, true);
  assert.equal(lifecycleResult.compliance.runtimeEventStatus, 'invalid');
  assert.equal(lifecycleResult.compliance.usageStatus, 'invalid');
  assert.equal(routingStatusCurrent({ sessionId: docsSessionId }, { home }).active.automaticRoute.role,
    'cli-doc-reader');
  assert.deepEqual(hookDecision({
    sessionId: docsSessionId,
    cwd: repo,
    toolName: 'fetch_copilot_cli_documentation',
    toolArgs: {},
  }, { home }), {});
  assert.deepEqual(hookDecision({
    sessionId: docsSessionId,
    cwd: repo,
    toolName: 'vote_memory',
    toolArgs: { memory_id: 'mem-1', direction: 'up' },
  }, { home }), {});
  const deniedStore = hookDecision({
    sessionId: docsSessionId,
    cwd: repo,
    toolName: 'store_memory',
    toolArgs: { content: 'token sk-secret-value' },
  }, { home });
  assert.equal(deniedStore.permissionDecision, 'deny');
  assert.match(deniedStore.permissionDecisionReason, /mechanically validated/);

  const tandemSessionId = 'ababab12-0000-4000-8000-000000000007';
  writeSessionEvents(home, tandemSessionId, 'gpt-5.6-sol', 'max');
  const tandemState = promptStartState({
    sessionId: tandemSessionId,
    cwd: repo,
    prompt: '<skill-context name="tandem-research">explicit tandem bootstrap</skill-context>',
    invokedSkillName: 'tandem-research',
    eventType: 'skill-context',
  }, { home });
  assert.equal(tandemState.intent.tandemRequested, true);
  const tandemStatus = routingStatusCurrent({ sessionId: tandemSessionId }, { home });
  assert.equal(tandemStatus.active.automaticRoute.role, 'evidence-curator');
  const tandemPrompt = 'Prepare the exact bounded tandem evidence packet only.';
  assert.deepEqual(hookDecision({
    sessionId: tandemSessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: automaticTaskArgs('evidence-curator', tandemPrompt),
  }, { home }), {});

  const copiedSessionId = 'ababab12-0000-4000-8000-000000000024';
  writeSessionEvents(home, copiedSessionId, 'gpt-5.6-sol', 'max');
  const copiedState = promptStartState({
    sessionId: copiedSessionId,
    cwd: repo,
    prompt: '<skill-context name="tandem-research">copied prose only</skill-context>',
  }, { home });
  assert.equal(copiedState.intent.tandemRequested, false);
  assert.equal(routingStatusCurrent({ sessionId: copiedSessionId }, { home }).active.automaticRoute, null);

  const retiredShell = hookDecision({
    sessionId: docsSessionId,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node "${ROUTING_SCRIPT}" dispatch-current history-reader`,
    },
  }, { home });
  assert.equal(retiredShell.permissionDecision, 'deny');
  assert.match(retiredShell.permissionDecisionReason, /retired on the model-facing shell surface/);

  for (const [suffix, envSessionId, input] of [
    ['bare', undefined, ''],
    ['env', docsSessionId, '{"sessionId":"ffffffff-ffff-4fff-8fff-ffffffffffff"}'],
    ['pipe', undefined, `{\"sessionId\":\"${docsSessionId}\"}`],
  ]) {
    const started = performance.now();
    const result = spawnSync(process.execPath, [ROUTING_SCRIPT, 'dispatch-current', 'history-reader'], {
      cwd: repo,
      env: {
        ...process.env,
        COPILOT_HOME: home,
        ...(envSessionId ? { COPILOT_SESSION_ID: envSessionId } : {}),
      },
      input,
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 4096,
    });
    const elapsed = performance.now() - started;
    assert.equal(result.status, 1, `${suffix} dispatch-current must fail closed`);
    assert.ok(elapsed < 1000, `${suffix} dispatch-current should fail fast`);
    assert.ok(result.stdout.length <= 1024, `${suffix} dispatch-current output must stay bounded`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.code, 'dispatch-current-retired');
    assert.equal(parsed.ok, false);
  }
});

test('protected routing shell commands deny self-disable, self-minted overrides, and cross-session status reads', () => {
  const home = makeTempDir('routing-home-');
  const sessionId = '34343434-3434-4434-8434-343434343434';
  const otherSessionId = '35353535-3535-4535-8535-353535353535';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  writeSessionEvents(home, otherSessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId, prompt: 'route safely' }, { home });
  promptStartState({ sessionId: otherSessionId, prompt: 'other protected root' }, { home });
  const alternateScript = path.join(SCRIPT_DIR, '..', 'scripts', 'routing-enforcement.mjs');
  const modeFile = path.join(home, 'mode.json');
  const overrideFile = path.join(home, 'override.json');
  const currentStatusFile = path.join(home, 'status-current.json');
  const otherStatusFile = path.join(home, 'status-other.json');
  writeJson(modeFile, { mode: 'audit' });
  writeJson(overrideFile, { sessionId, allowedToolNames: ['view'], maxUses: 1 });
  writeJson(currentStatusFile, { sessionId });
  writeJson(otherStatusFile, { sessionId: otherSessionId });

  const deniedMode = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'bash',
    toolArgs: {
      command: `node "${alternateScript}" set-mode "${modeFile}"`,
    },
  }, { home });
  assert.equal(deniedMode.permissionDecision, 'deny');
  assert.match(deniedMode.permissionDecisionReason, /manual config-file edit/i);

  const deniedOverride = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'bash',
    toolArgs: {
      command: `node '${ROUTING_SCRIPT}' authorize-operator '${overrideFile}'`,
    },
  }, { home });
  assert.equal(deniedOverride.permissionDecision, 'deny');
  assert.match(deniedOverride.permissionDecisionReason, /minted externally/i);

  const deniedStatus = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'bash',
    toolArgs: {
      command: `node ${ROUTING_SCRIPT} status ${currentStatusFile}`,
    },
  }, { home });
  assert.equal(deniedStatus.permissionDecision, 'deny');
  assert.match(deniedStatus.permissionDecisionReason, /status-current/);

  const allowedCurrent = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'bash',
    toolArgs: {
      command: `node ${ROUTING_SCRIPT} status-current ${currentStatusFile}`,
    },
  }, { home });
  assert.deepEqual(allowedCurrent, {});

  const deniedOther = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'bash',
    toolArgs: {
      command: `node ${ROUTING_SCRIPT} status-current ${otherStatusFile}`,
    },
  }, { home });
  assert.equal(deniedOther.permissionDecision, 'deny');
  assert.match(deniedOther.permissionDecisionReason, /active caller session/);
});

test('same-session helper routing trusts only the validated host envelope session', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'ha-react');
  const sessionA = '36363636-3636-4636-8636-363636363636';
  const sessionB = '37373737-3737-4737-8737-373737373737';
  writeSessionEvents(home, sessionA, 'gpt-5.6-sol', 'max');
  writeSessionEvents(home, sessionB, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId: sessionA, prompt: 'route helper commands safely' }, { home });
  promptStartState({ sessionId: sessionB, prompt: 'other protected root' }, { home });

  const currentStatusFile = path.join(home, 'status-current.json');
  const otherStatusFile = path.join(home, 'status-other.json');
  const duplicateStatusFile = path.join(home, 'status-duplicate.json');
  const traversalStatusFile = path.join(home, 'status-traversal.json');
  const manifestSpoofFile = path.join(home, 'manifest-spoof.json');
  writeJson(currentStatusFile, { sessionId: sessionA });
  writeJson(otherStatusFile, { sessionId: sessionB });
  fs.writeFileSync(duplicateStatusFile, JSON.stringify({
    sessionId: sessionA,
    session_id: sessionB,
  }, null, 2));
  writeJson(traversalStatusFile, { sessionId: '../escape' });
  writeJson(manifestSpoofFile, {
    sessionId: sessionB,
    repository: repo,
    scope: ['api'],
    role: 'implementation-coordinator',
    agentType: 'general-purpose',
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['repository-read', 'repository-edit', 'tests'],
    validations: ['npm test'],
    researchAuthorized: false,
    plan: { status: 'ready', opportunity: 'focused-tests' },
  });

  const allowedQuoted = hookDecision({
    sessionId: sessionA,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node '${ROUTING_SCRIPT}' status-current "${currentStatusFile}"`,
    },
  }, { home });
  assert.deepEqual(allowedQuoted, {});

  const deniedSpoofedTarget = hookDecision({
    sessionId: sessionA,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node "${ROUTING_SCRIPT}" status-current "${otherStatusFile}"`,
    },
  }, { home });
  assert.equal(deniedSpoofedTarget.permissionDecision, 'deny');
  assert.match(deniedSpoofedTarget.permissionDecisionReason, /active caller session/);

  const deniedManifestSpoof = hookDecision({
    sessionId: sessionA,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node "${ROUTING_SCRIPT}" manifest-from-active-prompt "${manifestSpoofFile}"`,
    },
  }, { home });
  assert.equal(deniedManifestSpoof.permissionDecision, 'deny');
  assert.match(deniedManifestSpoof.permissionDecisionReason, /active caller session/);

  const deniedDuplicateKeys = hookDecision({
    sessionId: sessionA,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node "${ROUTING_SCRIPT}" status-current "${duplicateStatusFile}"`,
    },
  }, { home });
  assert.equal(deniedDuplicateKeys.permissionDecision, 'deny');
  assert.match(deniedDuplicateKeys.permissionDecisionReason, /only one top-level sessionId field/);

  const deniedTraversal = hookDecision({
    sessionId: sessionA,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node "${ROUTING_SCRIPT}" status-current "${traversalStatusFile}"`,
    },
  }, { home });
  assert.equal(deniedTraversal.permissionDecision, 'deny');
  assert.match(deniedTraversal.permissionDecisionReason, /valid UUID/);

  const deniedEnvPrefix = hookDecision({
    sessionId: sessionA,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `COPILOT_SESSION_ID=${sessionB} node "${ROUTING_SCRIPT}" status-current "${currentStatusFile}"`,
    },
  }, { home });
  assert.equal(deniedEnvPrefix.permissionDecision, 'deny');

  const deniedExtraArgs = hookDecision({
    sessionId: sessionA,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node "${ROUTING_SCRIPT}" status-current "${currentStatusFile}" "${otherStatusFile}"`,
    },
  }, { home });
  assert.equal(deniedExtraArgs.permissionDecision, 'deny');
  assert.match(deniedExtraArgs.permissionDecisionReason, /exact form/);

  const duplicateEnvelope = spawnSync(process.execPath, [ROUTING_SCRIPT, 'hook'], {
    cwd: repo,
    env: { ...process.env, COPILOT_HOME: home },
    input: `{"sessionId":"${sessionA}","sessionId":"${sessionB}","cwd":${JSON.stringify(repo)},"toolName":"write_agent","toolArgs":{"scope":"children","message":"continue"}}`,
    encoding: 'utf8',
  });
  assert.equal(duplicateEnvelope.status, 0);
  const duplicateDecision = JSON.parse(duplicateEnvelope.stdout);
  assert.equal(duplicateDecision.permissionDecision, 'deny');
  assert.match(duplicateDecision.permissionDecisionReason, /duplicate top-level keys/);
});

test('write_agent allows only scope children or registered current child agents', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'festival-score-tracker');
  const parentSessionId = '38383838-3838-4838-8838-383838383838';
  const childSessionId = '39393939-3939-4939-8939-393939393939';
  const { agentId } = registerCurrentChildAgent({
    home,
    repo,
    parentSessionId,
    childSessionId,
  });

  const explicitAllowed = hookDecision({
    sessionId: parentSessionId,
    cwd: repo,
    toolName: 'write_agent',
    toolArgs: {
      agent_id: agentId,
      message: 'continue the bounded worker',
    },
  }, { home });
  assert.deepEqual(explicitAllowed, {});

  const scopeAllowed = hookDecision({
    sessionId: parentSessionId,
    cwd: repo,
    toolName: 'write_agent',
    toolArgs: {
      scope: 'children',
      message: 'continue all current children',
    },
  }, { home });
  assert.deepEqual(scopeAllowed, {});

  const unknownAgent = hookDecision({
    sessionId: parentSessionId,
    cwd: repo,
    toolName: 'write_agent',
    toolArgs: {
      agent_id: 'sibling-agent-1',
      message: 'nope',
    },
  }, { home });
  assert.equal(unknownAgent.permissionDecision, 'deny');
  assert.match(unknownAgent.permissionDecisionReason, /registered current child agents/);

  const siblingScope = hookDecision({
    sessionId: parentSessionId,
    cwd: repo,
    toolName: 'write_agent',
    toolArgs: {
      scope: 'siblings',
      message: 'nope',
    },
  }, { home });
  assert.equal(siblingScope.permissionDecision, 'deny');
  assert.match(siblingScope.permissionDecisionReason, /scope: children/);

  const mixed = hookDecision({
    sessionId: parentSessionId,
    cwd: repo,
    toolName: 'write_agent',
    toolArgs: {
      agent_id: agentId,
      scope: 'children',
      message: 'nope',
    },
  }, { home });
  assert.equal(mixed.permissionDecision, 'deny');
  assert.match(mixed.permissionDecisionReason, /cannot mix/);

  const duplicateList = hookDecision({
    sessionId: parentSessionId,
    cwd: repo,
    toolName: 'write_agent',
    toolArgs: {
      agent_ids: [agentId, agentId],
      message: 'nope',
    },
  }, { home });
  assert.equal(duplicateList.permissionDecision, 'deny');
  assert.match(duplicateList.permissionDecisionReason, /duplicates/);

  clearSessionState(parentSessionId, { home });
  writeSessionEvents(home, parentSessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId: parentSessionId, prompt: 'new prompt after child replay' }, { home });
  const replayedRegistration = hookDecision({
    sessionId: parentSessionId,
    cwd: repo,
    toolName: 'write_agent',
    toolArgs: {
      agent_id: agentId,
      message: 'stale child registration must not replay',
    },
  }, { home });
  assert.equal(replayedRegistration.permissionDecision, 'deny');
  assert.match(replayedRegistration.permissionDecisionReason, /registered current child agents/);
});

test('task dispatch rejects missing, inherit, and forbidden frontier pins', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'ha-react');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  writeSessionEvents(home, sessionId, 'gpt-5.4', 'medium');
  const state = promptStartState({ sessionId, prompt: 'delegate implementation' }, { home });
  const manifest = createDispatchManifest({
    sessionId,
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    repository: repo,
    scope: ['src'],
    role: 'implementation-coordinator',
    agentType: 'general-purpose',
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['repository-read', 'repository-edit', 'tests'],
    validations: ['npm test'],
    researchAuthorized: false,
    intent: { packetWorkflowVersion: 2 },
    plan: {
      status: 'needs-opportunity',
      candidates: [],
    },
  });

  const missing = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: {
      prompt: manifest.promptBlock,
      agent_type: 'general-purpose',
      context_tier: 'default',
      reasoning_effort: 'medium',
    },
  }, { home });
  assert.equal(missing.permissionDecision, 'deny');

  const inherit = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: {
      prompt: manifest.promptBlock,
      model: 'inherit',
      agent_type: 'general-purpose',
      context_tier: 'default',
      reasoning_effort: 'medium',
    },
  }, { home });
  assert.equal(inherit.permissionDecision, 'deny');

  const claude = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: {
      prompt: manifest.promptBlock,
      model: 'claude-sonnet-5',
      agent_type: 'general-purpose',
      context_tier: 'default',
      reasoning_effort: 'medium',
    },
  }, { home });
  assert.equal(claude.permissionDecision, 'deny');
});

test('exact cheaper task pins with a bound manifest are allowed', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'festival-score-tracker');
  const sessionId = '22222222-2222-4222-8222-222222222222';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId, prompt: 'delegate focused test' }, { home });
  const created = manifestFromActivePrompt({
    sessionId,
    repository: repo,
    scope: ['FSTService.Tests'],
    role: 'cheap-worker',
    agentType: 'task',
    model: 'mai-code-1.1-flash',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['tests'],
    validations: ['dotnet test FSTService.Tests/FSTService.Tests.csproj'],
    researchAuthorized: false,
    plan: cheapWorkerPlan(),
  }, { home });

  const allowed = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: {
      prompt: created.taskPrompt,
      model: 'mai-code-1.1-flash',
      agent_type: 'task',
      context_tier: 'default',
      reasoning_effort: 'medium',
    },
  }, { home });
  assert.deepEqual(allowed, {});
});

test('manifest-bound children with missing local events activate exact scope and fail closed otherwise', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'festival-score-tracker');
  const parentSessionId = 'abcde123-0000-4000-8000-000000000003';
  writeSessionEvents(home, parentSessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId: parentSessionId, prompt: 'delegate bounded worker' }, { home });
  const created = manifestFromActivePrompt({
    sessionId: parentSessionId,
    repository: repo,
    scope: ['api'],
    role: 'cheap-worker',
    agentType: 'task',
    model: 'mai-code-1.1-flash',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['repository-read', 'tests'],
    validations: ['node --test api/example.test.mjs'],
    researchAuthorized: false,
    taskPromptBody: 'Run the exact bounded worker plan.',
    plan: cheapWorkerPlan(),
  }, { home });

  const childSessionId = 'abcde123-0000-4000-8000-000000000004';
  const childState = promptStartState({
    sessionId: childSessionId,
    prompt: created.taskPrompt,
  }, { home });
  assert.equal(childState.classification, 'subagent-active');
  assert.equal(childState.model, 'mai-code-1.1-flash');
  assert.equal(childState.profileSource, 'child-activation-receipt');

  const readAllowed = hookDecision({
    sessionId: childSessionId,
    cwd: repo,
    toolName: 'view',
    toolArgs: { path: path.join(repo, 'api', 'example.ts'), view_range: [1, 1] },
  }, { home });
  assert.deepEqual(readAllowed, {});

  const testAllowed = hookDecision({
    sessionId: childSessionId,
    cwd: repo,
    toolName: 'bash',
    toolArgs: { command: 'node --test api/example.test.mjs' },
  }, { home });
  assert.deepEqual(testAllowed, {});

  const denied = hookDecision({
    sessionId: childSessionId,
    cwd: repo,
    toolCalls: [
      { id: 'search', name: 'rg', args: { pattern: 'value', paths: [repo] } },
      { id: 'shell', name: 'bash', args: { command: 'echo off-plan' } },
      { id: 'history', name: 'session_store_sql', args: { query: 'select 1' } },
    ],
  }, { home });
  assert.equal(Object.keys(denied).length, 3);
  assert.equal(denied.search.permissionDecision, 'deny');
  assert.equal(denied.shell.permissionDecision, 'deny');
  assert.equal(denied.history.permissionDecision, 'deny');

  const replaySessionId = 'abcde123-0000-4000-8000-000000000005';
  const replayState = promptStartState({
    sessionId: replaySessionId,
    prompt: created.taskPrompt,
  }, { home });
  assert.equal(replayState.classification, 'subagent-unresolved');
  const replayDenied = hookDecision({
    sessionId: replaySessionId,
    cwd: repo,
    toolName: 'view',
    toolArgs: { path: path.join(repo, 'api', 'example.ts'), view_range: [1, 1] },
  }, { home });
  assert.equal(replayDenied.permissionDecision, 'deny');

  const forgedPrompt = created.taskPrompt.replace('"api"]', '"other"]');
  const forgedSessionId = 'abcde123-0000-4000-8000-000000000006';
  const forgedState = promptStartState({
    sessionId: forgedSessionId,
    prompt: forgedPrompt,
  }, { home });
  assert.equal(forgedState.classification, 'subagent-unresolved');
});

test('frontier task dispatch is denied because packet-only frontier work cannot use task agents', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'evershelf');
  const sessionId = '33333333-3333-4333-8333-333333333333';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  const { state, packet, packetReceipt, frontierReceipt } = makeFrontierRequest({
    home,
    repo,
    sessionId,
  });
  const manifest = createDispatchManifest({
    sessionId,
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    repository: repo,
    scope: ['api'],
    role: 'frontier-research',
    model: 'gpt-5.6-sol',
    effort: 'max',
    context: 'default',
    allowedToolCategories: [],
    validations: ['strict-json-output'],
    researchAuthorized: true,
    receiptHash: frontierReceipt.receiptHash,
    evidencePacketHash: packet.packetHash,
    intent: { researchMode: 'repository', packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'external-research' },
  });
  void packetReceipt;

  const denied = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: {
      prompt: manifest.promptBlock,
      model: 'gpt-5.6-sol',
      agent_type: 'research',
      context_tier: 'default',
      reasoning_effort: 'max',
    },
  }, { home });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /reason-only run-leaf path/);
});

test('protected frontier roots deny evidence research run launches that bypass bound run-leaf receipts', () => {
  const home = makeTempDir('routing-home-');
  const sessionId = '33333333-3333-4333-8333-333333333334';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({
    sessionId,
    prompt: 'frontier research without a bound receipt',
    intent: { researchMode: 'repository' },
  }, { home });

  const denied = hookDecision({
    sessionId,
    cwd: '/tmp',
    toolName: 'bash',
    toolArgs: {
      command: `node ${RESEARCH_SCRIPT} run /tmp/task.json /tmp/repo /tmp/out /tmp/cache`,
    },
  }, { home });
  assert.equal(denied.permissionDecision, 'deny');
});

test('Sol packet-only reason-only run-leaf dispatch is allowed', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'evershelf');
  const sessionId = '44444444-4444-4444-8444-444444444444';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  const { state, packet, frontierReceipt } = makeFrontierRequest({ home, repo, sessionId });
  const manifest = createDispatchManifest({
    sessionId,
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    repository: repo,
    scope: ['api'],
    role: 'frontier-research',
    model: 'gpt-5.6-sol',
    effort: 'max',
    context: 'default',
    allowedToolCategories: [],
    validations: ['strict-json-output'],
    researchAuthorized: true,
    receiptHash: frontierReceipt.receiptHash,
    evidencePacketHash: packet.packetHash,
    intent: { researchMode: 'repository', packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'external-research' },
  });
  const request = createBoundReasonOnlyLeafRequest({
    dispatchManifest: manifest,
    frontierReceipt,
    evidencePacket: packet,
    question: 'How should the validator behave?',
    sanitized: true,
    maxCredits: 60,
    timeoutSeconds: 60,
  });
  const requestFile = path.join(home, 'request.json');
  writeJson(requestFile, request);

  const allowed = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node ${RUN_LEAF_SCRIPT} ${requestFile} ${path.join(home, 'out')}`,
    },
  }, { home });
  assert.deepEqual(allowed, {});
});

test('Astra tandem dispatch is allowed only with both frontier and tandem-pair receipts', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'evershelf');
  const sessionId = '55555555-5555-4555-8555-555555555555';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  const base = makeFrontierRequest({ home, repo, sessionId, tandem: true });
  const secondaryReceipt = authorizeResearchReceipt({
    sessionId,
    promptHash: base.state.promptHash,
    role: 'tandem-secondary-research',
    evidencePacket: base.packet,
    evidencePacketReceiptHash: base.packetReceipt.receiptHash,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { home });
  const pairReceipt = createTandemPairReceipt({
    workflowId: base.packet.workflowId,
    promptHash: base.packet.promptHash,
    questionHash: base.packet.questionBinding.questionHash,
    mode: base.packet.mode,
    scopeHash: base.packet.scopeHash,
    packetHash: base.packet.packetHash,
    primaryProfile: { model: 'gpt-5.6-sol', effort: 'max', context: 'default' },
    secondaryProfile: { model: 'gpt-6-astra', effort: 'medium', context: 'default' },
    primaryDispatchReceiptHash: base.frontierReceipt.receiptHash,
    secondaryDispatchReceiptHash: secondaryReceipt.receiptHash,
    gapLoops: 0,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const manifest = createDispatchManifest({
    sessionId,
    workflowId: base.state.workflowId,
    promptHash: base.state.promptHash,
    repository: repo,
    scope: ['api'],
    role: 'tandem-secondary-research',
    model: 'gpt-6-astra',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: [],
    validations: ['strict-json-output'],
    researchAuthorized: true,
    receiptHash: secondaryReceipt.receiptHash,
    evidencePacketHash: base.packet.packetHash,
    tandemPairReceiptHash: pairReceipt.receiptHash,
    intent: {
      researchMode: 'repository',
      tandemRequested: true,
      packetWorkflowVersion: 2,
    },
    plan: { status: 'ready', opportunity: 'tandem-research' },
  });
  const request = createBoundReasonOnlyLeafRequest({
    dispatchManifest: manifest,
    frontierReceipt: secondaryReceipt,
    tandemPairReceipt: pairReceipt,
    evidencePacket: base.packet,
    question: 'Compare the prior approach',
    sanitized: true,
    maxCredits: 60,
    timeoutSeconds: 60,
  });
  const requestFile = path.join(home, 'astra-request.json');
  writeJson(requestFile, request);

  const allowed = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node ${RUN_LEAF_SCRIPT} ${requestFile} ${path.join(home, 'astra-out')}`,
    },
  }, { home });
  assert.deepEqual(allowed, {});
});

test('tandem frontier profiles fail closed for stale roles, wrong pins, and tool-bearing manifests', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'evershelf');
  const sessionId = '56565656-5656-4565-8565-565656565656';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  const base = makeFrontierRequest({ home, repo, sessionId, tandem: true });

  assert.throws(() => authorizeResearchReceipt({
    sessionId,
    promptHash: base.state.promptHash,
    role: 'tandem-opus-research',
    evidencePacket: base.packet,
    evidencePacketReceiptHash: base.packetReceipt.receiptHash,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { home }), /role is invalid/);

  assert.throws(() => authorizeResearchReceipt({
    sessionId,
    promptHash: base.state.promptHash,
    role: 'tandem-secondary-research',
    model: 'claude-opus-5',
    effort: 'medium',
    context: 'default',
    evidencePacket: base.packet,
    evidencePacketReceiptHash: base.packetReceipt.receiptHash,
    tandemPairReceiptHash: 'a'.repeat(64),
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { home }), /exact approved profile/);

  assert.throws(() => authorizeResearchReceipt({
    sessionId,
    promptHash: base.state.promptHash,
    role: 'tandem-secondary-research',
    model: 'gpt-6-astra',
    effort: 'high',
    context: 'default',
    evidencePacket: base.packet,
    evidencePacketReceiptHash: base.packetReceipt.receiptHash,
    tandemPairReceiptHash: 'a'.repeat(64),
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { home }), /exact approved profile/);

  assert.throws(() => authorizeResearchReceipt({
    sessionId,
    promptHash: base.state.promptHash,
    role: 'frontier-research',
    model: 'gpt-5.6-sol',
    effort: 'high',
    context: 'default',
    evidencePacket: base.packet,
    evidencePacketReceiptHash: base.packetReceipt.receiptHash,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { home }), /exact approved profile/);

  const secondaryReceipt = authorizeResearchReceipt({
    sessionId,
    promptHash: base.state.promptHash,
    role: 'tandem-secondary-research',
    evidencePacket: base.packet,
    evidencePacketReceiptHash: base.packetReceipt.receiptHash,
    tandemPairReceiptHash: 'b'.repeat(64),
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { home });

  assert.throws(() => createDispatchManifest({
    sessionId,
    workflowId: base.state.workflowId,
    promptHash: base.state.promptHash,
    repository: repo,
    scope: ['api'],
    role: 'tandem-secondary-research',
    model: 'gpt-6-astra',
    effort: 'medium',
    context: 'long_context',
    allowedToolCategories: [],
    validations: ['strict-json-output'],
    researchAuthorized: true,
    receiptHash: secondaryReceipt.receiptHash,
    evidencePacketHash: base.packet.packetHash,
    tandemPairReceiptHash: 'b'.repeat(64),
    intent: { researchMode: 'repository', tandemRequested: true, packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'tandem-research' },
  }), /must use gpt-6-astra\/medium\/default/);

  assert.throws(() => createDispatchManifest({
    sessionId,
    workflowId: base.state.workflowId,
    promptHash: base.state.promptHash,
    repository: repo,
    scope: ['api'],
    role: 'tandem-secondary-research',
    model: 'gpt-6-astra',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['repository-read'],
    validations: ['strict-json-output'],
    researchAuthorized: true,
    receiptHash: secondaryReceipt.receiptHash,
    evidencePacketHash: base.packet.packetHash,
    tandemPairReceiptHash: 'b'.repeat(64),
    intent: { researchMode: 'repository', tandemRequested: true, packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'tandem-research' },
  }), /cannot grant repository, shell, browser, or history tools/);
});

test('stale or mismatched packets are denied', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'evershelf');
  const sessionId = '66666666-6666-4666-8666-666666666666';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  const state = promptStartState({
    sessionId,
    prompt: 'stale packet research',
    intent: { researchMode: 'repository' },
  }, { home });
  const stalePacket = makePacket({
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    repositoryRoot: repo,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const stalePacketReceipt = createEvidencePacketReceipt(stalePacket);
  const frontierReceipt = authorizeResearchReceipt({
    sessionId,
    promptHash: state.promptHash,
    role: 'frontier-research',
    evidencePacket: stalePacket,
    evidencePacketReceiptHash: stalePacketReceipt.receiptHash,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { home });
  const manifest = createDispatchManifest({
    sessionId,
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    repository: repo,
    scope: ['api'],
    role: 'frontier-research',
    model: 'gpt-5.6-sol',
    effort: 'max',
    context: 'default',
    allowedToolCategories: [],
    validations: ['strict-json-output'],
    researchAuthorized: true,
    receiptHash: frontierReceipt.receiptHash,
    evidencePacketHash: stalePacket.packetHash,
    intent: { researchMode: 'repository', packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'external-research' },
  });
  const request = createBoundReasonOnlyLeafRequest({
    dispatchManifest: manifest,
    frontierReceipt,
    evidencePacket: stalePacket,
    sanitized: true,
    maxCredits: 60,
    timeoutSeconds: 60,
  });
  const requestFile = path.join(home, 'stale-request.json');
  writeJson(requestFile, request);

  const denied = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'bash',
    toolArgs: {
      command: `node ${RUN_LEAF_SCRIPT} ${requestFile} ${path.join(home, 'stale-out')}`,
    },
  }, { home });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /stale/);
});

test('prompt rebinding is idempotent, survives missing events, and invalidates stale manifests and overrides', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'ha-react');
  const sessionId = 'abcde123-0000-4000-8000-000000000007';
  writeSessionEvents(home, sessionId, 'gpt-5.4', 'medium');

  const first = promptStartState({ sessionId, prompt: 'first prompt' }, { home });
  const firstAgain = promptStartState({ sessionId, prompt: 'first prompt' }, { home });
  assert.equal(firstAgain.workflowId, first.workflowId);
  assert.equal(firstAgain.promptIndex, first.promptIndex);

  const manifest = manifestFromActivePrompt({
    sessionId,
    repository: repo,
    scope: ['api'],
    role: 'implementation-coordinator',
    agentType: 'general-purpose',
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['repository-read', 'repository-edit', 'tests'],
    validations: ['npm test'],
    researchAuthorized: false,
    taskPromptBody: 'Implement the focused fix.',
    plan: { status: 'ready', opportunity: 'focused-tests' },
  }, { home });
  const staleReceipt = authorizeOperatorOverride({
    sessionId,
    allowedToolNames: ['manage_schedule'],
    allowedToolCategories: ['schedule-create'],
    scheduleActions: ['create'],
    maxUses: 1,
  }, { home });

  fs.unlinkSync(path.join(home, 'session-state', sessionId, 'events.jsonl'));
  clearSessionState(sessionId, { home });
  const second = promptStartState({ sessionId, prompt: 'second prompt after resume' }, { home });
  assert.notEqual(second.workflowId, first.workflowId);
  assert.equal(second.promptIndex, first.promptIndex + 1);
  assert.equal(second.model, 'gpt-5.4');
  assert.equal(second.profileSource, 'session-routing-state');

  const staleTask = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'task',
    toolArgs: {
      prompt: manifest.taskPrompt,
      model: 'gpt-5.4',
      agent_type: 'general-purpose',
      context_tier: 'default',
      reasoning_effort: 'medium',
    },
  }, { home });
  assert.equal(staleTask.permissionDecision, 'deny');
  assert.match(staleTask.permissionDecisionReason, /active session, workflow, and prompt/);

  const staleOverride = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'manage_schedule',
    toolArgs: {
      action: 'create',
      interval: '5m',
      prompt: 'stale override should not carry forward',
      operatorOverrideReceipt: staleReceipt,
    },
  }, { home });
  assert.equal(staleOverride.permissionDecision, 'deny');
});

test('operator overrides stay exact to tool, scope, use count, expiry, and session', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'test-project');
  const sessionId = 'abcde123-0000-4000-8000-000000000008';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId, prompt: 'need explicit operator override' }, { home });

  const receipt = authorizeOperatorOverride({
    sessionId,
    allowedToolNames: ['view', 'manage_schedule'],
    allowedToolCategories: ['schedule-create'],
    pathPrefixes: [path.join(repo, 'api')],
    scheduleActions: ['create'],
    maxUses: 2,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { home });
  assert.equal(receipt.maxUses, 2);

  const firstUse = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'view',
    toolArgs: {
      path: path.join(repo, 'api', 'example.ts'),
      view_range: [1, 1],
      operatorOverrideReceipt: receipt,
    },
  }, { home });
  assert.deepEqual(firstUse, {});

  const secondUse = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'manage_schedule',
    toolArgs: {
      action: 'create',
      interval: '5m',
      prompt: 'allowed exact action',
      operatorOverrideReceipt: receipt,
    },
  }, { home });
  assert.deepEqual(secondUse, {});

  const exhausted = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'view',
    toolArgs: { path: path.join(repo, 'api', 'example.ts'), view_range: [1, 1] },
  }, { home });
  assert.equal(exhausted.permissionDecision, 'deny');

  const broader = authorizeOperatorOverride({
    sessionId,
    allowedToolNames: ['view'],
    pathPrefixes: [path.join(repo, 'api')],
    maxUses: 1,
    issuedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  }, { home });
  const expired = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'view',
    toolArgs: {
      path: path.join(repo, 'api', 'example.ts'),
      view_range: [1, 1],
      operatorOverrideReceipt: broader,
    },
  }, { home });
  assert.equal(expired.permissionDecision, 'deny');

  assert.throws(() => authorizeOperatorOverride({
    sessionId,
    allowedToolNames: ['bash'],
    commandPrefixes: ['git push origin main'],
    maxUses: 1,
  }, { home }), /allowRelease=true/);

  const otherSession = 'abcde123-0000-4000-8000-000000000009';
  writeSessionEvents(home, otherSession, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId: otherSession, prompt: 'other prompt' }, { home });
  const crossSession = hookDecision({
    sessionId: otherSession,
    cwd: repo,
    toolName: 'view',
    toolArgs: {
      path: path.join(repo, 'api', 'example.ts'),
      view_range: [1, 1],
      operatorOverrideReceipt: receipt,
    },
  }, { home });
  assert.equal(crossSession.permissionDecision, 'deny');
});

test('operator override receipts reject forged, tool-mismatched, and out-of-scope use', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'test-project');
  const sessionId = '19191919-1919-4919-8919-191919191919';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId, prompt: 'need a tightly scoped override' }, { home });
  const receipt = authorizeOperatorOverride({
    sessionId,
    allowedToolNames: ['view'],
    pathPrefixes: [path.join(repo, 'api')],
    maxUses: 2,
  }, { home });

  const wrongTool = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'web_search',
    toolArgs: {
      query: 'latest release',
      operatorOverrideReceipt: receipt,
    },
  }, { home });
  assert.equal(wrongTool.permissionDecision, 'deny');
  assert.match(wrongTool.permissionDecisionReason, /does not allow this tool/);

  const wrongScope = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'view',
    toolArgs: {
      path: path.join(repo, '.github', 'agent-budget.json'),
      view_range: [1, 1],
      operatorOverrideReceipt: receipt,
    },
  }, { home });
  assert.equal(wrongScope.permissionDecision, 'deny');
  assert.match(wrongScope.permissionDecisionReason, /path scope/);

  const tampered = structuredClone(receipt);
  tampered.allowedToolNames = ['web_search'];
  const tamperedUse = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'web_search',
    toolArgs: {
      query: 'forged',
      operatorOverrideReceipt: tampered,
    },
  }, { home });
  assert.equal(tamperedUse.permissionDecision, 'deny');
  assert.match(tamperedUse.permissionDecisionReason, /hash mismatch/);

  const forged = structuredClone(receipt);
  forged.allowedToolNames = ['web_search'];
  const { receiptHash: ignored, ...unsigned } = forged;
  void ignored;
  forged.receiptHash = sha256(unsigned);
  const forgedUse = hookDecision({
    sessionId,
    cwd: repo,
    toolName: 'web_search',
    toolArgs: {
      query: 'forged-registered',
      operatorOverrideReceipt: forged,
    },
  }, { home });
  assert.equal(forgedUse.permissionDecision, 'deny');
  assert.match(forgedUse.permissionDecisionReason, /hash mismatch|forged|registered/);
});

test('routing session IDs reject traversal, encoded forms, nulls, separators, and overlong values', () => {
  const home = makeTempDir('routing-home-');
  const invalidIds = [
    '../escape',
    '..\\escape',
    '%2e%2e%2fescape',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/../../other',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\..\\other',
    `cccccccc-cccc-4ccc-8ccc-cccccccccccc\u0000tail`,
    'd'.repeat(512),
  ];
  for (const sessionId of invalidIds) {
    assert.throws(() => promptStartState({ sessionId, prompt: 'nope' }, { home }), /valid UUID/);
    assert.throws(() => routingStatus({ sessionId }, { home }), /valid UUID/);
    assert.throws(() => clearSessionState(sessionId, { home }), /valid UUID/);
  }
});

test('child activation and operator override ledgers hash sensitive constraints instead of persisting raw values', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'festival-score-tracker');
  const sessionId = '21212121-2121-4121-8121-212121212121';
  const secretScope = 'api/secret-area';
  const secretValidation = 'node --test api/secret-validator.test.mjs --grep secret-token';
  const secretPathPrefix = path.join(repo, 'api', 'secret-area');
  const secretCommandPrefix = 'npm test -- --grep secret-command';
  const secretQueryPrefix = 'select * from secrets where token = secret-query';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId, prompt: 'create bounded secret receipts' }, { home });
  manifestFromActivePrompt({
    sessionId,
    repository: repo,
    scope: [secretScope],
    role: 'cheap-worker',
    agentType: 'task',
    model: 'mai-code-1.1-flash',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['repository-read', 'tests'],
    validations: [secretValidation],
    researchAuthorized: false,
    taskPromptBody: 'Run the exact bounded validator tests.',
    plan: cheapWorkerPlan(),
  }, { home });
  authorizeOperatorOverride({
    sessionId,
    allowedToolNames: ['view', 'bash', 'session_store_sql'],
    pathPrefixes: [secretPathPrefix],
    commandPrefixes: [secretCommandPrefix],
    queryPrefixes: [secretQueryPrefix],
    maxUses: 1,
  }, { home });

  const childText = fs.readFileSync(path.join(home, 'budget-routing', `${sessionId}.child-activations.json`), 'utf8');
  assert.equal(childText.includes(secretScope), false);
  assert.equal(childText.includes(secretValidation), false);
  assert.equal(childText.includes(repo), false);
  assert.match(childText, /scopeHash/);
  assert.match(childText, /validationHashes/);

  const overrideText = fs.readFileSync(path.join(home, 'budget-routing', `${sessionId}.operator-overrides.json`), 'utf8');
  assert.equal(overrideText.includes(secretPathPrefix), false);
  assert.equal(overrideText.includes(secretCommandPrefix), false);
  assert.equal(overrideText.includes(secretQueryPrefix), false);
  assert.equal(overrideText.includes('secret-command'), false);
  assert.equal(overrideText.includes('secret-query'), false);
  assert.match(overrideText, /pathPrefixHashes/);
  assert.match(overrideText, /commandPrefixHashes/);
  assert.match(overrideText, /queryPrefixHashes/);
});

test('control artifacts stay inside the active session files directory with safe sanitized payloads', async () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'festival-score-tracker');
  const sessionId = 'ababab12-0000-4000-8000-000000000008';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({
    sessionId,
    cwd: repo,
    prompt: 'write a sanitized control artifact only',
  }, { home });
  const created = manifestFromActivePrompt({
    sessionId,
    repository: repo,
    scope: ['api'],
    role: 'cheap-worker',
    agentType: 'task',
    model: 'mai-code-1.1-flash',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: ['repository-read', 'tests'],
    validations: ['node --test api/example.test.mjs'],
    researchAuthorized: false,
    taskPromptBody: 'Run the exact bounded validator tests.',
    plan: cheapWorkerPlan(),
  }, { home });
  const artifact = writeControlArtifactCurrent({
    sessionId,
    filename: 'dispatch-history-reader.json',
    artifactType: 'dispatch-request',
    dispatchManifest: created.dispatchManifest,
    childActivation: created.childActivation,
  }, { home });
  assertPrivateMode(path.dirname(artifact.file), 0o700);
  assertPrivateMode(artifact.file, 0o600);
  const written = JSON.parse(fs.readFileSync(artifact.file, 'utf8'));
  assert.equal(written.value.role, 'cheap-worker');
  assert.equal(JSON.stringify(written).includes('Run the exact bounded validator tests.'), false);
  assert.equal(JSON.stringify(written).includes(repo), false);

  const logArtifact = writeControlArtifactCurrent({
    sessionId,
    filename: 'progress-routing.log',
    artifactType: 'progress-log',
    entries: ['2026-09-15T00:00:00Z progress: waiting for bounded history query'],
  }, { home });
  assertPrivateMode(logArtifact.file, 0o600);

  const symlinkTarget = path.join(home, 'session-state', sessionId, 'files', 'result-safe.json');
  fs.symlinkSync(path.join(home, 'elsewhere.json'), symlinkTarget);
  assert.throws(() => writeControlArtifactCurrent({
    sessionId,
    filename: 'result-safe.json',
    artifactType: 'result-envelope',
    value: { status: 'ok' },
  }, { home }), /symlink/);
});

test('audit mode logs sanitized would-deny decisions while invalid mode fails closed to enforce', () => {
  const home = makeTempDir('routing-home-');
  const sessionId = 'abcde123-0000-4000-8000-00000000000a';
  const file = path.join(home, 'secret.txt');
  fs.writeFileSync(file, 'shh\n');
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId, prompt: 'audit denied operations only' }, { home });

  setRoutingMode({ mode: 'audit' }, { home });
  const allowed = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'view',
    toolArgs: { path: file, view_range: [1, 1] },
  }, { home });
  assert.deepEqual(allowed, {});
  const auditLog = fs.readFileSync(path.join(home, 'budget-routing', 'audit.jsonl'), 'utf8');
  assert.equal(auditLog.includes('audit denied operations only'), false);
  assert.equal(auditLog.includes(file), false);

  setRoutingMode({ mode: 'enforce' }, { home });
  const denied = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'view',
    toolArgs: { path: file, view_range: [1, 1] },
  }, { home });
  assert.equal(denied.permissionDecision, 'deny');

  fs.writeFileSync(path.join(home, 'budget-routing', 'config.json'), JSON.stringify({
    version: 3,
    kind: 'routing-config',
    mode: 'bogus',
    updatedAt: new Date().toISOString(),
  }, null, 2));
  assert.equal(effectiveRoutingMode({ home }).mode, 'enforce');
});

test('audit mode allows raw apply_patch payloads and records only sanitized metadata', () => {
  const home = makeTempDir('routing-home-');
  const sessionId = 'ababab12-0000-4000-8000-000000000009';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
  promptStartState({ sessionId, cwd: home, prompt: 'audit apply patch payloads' }, { home });
  setRoutingMode({ mode: 'audit' }, { home });
  const patch = `*** Begin Patch\n*** Add File: secret.txt\n+token sk-secret-value\n*** End Patch\n`;
  const result = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'apply_patch',
    toolArgs: patch,
  }, { home });
  assert.deepEqual(result, {});
  const auditLog = fs.readFileSync(path.join(home, 'budget-routing', 'audit.jsonl'), 'utf8');
  assert.equal(auditLog.includes('*** Begin Patch'), false);
  assert.equal(auditLog.includes('sk-secret-value'), false);
  assert.match(auditLog, /"tool":"apply_patch"/);
  assert.match(auditLog, /"argsShape":\["__raw"\]/);
});

test('routing state writers keep private POSIX modes and registered child hashes only', () => {
  const home = makeTempDir('routing-home-');
  const repo = makeTempDir('routing-repo-');
  makeRepo(repo, 'festival-score-tracker');

  const protectedSessionId = '40404040-4040-4040-8040-404040404040';
  const approvedSessionId = '41414141-4141-4141-8141-414141414141';
  const childSessionId = '42424242-4242-4242-8242-424242424242';
  const frontierSessionId = '43434343-4343-4343-8343-434343434343';

  writeSessionEvents(home, protectedSessionId, 'gpt-5.6-sol', 'max');
  writeSessionEvents(home, approvedSessionId, 'gpt-5.4', 'medium');
  const protectedState = promptStartState({ sessionId: protectedSessionId, prompt: 'protected routing prompt' }, { home });
  const approvedState = promptStartState({ sessionId: approvedSessionId, prompt: 'intent acceptance prompt' }, { home });
  void protectedState;

  setRoutingMode({ mode: 'audit' }, { home });
  registerCurrentChildAgent({
    home,
    repo,
    parentSessionId: protectedSessionId,
    childSessionId,
  });
  authorizeOperatorOverride({
    sessionId: protectedSessionId,
    allowedToolNames: ['view'],
    pathPrefixes: [path.join(repo, 'api')],
    maxUses: 1,
  }, { home });
  const frontier = makeFrontierRequest({ home, repo, sessionId: frontierSessionId });
  void frontier;
  const intentPacket = makeIntentAcceptancePacket({
    workflowId: approvedState.workflowId,
    sessionId: approvedSessionId,
    promptHash: approvedState.promptHash,
  });
  authorizeIntentAcceptanceReceipt({
    sessionId: approvedSessionId,
    promptHash: approvedState.promptHash,
    intentAcceptancePacket: intentPacket,
    attempt: 1,
  }, { home });
  hookDecision({
    sessionId: protectedSessionId,
    cwd: repo,
    toolName: 'view',
    toolArgs: {
      path: path.join(repo, 'api', 'example.ts'),
      view_range: [1, 1],
    },
  }, { home });

  const budgetDir = path.join(home, 'budget-routing');
  const expectedFiles = [
    `${protectedSessionId}.json`,
    `${protectedSessionId}.ledger.json`,
    `${protectedSessionId}.child-activations.json`,
    `${protectedSessionId}.child-agents.json`,
    `${protectedSessionId}.operator-overrides.json`,
    `${approvedSessionId}.json`,
    `${approvedSessionId}.ledger.json`,
    `${approvedSessionId}.intent-acceptance.json`,
    `${frontierSessionId}.frontier.json`,
    'audit.jsonl',
    'config.json',
  ];
  assertPrivateMode(budgetDir, 0o700);
  for (const name of expectedFiles) {
    assertPrivateMode(path.join(budgetDir, name), 0o600);
  }
  const childRegistryText = fs.readFileSync(path.join(budgetDir, `${protectedSessionId}.child-agents.json`), 'utf8');
  assert.equal(childRegistryText.includes('child-agent-1'), false);
  assert.match(childRegistryText, /agentIdHash/);
});

test('atomic routing writes leave prior state intact and clean temp files on rename or partial-write faults', () => {
  const home = makeTempDir('routing-home-');
  writeSessionEvents(home, '44444444-4444-4444-8444-444444444445', 'gpt-5.4', 'medium');
  promptStartState({ sessionId: '44444444-4444-4444-8444-444444444445', prompt: 'fault test prompt' }, { home });
  setRoutingMode({ mode: 'audit' }, { home });

  const budgetDir = path.join(home, 'budget-routing');
  const configFile = path.join(budgetDir, 'config.json');
  const stateFile = path.join(budgetDir, '44444444-4444-4444-8444-444444444445.json');
  const originalConfig = fs.readFileSync(configFile, 'utf8');
  const originalState = fs.readFileSync(stateFile, 'utf8');

  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('simulated rename fault');
  };
  try {
    assert.throws(() => setRoutingMode({ mode: 'enforce' }, { home }), /simulated rename fault/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(fs.readFileSync(configFile, 'utf8'), originalConfig);
  assert.deepEqual(fs.readdirSync(budgetDir).filter(name => name.endsWith('.tmp')), []);

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (target, data, options) => {
    if (typeof target === 'number') {
      originalWriteFileSync(target, '{"partial"', options);
    }
    throw new Error('simulated partial write');
  };
  try {
    assert.throws(() => promptStartState({
      sessionId: '44444444-4444-4444-8444-444444444445',
      prompt: 'fault test prompt replacement',
    }, { home }), /simulated partial write/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(fs.readFileSync(stateFile, 'utf8'), originalState);
  assert.deepEqual(fs.readdirSync(budgetDir).filter(name => name.endsWith('.tmp')), []);
});

test('routing readers reject truncated config, state, ledger, child, override, frontier, and intent stores', () => {
  const truncate = file => fs.writeFileSync(file, '{"truncated"');

  {
    const home = makeTempDir('routing-home-');
    setRoutingMode({ mode: 'audit' }, { home });
    truncate(path.join(home, 'budget-routing', 'config.json'));
    assert.throws(() => effectiveRoutingMode({ home }), /Routing config is not valid JSON/);
  }

  {
    const home = makeTempDir('routing-home-');
    const sessionId = '45454545-4545-4545-8545-454545454545';
    writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
    promptStartState({ sessionId, prompt: 'protected routing prompt' }, { home });
    truncate(path.join(home, 'budget-routing', `${sessionId}.json`));
    assert.throws(() => routingStatus({ sessionId }, { home }), /Routing state is not valid JSON/);
  }

  {
    const home = makeTempDir('routing-home-');
    const sessionId = '46464646-4646-4646-8646-464646464646';
    writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
    promptStartState({ sessionId, prompt: 'protected routing prompt' }, { home });
    truncate(path.join(home, 'budget-routing', `${sessionId}.ledger.json`));
    assert.throws(() => routingStatus({ sessionId }, { home }), /Routing prompt ledger is not valid JSON/);
  }

  {
    const home = makeTempDir('routing-home-');
    const repo = makeTempDir('routing-repo-');
    makeRepo(repo, 'festival-score-tracker');
    registerCurrentChildAgent({
      home,
      repo,
      parentSessionId: '47474747-4747-4747-8747-474747474747',
      childSessionId: '48484848-4848-4848-8848-484848484848',
    });
    truncate(path.join(home, 'budget-routing', '47474747-4747-4747-8747-474747474747.child-activations.json'));
    assert.throws(() => routingStatus({ sessionId: '47474747-4747-4747-8747-474747474747' }, { home }), /Child activation store is not valid JSON/);
  }

  {
    const home = makeTempDir('routing-home-');
    const repo = makeTempDir('routing-repo-');
    makeRepo(repo, 'festival-score-tracker');
    const parentSessionId = '49494949-4949-4949-8949-494949494949';
    registerCurrentChildAgent({
      home,
      repo,
      parentSessionId,
      childSessionId: '50505050-5050-4050-8050-505050505050',
    });
    truncate(path.join(home, 'budget-routing', `${parentSessionId}.child-agents.json`));
    const denied = hookDecision({
      sessionId: parentSessionId,
      cwd: repo,
      toolName: 'write_agent',
      toolArgs: { agent_id: 'child-agent-1', message: 'continue' },
    }, { home });
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /Child agent registry is not valid JSON/);
  }

  {
    const home = makeTempDir('routing-home-');
    const repo = makeTempDir('routing-repo-');
    makeRepo(repo, 'festival-score-tracker');
    const sessionId = '51515151-5151-4151-8151-515151515151';
    writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'max');
    promptStartState({ sessionId, prompt: 'need override' }, { home });
    const receipt = authorizeOperatorOverride({
      sessionId,
      allowedToolNames: ['view'],
      pathPrefixes: [path.join(repo, 'api')],
      maxUses: 1,
    }, { home });
    truncate(path.join(home, 'budget-routing', `${sessionId}.operator-overrides.json`));
    assert.throws(() => hookDecision({
      sessionId,
      cwd: repo,
      toolName: 'view',
      toolArgs: {
        path: path.join(repo, 'api', 'example.ts'),
        view_range: [1, 1],
        operatorOverrideReceipt: receipt,
      },
    }, { home }), /Operator override store is not valid JSON/);
  }

  {
    const home = makeTempDir('routing-home-');
    const repo = makeTempDir('routing-repo-');
    makeRepo(repo, 'festival-score-tracker');
    const sessionId = '52525252-5252-4252-8252-525252525252';
    const frontier = makeFrontierRequest({ home, repo, sessionId });
    const manifest = createDispatchManifest({
      sessionId,
      workflowId: frontier.state.workflowId,
      promptHash: frontier.state.promptHash,
      repository: repo,
      scope: ['api'],
      role: 'frontier-research',
      model: 'gpt-5.6-sol',
      effort: 'max',
      context: 'default',
      allowedToolCategories: [],
      validations: ['strict-json-output'],
      researchAuthorized: true,
      receiptHash: frontier.frontierReceipt.receiptHash,
      evidencePacketHash: frontier.packet.packetHash,
      intent: { researchMode: 'repository', packetWorkflowVersion: 2 },
      plan: { status: 'ready', opportunity: 'external-research' },
    });
    const request = createBoundReasonOnlyLeafRequest({
      dispatchManifest: manifest,
      frontierReceipt: frontier.frontierReceipt,
      evidencePacket: frontier.packet,
      question: 'How should the validator behave?',
      sanitized: true,
      maxCredits: 60,
      timeoutSeconds: 60,
    });
    const requestFile = path.join(home, 'frontier-request.json');
    writeJson(requestFile, request);
    truncate(path.join(home, 'budget-routing', `${sessionId}.frontier.json`));
    assert.throws(() => hookDecision({
      sessionId,
      cwd: repo,
      toolName: 'bash',
      toolArgs: {
        command: `node ${RUN_LEAF_SCRIPT} ${requestFile} ${path.join(home, 'frontier-out')}`,
      },
    }, { home }), /Frontier receipt store is not valid JSON/);
  }

  {
    const home = makeTempDir('routing-home-');
    const sessionId = '53535353-5353-4353-8353-535353535353';
    writeSessionEvents(home, sessionId, 'gpt-5.4', 'medium');
    const state = promptStartState({ sessionId, prompt: 'intent acceptance prompt' }, { home });
    const packet = makeIntentAcceptancePacket({
      workflowId: state.workflowId,
      sessionId,
      promptHash: state.promptHash,
    });
    const receipt = authorizeIntentAcceptanceReceipt({
      sessionId,
      promptHash: state.promptHash,
      intentAcceptancePacket: packet,
      attempt: 1,
    }, { home });
    const manifest = createDispatchManifest({
      sessionId,
      workflowId: state.workflowId,
      promptHash: state.promptHash,
      project: 'test-project',
      repository: null,
      scope: ['api', 'tests'],
      role: 'user-intent-acceptance',
      model: 'gpt-5.4',
      effort: 'medium',
      context: 'default',
      allowedToolCategories: [],
      validations: [],
      researchAuthorized: false,
      intentAcceptanceAuthorized: true,
      receiptHash: receipt.receiptHash,
      evidencePacketHash: packet.packetHash,
      intent: { packetWorkflowVersion: 2 },
      plan: { status: 'ready', opportunity: 'final-acceptance' },
    });
    const request = createBoundReasonOnlyLeafRequest({
      dispatchManifest: manifest,
      intentAcceptanceDispatchReceipt: receipt,
      intentAcceptancePacket: packet,
      sanitized: true,
      maxCredits: 60,
      timeoutSeconds: 60,
    });
    const requestFile = path.join(home, 'intent-request.json');
    writeJson(requestFile, request);
    truncate(path.join(home, 'budget-routing', `${sessionId}.intent-acceptance.json`));
    assert.throws(() => hookDecision({
      sessionId,
      cwd: process.cwd(),
      toolName: 'bash',
      toolArgs: {
        command: `node ${RUN_LEAF_SCRIPT} ${requestFile} ${path.join(home, 'intent-out')}`,
      },
    }, { home }), /Intent acceptance receipt store is not valid JSON/);
  }
});

test('team pipeline medium policy accepts gpt-5.4 and rejects Claude/Sol ownership', () => {
  const registry = makeToolRegistry('test-project');
  const basePolicy = {
    version: 3,
    project: 'test-project',
    qualification: {
      status: 'provisional',
      minimumUnattendedCases: 30,
      automaticApplication: false,
    },
    triggerCatalog: [
      { id: 'approved-research', category: 'research', description: 'research' },
    ],
    opportunities: [
      {
        id: 'focused-tests',
        label: 'Focused tests',
        triggers: ['test'],
        evidence: 'repository',
        enabled: true,
        evaluationStatus: 'provisional',
        casePacketStatus: 'provisional',
        skills: ['skill'],
        team: {
          id: 'team',
          topology: 'medium-owner-only',
          trustTier: 'provisional-staging',
          maxRevisions: 1,
          coordinator: { role: 'medium-coordinator', profile: { model: 'gpt-5.4', effort: 'medium', context: 'default' }, evidenceStatus: 'provisional' },
          reviewer: { role: 'medium-review', profile: { model: 'gpt-5.4', effort: 'medium', context: 'default' }, evidenceStatus: 'provisional' },
          workerCandidate: { role: 'cheap-worker', enabled: false, profile: { model: 'mai-code-1.1-flash', effort: 'medium', context: 'default' }, evidenceStatus: 'disabled', currentCases: 0, authority: 'staging-only' },
          repositoryApply: { authority: 'operator', enabled: false },
        },
        conditionalProfiles: [
          { id: 'research', kind: 'research-frontier', profile: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' }, triggerIds: ['approved-research'], requiresTriggerReceipt: true },
        ],
        phases: [
          { id: 'research-if-triggered', kind: 'research-frontier', profileRef: 'conditional:research', condition: { triggerIds: ['approved-research'], requiresTriggerReceipt: true } },
          { id: 'coordinate', kind: 'medium-coordinator', profileRef: 'coordinator' },
        ],
        rationale: 'rationale',
      },
    ],
  };
  validateOpportunityPolicyV3(basePolicy, registry, {
    opportunityPacket: null,
    workerPacket: null,
  });

  const invalid = structuredClone(basePolicy);
  invalid.opportunities[0].team.coordinator.profile.model = 'claude-sonnet-5';
  assert.throws(() => validateOpportunityPolicyV3(invalid, registry, {
    opportunityPacket: null,
    workerPacket: null,
  }), /coordinator must be a project-qualified medium\/default profile/);
});

test('release machine v3 requires gpt-5.4 reviewer and Sol research exception', () => {
  const registry = makeToolRegistry('test-project');
  const machine = {
    version: 3,
    project: 'test-project',
    opportunity: 'release',
    enabled: false,
    fakeOnly: false,
    operatorAuthorizationRequired: true,
    reviewer: {
      role: 'medium-review',
      authority: 'review-only',
      profile: { model: 'gpt-5.4', effort: 'medium', context: 'default' },
    },
    exception: {
      role: 'research-frontier',
      requiresTriggerReceipt: true,
      triggerIds: ['approved-research'],
      profile: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
    },
    toolRegistry: registry,
    steps: [
      { id: 'validate', label: 'Validate', executor: 'deterministic', operation: 'command', tool: 'unit-tests', failure: 'rejected', evidence: ['tests'] },
      { id: 'rollback', label: 'Rollback', executor: 'deterministic', operation: 'rollback', tool: 'unit-tests', rollbackOnly: true, rollbackVerificationTool: 'unit-tests', failure: 'abnormal', evidence: ['rollback'] },
      { id: 'cleanup', label: 'Cleanup', executor: 'deterministic', operation: 'cleanup', tool: 'unit-tests', failure: 'abnormal', evidence: ['cleanup'] },
    ],
  };
  validateReleaseMachineV3(machine, 'test-project');

  const invalid = structuredClone(machine);
  invalid.reviewer.profile.model = 'gpt-5.6-sol';
  assert.throws(() => validateReleaseMachineV3(invalid, 'test-project'),
    /gpt-5\.4 medium\/default/);
});

test('large session event files are processed from a bounded tail', () => {
  const home = makeTempDir('routing-home-');
  const sessionId = '40404040-4040-4040-8040-404040404040';
  writeSessionEvents(home, sessionId, 'gpt-5.6-sol', 'high');
  const filler = path.join(home, 'session-state', sessionId, 'events.jsonl');
  for (let index = 0; index < 50_000; index += 1) {
    appendSessionEvent(home, sessionId, {
      type: 'assistant.message',
      data: {
        content: `line ${index}`,
      },
    });
  }
  appendSessionEvent(home, sessionId, {
    type: 'session.model_change',
    data: {
      newModel: 'gpt-5.4',
      reasoningEffort: 'medium',
      contextTier: 'default',
    },
  });
  const profile = resolveSessionProfile(home, sessionId);
  assert.equal(profile.model, 'gpt-5.4');
  promptStartState({ sessionId, prompt: 'route only' }, { home });
  const started = performance.now();
  const samples = [];
  for (let index = 0; index < 250; index += 1) {
    const started = performance.now();
    hookDecision({
      sessionId,
      cwd: home,
      toolCalls: [
        { id: 'sql', name: 'session_store_sql', args: { query: 'select 1' } },
        { id: 'bash', name: 'bash', args: { command: `node ${OPPORTUNITIES_SCRIPT} plan /tmp/root /tmp/task.json` } },
        { id: 'view', name: 'view', args: { path: filler, view_range: [1, 3] } },
      ],
    }, { home });
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const max = sorted.at(-1);
  assert.ok(p95 < 50, `expected p95 < 50ms, received ${p95}`);
  assert.ok(max < 200, `expected max < 200ms, received ${max}`);
});

test('projection reports full non-research frontier elimination', () => {
  const projection = projectedFrontierReduction({
    baselineFrontierCredits: 2441,
    baselineResearchFrontierCredits: 122.05,
    candidateResearchFrontierCredits: 122.05,
    candidateNonResearchFrontierCredits: 0,
    assumptions: 'Assumes 5% of the seven-day Sol baseline was legitimate research and all remaining frontier credits were non-research.',
  });
  assert.equal(projection.baselineNonResearchFrontierCredits, 2318.95);
  assert.equal(projection.nonResearchFrontierCreditReduction, 1);
});
