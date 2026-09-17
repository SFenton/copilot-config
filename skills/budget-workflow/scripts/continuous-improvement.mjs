#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contained, readAdapter } from './budget.mjs';
import { fsyncDirectory } from './durability.mjs';
import { AUTOMATIC_ROUTE_ROLE_CATALOG } from './model-catalog.mjs';
import {
  DISPATCH_ROLE_CATALOG,
  expectedTaskContract,
} from './effective-contract.mjs';
import {
  canonicalJson,
  sha256,
  validateOpportunityPolicyV2,
  validateToolRegistry,
} from './workflow.mjs';
import { mineCandidates } from './improvement-candidates.mjs';
import { createReplayPlan, incubateCandidate } from './improvement-replay.mjs';
import { validateOpportunityPolicyV3 } from './team-pipeline.mjs';
import { normalizeUsage } from './usage.mjs';

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
const UUID_SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FRONTIER_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-sol-fast',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
]);
const SESSION_MECHANICAL_TOOL_CATEGORIES = new Set([
  'repository-read',
  'repository-search',
  'repository-edit',
  'shell',
  'tests',
  'review',
  'history-sql',
  'workflow-sql',
  'web',
  'github',
  'browser',
  'mcp',
  'documentation',
  'memory-vote',
  'memory-store',
  'git',
  'schedule',
  'other',
]);
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function findRoot(cwd) {
  try {
    return fs.realpathSync(execFileSync('git', [
      '-C', path.resolve(cwd), 'rev-parse', '--show-toplevel',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
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

function profileFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const model = value.selectedModel ?? value.selected_model ?? value.newModel ??
    value.new_model ?? value.model;
  const effort = value.reasoningEffort ?? value.reasoning_effort ?? value.effort;
  const context = value.contextTier ?? value.context_tier ?? value.context;
  if (typeof model !== 'string' || typeof effort !== 'string' || model.length === 0 ||
    effort.length === 0) {
    return null;
  }
  return {
    model,
    effort,
    context: typeof context === 'string' && context.length > 0 ? context : 'default',
  };
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

function safeSessionStateId(value) {
  assert(typeof value === 'string' && value.trim().length > 0,
    'Session identifier required');
  const sessionId = value.trim();
  assert(!sessionId.includes(path.sep) && sessionId !== '.' && sessionId !== '..',
    'Session identifier is invalid');
  return sessionId;
}

function sessionComplianceFile(home, repositoryHash, sessionId) {
  return path.join(stateRoot(home), repositoryHash, 'compliance',
    `${sessionId}.json`);
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

function writePrivateJsonAtomic(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    renamed = true;
    fs.chmodSync(file, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (!renamed && fs.statSync(temporary, { throwIfNoEntry: false })?.isFile()) {
      fs.unlinkSync(temporary);
    }
  }
}

function classifyOptionalReportingFailure(error) {
  if (!error || typeof error !== 'object') return 'unexpected';
  switch (error.code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'ENOSPC':
      return 'no-space';
    case 'EEXIST':
      return 'already-exists';
    case 'EIO':
    case 'EROFS':
    case 'EXDEV':
      return 'io-failure';
    default:
      return 'io-failure';
  }
}

function optionalReportingFailure(stage, error) {
  return {
    stage,
    classification: classifyOptionalReportingFailure(error),
  };
}

function gitOutput(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function safePolicyPath(relative) {
  assert(typeof relative === 'string' && relative.length > 0 &&
    !path.isAbsolute(relative), 'Project policy path must be repository-relative');
  const normalized = path.posix.normalize(relative.replaceAll(path.sep, '/'));
  assert(normalized !== '..' && !normalized.startsWith('../') &&
    normalized !== '.git' && !normalized.startsWith('.git/'),
  'Project policy path escapes repository');
  return normalized;
}

function validateAdapterDocument(adapter, readText) {
  assert(adapter?.version === 1 && typeof adapter.project === 'string' &&
    adapter.project.length > 0, 'Invalid adapter version/project');
  for (const key of ['instructions', 'riskTerms', 'gates']) {
    assert(Array.isArray(adapter[key]) &&
      adapter[key].every(item => typeof item === 'string'),
    `Invalid adapter ${key}`);
  }
  assert(adapter.instructions.length > 0 && adapter.gates.length > 0,
    'Adapter must retain instructions and gates');
  for (const instruction of adapter.instructions) readText(safePolicyPath(instruction));
  for (const key of [
    'learningPolicy',
    'opportunityPolicy',
    'toolRegistry',
    'opportunityEvaluation',
    'workerEvaluation',
    'delegationPolicy',
    'releaseMachine',
    'destructiveMaintenanceMachine',
  ]) {
    if (Object.hasOwn(adapter, key)) {
      assert(typeof adapter[key] === 'string' && adapter[key].length > 0,
        `Invalid adapter ${key}`);
      readText(safePolicyPath(adapter[key]));
    }
  }
  return adapter;
}

function validateOpportunityHintPolicy(value, project) {
  assert(value && typeof value === 'object' && value.project === project,
    'Opportunity policy project mismatch');
  assert([1, 2, 3].includes(value.version) &&
    Array.isArray(value.opportunities) && value.opportunities.length > 0,
  'Opportunity policy is invalid');
  for (const opportunity of value.opportunities) {
    assert(ID_PATTERN.test(opportunity.id), 'Opportunity policy ID is invalid');
    if (opportunity.triggers !== undefined) {
      assert(Array.isArray(opportunity.triggers) &&
        opportunity.triggers.every(trigger =>
          typeof trigger === 'string' && trigger.length > 1),
      'Opportunity trigger policy is invalid');
    }
  }
  return value;
}

function loadPolicyBundle(readText, source) {
  const adapter = validateAdapterDocument(
    JSON.parse(readText('.github/agent-budget.json')),
    readText,
  );
  assert(typeof adapter.learningPolicy === 'string',
    'Repository has no learning policy');
  const policy = validateLearningPolicy(
    JSON.parse(readText(safePolicyPath(adapter.learningPolicy))),
    adapter.project,
  );
  const registry = typeof adapter.toolRegistry === 'string'
    ? validateToolRegistry(
        JSON.parse(readText(safePolicyPath(adapter.toolRegistry))),
        adapter.project,
      )
    : { version: 1, project: adapter.project, tools: [] };
  const opportunityEvaluationPacket =
    typeof adapter.opportunityEvaluation === 'string'
      ? JSON.parse(readText(safePolicyPath(adapter.opportunityEvaluation)))
      : null;
  const workerEvaluationPacket = typeof adapter.workerEvaluation === 'string'
    ? JSON.parse(readText(safePolicyPath(adapter.workerEvaluation)))
    : null;
  const opportunityPolicy = typeof adapter.opportunityPolicy === 'string'
    ? JSON.parse(readText(safePolicyPath(adapter.opportunityPolicy)))
    : null;
  if (opportunityPolicy?.version === 3) {
    validateOpportunityPolicyV3(opportunityPolicy, registry, {
      opportunityPacket: opportunityEvaluationPacket,
      workerPacket: workerEvaluationPacket,
    });
  } else if (opportunityPolicy?.version === 2) {
    validateOpportunityPolicyV2(opportunityPolicy, registry);
  } else if (opportunityPolicy !== null) {
    validateOpportunityHintPolicy(opportunityPolicy, adapter.project);
  }
  const sourceHash = sha256({
    adapter,
    policy,
    toolRegistry: registry,
    opportunityPolicy,
    opportunityEvaluationPacket,
    workerEvaluationPacket,
  });
  return {
    adapter,
    policy: {
      ...policy,
      knownTools: [...new Set([
        ...(policy.knownTools ?? []),
        ...registry.tools.map(tool => tool.id),
      ])].sort(),
    },
    toolRegistry: registry,
    opportunityPolicy,
    opportunityEvaluationPacket,
    workerEvaluationPacket,
    source: { ...source, sourceHash },
  };
}

function currentPolicyBundle(root, options = {}) {
  const adapterFile = path.join(root, '.github/agent-budget.json');
  if (!fs.statSync(adapterFile, { throwIfNoEntry: false })?.isFile()) return null;
  try {
    const bundle = loadPolicyBundle(relative => {
      const file = path.resolve(root, safePolicyPath(relative));
      const resolved = fs.realpathSync(file);
      const relation = path.relative(root, resolved);
      assert(relation !== '..' && !relation.startsWith(`..${path.sep}`),
        'Project policy path escapes repository');
      return fs.readFileSync(resolved, 'utf8');
    }, {
      kind: 'worktree',
      ref: null,
      revision: gitOutput(root, ['rev-parse', 'HEAD']),
    });
    const projectSkills = fs.statSync(path.join(root, '.github/skills'),
      { throwIfNoEntry: false })?.isDirectory()
      ? fs.readdirSync(path.join(root, '.github/skills'), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
      : [];
    return {
      ...bundle,
      policy: {
        ...bundle.policy,
        knownSkills: [...new Set([
          ...(bundle.policy.knownSkills ?? []),
          ...projectSkills,
        ])].sort(),
      },
    };
  } catch (error) {
    if (options.failOnInvalidCurrent === false) return null;
    throw new Error(`Current repository policy bundle is invalid: ${error.message}`);
  }
}

function maybeCurrentPolicyBundle(root) {
  try {
    return currentPolicyBundle(root, { failOnInvalidCurrent: false });
  } catch {
    return null;
  }
}

function minimalLifecyclePolicy(project) {
  return {
    version: 1,
    project,
    enabled: false,
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
    priorities: [],
    destinations: {
      incubation: '.git/copilot-learning',
      tools: '.github/learned-tools',
      skills: '.github/skills',
      fixtures: 'tests/fixtures/learning',
    },
    eligiblePaths: ['.'],
    excludedPaths: ['.env', 'secrets'],
    riskClasses: [],
    validators: [],
    knownTools: [],
    knownSkills: [],
    automaticBuild: false,
    automaticPromotion: false,
    continuation: { enabled: false },
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

function lifecycleContext(root, options = {}) {
  try {
    return options.context ?? resolveContext(root, options);
  } catch {
    const adapter = maybeCurrentPolicyBundle(root)?.adapter ??
      (() => {
        try {
          return readAdapter(root);
        } catch {
          return {
            version: 1,
            project: path.basename(root),
            instructions: [],
            riskTerms: [],
            gates: [],
          };
        }
      })();
    return {
      root,
      adapter,
      policy: minimalLifecyclePolicy(adapter.project),
      toolRegistry: { version: 1, project: adapter.project, tools: [] },
      opportunityPolicy: null,
      opportunityEvaluationPacket: null,
      workerEvaluationPacket: null,
      source: {
        kind: 'advisory-no-learning-policy',
        ref: null,
        revision: gitOutput(root, ['rev-parse', 'HEAD']),
        sourceHash: sha256({ project: adapter.project, root }),
      },
      identity: logicalRepositoryIdentity(root, adapter.project),
    };
  }
}

function configuredRemote(root) {
  const upstream = gitOutput(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name',
    '@{upstream}']);
  if (upstream?.includes('/')) return upstream.split('/')[0];
  const pushDefault = gitOutput(root, ['config', '--get', 'remote.pushDefault']);
  if (pushDefault) return pushDefault;
  const remotes = (gitOutput(root, ['remote']) ?? '').split('\n').filter(Boolean);
  if (remotes.includes('origin')) return 'origin';
  if (remotes.includes('upstream')) return 'upstream';
  return remotes.length === 1 ? remotes[0] : null;
}

function fallbackPolicyRefGroups(root) {
  const groups = [];
  const remote = configuredRemote(root);
  if (remote) {
    const remoteHead = gitOutput(root, ['symbolic-ref', '--quiet', '--short',
      `refs/remotes/${remote}/HEAD`]);
    if (remoteHead) groups.push([remoteHead]);
    const upstream = gitOutput(root, ['rev-parse', '--abbrev-ref',
      '--symbolic-full-name', '@{upstream}']);
    if (upstream && /\/(?:main|master)$/.test(upstream)) groups.push([upstream]);
  }
  groups.push(['origin/master', 'origin/main', 'upstream/main']);
  return groups.map(group => [...new Set(group)].filter(ref =>
    gitOutput(root, ['rev-parse', '--verify', `${ref}^{commit}`])));
}

function fallbackPolicyBundle(root, options = {}) {
  for (const refs of fallbackPolicyRefGroups(root)) {
    const valid = [];
    for (const ref of refs) {
      const revision = gitOutput(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
      try {
        const bundle = loadPolicyBundle(relative => execFileSync('git', [
          '-C', root, 'show', `${ref}:${safePolicyPath(relative)}`,
        ], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }), {
          kind: 'git-ref',
          ref,
          revision,
        });
        if (!options.requireOpportunityPolicyV3 ||
          bundle.opportunityPolicy?.version === 3) {
          valid.push(bundle);
        }
      } catch {
        // Invalid refs are not policy sources.
      }
    }
    const unique = new Map(valid.map(bundle => [
      `${bundle.source.revision}:${bundle.source.sourceHash}`,
      bundle,
    ]));
    if (unique.size === 1) return unique.values().next().value;
    assert(unique.size === 0,
      'Repository has ambiguous default-branch learning policy sources');
  }
  throw new Error('Repository has no valid learning policy source');
}

export function readEffectiveOpportunityPolicyBundle(root) {
  const gitRoot = findRoot(root);
  assert(gitRoot, 'Repository root not found');
  const current = currentPolicyBundle(gitRoot);
  const bundle = current?.opportunityPolicy?.version === 3
    ? current
    : fallbackPolicyBundle(gitRoot, { requireOpportunityPolicyV3: true });
  return { root: gitRoot, ...bundle };
}

export function readEffectiveProjectPolicy(root) {
  const gitRoot = findRoot(root);
  assert(gitRoot, 'Repository root not found');
  const current = currentPolicyBundle(gitRoot);
  const bundle = current ?? fallbackPolicyBundle(gitRoot);
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
    root: gitRoot,
    ...bundle,
    policy: {
      ...bundle.policy,
      knownSkills: [...new Set([
        ...(bundle.policy.knownSkills ?? []),
        ...personalSkills,
      ])].sort(),
    },
  };
}

function normalizedRemoteIdentity(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let host;
  let repositoryPath;
  try {
    const parsed = new URL(value);
    host = parsed.hostname.toLowerCase();
    repositoryPath = decodeURIComponent(parsed.pathname);
  } catch {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
    if (!scp) return null;
    host = scp[1].toLowerCase();
    repositoryPath = scp[2];
  }
  const normalizedPath = repositoryPath.replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '').toLowerCase();
  return host && normalizedPath ? `${host}/${normalizedPath}` : null;
}

export function logicalRepositoryIdentity(root, project) {
  const remote = configuredRemote(root);
  const candidates = [
    remote,
    'origin',
    'upstream',
  ].filter(Boolean);
  let identity = null;
  for (const name of [...new Set(candidates)]) {
    identity = normalizedRemoteIdentity(gitOutput(root, ['remote', 'get-url', name]));
    if (identity) break;
  }
  if (!identity) {
    const identities = [...new Set((gitOutput(root, ['remote']) ?? '')
      .split('\n')
      .filter(Boolean)
      .map(name => normalizedRemoteIdentity(
        gitOutput(root, ['remote', 'get-url', name])))
      .filter(Boolean))];
    if (identities.length === 1) [identity] = identities;
  }
  const repositoryIdentityHash = identity
    ? sha256(`remote:${identity}`)
    : sha256(`git-common-dir:${fs.realpathSync(path.resolve(root,
        gitOutput(root, ['rev-parse', '--git-common-dir'])))}`);
  return {
    projectId: project,
    repositoryIdentityHash,
    repositoryHash: sha256({ projectId: project, repositoryIdentityHash }),
  };
}

function resolveContext(root, options = {}) {
  const effective = options.effective ?? readEffectiveProjectPolicy(root);
  const identity = options.identity ??
    logicalRepositoryIdentity(effective.root, effective.adapter.project);
  return { ...effective, identity };
}

function opportunityHint(prompt, opportunityPolicy) {
  if (typeof prompt !== 'string' || !opportunityPolicy) return null;
  const question = prompt.toLowerCase();
  const matches = opportunityPolicy.opportunities.filter(item =>
    item.enabled !== false &&
    (item.triggers ?? []).some(trigger => question.includes(trigger.toLowerCase())));
  return matches.length === 1 ? matches[0].id : null;
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
  const context = options.context ?? resolveContext(root, options);
  const adapter = options.adapter ?? context.adapter;
  const repositoryHash = context.identity.repositoryHash;
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
  const explicitOpportunity = selectedOpportunity(payload);
  const hintedOpportunity = opportunityHint(prompt, context.opportunityPolicy);
  const opportunityId = explicitOpportunity ?? hintedOpportunity;
  const plan = payload.plan ?? payload.selectedPlan ?? null;
  const opportunityClassificationSupplied =
    options.opportunityClassificationSupplied === true;
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
    opportunityHint: explicitOpportunity === null && hintedOpportunity !== null,
    opportunityClassificationSupplied,
    opportunityClassificationHash: opportunityClassificationSupplied
      ? sha256({
          kind: 'operator-coordinator-backfill-classification',
          opportunityId,
        })
      : null,
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
  const context = options.context ?? resolveContext(root, options);
  const repositoryHash = context.identity.repositoryHash;
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
    opportunityHint: false,
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
  const context = options.context ?? resolveContext(root, options);
  const repositoryHash = context.identity.repositoryHash;
  const sessionId = sha256(`session:${rawSessionId}`);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const current = activeWorkflow(home, repositoryHash, sessionId);
  assert(current, 'No active prompt workflow for session');
  assert(current.opportunityId === null || current.opportunityId === opportunityId,
    'Active workflow opportunity is already bound differently');
  const unsigned = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'stateHash')),
    opportunityId,
    opportunityHint: false,
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
  const context = options.context ?? (
    options.adapter && options.policy && options.identity
      ? {
          adapter: options.adapter,
          policy: options.policy,
          identity: options.identity,
          source: options.policySource ?? {
            kind: 'worktree',
            ref: null,
            revision: options.revision ?? gitOutput(root, ['rev-parse', 'HEAD']),
            sourceHash: null,
          },
        }
      : resolveContext(root, options)
  );
  const adapter = options.adapter ?? context.adapter;
  const policy = options.policy ?? context.policy;
  const repositoryHash = context.identity.repositoryHash;
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
  const resultClass = ['accepted', 'rejected', 'failed', 'rollback', 'observed']
    .includes(payload.outcomeClass)
    ? payload.outcomeClass
    : eventKind === 'post-tool-use-failure'
    ? 'abnormal-failure'
    : eventKind === 'post-tool-use'
      ? 'accepted'
      : eventKind === 'session-end'
        ? sessionOutcome(payload.reason)
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
    repositoryIdentityHash: context.identity.repositoryIdentityHash,
    revision: options.revision ?? gitOutput(root, ['rev-parse', 'HEAD']) ?? 'uncommitted',
    policySourceKind: context.source.kind,
    policySourceRef: context.source.ref,
    policySourceRevision: context.source.revision,
    policySourceHash: context.source.sourceHash,
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
    skillIdentityHash: options.skillIdentityHash ?? null,
    sourceEventIdHash: options.sourceEventIdHash ?? null,
    sourceEventHash: options.sourceEventHash ?? null,
    opportunityClassificationSupplied:
      workflowState?.opportunityClassificationSupplied === true,
    opportunityClassificationHash:
      workflowState?.opportunityClassificationHash ?? null,
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

function dispatchManifestFromPrompt(prompt) {
  const match = String(prompt ?? '').match(/```budget-dispatch-manifest\s*([\s\S]*?)\s*```/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function normalizedTaskField(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
}

function classifyTaskRole(args) {
  const manifest = dispatchManifestFromPrompt(args.prompt);
  if (manifest?.role && expectedTaskContract(manifest)) {
    return { role: manifest.role, mode: 'explicit-dispatch', manifest };
  }
  const values = [
    args.taskClass,
    args.task_class,
    args.name,
    args.description,
  ]
    .map(normalizedTaskField)
    .filter(Boolean);
  for (const [role] of Object.entries(AUTOMATIC_ROUTE_ROLE_CATALOG)) {
    const normalizedRole = normalizedTaskField(role);
    if (values.some(value => value === normalizedRole ||
      value.includes(normalizedRole) ||
      normalizedRole.includes(value))) {
      return { role, mode: 'automatic-route', manifest: null };
    }
  }
  for (const [role] of Object.entries(DISPATCH_ROLE_CATALOG)) {
    const normalizedRole = normalizedTaskField(role);
    if (values.some(value => value === normalizedRole ||
      value.includes(normalizedRole) ||
      normalizedRole.includes(value))) {
      return { role, mode: 'explicit-dispatch', manifest: null };
    }
  }
  return {
    role: null,
    mode: 'unclassified',
    manifest,
  };
}

function taskPins(args) {
  return {
    model: args.model ?? null,
    effort: args.reasoning_effort ?? args.reasoningEffort ?? null,
    context: args.context_tier ?? args.contextTier ?? null,
    agentType: args.agent_type ?? args.agentType ?? null,
  };
}

function hasMissingTaskPins(pins) {
  return ['model', 'effort', 'context', 'agentType']
    .some(key => typeof pins[key] !== 'string' || pins[key].trim().length === 0);
}

function hasInheritPins(pins) {
  return ['model', 'effort', 'context', 'agentType']
    .some(key => typeof pins[key] === 'string' &&
      pins[key].trim().toLowerCase() === 'inherit');
}

function taskRoleMismatch(taskInfo, pins) {
  if (!taskInfo?.role || hasMissingTaskPins(pins) || hasInheritPins(pins)) {
    return false;
  }
  const expected = expectedTaskContract(taskInfo.manifest ?? { role: taskInfo.role });
  if (!expected) return false;
  return expected.model !== pins.model ||
    expected.effort !== pins.effort ||
    expected.context !== pins.context ||
    (expected.agentTypes.length > 0 && !expected.agentTypes.includes(pins.agentType));
}

function lineSeparatedJsonRecords(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { status: 'missing', events: [] };
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return {
      status: 'ok',
      events: lines.map(line => JSON.parse(line)),
    };
  } catch {
    return { status: 'invalid', events: [] };
  }
}

function sessionRuntimeEventsFile(home, sessionId) {
  return path.join(home, 'session-state', safeSessionStateId(sessionId), 'events.jsonl');
}

function sessionUsageFile(home, sessionId) {
  return path.join(home, 'session-state', safeSessionStateId(sessionId), 'usage.json');
}

function sessionUsageSummary(home, sessionId) {
  const file = sessionUsageFile(home, sessionId);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { status: 'missing', usage: null };
  try {
    const usage = normalizeUsage(JSON.parse(fs.readFileSync(file, 'utf8')));
    return {
      status: 'ok',
      usage: {
        credits: usage.credits,
        totalTokens: usage.totalTokens,
        usageHash: sha256(usage),
      },
    };
  } catch {
    return { status: 'invalid', usage: null };
  }
}

function modelIsClaude(model) {
  return typeof model === 'string' && /^claude-/i.test(model);
}

function modelIsFrontier(model) {
  return typeof model === 'string' && FRONTIER_MODELS.has(model);
}

function mechanicalToolCategory(toolName, args) {
  const name = typeof toolName === 'string' ? toolName : '';
  if (name === 'task') return 'delegation';
  if (name === 'session_store_sql') return 'history-sql';
  if (name === 'sql') return 'workflow-sql';
  if (name === 'fetch_copilot_cli_documentation') return 'documentation';
  if (name === 'vote_memory') return 'memory-vote';
  if (name === 'store_memory') return 'memory-store';
  if (['view', 'Read'].includes(name)) return 'repository-read';
  if (['rg', 'glob', 'grep'].includes(name)) return 'repository-search';
  if (['apply_patch', 'edit', 'create', 'write'].includes(name)) return 'repository-edit';
  if (name === 'bash' || name === 'powershell') {
    const command = typeof args?.command === 'string' ? args.command.trim() : '';
    if (/^(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test(?::[\w-]+)?|lint|build|check(?::[\w-]+)?))\b|node\s+--test\b|dotnet\s+(?:test|build)\b|pytest\b|python\s+-m\s+pytest\b|cargo\s+(?:test|check)\b|go\s+test\b)/i.test(command)) {
      return 'tests';
    }
    if (/^git\b/i.test(command)) return 'git';
    if (/^node\b.*\brouting-enforcement\.mjs\b/i.test(command)) return 'shell';
    return 'shell';
  }
  if (name === 'task_complete' || name === 'skill') return 'control-plane';
  if (name === 'web_fetch' || name === 'web_search') return 'web';
  if (/^(?:github-mcp-server-)?(?:search_code|search_users|get_file_contents|get_copilot_space|list_copilot_spaces)$/.test(name)) {
    return 'github';
  }
  if (name.startsWith('browser_')) return 'browser';
  if (/^(?:ha_|plex-|plex_|unifi-|unifi_|arr_|fetch$)/.test(name)) return 'mcp';
  return 'other';
}

function runtimeProfileFromEvent(event) {
  if (!['session.start', 'session.model_change'].includes(event?.type)) return null;
  const data = event.data ?? {};
  return profileFromObject(data);
}

function runtimeEventTimestamp(event) {
  return Date.parse(normalizeTimestamp(event?.timestamp ?? event?.data?.timestamp ?? Date.now()));
}

function summarizeSessionCompliance(runtimeEvents, usageSummary, state, options = {}) {
  const categories = Object.fromEntries([...SESSION_MECHANICAL_TOOL_CATEGORIES]
    .map(name => [name, 0]));
  const mismatchRoles = new Set();
  const delegationRoles = { automatic: {}, explicit: {} };
  const counts = {
    frontierDirectMechanicalTools: categories,
    frontierDirectMechanicalToolTotal: 0,
    missingTaskPins: 0,
    inheritTaskPins: 0,
    claudePersistentPins: 0,
    modelRoleMismatches: 0,
    automaticDelegation: 0,
    explicitDelegation: 0,
  };
  const sessionModels = new Set();
  const events = [...runtimeEvents].sort((left, right) =>
    runtimeEventTimestamp(left) - runtimeEventTimestamp(right));
  let currentProfile = {
    model: state?.model ?? null,
    effort: state?.effort ?? null,
    context: state?.context ?? 'default',
  };
  for (const event of events) {
    const profile = runtimeProfileFromEvent(event);
    if (profile) {
      currentProfile = profile;
      if (modelIsClaude(profile.model)) counts.claudePersistentPins += 1;
      if (typeof profile.model === 'string' && profile.model.length > 0) {
        sessionModels.add(profile.model);
      }
      continue;
    }
    if (event?.type !== 'tool.execution_start') continue;
    const data = event.data ?? {};
    const toolName = data.toolName;
    const args = data.arguments ?? {};
    if (toolName === 'task') {
      const pins = taskPins(args);
      const role = classifyTaskRole(args);
      if (hasMissingTaskPins(pins)) counts.missingTaskPins += 1;
      if (hasInheritPins(pins)) counts.inheritTaskPins += 1;
      if (typeof pins.model === 'string' && modelIsClaude(pins.model)) {
        counts.claudePersistentPins += 1;
      }
      if (role.mode === 'automatic-route' && role.role) {
        counts.automaticDelegation += 1;
        delegationRoles.automatic[role.role] = (delegationRoles.automatic[role.role] ?? 0) + 1;
      } else if (role.mode === 'explicit-dispatch' && role.role) {
        counts.explicitDelegation += 1;
        delegationRoles.explicit[role.role] = (delegationRoles.explicit[role.role] ?? 0) + 1;
      }
      if (taskRoleMismatch(role, pins)) {
        counts.modelRoleMismatches += 1;
        mismatchRoles.add(role.role);
      }
      continue;
    }
    if (!modelIsFrontier(currentProfile.model)) continue;
    const category = mechanicalToolCategory(toolName, args);
    if (!SESSION_MECHANICAL_TOOL_CATEGORIES.has(category)) continue;
    categories[category] += 1;
    counts.frontierDirectMechanicalToolTotal += 1;
  }
  const frontierDirectOnly = counts.frontierDirectMechanicalToolTotal > 0 &&
    counts.automaticDelegation === 0 &&
    counts.explicitDelegation === 0 &&
    counts.modelRoleMismatches === 0 &&
    counts.missingTaskPins === 0 &&
    counts.inheritTaskPins === 0 &&
    [...sessionModels].every(model => modelIsFrontier(model));
  const estimatedAvoidableCredits = usageSummary.status === 'ok' &&
    usageSummary.usage &&
    frontierDirectOnly
    ? {
      credits: usageSummary.usage.credits,
      basis: 'frontier-direct-session-upper-bound',
      usageHash: usageSummary.usage.usageHash,
    }
    : null;
  return {
    counts,
    mismatchRoles: [...mismatchRoles].sort(),
    delegationRoles: {
      automatic: Object.fromEntries(Object.entries(delegationRoles.automatic).sort()),
      explicit: Object.fromEntries(Object.entries(delegationRoles.explicit).sort()),
    },
    sessionModels: [...sessionModels].sort(),
    estimatedAvoidableCredits,
  };
}

export function readSessionComplianceObservation(home, repositoryHash, sessionId) {
  const file = sessionComplianceFile(home, repositoryHash, sessionId);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  return readJson(file);
}

export function buildSessionComplianceObservation(root, payload, options = {}) {
  const context = lifecycleContext(root, options);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const rawSessionId = safeSessionStateId(String(payload.sessionId ?? payload.session_id ?? 'unknown'));
  const repositoryHash = context.identity.repositoryHash;
  const sessionId = sha256(`session:${rawSessionId}`);
  const state = activeWorkflow(home, repositoryHash, sessionId);
  const runtime = lineSeparatedJsonRecords(sessionRuntimeEventsFile(home, rawSessionId));
  const usage = sessionUsageSummary(home, rawSessionId);
  const summary = summarizeSessionCompliance(runtime.events, usage, state, options);
  const unsigned = {
    version: 1,
    kind: 'routing-compliance-observation',
    mode: 'markdown-first-advisory',
    project: context.adapter.project,
    repositoryHash,
    repositoryIdentityHash: context.identity.repositoryIdentityHash,
    sessionId,
    workflowId: state?.workflowId ?? null,
    promptHash: state?.promptHash ?? null,
    observedAt: normalizeTimestamp(options.timestamp ?? payload.timestamp ?? Date.now()),
    runtimeEventStatus: runtime.status,
    usageStatus: usage.status,
    counts: summary.counts,
    mismatchRoles: summary.mismatchRoles,
    delegationRoles: summary.delegationRoles,
    sessionModels: summary.sessionModels,
    estimatedAvoidableCredits: summary.estimatedAvoidableCredits,
  };
  return { ...unsigned, reportHash: sha256(unsigned) };
}

export function persistSessionComplianceObservation(root, payload, options = {}) {
  const report = buildSessionComplianceObservation(root, payload, options);
  const context = lifecycleContext(root, options);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  writePrivateJsonAtomic(
    sessionComplianceFile(home, context.identity.repositoryHash, report.sessionId),
    report,
  );
  return report;
}

export function recordLifecyclePromptStart(payload, options = {}) {
  const root = findRoot(payload.cwd ?? process.cwd());
  if (!root) return { recorded: false, reason: 'no-root' };
  const context = lifecycleContext(root, options);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const workflowState = options.workflowState ??
    beginPromptWorkflow(root, payload, { ...options, home, context });
  appendSanitizedEvent(home, sanitizeHookEvent('user-prompt-submitted', payload, {
    root,
    adapter: context.adapter,
    policy: context.policy,
    home,
    workflowState,
    context,
    modelProfile: options.modelProfile ?? null,
    modelBacked: false,
  }));
  return {
    recorded: true,
    workflowId: workflowState.workflowId,
    promptHash: workflowState.promptHash,
  };
}

export function recordLifecycleSessionEnd(payload, options = {}) {
  const root = findRoot(payload.cwd ?? process.cwd());
  if (!root) return { recorded: false, reason: 'no-root' };
  const context = lifecycleContext(root, options);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const rawSessionId = safeSessionStateId(String(payload.sessionId ?? payload.session_id ?? 'unknown'));
  const sessionId = sha256(`session:${rawSessionId}`);
  const workflowState = activeWorkflow(home, context.identity.repositoryHash, sessionId);
  const reportingFailures = [];
  let eventRecorded = false;
  try {
    appendSanitizedEvent(home, sanitizeHookEvent('session-end', payload, {
      root,
      adapter: context.adapter,
      policy: context.policy,
      home,
      workflowState,
      context,
    }));
    eventRecorded = true;
  } catch (error) {
    reportingFailures.push(optionalReportingFailure('session-end-event', error));
  }
  let compliance = null;
  try {
    compliance = persistSessionComplianceObservation(root, payload, {
      ...options,
      context,
      home,
    });
  } catch (error) {
    reportingFailures.push(optionalReportingFailure('session-end-compliance', error));
  }
  let prunedExpiredEvents = null;
  try {
    prunedExpiredEvents = pruneExpiredEvents(
      home,
      context.identity.repositoryHash,
      context.policy.retentionDays,
    );
  } catch (error) {
    reportingFailures.push(optionalReportingFailure('session-end-prune', error));
  }
  return {
    recorded: true,
    eventRecorded,
    complianceRecorded: compliance !== null,
    compliance,
    reportingFailures,
    prunedExpiredEvents,
  };
}

function gitLearningRoot(root) {
  const value = execFileSync('git', ['-C', root, 'rev-parse', '--git-path',
    'copilot-learning'], { encoding: 'utf8' }).trim();
  return path.resolve(root, value);
}

function candidateLedgerFile(home, repositoryHash, candidateId) {
  assert(ID_PATTERN.test(candidateId), 'Candidate ID must be safe kebab-case');
  return path.join(stateRoot(home), repositoryHash, 'candidates',
    candidateId, 'ledger.json');
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
    incubationBinding: existing?.incubationBinding ?? null,
    validatedWorktrees: existing?.validatedWorktrees ?? [],
    updatedAt: new Date().toISOString(),
  };
}

export function persistCandidateLedger(root, candidate, update = {}, options = {}) {
  const context = options.context ?? resolveContext(root, options);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const file = candidateLedgerFile(home, context.identity.repositoryHash, candidate.id);
  const existing = fs.statSync(file, { throwIfNoEntry: false })?.isFile()
    ? readCandidateLedger(root, candidate.id, { ...options, context, home })
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
    repositoryHash: context.identity.repositoryHash,
  };
  const ledger = { ...unsigned, ledgerHash: sha256(unsigned) };
  writePrivateJson(file, ledger);
  return ledger;
}

export function readCandidateLedger(root, candidateId, options = {}) {
  const context = options.context ?? resolveContext(root, options);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const ledger = readJson(candidateLedgerFile(
    home, context.identity.repositoryHash, candidateId,
  ));
  const { ledgerHash, ...unsigned } = ledger;
  assert(ledgerHash === sha256(unsigned), 'Candidate ledger integrity failed');
  assert(ledger.candidate?.id === candidateId, 'Candidate ledger ID mismatch');
  assert(ledger.repositoryHash === context.identity.repositoryHash,
    'Candidate ledger repository mismatch');
  return ledger;
}

function resolvedCoordinator(opportunityPolicy, opportunityId) {
  if (!opportunityPolicy || !opportunityId) return null;
  const policy = opportunityPolicy;
  const opportunity = policy.opportunities?.find(item => item.id === opportunityId);
  return opportunity?.team?.coordinator ?? null;
}

export function decideAgentStop(root, payload, options = {}) {
  const started = Date.now();
  const context = options.context ?? resolveContext(root, options);
  const adapter = options.adapter ?? context.adapter;
  const policy = options.policy ?? context.policy;
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
    context,
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
  if (fs.statSync(candidateLedgerFile(home, event.repositoryHash, result.candidate.id),
    { throwIfNoEntry: false })?.isFile()) {
    return { action: 'allow', reason: 'candidate-already-recorded', result };
  }
  const marker = markerFile(home, event.repositoryHash, event.workflowId);
  if (fs.existsSync(marker)) return { action: 'allow', reason: 'already-prompted', result };
  const coordinator = resolvedCoordinator(context.opportunityPolicy,
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
  }, { context, home });
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
  const context = options.context ?? resolveContext(root, options);
  assert(verified.repositoryHash === context.identity.repositoryHash,
    'Learning completion repository mismatch');
  const adapter = options.adapter ?? context.adapter;
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
    context,
  });
  appendSanitizedEvent(home, event);
  return event;
}

