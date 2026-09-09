#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contained, readAdapter } from './budget.mjs';
import { canonicalJson, sha256 } from './workflow.mjs';
import { mineCandidates } from './improvement-candidates.mjs';
import { createReplayPlan, incubateCandidate } from './improvement-replay.mjs';

const EVENT_KINDS = new Set([
  'user-prompt-submitted',
  'post-tool-use',
  'post-tool-use-failure',
  'subagent-stop',
  'agent-stop',
  'session-end',
  'workflow-complete',
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRIVATE_KEYS = new Set([
  'prompt',
  'initialPrompt',
  'last_assistant_message',
  'response',
  'result',
  'text_result_for_llm',
  'tool_input',
  'toolArgs',
  'environment',
  'env',
  'command',
  'stdout',
  'stderr',
  'content',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findRoot(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.statSync(path.join(current, '.github/agent-budget.json'),
      { throwIfNoEntry: false })?.isFile()) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function normalizeTimestamp(value) {
  const timestamp = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : value;
  const milliseconds = typeof timestamp === 'number'
    ? timestamp
    : Date.parse(timestamp);
  assert(Number.isFinite(milliseconds), 'Hook timestamp is invalid');
  return new Date(milliseconds).toISOString();
}

function scalarShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function normalizedKey(key) {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
    ? key.toLowerCase()
    : `field-${sha256(key).slice(0, 12)}`;
}

function argumentShape(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth >= 2) return scalarShape(value);
  if (Array.isArray(value)) {
    return { type: 'array', itemTypes: [...new Set(value.map(scalarShape))].sort() };
  }
  return Object.fromEntries(Object.keys(value)
    .filter(key => !PRIVATE_KEYS.has(key))
    .sort()
    .map(key => [normalizedKey(key), argumentShape(value[key], depth + 1)]));
}

function repositoryRelative(value, root) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)) return null;
  return relative || '.';
}

function pathClass(relative) {
  if (relative === null) return 'outside-repository';
  const top = relative.split(path.sep)[0] || 'repository-root';
  if (top === '.git') return 'git-metadata';
  if (top === 'src' || top === 'lib' || top === 'api' ||
    top === 'custom_components' || top.endsWith('Service')) return 'source';
  if (top === 'tests' || top === 'test' || top === 'e2e' ||
    top.endsWith('.Tests')) return 'test';
  if (top === 'docs') return 'documentation';
  if (top === '.github') return 'project-policy';
  if (top === 'scripts' || top === 'tools') return 'automation';
  return 'repository-other';
}

function pathMatches(relative, configured) {
  if (relative === null) return false;
  const normalized = relative.split(path.sep).join('/');
  return configured.some(entry =>
    normalized === entry || normalized.startsWith(`${entry.replace(/\/+$/, '')}/`));
}

function collectPathEvidence(value, root, policy, key = '', output = [], depth = 0) {
  if (depth > 4) return output;
  if (typeof value === 'string' && /(path|file|root|cwd|directory|target)/i.test(key)) {
    const relative = repositoryRelative(value, root);
    output.push({
      class: pathClass(relative),
      eligible: pathMatches(relative, policy.eligiblePaths),
      excluded: pathMatches(relative, policy.excludedPaths),
    });
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectPathEvidence(item, root, policy, key, output, depth + 1);
    }
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectPathEvidence(child, root, policy, childKey, output, depth + 1);
    }
  }
  return output;
}

function contentEvidence(...values) {
  const value = values.find(item =>
    typeof item === 'string' || Buffer.isBuffer(item));
  if (value === undefined) return { hash: null, bytes: null };
  return { hash: sha256(value), bytes: Buffer.byteLength(value) };
}

function inferToolEvidence(eventKind, toolId, rawArgs) {
  const normalized = toolId ?? '';
  const serializedKeys = Object.keys(rawArgs && typeof rawArgs === 'object' ? rawArgs : {})
    .join(':').toLowerCase();
  if (eventKind === 'subagent-stop' || normalized === 'task') {
    return {
      modelBacked: true,
      modelRole: rawArgs?.agent_type ?? rawArgs?.agentType ?? 'subagent',
    };
  }
  return { modelBacked: false, modelRole: null };
}