function currentWorktreeBinding(root) {
  return {
    worktreeHash: sha256(`worktree:${fs.realpathSync(root)}`),
    revision: gitOutput(root, ['rev-parse', 'HEAD']),
    treeHash: gitOutput(root, ['rev-parse', 'HEAD^{tree}']),
  };
}

function candidateWorktreeAllowed(root, ledger) {
  const current = currentWorktreeBinding(root);
  return ledger.incubationBinding?.worktreeHash === current.worktreeHash ||
    ledger.validatedWorktrees?.some(item =>
      item.worktreeHash === current.worktreeHash &&
      item.treeHash === current.treeHash);
}

function prepareCandidate(root, candidateId, options = {}) {
  const context = options.context ?? resolveContext(root, options);
  const policy = context.policy;
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const ledger = readCandidateLedger(root, candidateId, { context, home });
  assert(ledger.candidate.requiresPrioritySelection !== true &&
    typeof ledger.candidate.selectedPriority === 'string',
  'Candidate priority must be explicitly selected before preparation');
  const binding = currentWorktreeBinding(root);
  if (ledger.incubationBinding) {
    assert(candidateWorktreeAllowed(root, ledger),
      'Candidate incubation is bound to another worktree/revision');
  }
  const plan = createReplayPlan(ledger.candidate, []);
  const incubation = incubateCandidate(root, ledger.candidate, plan, policy);
  const updated = persistCandidateLedger(root, incubation.candidate, {
    status: 'incubating',
    incubationBinding: ledger.incubationBinding ?? binding,
    evidence: {
      ...ledger.evidence,
      incubation: incubation.evidenceHash,
    },
    history: [{
      action: 'incubation-prepared',
      evidenceHash: incubation.evidenceHash,
    }],
  }, { context, home });
  return { directory: incubation.directory, ledger: updated };
}

function selectCandidatePriority(root, candidateId, priorityId, options = {}) {
  assert(ID_PATTERN.test(priorityId), 'Candidate priority ID invalid');
  const context = options.context ?? resolveContext(root, options);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const ledger = readCandidateLedger(root, candidateId, { context, home });
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
  }, { context, home });
}

function recordCandidateEvidence(root, candidateId, evidenceType, receiptFile,
  options = {}) {
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
  const context = options.context ?? resolveContext(root, options);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const ledger = readCandidateLedger(root, candidateId, { context, home });
  const receipt = readJson(receiptFile);
  const [expectedKind, hashKey] = contracts[evidenceType];
  assert(receipt.kind === expectedKind && receipt.candidateId === candidateId,
    'Candidate evidence receipt contract mismatch');
  const { [hashKey]: receiptHash, ...unsigned } = receipt;
  assert(HASH_PATTERN.test(receiptHash ?? '') && receiptHash === sha256(unsigned),
    'Candidate evidence receipt hash mismatch');
  const current = currentWorktreeBinding(root);
  let validatedWorktrees = ledger.validatedWorktrees ?? [];
  if (ledger.incubationBinding && !candidateWorktreeAllowed(root, ledger)) {
    assert(evidenceType === 'scope-tree' &&
      receipt.treeHash === ledger.incubationBinding.treeHash,
    'Candidate evidence is bound to another worktree/tree');
    validatedWorktrees = [...validatedWorktrees, {
      worktreeHash: current.worktreeHash,
      revision: current.revision,
      treeHash: current.treeHash,
      scopeHash: receipt.scopeHash,
      evidenceHash: receiptHash,
    }];
  }
  const updated = persistCandidateLedger(root, ledger.candidate, {
    evidence: { ...ledger.evidence, [evidenceType]: receiptHash },
    validatedWorktrees,
    history: [{ action: `evidence:${evidenceType}`, evidenceHash: receiptHash }],
  }, { context, home });
  return updated;
}