function normalizedCommandShape(command) {
  return command.trim().toLowerCase()
    .replace(/(["'])((?:\\.|(?!\1).)*)\1/g, '$1<value>$1')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hash>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<number>')
    .replace(/(?:^|\s)(?:\/|\.{1,2}\/)[^\s]+/g, ' <path>')
    .replace(/\s+/g, ' ');
}

function shellCommandEvidence(toolId, rawArgs) {
  if (!['bash', 'powershell'].includes(toolId)) return null;
  const command = typeof rawArgs?.command === 'string' ? rawArgs.command.trim() : '';
  if (!command) return {
    exactHash: null,
    normalizedHash: null,
    sideEffectClass: 'external',
    riskClass: 'opaque-command',
    safeLocal: false,
  };
  const exactHash = sha256(command);
  const normalizedHash = sha256(normalizedCommandShape(command));
  const unsafeSyntax = /[\n\r;|<>`]|\$\(|\$\{|\b(?:eval|source)\b/i.test(command);
  const liveOrDestructive = /\b(?:curl|wget|gh|ssh|scp|rsync|nc|ncat|telnet|ftp|http|https|push|pull|fetch|clone|deploy|release|publish|upload|download|rm|rmdir|del|remove-item|format|mkfs|dd|sudo|kubectl|helm|terraform|ansible|hass|home-assistant|psql|mysql|sqlite3)\b/i
    .test(command);
  if (unsafeSyntax || liveOrDestructive) return {
    exactHash,
    normalizedHash,
    sideEffectClass: 'external',
    riskClass: liveOrDestructive ? 'external-or-destructive-command' : 'opaque-command',
    safeLocal: false,
  };
  const segments = command.split(/\s*&&\s*/);
  const inventory = /^(?:git\s+(?:status|diff|show|log|rev-parse|ls-files)\b|pwd\b|ls\b|rg\b|grep\b)/i;
  const validation = /^(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test(?::[\w-]+)?|lint|build|check(?::[\w-]+)?))\b|node\s+--test\b|dotnet\s+(?:test|build)\b|pytest\b|python\s+-m\s+pytest\b|cargo\s+(?:test|check)\b|go\s+test\b)/i;
  const container = /^docker\s+(?:compose\s+)?(?:config|inspect|version|info)\b/i;
  if (segments.every(segment => inventory.test(segment.trim()))) return {
    exactHash,
    normalizedHash,
    sideEffectClass: 'none',
    riskClass: null,
    safeLocal: true,
  };
  if (segments.every(segment => validation.test(segment.trim()))) return {
    exactHash,
    normalizedHash,
    sideEffectClass: 'workspace',
    riskClass: null,
    safeLocal: true,
  };
  if (segments.every(segment => container.test(segment.trim()))) return {
    exactHash,
    normalizedHash,
    sideEffectClass: 'local-container',
    riskClass: null,
    safeLocal: true,
  };
  return {
    exactHash,
    normalizedHash,
    sideEffectClass: 'external',
    riskClass: 'opaque-command',
    safeLocal: false,
  };
}

function inferRisk(toolId, rawArgs, commandEvidence = null) {
  const id = toolId ?? '';
  if (['apply-patch', 'edit', 'create', 'write'].some(value => id.includes(value))) {
    return { sideEffectClass: 'workspace', riskClass: 'workspace-edit' };
  }
  if (id === 'bash' || id === 'powershell') {
    return {
      sideEffectClass: commandEvidence.sideEffectClass,
      riskClass: commandEvidence.riskClass,
    };
  }
  if (/github|network|web-fetch|web-search|curl|http/.test(id)) {
    return { sideEffectClass: 'external', riskClass: 'external-network' };
  }
  if (/hass|home-assistant|ha-call|ha-config/.test(id)) {
    return { sideEffectClass: 'live', riskClass: 'live-home-assistant' };
  }
  if (/sql|database|postgres|mysql|sqlite/.test(id)) {
    return { sideEffectClass: 'external', riskClass: 'database' };
  }
  if (/deploy|release|publish/.test(id)) {
    return { sideEffectClass: 'production', riskClass: 'production' };
  }
  if (rawArgs && typeof rawArgs === 'object' &&
    Object.keys(rawArgs).some(key => /token|secret|password|credential/i.test(key))) {
    return { sideEffectClass: 'external', riskClass: 'credential' };
  }
  return { sideEffectClass: 'none', riskClass: null };
}

function traceIdentity(payload, repositoryHash, sessionId, workflowId) {
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/i
    .exec(process.env.COPILOT_TRACEPARENT ?? '');
  return {
    traceId: match?.[1].toLowerCase() ??
      sha256(`trace:${repositoryHash}:${sessionId}`).slice(0, 32),
    parentSpanId: match?.[2].toLowerCase() ?? null,
    workflowId: workflowId ??
      sha256(`workflow:${repositoryHash}:${sessionId}:${payload.workflowId ?? ''}`),
  };
}

function transcriptMetadataHash(payload) {
  if (typeof payload.transcriptPath !== 'string') return null;
  const stat = fs.statSync(payload.transcriptPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) return sha256({ present: false });
  return sha256({
    present: true,
    bytes: stat.size,
    modifiedBucket: Math.floor(stat.mtimeMs / 60000),
  });
}

function stateRoot(home = process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot')) {
  return path.join(home, 'learning');
}

function sessionStateFile(home, repositoryHash, sessionId) {
  return path.join(stateRoot(home), repositoryHash, 'sessions', `${sessionId}.json`);
}

function markerFile(home, repositoryHash, workflowId) {
  return path.join(stateRoot(home), repositoryHash, 'markers', `${workflowId}.json`);
}

function pendingPromptFile(home, repositoryHash, sessionId) {
  return path.join(stateRoot(home), repositoryHash, 'sessions',
    `${sessionId}.pending-improvement.json`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivateJson(file, value, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    ...options,
  });
}

function selectedOpportunity(payload) {
  const values = [
    payload.opportunityId,
    payload.selectedOpportunity,
    payload.plan?.opportunityId,
    payload.plan?.opportunity,
  ];
  return values.find(value => typeof value === 'string' && ID_PATTERN.test(value)) ?? null;
}

function activeWorkflow(home, repositoryHash, sessionId) {
  const file = sessionStateFile(home, repositoryHash, sessionId);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  const state = readJson(file);
  const { stateHash, ...unsigned } = state;
  return stateHash === sha256(unsigned) ? state : null;
}

function activeWorkflowFiles(home, repositoryHash) {
  const directory = path.join(stateRoot(home), repositoryHash, 'sessions');
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(directory)
    .filter(name => name.endsWith('.json') &&
      !name.endsWith('.pending-improvement.json'))
    .sort()
    .map(name => path.join(directory, name));
}

export function beginPromptWorkflow(root, payload, options = {}) {
  const adapter = options.adapter ?? readAdapter(root);
  const repositoryHash = sha256(fs.realpathSync(root));
  const sessionId = sha256(`session:${payload.sessionId ?? 'unknown'}`);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const previous = activeWorkflow(home, repositoryHash, sessionId);
  const prompt = payload.prompt ?? payload.userPrompt ?? payload.initialPrompt ?? '';
  const promptEvidence = contentEvidence(prompt);
  const pendingFile = pendingPromptFile(home, repositoryHash, sessionId);
  const pending = fs.statSync(pendingFile, { throwIfNoEntry: false })?.isFile()
    ? readJson(pendingFile)
    : null;
  const improvementTask = pending?.promptHash === promptEvidence.hash &&
    pending?.markerHash === sha256({
      candidateId: pending.candidateId,
      promptHash: pending.promptHash,
    });
  if (improvementTask) fs.unlinkSync(pendingFile);
  const promptIndex = (previous?.promptIndex ?? 0) + 1;
  const timestamp = normalizeTimestamp(options.timestamp ?? payload.timestamp ?? Date.now());
  const opportunityId = selectedOpportunity(payload);
  const plan = payload.plan ?? payload.selectedPlan ?? null;
  const unsigned = {
    version: 1,
    repositoryHash,
    sessionId,
    workflowId: sha256({
      repositoryHash,
      sessionId,
      promptIndex,
      promptHash: promptEvidence.hash,
      timestamp,
    }),
    promptIndex,
    promptHash: promptEvidence.hash,
    promptBytes: promptEvidence.bytes,
    opportunityId,
    planHash: plan === null ? null : sha256(plan),
    improvementTask,
    startedAt: timestamp,
    project: adapter.project,
  };
  const state = { ...unsigned, stateHash: sha256(unsigned) };
  writePrivateJson(sessionStateFile(home, repositoryHash, sessionId), state);
  return state;
}

export function bindRecentPromptWorkflow(root, question, opportunityId, plan,
  options = {}) {
  assert(typeof question === 'string' && question.length > 0,
    'Workflow binding task question required');
  assert(ID_PATTERN.test(opportunityId), 'Workflow binding opportunity ID invalid');
  assert(plan?.opportunity === opportunityId &&
    plan.status === 'ready' &&
    plan.enabled !== false,
  'Only a ready enabled opportunity plan can bind a workflow');
  const repositoryHash = sha256(fs.realpathSync(root));
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const now = options.now ?? Date.now();
  const recentWindowMs = options.recentWindowMs ?? 30 * 60 * 1000;
  const promptHash = sha256(question);
  const matches = activeWorkflowFiles(home, repositoryHash)
    .map(readJson)
    .filter(state => {
      const { stateHash, ...unsigned } = state;
      const startedAt = Date.parse(state.startedAt);
      return stateHash === sha256(unsigned) &&
        state.repositoryHash === repositoryHash &&
        state.promptHash === promptHash &&
        state.planHash === null &&
        (state.opportunityId === null || state.opportunityId === opportunityId) &&
        Number.isFinite(startedAt) &&
        Math.abs(now - startedAt) <= recentWindowMs;
    });
  if (matches.length !== 1) {
    return {
      bound: false,
      reason: matches.length === 0
        ? 'no-unique-recent-prompt-hash-match'
        : 'ambiguous-recent-prompt-hash-match',
      matchCount: matches.length,
    };
  }
  const current = matches[0];
  const unsigned = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'stateHash')),
    opportunityId,
    planHash: sha256(plan),
  };
  const state = { ...unsigned, stateHash: sha256(unsigned) };
  writePrivateJson(sessionStateFile(home, repositoryHash, current.sessionId), state);
  return { bound: true, reason: 'unique-recent-prompt-hash-match', state };
}

export function bindPromptWorkflow(root, rawSessionId, opportunityId, plan,
  options = {}) {
  assert(typeof rawSessionId === 'string' && rawSessionId.length > 0,
    'Workflow binding session ID required');
  assert(ID_PATTERN.test(opportunityId), 'Workflow binding opportunity ID invalid');
  assert(plan?.opportunity === opportunityId &&
    plan.status === 'ready' &&
    plan.enabled !== false,
  'Only a ready enabled opportunity plan can bind a workflow');
  const repositoryHash = sha256(fs.realpathSync(root));
  const sessionId = sha256(`session:${rawSessionId}`);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const current = activeWorkflow(home, repositoryHash, sessionId);
  assert(current, 'No active prompt workflow for session');
  assert(current.opportunityId === null || current.opportunityId === opportunityId,
    'Active workflow opportunity is already bound differently');
  const unsigned = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'stateHash')),
    opportunityId,
    planHash: sha256(plan),
  };
  const state = { ...unsigned, stateHash: sha256(unsigned) };
  writePrivateJson(sessionStateFile(home, repositoryHash, sessionId), state);
  return state;
}

export function validateLearningPolicy(policy, project) {
  assert(policy?.version === 1 && policy.project === project,
    'Learning policy version/project mismatch');
  assert(typeof policy.enabled === 'boolean', 'Learning policy enabled flag required');
  assert(Number.isInteger(policy.retentionDays) &&
    policy.retentionDays >= 1 && policy.retentionDays <= 365,
  'Learning retention must be 1-365 days');
  const thresholds = policy.thresholds;
  assert(Number.isInteger(thresholds?.minimumSuccessfulWorkflows) &&
    thresholds.minimumSuccessfulWorkflows >= 2,
  'Learning workflow threshold invalid');
  assert(Number.isInteger(thresholds.minimumDistinctSessions) &&
    thresholds.minimumDistinctSessions >= 2,
  'Learning session threshold invalid');
  assert(typeof thresholds.minimumStability === 'number' &&
    thresholds.minimumStability >= 0 && thresholds.minimumStability <= 1,
  'Learning stability threshold invalid');
  assert(thresholds.maximumCandidatesPerWorkflow === 1,
    'Learning budget must be one candidate per workflow');
  assert(Number.isInteger(thresholds.minimumOperationCount) &&
    thresholds.minimumOperationCount >= 2,
  'Learning minimum operation count must be at least two');
  assert(Number.isInteger(thresholds.maximumSubgraphOperations) &&
    thresholds.maximumSubgraphOperations >= thresholds.minimumOperationCount &&
    thresholds.maximumSubgraphOperations <= 12,
  'Learning maximum subgraph operation count invalid');
  assert(Number.isInteger(thresholds.maximumAnalysisEvents) &&
    thresholds.maximumAnalysisEvents >= 100 && thresholds.maximumAnalysisEvents <= 20000,
  'Learning analysis event cap invalid');
  for (const key of ['priorities', 'eligiblePaths', 'excludedPaths',
    'riskClasses', 'validators']) {
    assert(Array.isArray(policy[key]), `Learning policy ${key} array required`);
  }
  for (const priority of policy.priorities) {
    assert(ID_PATTERN.test(priority.id) && ID_PATTERN.test(priority.opportunity),
      'Learning priorities require safe IDs');
    assert(Array.isArray(priority.validators) && priority.validators.length > 0,
      `${priority.id}: priority validators required`);
    assert(['tools', 'skills', 'fixtures'].includes(priority.destination),
      `${priority.id}: priority destination invalid`);
  }
  for (const key of ['incubation', 'tools', 'skills', 'fixtures']) {
    assert(typeof policy.destinations?.[key] === 'string' &&
      policy.destinations[key].length > 0,
    `Learning destination ${key} required`);
  }
  assert(typeof policy.automaticBuild === 'boolean',
    'Learning automaticBuild flag required');
  assert(typeof policy.automaticPromotion === 'boolean',
    'Learning automaticPromotion flag required');
  assert(policy.automaticPromotion === false,
    'Automatic promotion remains disabled');
  assert(policy.promotion?.requireReplay === true &&
    policy.promotion.requireProjectValidation === true &&
    policy.promotion.requireMediumReview === true &&
    policy.promotion.requirePositiveValue === true &&
    policy.promotion.requireScopeCheck === true &&
    policy.promotion.requireRollback === true,
  'Learning promotion gates must remain enabled');
  assert(Array.isArray(policy.promotion.allowedSideEffects) &&
    policy.promotion.allowedSideEffects.every(value =>
      ['none', 'workspace'].includes(value)),
  'Automatic learning side effects must remain repository-local');
  assert(typeof policy.continuation?.enabled === 'boolean',
    'Learning continuation policy required');
  return policy;
}

export function readLearningPolicy(root, adapter = readAdapter(root)) {
  assert(typeof adapter.learningPolicy === 'string',
    'Repository has no learning policy');
  const policy = validateLearningPolicy(
    JSON.parse(fs.readFileSync(contained(root, adapter.learningPolicy), 'utf8')),
    adapter.project,
  );
  const registeredTools = typeof adapter.toolRegistry === 'string'
    ? JSON.parse(fs.readFileSync(contained(root, adapter.toolRegistry), 'utf8'))
      .tools.map(tool => tool.id)
    : [];
  const projectSkills = fs.statSync(path.join(root, '.github/skills'),
    { throwIfNoEntry: false })?.isDirectory()
    ? fs.readdirSync(path.join(root, '.github/skills'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    : [];
  const personalSkillsRoot = path.join(
    process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot'),
    'skills',
  );
  const personalSkills = fs.statSync(personalSkillsRoot,
    { throwIfNoEntry: false })?.isDirectory()
    ? fs.readdirSync(personalSkillsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
    : [];
  return {
    ...policy,
    knownTools: [...new Set([...(policy.knownTools ?? []), ...registeredTools])].sort(),
    knownSkills: [...new Set([
      ...(policy.knownSkills ?? []),
      ...projectSkills,
      ...personalSkills,
    ])].sort(),
  };
}

function sessionOutcome(reason) {
  const normalized = String(reason ?? '').toLowerCase();
  if (/error|fail|timeout|crash/.test(normalized)) return 'failed';
  if (/cancel|reject|abort|interrupt/.test(normalized)) return 'rejected';
  if (/complete|success|done|end|user/.test(normalized)) return 'accepted';
  return 'failed';
}

export function sanitizeHookEvent(eventKind, payload, options = {}) {
  assert(EVENT_KINDS.has(eventKind), 'Unsupported learning event');
  assert(payload && typeof payload === 'object' && !Array.isArray(payload),
    'Hook payload must be an object');
  const discovered = options.root ?? findRoot(payload.cwd ?? process.cwd());
  assert(discovered, 'Repository root not found');
  const root = fs.realpathSync(discovered);
  const adapter = options.adapter ?? readAdapter(root);
  const policy = options.policy ?? readLearningPolicy(root, adapter);
  const repositoryHash = sha256(root);
  const sessionId = sha256(`session:${payload.sessionId ?? 'unknown'}`);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const workflowState = options.workflowState ??
    activeWorkflow(home, repositoryHash, sessionId);
  const trace = traceIdentity(payload, repositoryHash, sessionId,
    options.workflowId ?? workflowState?.workflowId);
  const toolId = typeof payload.toolName === 'string'
    ? payload.toolName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
    : null;
  const rawArgs = payload.toolArgs ?? payload.tool_input ?? {};
  const commandEvidence = shellCommandEvidence(toolId, rawArgs);
  const paths = collectPathEvidence(rawArgs, root, policy);
  const pathAffectingTool = /(?:^|-)(?:apply-patch|edit|create|write|view|glob|rg)(?:-|$)/
    .test(toolId ?? '') ||
    (['bash', 'powershell'].includes(toolId) && commandEvidence?.safeLocal !== true);
  const operation = toolId ? {
    toolId,
    argumentShape: argumentShape(rawArgs),
    pathClasses: [...new Set(paths.map(item => item.class))].sort(),
    commandShapeHash: commandEvidence?.normalizedHash ?? null,
  } : null;
  const resultEvidence = contentEvidence(
    payload.toolResult?.textResultForLlm,
    payload.tool_result?.text_result_for_llm,
    payload.result,
    payload.text_result_for_llm,
    payload.stdout,
  );
  const errorEvidence = contentEvidence(payload.error, payload.errorMessage,
    payload.stderr);
  const promptEvidence = contentEvidence(payload.prompt, payload.userPrompt,
    payload.initialPrompt);
  const subagentEvidence = contentEvidence(
    eventKind === 'subagent-stop'
      ? payload.response ?? payload.last_assistant_message
      : undefined,
  );
  const inferredModel = inferToolEvidence(eventKind, toolId, rawArgs);
  const inferredRisk = inferRisk(toolId, rawArgs, commandEvidence);
  const opportunityId = selectedOpportunity(payload) ??
    options.opportunityId ?? workflowState?.opportunityId ?? null;
  const resultClass = eventKind === 'post-tool-use-failure'
    ? 'abnormal-failure'
    : eventKind === 'post-tool-use'
      ? 'accepted'
      : eventKind === 'session-end'
        ? sessionOutcome(payload.reason)
        : ['accepted', 'rejected', 'failed', 'rollback', 'observed']
            .includes(payload.outcomeClass)
          ? payload.outcomeClass
          : 'observed';
  const record = {
    version: 1,
    schema: 'agent-learning-event-v1',
    traceId: trace.traceId,
    parentSpanId: trace.parentSpanId,
    sessionId,
    workflowId: trace.workflowId,
    projectId: adapter.project,
    opportunityId: ID_PATTERN.test(opportunityId ?? '') ? opportunityId : null,
    repositoryHash,
    revision: options.revision ?? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' }).trim(),
    timestamp: normalizeTimestamp(options.timestamp ?? payload.timestamp ?? Date.now()),
    eventKind,
    parentEventHash: options.previousEventHash ?? null,
    toolId,
    operationSignature: operation ? sha256(operation) : null,
    commandHash: commandEvidence?.exactHash ?? null,
    commandShapeHash: commandEvidence?.normalizedHash ?? null,
    pathClasses: operation?.pathClasses ?? [],
    eligiblePath: paths.length > 0
      ? paths.every(item => item.eligible)
      : !pathAffectingTool,
    pathEvidenceComplete: paths.length > 0 || !pathAffectingTool,
    excludedPath: paths.some(item => item.excluded),
    outputShape: payload.outputShape === undefined
      ? null : scalarShape(payload.outputShape),
    resultClass,
    sideEffectClass: options.sideEffectClass ?? inferredRisk.sideEffectClass,
    riskClass: options.riskClass ?? inferredRisk.riskClass,
    modelRole: options.modelRole ?? inferredModel.modelRole,
    modelProfileHash: options.modelProfile ? sha256(options.modelProfile) : null,
    modelBacked: options.modelBacked ?? inferredModel.modelBacked,
    promptHash: eventKind === 'user-prompt-submitted'
      ? promptEvidence.hash : null,
    promptBytes: eventKind === 'user-prompt-submitted'
      ? promptEvidence.bytes : null,
    resultHash: resultEvidence.hash,
    resultBytes: resultEvidence.bytes,
    errorHash: errorEvidence.hash,
    errorBytes: errorEvidence.bytes,
    responseHash: subagentEvidence.hash,
    responseBytes: subagentEvidence.bytes,
    transcriptMetadataHash: transcriptMetadataHash(payload),
    receiptHash: options.receiptHash ?? null,
    validatorClass: options.validatorClass ?? null,
    routingMiss: options.routingMiss === true,
    revisionEvent: options.revisionEvent === true || options.revision === true,
    improvementTask: workflowState?.improvementTask === true,
  };
  const retained = { ...record, retentionDays: policy.retentionDays };
  return { ...retained, eventHash: sha256(retained) };
}

function eventFile(home, event) {
  return path.join(stateRoot(home), event.repositoryHash, 'events',
    `${event.sessionId}.jsonl`);
}

function verifyEventSequence(events) {
  let previous = null;
  for (const event of events) {
    const { eventHash, ...unsigned } = event;
    assert(HASH_PATTERN.test(eventHash ?? '') && eventHash === sha256(unsigned),
      'Learning event hash mismatch');
    assert(event.parentEventHash === previous,
      'Learning event parent link mismatch');
    previous = eventHash;
  }
  return true;
}

export function appendSanitizedEvent(home, event) {
  const file = eventFile(home, event);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let fd = null;
  for (let attempt = 0; attempt < 5 && fd === null; attempt += 1) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.statSync(lock, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        fs.unlinkSync(lock);
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  assert(fd !== null, 'Learning event shard is busy');
  try {
    const existing = fs.statSync(file, { throwIfNoEntry: false })?.isFile()
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      : [];
    verifyEventSequence(existing);
    const { eventHash: ignored, ...unsigned } = event;
    void ignored;
    const linked = {
      ...unsigned,
      parentEventHash: existing.at(-1)?.eventHash ?? null,
    };
    fs.appendFileSync(file, `${canonicalJson({
      ...linked,
      eventHash: sha256(linked),
    })}\n`, { mode: 0o600 });
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
  return file;
}

function repositoryEventFiles(home, repositoryHash) {
  const directory = path.join(stateRoot(home), repositoryHash, 'events');
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort()
    .map(name => path.join(directory, name));
}

export function readRepositoryEventLedger(home, repositoryHash, maximumEvents = 20000) {
  const events = [];
  try {
    for (const file of repositoryEventFiles(home, repositoryHash)) {
      const expectedSessionId = path.basename(file, '.jsonl');
      const shard = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map(line => JSON.parse(line));
      if (events.length + shard.length > maximumEvents) {
        return { events: [], valid: false, reason: 'analysis-event-cap-exceeded' };
      }
      verifyEventSequence(shard);
      assert(shard.every(event =>
        event.version === 1 &&
        event.schema === 'agent-learning-event-v1' &&
        event.repositoryHash === repositoryHash &&
        event.sessionId === expectedSessionId &&
        typeof event.projectId === 'string' &&
        event.projectId.length > 0),
      'Learning event shard binding mismatch');
      events.push(...shard);
    }
    return { events, valid: true, reason: 'verified' };
  } catch {
    return { events: [], valid: false, reason: 'event-ledger-integrity-failed' };
  }
}

export function readRepositoryEvents(home, repositoryHash, maximumEvents = 20000) {
  return readRepositoryEventLedger(home, repositoryHash, maximumEvents).events;
}

export function pruneExpiredEvents(home, repositoryHash, retentionDays,
  now = Date.now()) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of repositoryEventFiles(home, repositoryHash)) {
    const shard = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line));
    verifyEventSequence(shard);
    const retained = shard.filter(event => {
      const keep = Date.parse(normalizeTimestamp(event.timestamp)) >= cutoff;
      if (!keep) removed += 1;
      return keep;
    });
    if (retained.length === 0) {
      fs.unlinkSync(file);
      continue;
    }
    let previous = null;
    const rechained = retained.map(event => {
      const { eventHash: ignored, ...unsigned } = event;
      void ignored;
      const linked = { ...unsigned, parentEventHash: previous };
      const next = { ...linked, eventHash: sha256(linked) };
      previous = next.eventHash;
      return next;
    });
    fs.writeFileSync(file, `${rechained.map(canonicalJson).join('\n')}\n`,
      { mode: 0o600 });
  }
  return removed;
}

function gitLearningRoot(root) {
  const value = execFileSync('git', ['-C', root, 'rev-parse', '--git-path',
    'copilot-learning'], { encoding: 'utf8' }).trim();
  return path.resolve(root, value);
}

function candidateLedgerFile(root, candidateId) {
  assert(ID_PATTERN.test(candidateId), 'Candidate ID must be safe kebab-case');
  return path.join(gitLearningRoot(root), 'candidates', candidateId, 'ledger.json');
}

function candidateLedgerUnsigned(candidate, existing = null) {
  return {
    version: 1,
    candidate,
    status: candidate.state,
    sourceWorkflowIds: candidate.sourceWorkflowIds,
    selectedPriority: candidate.selectedPriority,
    priorityOptions: candidate.priorityOptions ?? [],
    requiredValidators: candidate.requiredValidators,
    destination: candidate.destination,
    promptMarker: existing?.promptMarker ?? null,
    evidence: existing?.evidence ?? {},
    history: existing?.history ?? [],
    updatedAt: new Date().toISOString(),
  };
}

export function persistCandidateLedger(root, candidate, update = {}) {
  const file = candidateLedgerFile(root, candidate.id);
  const existing = fs.statSync(file, { throwIfNoEntry: false })?.isFile()
    ? readCandidateLedger(root, candidate.id)
    : null;
  const unsigned = {
    ...candidateLedgerUnsigned(candidate, existing),
    ...update,
    candidate,
    status: update.status ?? candidate.state,
    history: [
      ...(existing?.history ?? []),
      ...(update.history ?? []),
    ],
  };
  const ledger = { ...unsigned, ledgerHash: sha256(unsigned) };
  writePrivateJson(file, ledger);
  return ledger;
}

export function readCandidateLedger(root, candidateId) {
  const ledger = readJson(candidateLedgerFile(root, candidateId));
  const { ledgerHash, ...unsigned } = ledger;
  assert(ledgerHash === sha256(unsigned), 'Candidate ledger integrity failed');
  assert(ledger.candidate?.id === candidateId, 'Candidate ledger ID mismatch');
  return ledger;
}

function resolvedCoordinator(root, adapter, opportunityId) {
  if (!adapter.opportunityPolicy || !opportunityId) return null;
  const policy = readJson(contained(root, adapter.opportunityPolicy));
  const opportunity = policy.opportunities?.find(item => item.id === opportunityId);
  return opportunity?.team?.coordinator ?? null;
}

export function decideAgentStop(root, payload, options = {}) {
  const started = Date.now();
  const adapter = options.adapter ?? readAdapter(root);
  if (!adapter.learningPolicy) return { action: 'allow', reason: 'no-learning-policy' };
  const policy = options.policy ?? readLearningPolicy(root, adapter);
  if (!policy.enabled) return { action: 'allow', reason: 'learning-disabled' };
  if (policy.continuation.enabled !== true || policy.automaticBuild !== true) {
    return { action: 'allow', reason: 'automatic-build-disabled' };
  }
  if (payload.stop_hook_active === true) return { action: 'allow', reason: 'stop-hook-active' };
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const event = sanitizeHookEvent('agent-stop', payload, {
    ...options,
    home,
    root,
    adapter,
    policy,
  });
  if (event.improvementTask) {
    appendSanitizedEvent(home, event);
    return { action: 'allow', reason: 'improvement-recursion-guard' };
  }
  appendSanitizedEvent(home, event);
  const ledger = readRepositoryEventLedger(home, event.repositoryHash,
    policy.thresholds.maximumAnalysisEvents);
  if (!ledger.valid) return { action: 'allow', reason: ledger.reason };
  const result = mineCandidates(ledger.events, policy, {
    opportunityId: event.opportunityId,
  });
  if (Date.now() - started > 8000) {
    return { action: 'allow', reason: 'analysis-time-budget-exceeded' };
  }
  if (result.decision !== 'candidate') {
    return { action: 'allow', reason: result.reason, result };
  }
  if (fs.statSync(candidateLedgerFile(root, result.candidate.id),
    { throwIfNoEntry: false })?.isFile()) {
    return { action: 'allow', reason: 'candidate-already-recorded', result };
  }
  const marker = markerFile(home, event.repositoryHash, event.workflowId);
  if (fs.existsSync(marker)) return { action: 'allow', reason: 'already-prompted', result };
  const coordinator = resolvedCoordinator(root, adapter,
    result.candidate.opportunityId);
  const prepareCommand = `node "$HOME/.copilot/skills/budget-workflow/scripts/` +
    `continuous-improvement.mjs" prepare-candidate ${JSON.stringify(root)} ` +
    `${result.candidate.id}`;
  const selectionCommands = (result.candidate.priorityOptions ?? []).map(option =>
    `node "$HOME/.copilot/skills/budget-workflow/scripts/continuous-improvement.mjs" ` +
    `select-priority ${JSON.stringify(root)} ${result.candidate.id} ${option.id}`);
  const selection = result.candidate.requiresPrioritySelection === true
    ? `First choose exactly one ranked project priority as the resolved medium ` +
      `coordinator and run its matching command: ${selectionCommands.join(' OR ')}. ` +
      `Then run exactly: ${prepareCommand}.`
    : `Run exactly: ${prepareCommand}.`;
  const task = `${selection} Then delegate implementation to the resolved ` +
    `${coordinator?.role ?? 'project medium-coordinator'} ` +
    `(${coordinator?.profile?.model ?? 'project policy model'}, ` +
    `${coordinator?.profile?.effort ?? 'medium'} effort) for opportunity ` +
    `${result.candidate.opportunityId}. Build and validate the candidate without ` +
    `changing the completed user outcome or performing external/live effects.`;
  const markerValue = {
    version: 1,
    workflowId: event.workflowId,
    candidateId: result.candidate.id,
    promptHash: sha256(task),
  };
  markerValue.markerHash = sha256({
    workflowId: markerValue.workflowId,
    candidateId: markerValue.candidateId,
    promptHash: markerValue.promptHash,
  });
  writePrivateJson(marker, markerValue, { flag: 'wx' });
  writePrivateJson(pendingPromptFile(home, event.repositoryHash, event.sessionId), {
    candidateId: result.candidate.id,
    promptHash: markerValue.promptHash,
    markerHash: sha256({
      candidateId: result.candidate.id,
      promptHash: markerValue.promptHash,
    }),
  });
  persistCandidateLedger(root, result.candidate, {
    promptMarker: markerValue,
    history: [{
      action: 'continuation-requested',
      evidenceHash: sha256(markerValue),
    }],
  });
  return {
    action: 'block',
    reason: 'eligible-learning-candidate',
    candidate: result.candidate,
    command: result.candidate.requiresPrioritySelection === true
      ? selectionCommands : prepareCommand,
    task,
  };
}

export function createWorkflowCompletionObservation(input) {
  const observation = {
    version: 1,
    kind: 'learning-workflow-completion',
    workflowId: input.workflowId,
    project: input.project,
    opportunityId: input.opportunityId,
    repositoryHash: input.repositoryHash,
    pipelineHash: input.pipelineHash,
    verifiedPipelineReceiptHash: input.verifiedPipelineReceiptHash,
    traceHash: input.traceHash,
    transcriptMetadataHash: input.transcriptMetadataHash ?? null,
    usageHash: input.usageHash,
    outcome: input.outcome,
    candidateId: input.candidateId ?? null,
    candidateState: input.candidateState ?? 'observed',
    observedAt: normalizeTimestamp(input.observedAt),
  };
  for (const key of ['workflowId', 'project', 'opportunityId', 'repositoryHash',
    'pipelineHash', 'verifiedPipelineReceiptHash', 'traceHash', 'usageHash',
    'outcome', 'observedAt']) {
    assert(typeof observation[key] === 'string' && observation[key].length > 0,
      `Learning completion ${key} required`);
  }
  return { ...observation, receiptHash: sha256(observation) };
}

export function verifyWorkflowCompletionObservation(receipt, context) {
  const { receiptHash, ...unsigned } = receipt;
  assert(receipt.kind === 'learning-workflow-completion',
    'Learning completion receipt required');
  assert(receiptHash === sha256(unsigned), 'Learning completion receipt hash mismatch');
  for (const key of ['workflowId', 'project', 'opportunityId', 'repositoryHash',
    'pipelineHash', 'verifiedPipelineReceiptHash']) {
    assert(receipt[key] === context[key], `Learning completion ${key} mismatch`);
  }
  return receipt;
}

export function persistWorkflowCompletion(root, receipt, options = {}) {
  const verified = verifyWorkflowCompletionObservation(receipt, receipt);
  assert(verified.repositoryHash === sha256(fs.realpathSync(root)),
    'Learning completion repository mismatch');
  const adapter = options.adapter ?? readAdapter(root);
  assert(adapter.project === receipt.project, 'Learning completion project mismatch');
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const event = sanitizeHookEvent('workflow-complete', {
    cwd: root,
    sessionId: `pipeline-${receipt.workflowId}`,
    timestamp: receipt.observedAt,
    opportunityId: receipt.opportunityId,
    outcomeClass: receipt.outcome,
  }, {
    root,
    adapter,
    home,
    workflowId: receipt.workflowId,
    opportunityId: receipt.opportunityId,
    receiptHash: receipt.receiptHash,
  });
  appendSanitizedEvent(home, event);
  return event;
}

function prepareCandidate(root, candidateId) {
  const adapter = readAdapter(root);
  const policy = readLearningPolicy(root, adapter);
  const ledger = readCandidateLedger(root, candidateId);
  assert(ledger.candidate.requiresPrioritySelection !== true &&
    typeof ledger.candidate.selectedPriority === 'string',
  'Candidate priority must be explicitly selected before preparation');
  const plan = createReplayPlan(ledger.candidate, []);
  const incubation = incubateCandidate(root, ledger.candidate, plan, policy);
  const updated = persistCandidateLedger(root, incubation.candidate, {
    status: 'incubating',
    evidence: {
      ...ledger.evidence,
      incubation: incubation.evidenceHash,
    },
    history: [{
      action: 'incubation-prepared',
      evidenceHash: incubation.evidenceHash,
    }],
  });
  return { directory: incubation.directory, ledger: updated };
}

function selectCandidatePriority(root, candidateId, priorityId) {
  assert(ID_PATTERN.test(priorityId), 'Candidate priority ID invalid');
  const ledger = readCandidateLedger(root, candidateId);
  assert(ledger.status === 'eligible', 'Candidate priority selection requires eligible state');
  assert(ledger.candidate.requiresPrioritySelection === true,
    'Candidate does not require priority selection');
  const option = ledger.candidate.priorityOptions?.find(item => item.id === priorityId);
  assert(option, 'Candidate priority is not one of the ranked options');
  const candidate = {
    ...ledger.candidate,
    selectedPriority: option.id,
    requiredValidators: [...option.validators].sort(),
    destination: ledger.candidate.forcedClass === 'reusable-skill'
      ? 'skills'
      : option.destination,
    class: ledger.candidate.forcedClass ?? option.class,
    requiresPrioritySelection: false,
  };
  return persistCandidateLedger(root, candidate, {
    status: 'eligible',
    history: [{
      action: 'priority-selected',
      priorityId,
      evidenceHash: sha256(option),
    }],
  });
}

function recordCandidateEvidence(root, candidateId, evidenceType, receiptFile) {
  const contracts = {
    artifact: ['candidate-artifact', 'evidenceHash'],
    integration: ['candidate-integration', 'evidenceHash'],
    replay: ['candidate-replay', 'replayHash'],
    'project-validation': ['candidate-project-validation', 'evidenceHash'],
    'medium-review': ['candidate-medium-review', 'evidenceHash'],
    'scope-tree': ['candidate-scope-tree', 'evidenceHash'],
    rollback: ['candidate-rollback', 'evidenceHash'],
    accounting: ['candidate-accounting', 'accountingHash'],
  };
  assert(contracts[evidenceType], 'Unknown candidate evidence type');
  const ledger = readCandidateLedger(root, candidateId);
  const receipt = readJson(receiptFile);
  const [expectedKind, hashKey] = contracts[evidenceType];
  assert(receipt.kind === expectedKind && receipt.candidateId === candidateId,
    'Candidate evidence receipt contract mismatch');
  const { [hashKey]: receiptHash, ...unsigned } = receipt;
  assert(HASH_PATTERN.test(receiptHash ?? '') && receiptHash === sha256(unsigned),
    'Candidate evidence receipt hash mismatch');
  const updated = persistCandidateLedger(root, ledger.candidate, {
    evidence: { ...ledger.evidence, [evidenceType]: receiptHash },
    history: [{ action: `evidence:${evidenceType}`, evidenceHash: receiptHash }],
  });
  return updated;
}

function parseStdin() {
  const text = fs.readFileSync(0, 'utf8');
  return text.trim() ? JSON.parse(text) : {};
}

function hookEventName(command) {
  return {
    'user-prompt-submitted': 'userPromptSubmitted',
    'post-tool-use': 'postToolUse',
    'post-tool-use-failure': 'postToolUseFailure',
    'subagent-stop': 'subagentStop',
    'agent-stop': 'agentStop',
    'session-end': 'sessionEnd',
  }[command] ?? null;
}

function main() {
  const [event, first, second, third] = process.argv.slice(2);
  if (event === 'validate') {
    const root = fs.realpathSync(first ?? process.cwd());
    const policy = readLearningPolicy(root, readAdapter(root));
    process.stdout.write(`${JSON.stringify({
      valid: true,
      project: policy.project,
      priorities: policy.priorities.length,
      automaticBuild: policy.automaticBuild,
      automaticPromotion: policy.automaticPromotion,
      continuation: policy.continuation.enabled,
    }, null, 2)}\n`);
    return;
  }
  if (event === 'select-priority') {
    assert(first && second && third,
      'Usage: continuous-improvement.mjs select-priority ROOT ID PRIORITY_ID');
    process.stdout.write(`${JSON.stringify(selectCandidatePriority(
      fs.realpathSync(first), second, third,
    ), null, 2)}\n`);
    return;
  }
  if (event === 'status') {
    const root = fs.realpathSync(first ?? process.cwd());
    const policy = readLearningPolicy(root, readAdapter(root));
    const repositoryHash = sha256(root);
    const home = process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
    const eventLedger = readRepositoryEventLedger(home, repositoryHash,
      policy.thresholds.maximumAnalysisEvents);
    const candidatesRoot = path.join(gitLearningRoot(root), 'candidates');
    const candidates = fs.statSync(candidatesRoot, { throwIfNoEntry: false })?.isDirectory()
      ? fs.readdirSync(candidatesRoot).sort().map(id => readCandidateLedger(root, id))
      : [];
    process.stdout.write(`${JSON.stringify({
      project: policy.project,
      eventCount: eventLedger.events.length,
      eventLedger: { valid: eventLedger.valid, reason: eventLedger.reason },
      mining: eventLedger.valid ? mineCandidates(eventLedger.events, policy) : null,
      candidates,
    }, null, 2)}\n`);
    return;
  }
  if (event === 'prepare-candidate') {
    assert(first && second, 'Usage: continuous-improvement.mjs prepare-candidate ROOT ID');
    process.stdout.write(`${JSON.stringify(prepareCandidate(
      fs.realpathSync(first), second,
    ), null, 2)}\n`);
    return;
  }
  if (event === 'bind-workflow') {
    assert(first && second && third,
      'Usage: continuous-improvement.mjs bind-workflow ROOT SESSION_ID OPPORTUNITY_ID PLAN.json');
    const planFile = process.argv[6];
    assert(planFile, 'Workflow binding plan file required');
    process.stdout.write(`${JSON.stringify(bindPromptWorkflow(
      fs.realpathSync(first), second, third, readJson(planFile),
    ), null, 2)}\n`);
    return;
  }
  if (event === 'record-evidence') {
    assert(first && second && third,
      'Usage: continuous-improvement.mjs record-evidence ROOT ID TYPE RECEIPT.json');
    const receiptFile = process.argv[6];
    assert(receiptFile, 'Evidence receipt file required');
    process.stdout.write(`${JSON.stringify(recordCandidateEvidence(
      fs.realpathSync(first), second, third, receiptFile,
    ), null, 2)}\n`);
    return;
  }
  if (event === 'record-completion') {
    assert(first && second,
      'Usage: continuous-improvement.mjs record-completion ROOT RECEIPT.json');
    process.stdout.write(`${JSON.stringify(persistWorkflowCompletion(
      fs.realpathSync(first), readJson(second),
    ), null, 2)}\n`);
    return;
  }
  assert(hookEventName(event), 'Unknown continuous-improvement hook command');
  const payload = parseStdin();
  const root = findRoot(payload.cwd ?? process.cwd());
  if (!root) {
    process.stdout.write('{}');
    return;
  }
  const adapter = readAdapter(root);
  if (!adapter.learningPolicy) {
    process.stdout.write('{}');
    return;
  }
  const policy = readLearningPolicy(root, adapter);
  const home = process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  if (event === 'user-prompt-submitted') {
    const workflowState = beginPromptWorkflow(root, payload, { home, adapter });
    appendSanitizedEvent(home, sanitizeHookEvent(event, payload, {
      root, adapter, policy, home, workflowState,
    }));
    process.stdout.write('{}');
    return;
  }
  if (event === 'agent-stop') {
    const decision = decideAgentStop(root, payload, { home, adapter, policy });
    process.stdout.write(decision.action === 'block'
      ? JSON.stringify({ decision: 'block', reason: decision.task })
      : '{}');
    return;
  }
  const record = sanitizeHookEvent(event, payload, { root, adapter, policy, home });
  appendSanitizedEvent(home, record);
  if (event === 'session-end') {
    pruneExpiredEvents(home, record.repositoryHash, policy.retentionDays);
  }
  process.stdout.write('{}');
}

if (process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    if (hookEventName(process.argv[2])) {
      process.stdout.write('{}');
    } else {
      console.error(`continuous-improvement: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