function backfillIndexFile(home, repositoryHash) {
  return path.join(stateRoot(home), repositoryHash, 'backfill', 'sources.json');
}

function readBackfillIndex(home, repositoryHash) {
  const file = backfillIndexFile(home, repositoryHash);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return { hashes: new Set(), ids: new Set() };
  }
  const value = readJson(file);
  const { indexHash, ...unsigned } = value;
  assert(indexHash === sha256(unsigned) &&
    value.repositoryHash === repositoryHash &&
    Array.isArray(value.sourceEventHashes) &&
    value.sourceEventHashes.every(hash => HASH_PATTERN.test(hash)) &&
    Array.isArray(value.sourceEventIdHashes) &&
    value.sourceEventIdHashes.every(hash => HASH_PATTERN.test(hash)),
  'Backfill source index integrity failed');
  return {
    hashes: new Set(value.sourceEventHashes),
    ids: new Set(value.sourceEventIdHashes),
  };
}

function writeBackfillIndex(home, repositoryHash, hashes, ids) {
  const unsigned = {
    version: 1,
    repositoryHash,
    sourceEventHashes: [...hashes].sort(),
    sourceEventIdHashes: [...ids].sort(),
  };
  writePrivateJson(backfillIndexFile(home, repositoryHash), {
    ...unsigned,
    indexHash: sha256(unsigned),
  });
}

function eventData(event) {
  return event?.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data
    : {};
}

function eventTimestamp(event) {
  const data = eventData(event);
  return event.timestamp ?? data.timestamp ?? Date.now();
}

function eventTurnId(event) {
  const data = eventData(event);
  return String(data.turnId ?? event.turnId ?? '');
}

function eventToolCallId(event) {
  const data = eventData(event);
  return String(data.toolCallId ?? data.callId ?? event.toolCallId ?? event.id ?? '');
}

function privateText(...values) {
  return values.find(value => typeof value === 'string') ?? '';
}

function verifyBackfillRepository(root, events, context) {
  const roots = new Set();
  for (const event of events) {
    const data = eventData(event);
    for (const candidate of [
      data.cwd,
      data.repository,
      data.gitRoot,
      data.repositoryRoot,
      data.context?.cwd,
      data.context?.gitRoot,
      event.cwd,
    ]) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
      const discovered = findRoot(candidate);
      if (discovered) roots.add(discovered);
    }
  }
  assert(roots.size > 0, 'Backfill session has no verifiable Git root');
  for (const discovered of roots) {
    const candidate = readEffectiveProjectPolicy(discovered);
    const identity = logicalRepositoryIdentity(discovered, candidate.adapter.project);
    assert(identity.repositoryHash === context.identity.repositoryHash,
      'Backfill session belongs to a different logical repository');
  }
  assert([...roots].some(discovered => {
    const candidate = readEffectiveProjectPolicy(discovered);
    return logicalRepositoryIdentity(discovered, candidate.adapter.project)
      .repositoryHash === context.identity.repositoryHash;
  }), 'Backfill session does not belong to requested repository');
}

function terminalOutcome(data, fallback = 'accepted') {
  if (data.success === false || data.failed === true || data.error === true) return 'failed';
  const value = String(data.outcome ?? data.status ?? data.reason ?? '').toLowerCase();
  if (/fail|error|timeout|crash/.test(value)) return 'failed';
  if (/cancel|reject|abort|interrupt/.test(value)) return 'rejected';
  return fallback;
}

export function backfillEvents(root, eventsFile, options = {}) {
  const context = options.context ?? resolveContext(root, options);
  const home = options.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const suppliedOpportunityId = options.opportunity ?? options.opportunityId ?? null;
  if (suppliedOpportunityId !== null) {
    assert(ID_PATTERN.test(suppliedOpportunityId),
      'Backfill opportunity ID must be safe kebab-case');
    const opportunity = context.opportunityPolicy?.opportunities
      ?.find(item => item.id === suppliedOpportunityId);
    assert(opportunity, 'Backfill opportunity ID is unknown');
    assert(opportunity.enabled !== false, 'Backfill opportunity ID is disabled');
  }
  const lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean);
  const parsed = lines.map((line, index) => {
    const event = JSON.parse(line);
    assert(event && typeof event === 'object' && !Array.isArray(event),
      `Backfill event ${index + 1} must be an object`);
    const sourceEventId = event.id ?? eventData(event).eventId ?? null;
    return {
      event,
      sourceEventHash: sha256(line),
      sourceEventIdHash: sourceEventId === null
        ? null
        : sha256(String(sourceEventId)),
    };
  });
  verifyBackfillRepository(root, parsed.map(item => item.event), context);
  const recordedEvents = readRepositoryEvents(
    home,
    context.identity.repositoryHash,
    context.policy.thresholds.maximumAnalysisEvents,
  );
  const alreadyRecorded = new Set(recordedEvents
    .map(event => event.sourceEventHash).filter(Boolean));
  const alreadyRecordedIds = new Set(recordedEvents
    .map(event => event.sourceEventIdHash).filter(Boolean));
  const indexed = readBackfillIndex(home, context.identity.repositoryHash);
  const known = new Set([...alreadyRecorded, ...indexed.hashes]);
  const knownIds = new Set([...alreadyRecordedIds, ...indexed.ids]);
  const starts = new Map();
  const turns = new Map();
  let currentWorkflow = null;
  const counts = {
    processed: parsed.length,
    imported: 0,
    deduplicated: 0,
    ignored: 0,
    classifications: {
      prompts: 0,
      tools: 0,
      toolFailures: 0,
      skills: 0,
      terminals: 0,
      metadata: 0,
    },
  };
  const sessionSeed = sha256(`backfill-session:${parsed
    .map(item => item.sourceEventHash).join(':')}`);

  const append = (kind, source, payload, extra = {}) => {
    appendSanitizedEvent(home, sanitizeHookEvent(kind, payload, {
      root: context.root,
      context,
      home,
      workflowState: extra.workflowState ?? currentWorkflow,
      sourceEventIdHash: source.sourceEventIdHash,
      sourceEventHash: source.sourceEventHash,
      skillIdentityHash: extra.skillIdentityHash ?? null,
    }));
    counts.imported += 1;
  };

  for (const source of parsed) {
    if (known.has(source.sourceEventHash) ||
      source.sourceEventIdHash !== null && knownIds.has(source.sourceEventIdHash)) {
      counts.deduplicated += 1;
      continue;
    }
    const { event } = source;
    const data = eventData(event);
    const type = String(event.type ?? event.event ?? '');
    const turnId = eventTurnId(event);
    const rawSessionId = privateText(
      data.sessionId,
      event.sessionId,
      sessionSeed,
    );
    const base = {
      cwd: context.root,
      sessionId: rawSessionId,
      timestamp: eventTimestamp(event),
    };
    if (type === 'user.message') {
      const prompt = privateText(
        data.content,
        data.prompt,
        data.message,
        data.text,
      );
      const exactOpportunityId = opportunityHint(prompt, context.opportunityPolicy);
      const classifiedOpportunityId = exactOpportunityId === null
        ? suppliedOpportunityId
        : null;
      currentWorkflow = beginPromptWorkflow(context.root, {
        ...base,
        prompt,
        opportunityId: classifiedOpportunityId ?? undefined,
      }, {
        context,
        home,
        opportunityClassificationSupplied: classifiedOpportunityId !== null,
      });
      if (turnId) turns.set(turnId, currentWorkflow);
      append('user-prompt-submitted', source, { ...base, prompt }, {
        workflowState: currentWorkflow,
      });
      counts.classifications.prompts += 1;
    } else if (type === 'tool.execution_start') {
      const key = `${turnId}:${eventToolCallId(event)}`;
      starts.set(key, {
        toolName: data.toolName ?? data.name ?? event.toolName,
        toolArgs: data.arguments ?? data.args ?? data.input ?? {},
        workflowState: turns.get(turnId) ?? currentWorkflow,
      });
      counts.classifications.metadata += 1;
    } else if (type === 'tool.execution_complete') {
      const callId = eventToolCallId(event);
      let key = `${turnId}:${callId}`;
      let start = starts.get(key);
      if (!start && callId) {
        const matches = [...starts.entries()].filter(([candidate]) =>
          candidate.endsWith(`:${callId}`));
        if (matches.length === 1) {
          [key, start] = matches[0];
        }
      }
      if (!start && turnId) {
        const matches = [...starts.entries()].filter(([candidate]) =>
          candidate.startsWith(`${turnId}:`));
        if (matches.length === 1) {
          [key, start] = matches[0];
        }
      }
      if (start) {
        const success = data.success !== false && data.status !== 'failed' &&
          data.error === undefined;
        append(success ? 'post-tool-use' : 'post-tool-use-failure', source, {
          ...base,
          toolName: start.toolName,
          toolArgs: start.toolArgs,
          result: data.result ?? data.output,
          error: data.error,
        }, { workflowState: start.workflowState });
        starts.delete(key);
        counts.classifications[success ? 'tools' : 'toolFailures'] += 1;
      } else {
        counts.ignored += 1;
      }
    } else if (type === 'skill.invoked') {
      const identity = privateText(data.skillName, data.name, data.skill, data.content);
      append('post-tool-use', source, {
        ...base,
        toolName: 'skill-invoked',
        toolArgs: { identityHash: sha256(identity) },
      }, {
        workflowState: turns.get(turnId) ?? currentWorkflow,
        skillIdentityHash: sha256(identity),
      });
      counts.classifications.skills += 1;
    } else if (type === 'assistant.turn_end') {
      append('agent-stop', source, {
        ...base,
        outcomeClass: terminalOutcome(data),
      }, { workflowState: turns.get(turnId) ?? currentWorkflow });
      counts.classifications.terminals += 1;
    } else if (type === 'session.task_complete') {
      append('session-end', source, {
        ...base,
        outcomeClass: terminalOutcome(data),
        reason: terminalOutcome(data) === 'accepted' ? 'completed' : 'failed',
      });
      counts.classifications.terminals += 1;
    } else if (/shutdown|session\.end/.test(type)) {
      const outcome = terminalOutcome(data);
      append('session-end', source, {
        ...base,
        outcomeClass: outcome,
        reason: outcome === 'accepted' ? 'completed' : outcome,
      });
      counts.classifications.terminals += 1;
    } else {
      counts.ignored += 1;
      counts.classifications.metadata += 1;
    }
    known.add(source.sourceEventHash);
    if (source.sourceEventIdHash) knownIds.add(source.sourceEventIdHash);
  }
  for (const source of parsed) {
    indexed.hashes.add(source.sourceEventHash);
    if (source.sourceEventIdHash) indexed.ids.add(source.sourceEventIdHash);
  }
  writeBackfillIndex(home, context.identity.repositoryHash,
    indexed.hashes, indexed.ids);
  return counts;
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
  const args = process.argv.slice(2);
  const [event, first, second, third] = args;
  if (event === 'validate') {
    const context = resolveContext(first ?? process.cwd());
    const policy = context.policy;
    process.stdout.write(`${JSON.stringify({
      valid: true,
      project: policy.project,
      priorities: policy.priorities.length,
      automaticBuild: policy.automaticBuild,
      automaticPromotion: policy.automaticPromotion,
      continuation: policy.continuation.enabled,
      policySource: context.source,
      repositoryHash: context.identity.repositoryHash,
    }, null, 2)}\n`);
    return;
  }
  if (event === 'select-priority') {
    assert(first && second && third,
      'Usage: continuous-improvement.mjs select-priority ROOT ID PRIORITY_ID');
    process.stdout.write(`${JSON.stringify(selectCandidatePriority(
      findRoot(first), second, third,
    ), null, 2)}\n`);
    return;
  }
  if (event === 'status') {
    const context = resolveContext(first ?? process.cwd());
    const root = context.root;
    const policy = context.policy;
    const repositoryHash = context.identity.repositoryHash;
    const home = process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
    const eventLedger = readRepositoryEventLedger(home, repositoryHash,
      policy.thresholds.maximumAnalysisEvents);
    const candidatesRoot = path.join(stateRoot(home), repositoryHash, 'candidates');
    const candidates = fs.statSync(candidatesRoot, { throwIfNoEntry: false })?.isDirectory()
      ? fs.readdirSync(candidatesRoot).sort()
        .map(id => readCandidateLedger(root, id, { context, home }))
      : [];
    process.stdout.write(`${JSON.stringify({
      project: policy.project,
      repositoryHash,
      policySource: context.source,
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
      findRoot(first), second,
    ), null, 2)}\n`);
    return;
  }
  if (event === 'bind-workflow') {
    assert(first && second && third,
      'Usage: continuous-improvement.mjs bind-workflow ROOT SESSION_ID OPPORTUNITY_ID PLAN.json');
    const planFile = process.argv[6];
    assert(planFile, 'Workflow binding plan file required');
    process.stdout.write(`${JSON.stringify(bindPromptWorkflow(
      findRoot(first), second, third, readJson(planFile),
    ), null, 2)}\n`);
    return;
  }
  if (event === 'record-evidence') {
    assert(first && second && third,
      'Usage: continuous-improvement.mjs record-evidence ROOT ID TYPE RECEIPT.json');
    const receiptFile = process.argv[6];
    assert(receiptFile, 'Evidence receipt file required');
    process.stdout.write(`${JSON.stringify(recordCandidateEvidence(
      findRoot(first), second, third, receiptFile,
    ), null, 2)}\n`);
    return;
  }
  if (event === 'record-completion') {
    assert(first && second,
      'Usage: continuous-improvement.mjs record-completion ROOT RECEIPT.json');
    process.stdout.write(`${JSON.stringify(persistWorkflowCompletion(
      findRoot(first), readJson(second),
    ), null, 2)}\n`);
    return;
  }
  if (event === 'backfill-events') {
    assert(first && second && (args.length === 3 ||
      args.length === 5 && third === '--opportunity' && ID_PATTERN.test(args[4])),
    'Usage: continuous-improvement.mjs backfill-events ROOT EVENTS.jsonl ' +
      '[--opportunity OPPORTUNITY_ID]');
    process.stdout.write(`${JSON.stringify(backfillEvents(
      findRoot(first), path.resolve(second), {
        opportunity: args[4] ?? null,
      },
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
  const context = resolveContext(root);
  const adapter = context.adapter;
  const policy = context.policy;
  const home = process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  if (event === 'user-prompt-submitted') {
    recordLifecyclePromptStart(payload, { home, context });
    process.stdout.write('{}');
    return;
  }
  if (event === 'agent-stop') {
    const decision = decideAgentStop(root, payload, { home, context });
    process.stdout.write(decision.action === 'block'
      ? JSON.stringify({ decision: 'block', reason: decision.task })
      : '{}');
    return;
  }
  if (event === 'session-end') {
    recordLifecycleSessionEnd(payload, { home, context });
    process.stdout.write('{}');
    return;
  }
  const record = sanitizeHookEvent(event, payload, { root, context, home });
  appendSanitizedEvent(home, record);
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
