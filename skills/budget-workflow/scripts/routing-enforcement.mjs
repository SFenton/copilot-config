#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hookDecision as oversizedReadDecision } from './budget.mjs';
import { fsyncDirectory } from './durability.mjs';
import {
  AUTOMATIC_ROUTE_ROLE_CATALOG,
  LUNA_MEDIUM_DEFAULT_PROFILE,
  SUPPORTED_MODELS,
} from './model-catalog.mjs';
import {
  DISPATCH_ROLE_CATALOG,
  SUPPORTED_DISPATCH_ROLES,
  createDispatchEffectiveContract,
  expectedTaskContract,
} from './effective-contract.mjs';
import { planHistoryQuery } from './evidence/history.mjs';
import {
  FRONTIER_DISPATCH_RECEIPT_KIND,
  PACKET_WORKFLOW_VERSION,
  REASON_ONLY_TOOL_MODE,
  RESEARCH_MODES,
  createFrontierDispatchReceipt,
  createTandemPairReceipt,
  validateFrontierDispatchReceipt,
  validateFrozenEvidencePacket,
  validateTandemPairReceipt,
} from './evidence/schemas.mjs';
import {
  INTENT_ACCEPTANCE_DISPATCH_RECEIPT_KIND,
  INTENT_ACCEPTANCE_MAX_ATTEMPTS,
  INTENT_ACCEPTANCE_ROLE,
  createIntentAcceptanceDispatchReceipt,
  defaultIntentAcceptancePrompt,
  validateIntentAcceptanceDispatchReceipt,
  validateIntentAcceptanceOutcomeReceipt,
  validateIntentAcceptancePacket,
} from './intent-acceptance.mjs';
import { validateProfile } from './workflow.mjs';
import {
  recordLifecyclePromptStart,
  recordLifecycleSessionEnd,
} from './continuous-improvement.mjs';

const STATE_VERSION = 3;
const DISPATCH_KIND = 'budget-dispatch-manifest';
const ROUTING_STATE_KIND = 'prompt-routing-state';
const CHILD_ACTIVATION_KIND = 'budget-child-activation';
const CHILD_AGENT_REGISTRY_KIND = 'budget-child-agent-registry';
const OPERATOR_OVERRIDE_KIND = 'budget-operator-override';
const CONTROL_ARTIFACT_RESULT_KIND = 'routing-control-artifact';
const AUTOMATIC_ROUTE_STORE_KIND = 'automatic-route-store';
const DISPATCH_REQUEST_KIND = 'dispatch-request';
const SAFE_CONTROL_ARTIFACT_KIND = 'safe-control-artifact';
const DISPATCH_ROLES = new Set(SUPPORTED_DISPATCH_ROLES);
const TOOL_CATEGORIES = new Set([
  'repository-read',
  'repository-search',
  'repository-edit',
  'shell',
  'tests',
  'review',
  'routing-state',
  'workflow-sql',
  'history-sql',
  'web',
  'github',
  'browser',
  'mcp',
  'documentation',
  'memory-vote',
  'memory-store',
]);
const OVERRIDE_TOOL_CATEGORIES = new Set([
  ...TOOL_CATEGORIES,
  'git',
  'schedule-create',
  'schedule-wakeup',
]);
const ROUTING_MODES = new Set(['audit', 'enforce']);
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CONTROL_PLANE_TOOLS = new Set([
  'skill',
  'list_agents',
  'read_agent',
  'write_agent',
  'ask_user',
  'task_complete',
  'sql',
]);
const SAFE_CONTROL_PLANE_TOOLS = new Set([
  'fetch_copilot_cli_documentation',
  'vote_memory',
]);
const APPROVED_ROOT_MODELS = new Set([
  'gpt-5.6-luna',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'gemini-3.7-flash',
  'mai-code-1.1-flash',
]);
const REPOSITORY_READ_TOOLS = new Set(['view']);
const REPOSITORY_SEARCH_TOOLS = new Set(['rg', 'glob', 'grep']);
const REPOSITORY_EDIT_TOOLS = new Set(['apply_patch', 'edit', 'write', 'create']);
const WEB_TOOLS = new Set(['web_fetch', 'web_search']);
const GITHUB_TOOLS = new Set([
  'search_code',
  'search_users',
  'get_file_contents',
  'get_copilot_space',
  'list_copilot_spaces',
  'github-mcp-server-search_code',
  'github-mcp-server-search_users',
  'github-mcp-server-get_file_contents',
  'github-mcp-server-get_copilot_space',
  'github-mcp-server-list_copilot_spaces',
]);
const BROWSER_READONLY_TOOLS = new Set([
  'browser_navigate',
  'browser_navigate_back',
  'browser_wait_for',
  'browser_snapshot',
  'browser_console_messages',
  'browser_network_request',
  'browser_network_requests',
  'browser_take_screenshot',
  'browser_find',
  'browser_tabs',
  'browser_close',
]);
const SAFE_MEMORY_SCOPES = new Set(['personal', 'session']);
const SAFE_STORE_MEMORY_TAG_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const SAFE_CONTROL_ARTIFACT_TYPES = new Set([
  DISPATCH_REQUEST_KIND,
  'frozen-evidence-packet',
  'receipt',
  'result-envelope',
  'progress-log',
]);
const SENSITIVE_MEMORY_PATTERN = /(?:password|passwd|secret|token|credential|cookie|session[-_ ]?id|bearer|private key|api[-_ ]?key|gh[pousr]_|sk-[a-z0-9]{12,})/i;
const SESSION_LOOKUP_PATTERN = /\b(?:check|audit|resume)\s+(?:the\s+)?["“]([^"\n”]{1,120})["”]\s+session\b/i;
const LOOKBACK_PATTERN = /\b(?:look back|what did i do|have i (?:already )?(?:done|worked on|solved)|check .*session)\b/i;
const HISTORY_AUDIT_PATTERN = /\b(?:history|routing|policy|cost)\b.*\b(?:audit|attribution|attribute|why did this route)\b/i;
const HOST_DIAGNOSTIC_PATTERN = /\b(?:why is swap (?:filled|full)(?: up)?(?: right now)?|swap full|swap filled|host diagnostics?|memory pressure|\/proc\/pressure|psi|swapon|vmstat)\b/i;
const REPOSITORY_PATTERN = /\b(?:inspect|read|find|search)\b.*\b(?:repo(?:sitory)?|code|file|files|symbol|in repo)\b/i;
const EXTERNAL_PATTERN = /\b(?:research|fetch|look up|search)\b.*\b(?:sources?|web|github|browser|mcp|docs?|evidence)\b/i;
const CLI_DOC_PATTERN = /\b(?:what can you do|copilot cli|slash commands?|how do i use|what features do you have)\b/i;
const TRUSTED_TANDEM_SKILL_CONTEXT_PATTERN = /^<skill-context\b[^>]*\bname=(["'])tandem-research\1[^>]*>[\s\S]*<\/skill-context>\s*$/i;
const TRUSTED_SKILL_CONTEXT_EVENT_TYPES = new Set([
  'skill-context',
  'skill_context',
  'invoked-skill-context',
  'invoked_skill_context',
]);
const FORBIDDEN_TASK_MODELS = new Set([
  'inherit',
  'hydrafusion',
  'gpt-5.6-sol',
  'gpt-6-sol',
  'gpt-6-astra',
  'claude-sonnet-5',
  'claude-sonnet-4.6',
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-haiku-4.5',
]);
const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'root', 'cwd', 'directory', 'target'];
const ROUTING_LEDGER_LIMIT = 128;
const ROUTING_AUDIT_LIMIT = 256;
const MAX_COMMAND_INPUT_BYTES = 200000;
const MAX_CONTROL_ARTIFACT_BYTES = 65536;
const CONTROL_ARTIFACT_TEXT_BYTES = 16384;
const AUTOMATIC_ROUTE_ACCEPT_WINDOW_MS = 30 * 60_000;
const DISPATCH_CURRENT_COMPAT_OUTPUT_BYTES = 1024;
const SESSION_FILES_DIRECTORY = 'files';
const SAFE_CONTROL_FILENAME_PATTERN = /^(?:dispatch|packet|receipt|result|progress)-[a-z0-9._-]{1,48}\.(?:json|jsonl|log)$/;
const HOST_DIAGNOSTIC_COMMANDS = Object.freeze([
  'uptime',
  'free -h',
  'swapon --show --bytes',
  'vmstat -s',
  'cat /proc/pressure/memory',
  'cat /proc/pressure/io',
  'cat /proc/meminfo',
  'cat /proc/swaps',
  'cat /sys/fs/cgroup/memory.current',
  'cat /sys/fs/cgroup/memory.max',
  'cat /sys/fs/cgroup/memory.swap.current',
  'cat /sys/fs/cgroup/memory.swap.max',
  'ps -eo pid,ppid,comm,%mem,%cpu,rss,vsz,state --sort=-rss',
  'ps -eo pid,ppid,comm,%mem,%cpu,rss,vsz,state --sort=-rss | head -n 25',
]);
const SCRIPT_ROOT = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const KNOWN_SCRIPT_REALPATHS = Object.freeze({
  routingEnforcement: fs.realpathSync(fileURLToPath(import.meta.url)),
  budget: fs.realpathSync(path.join(SCRIPT_ROOT, 'budget.mjs')),
  opportunities: fs.realpathSync(path.join(SCRIPT_ROOT, 'opportunities.mjs')),
  continuousImprovement: fs.realpathSync(path.join(SCRIPT_ROOT, 'continuous-improvement.mjs')),
  history: fs.realpathSync(path.join(SCRIPT_ROOT, 'evidence', 'history.mjs')),
  research: fs.realpathSync(path.join(SCRIPT_ROOT, 'evidence', 'research.mjs')),
  intentAcceptance: fs.realpathSync(path.join(SCRIPT_ROOT, 'intent-acceptance.mjs')),
  runLeaf: fs.realpathSync(path.join(SCRIPT_ROOT, 'run-leaf.mjs')),
});
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value))
    .digest('hex');
}

function firstDefined(value, keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined) return value[key];
  }
  return undefined;
}

function normalizeSessionIdValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function requireValidSessionId(value, label = 'sessionId') {
  assert(typeof value === 'string' && value.trim().length > 0, `${label} required`);
  const sessionId = normalizeSessionIdValue(value);
  assert(SESSION_ID_PATTERN.test(sessionId), `${label} must be a valid UUID session ID`);
  return sessionId;
}

function resolveSessionId(value) {
  const sessionId = normalizeSessionIdValue(firstDefined(value, ['sessionId', 'session_id']));
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : '';
}

function resolvePrompt(value) {
  const prompt = firstDefined(value, [
    'prompt',
    'userPrompt',
    'user_prompt',
    'initialPrompt',
    'initial_prompt',
  ]);
  return typeof prompt === 'string' ? prompt : '';
}

function normalizedLowerToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizedTaskClass(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
}

function normalizeArgs(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { __raw: value };
    } catch {
      return { __raw: value };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function explicitTandemRequested(payload, prompt) {
  const trimmedPrompt = String(prompt ?? '').trim();
  if (/^\/tandem-research(?:\s|$)/i.test(trimmedPrompt)) return true;
  const invokedSkill = normalizedLowerToken(
    firstDefined(payload, ['invokedSkillName', 'invoked_skill_name']),
  );
  if (invokedSkill !== 'tandem-research') return false;
  const trustedEventTypes = [
    firstDefined(payload, ['eventType', 'event_type']),
    firstDefined(payload, ['promptFormat', 'prompt_format']),
    firstDefined(payload, ['inputFormat', 'input_format']),
    firstDefined(payload, ['invocationType', 'invocation_type']),
  ].map(normalizedLowerToken);
  return TRUSTED_TANDEM_SKILL_CONTEXT_PATTERN.test(trimmedPrompt) ||
    trustedEventTypes.some(value => TRUSTED_SKILL_CONTEXT_EVENT_TYPES.has(value));
}

function normalizeToolName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');
}

function assertPlainObject(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a JSON object`);
}

function parseTopLevelJsonKeys(text, label) {
  const source = String(text ?? '').trim();
  assert(source.startsWith('{'), `${label} must be a JSON object`);
  const counts = new Map();
  let depth = 0;
  let index = 0;
  let inString = false;
  let escape = false;
  let expectKey = false;
  let readingKey = false;
  let keyBuffer = '';
  while (index < source.length) {
    const char = source[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
        if (readingKey) {
          counts.set(keyBuffer, (counts.get(keyBuffer) ?? 0) + 1);
          readingKey = false;
          expectKey = false;
        }
      } else if (readingKey) {
        keyBuffer += char;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      if (depth === 1 && expectKey) {
        readingKey = true;
        keyBuffer = '';
      }
      index += 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
      if (depth === 1) expectKey = true;
      index += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 1) expectKey = false;
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 1 && char === ',') {
      expectKey = true;
    }
    index += 1;
  }
  return counts;
}

function objectInfo(value, label, rawText = null) {
  assertPlainObject(value, label);
  const keyCounts = rawText === null
    ? new Map(Object.keys(value).map(key => [key, 1]))
    : parseTopLevelJsonKeys(rawText, label);
  return { value, keyCounts };
}

function topLevelEntries(info, keys) {
  return keys
    .filter(key => Object.prototype.hasOwnProperty.call(info.value, key))
    .map(key => ({ key, value: info.value[key] }));
}

function assertNoDuplicateTopLevelKeys(info, keys, label) {
  const duplicates = keys.filter(key => (info.keyCounts.get(key) ?? 0) > 1);
  assert(duplicates.length === 0,
    `${label} contains duplicate top-level keys: ${duplicates.join(', ')}`);
}

function strictTopLevelSessionId(info, label, { required = true, allowOmitted = false } = {}) {
  assertNoDuplicateTopLevelKeys(info, ['sessionId', 'session_id'], label);
  const entries = topLevelEntries(info, ['sessionId', 'session_id']);
  if (entries.length === 0) {
    if (required && !allowOmitted) {
      assert(false, `${label} requires a top-level sessionId`);
    }
    return '';
  }
  assert(entries.length === 1,
    `${label} may include only one top-level sessionId field`);
  return requireValidSessionId(entries[0].value, `${label} ${entries[0].key}`);
}

function requireValidAgentId(value, label = 'agent_id') {
  assert(typeof value === 'string' && value.trim().length > 0, `${label} required`);
  const agentId = value.trim();
  assert(OPAQUE_AGENT_ID_PATTERN.test(agentId),
    `${label} must be a visible opaque identifier`);
  return agentId;
}

function validateHookEnvelope(payload, options = {}) {
  const info = objectInfo(payload, 'Hook envelope', options.rawPayloadText ?? null);
  const sessionId = strictTopLevelSessionId(info, 'Hook envelope');
  const hasBatchCalls = Object.prototype.hasOwnProperty.call(payload, 'toolCalls');
  const hasSingleCall = payload.toolName !== undefined ||
    payload.tool_name !== undefined ||
    payload.toolArgs !== undefined ||
    payload.tool_input !== undefined;
  assert(!(hasBatchCalls && hasSingleCall),
    'Hook envelope cannot mix toolCalls with single-call fields');
  assert(hasBatchCalls || hasSingleCall,
    'Hook envelope must describe one tool call or a toolCalls array');
  if (hasBatchCalls) {
    assert(Array.isArray(payload.toolCalls), 'Hook envelope toolCalls must be an array');
  }
  const cwd = payload.cwd === undefined
    ? process.cwd()
    : (() => {
      assert(typeof payload.cwd === 'string' && payload.cwd.length > 0,
        'Hook envelope cwd must be a non-empty string');
      return payload.cwd;
    })();
  return {
    info,
    sessionId,
    cwd,
  };
}

function homeRoot(home = process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot')) {
  return home;
}

function routingStateFile(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Routing state sessionId');
  return path.join(homeRoot(home), 'budget-routing', `${validSessionId}.json`);
}

function routingLedgerFile(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Routing ledger sessionId');
  return path.join(homeRoot(home), 'budget-routing', `${validSessionId}.ledger.json`);
}

function frontierReceiptFile(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Frontier receipt sessionId');
  return path.join(homeRoot(home), 'budget-routing', `${validSessionId}.frontier.json`);
}

function intentAcceptanceReceiptFile(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Intent acceptance receipt sessionId');
  return path.join(homeRoot(home), 'budget-routing', `${validSessionId}.intent-acceptance.json`);
}

function childActivationFile(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Child activation sessionId');
  return path.join(homeRoot(home), 'budget-routing', `${validSessionId}.child-activations.json`);
}

function childAgentRegistryFile(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Child agent registry sessionId');
  return path.join(homeRoot(home), 'budget-routing', `${validSessionId}.child-agents.json`);
}

function automaticRouteFile(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Automatic route sessionId');
  return path.join(homeRoot(home), 'budget-routing', `${validSessionId}.automatic-route.json`);
}

function operatorOverrideFile(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Operator override sessionId');
  return path.join(homeRoot(home), 'budget-routing', `${validSessionId}.operator-overrides.json`);
}

function routingConfigFile(home) {
  return path.join(homeRoot(home), 'budget-routing', 'config.json');
}

function routingAuditFile(home) {
  return path.join(homeRoot(home), 'budget-routing', 'audit.jsonl');
}

function sessionFilesDirectory(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Session files sessionId');
  return path.join(homeRoot(home), 'session-state', validSessionId, SESSION_FILES_DIRECTORY);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function realDirectoryOrNull(directory) {
  const stat = fs.statSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return null;
  return fs.realpathSync(directory);
}

function safeRepositoryRoot(start) {
  if (typeof start !== 'string' || start.trim().length === 0) return null;
  let current = fs.realpathSync(start);
  while (true) {
    const adapterFile = path.join(current, '.github', 'agent-budget.json');
    const gitDir = path.join(current, '.git');
    if (fs.statSync(adapterFile, { throwIfNoEntry: false })?.isFile() ||
      fs.statSync(gitDir, { throwIfNoEntry: false })) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function writePrivateFileAtomic(file, text) {
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
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

function writePrivateJson(file, value) {
  writePrivateFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readPrivateJson(file, label = path.basename(file)) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function sessionEventsFile(home, sessionId) {
  const validSessionId = requireValidSessionId(sessionId, 'Session events sessionId');
  return path.join(homeRoot(home), 'session-state', validSessionId, 'events.jsonl');
}

function tailText(file, maximumBytes = 262144) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return '';
  const length = Math.min(stat.size, maximumBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString('utf8');
  if (length < stat.size) {
    const index = text.indexOf('\n');
    text = index >= 0 ? text.slice(index + 1) : '';
  }
  return text;
}

function recentSessionEvents(home, sessionId, eventTypes = [], maximumLines = 128) {
  const text = tailText(sessionEventsFile(home, sessionId));
  if (!text) return [];
  const wanted = new Set(eventTypes);
  const lines = text.split('\n').filter(Boolean).slice(-maximumLines);
  const events = [];
  for (const line of lines) {
    if (wanted.size > 0 && ![...wanted].some(type => line.includes(`"type":"${type}"`))) continue;
    events.push(JSON.parse(line));
  }
  return events;
}

function stateHash(value) {
  const { stateHash: ignored, ...unsigned } = value;
  void ignored;
  return sha256(unsigned);
}

function receiptHash(value, field = 'receiptHash') {
  const copy = { ...value };
  delete copy[field];
  delete copy.promptBlock;
  return sha256(copy);
}

function listHashes(values) {
  return values.map(value => sha256(String(value)));
}

function arraysEqual(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function readRoutingLedger(home, sessionId) {
  const stored = readPrivateJson(routingLedgerFile(home, sessionId), 'Routing prompt ledger');
  if (!stored) {
    return {
      version: STATE_VERSION,
      kind: 'routing-prompt-ledger',
      sessionId,
      compactedEntries: 0,
      nextPromptIndex: 1,
      entries: [],
    };
  }
  assert(stored.version === STATE_VERSION &&
    stored.kind === 'routing-prompt-ledger' &&
    stored.sessionId === sessionId &&
    Number.isInteger(stored.nextPromptIndex) &&
    stored.nextPromptIndex >= 1 &&
    Array.isArray(stored.entries),
  'Routing prompt ledger is invalid');
  return stored;
}

function writeRoutingLedger(home, sessionId, ledger) {
  writePrivateJson(routingLedgerFile(home, sessionId), ledger);
}

function appendLedgerEntry(home, state) {
  const ledger = readRoutingLedger(home, state.sessionId);
  const existingIndex = ledger.entries.findIndex(entry => entry.stateHash === state.stateHash);
  const entries = existingIndex >= 0
    ? ledger.entries
    : [...ledger.entries, state];
  const compactedEntries = ledger.compactedEntries +
    Math.max(0, entries.length - ROUTING_LEDGER_LIMIT);
  const boundedEntries = entries.slice(-ROUTING_LEDGER_LIMIT);
  writeRoutingLedger(home, state.sessionId, {
    version: STATE_VERSION,
    kind: 'routing-prompt-ledger',
    sessionId: state.sessionId,
    compactedEntries,
    nextPromptIndex: Math.max(ledger.nextPromptIndex, state.promptIndex + 1),
    entries: boundedEntries,
  });
}

function profileFromObject(value) {
  if (!value || typeof value !== 'object') return null;
  const model = firstDefined(value, [
    'selectedModel', 'selected_model', 'newModel', 'new_model', 'model',
  ]);
  const effort = firstDefined(value, [
    'reasoningEffort', 'reasoning_effort', 'effort',
  ]);
  const context = firstDefined(value, [
    'contextTier', 'context_tier', 'context',
  ]);
  if ([model, effort].every(item => typeof item === 'string' && item.length > 0)) {
    return {
      model,
      effort,
      context: typeof context === 'string' && context.length > 0 ? context : 'default',
    };
  }
  return null;
}

function readRoutingConfig(home) {
  const stored = readPrivateJson(routingConfigFile(home), 'Routing config');
  if (!stored) return { mode: 'enforce', source: 'default' };
  const mode = typeof stored.mode === 'string' ? stored.mode.trim().toLowerCase() : '';
  if (!ROUTING_MODES.has(mode)) {
    return { mode: 'enforce', source: 'invalid-config' };
  }
  return { mode, source: 'config' };
}

export function effectiveRoutingMode(options = {}) {
  const envMode = String(
    options.env?.COPILOT_BUDGET_ROUTING_MODE ??
    options.env?.BUDGET_ROUTING_MODE ??
    '',
  ).trim().toLowerCase();
  if (envMode) {
    return ROUTING_MODES.has(envMode)
      ? { mode: envMode, source: 'environment' }
      : { mode: 'enforce', source: 'invalid-environment' };
  }
  return readRoutingConfig(options.home);
}

export function setRoutingMode(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Routing mode input required');
  const mode = String(input.mode ?? '').trim().toLowerCase();
  assert(ROUTING_MODES.has(mode), 'Routing mode must be audit or enforce');
  const value = {
    version: STATE_VERSION,
    kind: 'routing-config',
    mode,
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  writePrivateJson(routingConfigFile(options.home), value);
  return { mode, source: 'config', updatedAt: value.updatedAt };
}

function appendAuditEntry(home, entry) {
  const file = routingAuditFile(home);
  ensurePrivateDirectory(path.dirname(file));
  const existing = tailText(file, 131072).split('\n').filter(Boolean).slice(-(ROUTING_AUDIT_LIMIT - 1));
  existing.push(JSON.stringify(entry));
  writePrivateFileAtomic(file, `${existing.join('\n')}\n`);
}

function jsonFence(label, value) {
  return `\`\`\`${label}\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function parseJsonFence(prompt, label) {
  const match = String(prompt ?? '').match(new RegExp(`\\\`\\\`\\\`${label}\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\``));
  if (!match) return null;
  return JSON.parse(match[1]);
}

export function resolveSessionProfile(home, sessionId, options = {}) {
  const validSessionId = requireValidSessionId(sessionId, 'Session profile sessionId');
  const events = recentSessionEvents(home, validSessionId, ['session.start', 'session.model_change'], 96);
  if (events.length === 0) {
    const payloadProfile = profileFromObject(options.payload);
    if (payloadProfile) return { ...payloadProfile, source: 'hook-payload' };
    const state = currentPromptState(home, validSessionId);
    if (state?.model && state?.effort && state?.context) {
      return {
        model: state.model,
        effort: state.effort,
        context: state.context,
        source: 'session-routing-state',
      };
    }
    return { model: null, effort: null, context: null, source: 'missing-session-events' };
  }
  let model = null;
  let effort = null;
  let context = null;
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'session.start') {
      model = firstDefined(data, ['selectedModel', 'selected_model']) ?? model;
      effort = firstDefined(data, ['reasoningEffort', 'reasoning_effort']) ?? effort;
      context = firstDefined(data, ['contextTier', 'context_tier']) ?? context;
    } else if (event.type === 'session.model_change') {
      model = firstDefined(data, ['newModel', 'new_model', 'selectedModel', 'selected_model']) ?? model;
      effort = firstDefined(data, ['reasoningEffort', 'reasoning_effort']) ?? effort;
      context = firstDefined(data, ['contextTier', 'context_tier']) ?? context;
    }
  }
  return { model, effort, context: context ?? 'default', source: 'session-events-tail' };
}

function normalizeIntent(payload) {
  const prompt = resolvePrompt(payload);
  const supplied = payload.intent ?? {};
  const researchMode = firstDefined(supplied, ['researchMode', 'research_mode']) ??
    firstDefined(payload, ['researchMode', 'research_mode']) ??
    null;
  if (researchMode !== null) {
    assert(RESEARCH_MODES.includes(researchMode), 'Intent researchMode is invalid');
  }
  const tandemRequested = Boolean(
    firstDefined(supplied, ['tandemRequested', 'tandem_requested']) ??
    firstDefined(payload, ['tandemRequested', 'tandem_requested']) ??
    explicitTandemRequested(payload, prompt),
  );
  const historyRequested = Boolean(
    firstDefined(supplied, ['historyRequested', 'history_requested']) ??
    firstDefined(payload, ['historyRequested', 'history_requested']) ??
    researchMode === 'history',
  );
  const metaAudit = Boolean(
    firstDefined(supplied, ['metaAudit', 'meta_audit']) ??
    firstDefined(payload, ['metaAudit', 'meta_audit']) ??
    /\bmeta-audit\b/.test(prompt),
  );
  const packetWorkflowVersion = Number(
    firstDefined(supplied, ['packetWorkflowVersion', 'packet_workflow_version']) ??
    firstDefined(payload, ['packetWorkflowVersion', 'packet_workflow_version']) ??
    PACKET_WORKFLOW_VERSION,
  );
  assert(Number.isInteger(packetWorkflowVersion) &&
    packetWorkflowVersion === PACKET_WORKFLOW_VERSION,
  'Intent packet workflow version mismatch');
  return {
    researchMode,
    tandemRequested,
    historyRequested,
    metaAudit,
    packetWorkflowVersion,
  };
}

function sanitizedSessionLabel(label) {
  const value = String(label ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  assert(value.length > 0 && value.length <= 120 &&
    !value.includes('\n') && !value.includes('\r'),
  'Automatic history session labels must stay within the bounded title shape');
  return value;
}

function automaticRouteRecordHash(record) {
  const {
    routeHash: ignored,
    acceptedAt: ignoredAcceptedAt,
    acceptanceExpiresAt: ignoredAcceptanceExpiresAt,
    activatedChild: ignoredActivatedChild,
    ...unsigned
  } = record;
  void ignored;
  void ignoredAcceptedAt;
  void ignoredAcceptanceExpiresAt;
  void ignoredActivatedChild;
  return sha256(unsigned);
}

function automaticTaskIdentityForRole(role) {
  switch (role) {
    case 'history-reader':
      return {
        name: 'automatic-history-reader',
        description: 'Run the exact automatic history lookup',
      };
    case 'history-auditor':
      return {
        name: 'automatic-history-auditor',
        description: 'Run the exact automatic history audit',
      };
    case 'host-diagnostics-reader':
      return {
        name: 'automatic-host-diagnostics-reader',
        description: 'Run the exact read-only host diagnostics route',
      };
    case 'repository-reader':
      return {
        name: 'automatic-repository-reader',
        description: 'Inspect the current repository with exact read-only tools',
      };
    case 'external-evidence-reader':
      return {
        name: 'automatic-external-evidence-reader',
        description: 'Collect exact read-only external evidence',
      };
    case 'evidence-curator':
      return {
        name: 'automatic-evidence-curator',
        description: 'Prepare the exact bounded tandem evidence packet',
      };
    default:
      throw new Error(`Unsupported automatic route role: ${role}`);
  }
}

function automaticTaskScope(route) {
  if (route.role === 'repository-reader') return ['.'];
  if (route.role === 'evidence-curator') {
    return route.repositoryRoot ? ['.'] : ['external-evidence'];
  }
  if (route.role === 'history-reader' || route.role === 'history-auditor') {
    assert(route.historyPlan && typeof route.historyPlan.templateId === 'string',
      'Automatic history route plan missing');
    return normalizeScope([
      `history:${route.historyPlan.templateId}`,
      `source:${route.historyPlan.source}`,
      route.routeClass,
    ]);
  }
  if (route.role === 'host-diagnostics-reader') return ['host-diagnostics'];
  if (route.role === 'external-evidence-reader') return ['external-evidence'];
  if (route.role === 'cli-doc-reader') return ['cli-documentation'];
  return normalizeScope(route.scope ?? [route.routeClass]);
}

function automaticHistoryRoute(workflowId, promptHash, routeClass, role, overrides = {}) {
  const plan = planHistoryQuery({
    workflowId,
    promptHash,
    question: role === 'history-auditor'
      ? 'Automatic bounded history audit'
      : 'Automatic bounded history lookup',
    templateId: overrides.templateId,
    source: overrides.source ?? 'cloud',
    sessionLabel: overrides.sessionLabel ?? undefined,
    lookbackDays: overrides.lookbackDays,
    limit: overrides.limit,
  });
  return {
    role,
    dispatchKind: 'task',
    routeClass,
    historyPlan: plan,
    repositoryRoot: null,
    scope: [role === 'history-auditor' ? 'history-audit' : 'history-query'],
  };
}

function automaticRouteDescriptor(payload, state, home) {
  const prompt = resolvePrompt(payload);
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();
  const repositoryRoot = realDirectoryOrNull(cwd) ? safeRepositoryRoot(cwd) : null;
  if (explicitTandemRequested(payload, prompt)) {
    return {
      role: 'evidence-curator',
      dispatchKind: 'task',
      routeClass: 'explicit-tandem-research',
      repositoryRoot,
      scope: repositoryRoot ? ['repository-root', 'history', 'external'] : ['history', 'external'],
    };
  }
  const namedSession = normalizedPrompt.match(SESSION_LOOKUP_PATTERN);
  if (namedSession) {
    return automaticHistoryRoute(
      state.workflowId,
      state.promptHash,
      'named-session-lookup',
      'history-reader',
      {
        templateId: 'named-session-lookup',
        source: 'cloud',
        sessionLabel: sanitizedSessionLabel(namedSession[1]),
        lookbackDays: 30,
        limit: 5,
      },
    );
  }
  if (HISTORY_AUDIT_PATTERN.test(normalizedPrompt)) {
    return automaticHistoryRoute(
      state.workflowId,
      state.promptHash,
      'broad-history-audit',
      'history-auditor',
      {
        templateId: 'recent-sessions',
        source: 'cloud',
        lookbackDays: 7,
        limit: 20,
      },
    );
  }
  if (LOOKBACK_PATTERN.test(normalizedPrompt)) {
    return automaticHistoryRoute(
      state.workflowId,
      state.promptHash,
      'recent-history-lookback',
      'history-reader',
      {
        templateId: 'recent-sessions',
        source: 'cloud',
        lookbackDays: 7,
        limit: 12,
      },
    );
  }
  if (HOST_DIAGNOSTIC_PATTERN.test(normalizedPrompt)) {
    return {
      role: 'host-diagnostics-reader',
      dispatchKind: 'task',
      routeClass: 'host-diagnostics',
      repositoryRoot: null,
      scope: ['host-diagnostics'],
    };
  }
  if (CLI_DOC_PATTERN.test(normalizedPrompt)) {
    return {
      role: 'cli-doc-reader',
      dispatchKind: 'deterministic',
      routeClass: 'cli-documentation',
      repositoryRoot: null,
      scope: ['cli-documentation'],
    };
  }
  if (REPOSITORY_PATTERN.test(normalizedPrompt) && repositoryRoot) {
    return {
      role: 'repository-reader',
      dispatchKind: 'task',
      routeClass: 'repository-read',
      repositoryRoot,
      scope: ['repository-root'],
    };
  }
  if (EXTERNAL_PATTERN.test(normalizedPrompt)) {
    return {
      role: 'external-evidence-reader',
      dispatchKind: 'task',
      routeClass: 'external-evidence',
      repositoryRoot: null,
      scope: ['external-evidence'],
    };
  }
  void home;
  return null;
}

function automaticHistoryTaskPrompt(route) {
  const plan = route.historyPlan;
  return [
    `Automatic route: ${route.role}`,
    `Route class: ${route.routeClass}`,
    'Run only the exact automatic history route.',
    'Use only session_store_sql with the planned query below.',
    'Do not access attachments, tool arguments, or raw session IDs in the answer.',
    'Summaries must keep pseudonymous session refs and bounded snippets only.',
    `Template: ${plan.templateId}`,
    `Source: ${plan.source}`,
    `Lookback days: ${plan.lookbackDays}`,
    `Limit: ${plan.limit}`,
    `Query hash: ${plan.queryHash}`,
    'Planned query:',
    '```sql',
    plan.query,
    '```',
  ].join('\n');
}

function hostDiagnosticsTaskPrompt() {
  return [
    'Automatic route: host-diagnostics-reader',
    'Run only the exact allowlisted read-only diagnostics below.',
    'Do not restart, kill, install, mutate services, access the network, or run arbitrary shell.',
    'Allowed commands:',
    '```bash',
    ...HOST_DIAGNOSTIC_COMMANDS,
    '```',
  ].join('\n');
}

function externalEvidenceTaskPrompt() {
  return [
    'Automatic route: external-evidence-reader',
    'Collect read-only external evidence only.',
    'Use only the exact read-only web, GitHub, browser, or MCP tools allowed by the dispatch.',
    'No external writes, no live mutation, and no repository implementation work.',
  ].join('\n');
}

function repositoryReaderTaskPrompt() {
  return [
    'Automatic route: repository-reader',
    'Inspect only the repository visible from the current working directory.',
    'Use read/search tools only within the bound repository root.',
    'Do not edit files, run tests, mutate Git state, or use network tools.',
  ].join('\n');
}

function evidenceCuratorTaskPrompt() {
  return [
    'Automatic route: evidence-curator',
    'Prepare deterministic evidence for an explicit tandem research request.',
    'Use only bounded repository/history/external read tools allowed by the dispatch.',
    'Freeze the packet and hand back the evidence packet plus receipt; do not launch frontier models and do not implement changes.',
  ].join('\n');
}

function automaticTaskPreviewForRoute(route) {
  const catalog = AUTOMATIC_ROUTE_ROLE_CATALOG[route.role];
  assert(catalog && catalog.dispatchKind === route.dispatchKind,
    'Automatic route role catalog entry missing');
  const scope = automaticTaskScope(route);
  if (route.dispatchKind === 'deterministic') {
    return {
      dispatchKind: 'deterministic',
      role: route.role,
      toolName: catalog.toolName,
      scope,
      repositoryMode: 'none',
      repositoryHash: null,
      allowedToolCategories: ['documentation'],
      allowedToolNames: [catalog.toolName],
      allowedToolNamePrefixes: [],
      allowedQueries: [],
      validations: [],
    };
  }
  const identity = automaticTaskIdentityForRole(route.role);
  const repositoryMode = route.repositoryRoot ? 'cwd-repository-root' : 'none';
  const repositoryHash = route.repositoryRoot ? sha256(fs.realpathSync(route.repositoryRoot)) : null;
  if (route.role === 'history-reader' || route.role === 'history-auditor') {
    return {
      dispatchKind: 'task',
      role: route.role,
      name: identity.name,
      description: identity.description,
      prompt: automaticHistoryTaskPrompt(route),
      agentType: 'general-purpose',
      model: catalog.profile.model,
      effort: catalog.profile.effort,
      context: catalog.profile.context,
      scope,
      repositoryMode,
      repositoryHash,
      allowedToolCategories: ['history-sql'],
      allowedToolNames: ['session_store_sql'],
      allowedToolNamePrefixes: [],
      allowedQueries: [route.historyPlan.query],
      validations: [],
    };
  }
  if (route.role === 'host-diagnostics-reader') {
    return {
      dispatchKind: 'task',
      role: route.role,
      name: identity.name,
      description: identity.description,
      prompt: hostDiagnosticsTaskPrompt(),
      agentType: 'general-purpose',
      model: catalog.profile.model,
      effort: catalog.profile.effort,
      context: catalog.profile.context,
      scope,
      repositoryMode,
      repositoryHash,
      allowedToolCategories: ['shell'],
      allowedToolNames: ['bash'],
      allowedToolNamePrefixes: [],
      allowedQueries: [],
      validations: HOST_DIAGNOSTIC_COMMANDS,
    };
  }
  if (route.role === 'repository-reader') {
    return {
      dispatchKind: 'task',
      role: route.role,
      name: identity.name,
      description: identity.description,
      prompt: repositoryReaderTaskPrompt(),
      agentType: 'general-purpose',
      model: catalog.profile.model,
      effort: catalog.profile.effort,
      context: catalog.profile.context,
      scope,
      repositoryMode,
      repositoryHash,
      allowedToolCategories: ['repository-read', 'repository-search'],
      allowedToolNames: ['view', 'rg', 'glob'],
      allowedToolNamePrefixes: [],
      allowedQueries: [],
      validations: [],
    };
  }
  if (route.role === 'external-evidence-reader') {
    return {
      dispatchKind: 'task',
      role: route.role,
      name: identity.name,
      description: identity.description,
      prompt: externalEvidenceTaskPrompt(),
      agentType: 'general-purpose',
      model: catalog.profile.model,
      effort: catalog.profile.effort,
      context: catalog.profile.context,
      scope,
      repositoryMode,
      repositoryHash,
      allowedToolCategories: ['web', 'github', 'browser', 'mcp'],
      allowedToolNames: [...catalog.toolNames],
      allowedToolNamePrefixes: [...(catalog.toolNamePrefixes ?? [])],
      allowedQueries: [],
      validations: [],
    };
  }
  if (route.role === 'evidence-curator') {
    return {
      dispatchKind: 'task',
      role: route.role,
      name: identity.name,
      description: identity.description,
      prompt: evidenceCuratorTaskPrompt(),
      agentType: 'general-purpose',
      model: catalog.profile.model,
      effort: catalog.profile.effort,
      context: catalog.profile.context,
      scope,
      repositoryMode,
      repositoryHash,
      allowedToolCategories: route.repositoryRoot
        ? ['repository-read', 'repository-search', 'history-sql', 'web', 'github', 'browser', 'mcp']
        : ['history-sql', 'web', 'github', 'browser', 'mcp'],
      allowedToolNames: route.repositoryRoot
        ? [...catalog.toolNames]
        : catalog.toolNames.filter(name => !['view', 'rg', 'glob'].includes(name)),
      allowedToolNamePrefixes: [...(catalog.toolNamePrefixes ?? [])],
      allowedQueries: [],
      validations: [],
    };
  }
  throw new Error(`Unsupported automatic route role: ${route.role}`);
}

function storedAutomaticHistoryPlan(historyPlan) {
  if (!historyPlan) return null;
  return {
    templateId: historyPlan.templateId,
    source: historyPlan.source,
    lookbackDays: historyPlan.lookbackDays,
    limit: historyPlan.limit,
    queryHash: historyPlan.queryHash,
    sessionLabelHash: historyPlan.sessionLabelHash ??
      (historyPlan.pattern ? sha256(historyPlan.pattern) : null),
  };
}

function validateAutomaticRouteRecord(record) {
  assert(record && typeof record === 'object' && !Array.isArray(record),
    'Automatic route store is invalid');
  assert(record.version === STATE_VERSION &&
    record.kind === AUTOMATIC_ROUTE_STORE_KIND,
  'Automatic route store kind/version mismatch');
  const sessionId = requireValidSessionId(record.sessionId, 'Automatic route sessionId');
  assert(typeof record.workflowId === 'string' && record.workflowId.length > 0,
    'Automatic route workflowId required');
  assert(typeof record.promptHash === 'string' && /^[a-f0-9]{64}$/.test(record.promptHash),
    'Automatic route promptHash invalid');
  assert(Object.hasOwn(AUTOMATIC_ROUTE_ROLE_CATALOG, record.role),
    'Automatic route role invalid');
  assert(record.dispatchKind === 'task' || record.dispatchKind === 'deterministic',
    'Automatic route dispatch kind invalid');
  assert(typeof record.routeClass === 'string' && record.routeClass.length > 0,
    'Automatic route class required');
  assert(record.repositoryMode === 'none' || record.repositoryMode === 'cwd-repository-root',
    'Automatic route repositoryMode invalid');
  assert(record.repositoryHash === null || /^[a-f0-9]{64}$/.test(record.repositoryHash),
    'Automatic route repositoryHash invalid');
  record.scope = normalizeScope(record.scope);
  assert(record.scopeHash === sha256(record.scope), 'Automatic route scopeHash mismatch');
  assert(Array.isArray(record.allowedToolCategories) &&
    record.allowedToolCategories.every(category => TOOL_CATEGORIES.has(category)),
  'Automatic route allowed tool categories are invalid');
  assert(Array.isArray(record.allowedToolNames) &&
    record.allowedToolNames.every(value => typeof value === 'string' && value.length > 0),
  'Automatic route allowed tool names are invalid');
  assert(Array.isArray(record.allowedToolNamePrefixes) &&
    record.allowedToolNamePrefixes.every(value => typeof value === 'string' && value.length > 0),
  'Automatic route allowed tool prefixes are invalid');
  assert(Array.isArray(record.allowedQueryHashes) &&
    record.allowedQueryHashes.every(value => /^[a-f0-9]{64}$/.test(value)) &&
    Number.isInteger(record.allowedQueryCount) &&
    record.allowedQueryCount >= 0,
  'Automatic route allowed query hashes are invalid');
  assert(Array.isArray(record.validationHashes) &&
    record.validationHashes.every(value => /^[a-f0-9]{64}$/.test(value)) &&
    Number.isInteger(record.validationCount) &&
    record.validationCount >= 0,
  'Automatic route validation hashes are invalid');
  if (record.dispatchKind === 'task') {
    validateProfile({
      model: record.model,
      effort: record.effort,
      context: record.context,
    }, 'Automatic route profile');
    assert(typeof record.agentType === 'string' && record.agentType.length > 0,
      'Automatic route agentType required');
    assert(typeof record.taskNameHash === 'string' && /^[a-f0-9]{64}$/.test(record.taskNameHash),
      'Automatic route taskNameHash invalid');
    assert(typeof record.taskDescriptionHash === 'string' && /^[a-f0-9]{64}$/.test(record.taskDescriptionHash),
      'Automatic route taskDescriptionHash invalid');
    assert(typeof record.taskPromptHash === 'string' && /^[a-f0-9]{64}$/.test(record.taskPromptHash),
      'Automatic route taskPromptHash invalid');
    assert(Number.isInteger(record.taskPromptBytes) && record.taskPromptBytes > 0,
      'Automatic route taskPromptBytes invalid');
  } else {
    assert(record.toolName === 'fetch_copilot_cli_documentation',
      'Automatic deterministic route toolName invalid');
  }
  if (record.historyPlan !== null) {
    assert(record.historyPlan && typeof record.historyPlan === 'object' &&
      typeof record.historyPlan.templateId === 'string' &&
      typeof record.historyPlan.source === 'string' &&
      Number.isInteger(record.historyPlan.lookbackDays) &&
      Number.isInteger(record.historyPlan.limit) &&
      /^[a-f0-9]{64}$/.test(record.historyPlan.queryHash),
    'Automatic route history plan summary invalid');
    if (record.historyPlan.sessionLabelHash !== null) {
      assert(/^[a-f0-9]{64}$/.test(record.historyPlan.sessionLabelHash),
        'Automatic route sessionLabelHash invalid');
    }
  }
  if (record.acceptedAt !== null) {
    assert(typeof record.acceptedAt === 'string' && Number.isFinite(Date.parse(record.acceptedAt)),
      'Automatic route acceptedAt invalid');
  }
  if (record.acceptanceExpiresAt !== null) {
    assert(typeof record.acceptanceExpiresAt === 'string' &&
      Number.isFinite(Date.parse(record.acceptanceExpiresAt)) &&
      record.acceptedAt !== null &&
      Date.parse(record.acceptanceExpiresAt) > Date.parse(record.acceptedAt),
    'Automatic route acceptanceExpiresAt invalid');
  } else {
    assert(record.acceptedAt === null || record.activatedChild !== null,
      'Automatic route acceptance expiry missing');
  }
  if (record.activatedChild !== null) {
    assert(record.activatedChild &&
      typeof record.activatedChild === 'object' &&
      /^[a-f0-9]{64}$/.test(record.activatedChild.childSessionIdHash) &&
      /^[a-f0-9]{64}$/.test(record.activatedChild.childPromptHash) &&
      typeof record.activatedChild.activatedAt === 'string' &&
      Number.isFinite(Date.parse(record.activatedChild.activatedAt)),
    'Automatic route activatedChild invalid');
  }
  const routeHash = automaticRouteRecordHash(record);
  if (record.routeHash !== undefined) {
    assert(record.routeHash === routeHash, 'Automatic route hash mismatch');
  }
  return {
    ...record,
    sessionId,
    routeHash,
  };
}

function writeAutomaticRouteRecord(home, record) {
  const unsigned = {
    ...record,
    scope: normalizeScope(record.scope),
    historyPlan: storedAutomaticHistoryPlan(record.historyPlan),
    acceptedAt: record.acceptedAt ?? null,
    acceptanceExpiresAt: record.acceptanceExpiresAt ?? null,
    activatedChild: record.activatedChild ?? null,
  };
  const validated = validateAutomaticRouteRecord({
    ...unsigned,
    routeHash: automaticRouteRecordHash(unsigned),
  });
  writePrivateJson(automaticRouteFile(home, validated.sessionId), {
    ...validated,
    routeHash: validated.routeHash,
  });
  return validated;
}

function replaceAutomaticRouteRecord(home, sessionId, record) {
  const file = automaticRouteFile(home, sessionId);
  if (!record) {
    if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fs.unlinkSync(file);
    return;
  }
  const preview = automaticTaskPreviewForRoute(record);
  const unsigned = {
    version: STATE_VERSION,
    kind: AUTOMATIC_ROUTE_STORE_KIND,
    sessionId,
    workflowId: record.workflowId ?? null,
    promptHash: record.promptHash ?? null,
    role: record.role,
    dispatchKind: record.dispatchKind,
    routeClass: record.routeClass,
    repositoryMode: preview.repositoryMode,
    repositoryHash: preview.repositoryHash,
    scope: preview.scope,
    scopeHash: sha256(preview.scope),
    allowedToolCategories: preview.allowedToolCategories,
    allowedToolNames: preview.allowedToolNames,
    allowedToolNamePrefixes: preview.allowedToolNamePrefixes,
    allowedQueryHashes: listHashes(preview.allowedQueries),
    allowedQueryCount: preview.allowedQueries.length,
    validationHashes: listHashes(preview.validations),
    validationCount: preview.validations.length,
    model: preview.dispatchKind === 'task' ? preview.model : null,
    effort: preview.dispatchKind === 'task' ? preview.effort : null,
    context: preview.dispatchKind === 'task' ? preview.context : null,
    agentType: preview.dispatchKind === 'task' ? preview.agentType : null,
    taskNameHash: preview.dispatchKind === 'task' ? sha256(preview.name) : null,
    taskDescriptionHash: preview.dispatchKind === 'task' ? sha256(preview.description) : null,
    taskPromptHash: preview.dispatchKind === 'task' ? sha256(preview.prompt) : null,
    taskPromptBytes: preview.dispatchKind === 'task'
      ? Buffer.byteLength(preview.prompt, 'utf8')
      : 0,
    toolName: preview.dispatchKind === 'deterministic' ? preview.toolName : null,
    historyPlan: storedAutomaticHistoryPlan(record.historyPlan),
    acceptedAt: null,
    acceptanceExpiresAt: null,
    activatedChild: null,
  };
  writeAutomaticRouteRecord(home, unsigned);
}

function readAutomaticRouteRecord(home, sessionId) {
  const stored = readPrivateJson(automaticRouteFile(home, sessionId), 'Automatic route store');
  if (!stored) return null;
  return validateAutomaticRouteRecord(stored);
}

export function promptStartState(payload, options = {}) {
  const sessionId = requireValidSessionId(
    firstDefined(payload, ['sessionId', 'session_id']),
    'sessionId',
  );
  const home = options.home;
  const prompt = resolvePrompt(payload);
  const promptHash = sha256(prompt);
  const existing = currentPromptState(home, sessionId);
  if (existing &&
    existing.promptHash === promptHash &&
    existing.endedAt === null) {
    registerChildAgentFromPayload(home, existing, payload, startedAtFromPayload(payload, options.now));
    return existing;
  }
  const startedAt = startedAtFromPayload(payload, options.now);
  const intent = normalizeIntent(payload);
  const profile = resolveSessionProfile(home, sessionId, { payload });
  const childState = deriveChildSessionState({
    home,
    sessionId,
    prompt,
    promptHash,
    payload,
    startedAt,
  });
  const ledger = readRoutingLedger(home, sessionId);
  const promptIndex = ledger.nextPromptIndex;
  const trustedProfile = childState ?? {
    model: profile.model,
    effort: profile.effort,
    context: profile.context,
    profileSource: profile.source,
    classification: APPROVED_ROOT_MODELS.has(profile.model)
      ? 'approved-root'
      : 'protected-root',
    protectedSession: !APPROVED_ROOT_MODELS.has(profile.model),
    dispatchManifestHash: null,
    parentSessionId: null,
    parentWorkflowId: null,
    parentPromptHash: null,
    childActivationReceiptHash: null,
    role: null,
    repositoryMode: 'none',
    repositoryHash: null,
    scope: [],
    scopeHash: null,
    allowedToolCategories: [],
    allowedToolNames: [],
    allowedToolNamePrefixes: [],
    allowedQueries: [],
    validations: [],
  };
  const unsigned = {
    version: STATE_VERSION,
    kind: ROUTING_STATE_KIND,
    sessionId,
    workflowId: sha256({ sessionId, promptHash, promptIndex }),
    promptIndex,
    promptHash,
    promptBytes: Buffer.byteLength(prompt),
    model: trustedProfile.model,
    effort: trustedProfile.effort,
    context: trustedProfile.context,
    profileSource: trustedProfile.profileSource,
    classification: trustedProfile.classification,
    protectedSession: trustedProfile.protectedSession,
    role: trustedProfile.role,
    repositoryMode: trustedProfile.repositoryMode ?? 'none',
    repositoryHash: trustedProfile.repositoryHash ?? null,
    scope: trustedProfile.scope,
    scopeHash: trustedProfile.scopeHash,
    allowedToolCategories: trustedProfile.allowedToolCategories,
    allowedToolNames: trustedProfile.allowedToolNames,
    allowedToolNamePrefixes: trustedProfile.allowedToolNamePrefixes,
    allowedQueryHashes: Array.isArray(trustedProfile.allowedQueryHashes)
      ? [...trustedProfile.allowedQueryHashes]
      : listHashes(trustedProfile.allowedQueries ?? []),
    allowedQueryCount: Number.isInteger(trustedProfile.allowedQueryCount)
      ? trustedProfile.allowedQueryCount
      : (trustedProfile.allowedQueries ?? []).length,
    validationHashes: Array.isArray(trustedProfile.validationHashes)
      ? [...trustedProfile.validationHashes]
      : listHashes(trustedProfile.validations ?? []),
    validationCount: Number.isInteger(trustedProfile.validationCount)
      ? trustedProfile.validationCount
      : (trustedProfile.validations ?? []).length,
    dispatchManifestHash: trustedProfile.dispatchManifestHash,
    parentSessionId: trustedProfile.parentSessionId,
    parentWorkflowId: trustedProfile.parentWorkflowId,
    parentPromptHash: trustedProfile.parentPromptHash,
    childActivationReceiptHash: trustedProfile.childActivationReceiptHash,
    intent,
    startedAt,
    endedAt: null,
  };
  const state = { ...unsigned, stateHash: sha256(unsigned) };
  writePrivateJson(routingStateFile(home, sessionId), state);
  const automaticRoute = automaticRouteDescriptor(payload, state, home);
  replaceAutomaticRouteRecord(home, sessionId,
    automaticRoute && {
      ...automaticRoute,
      sessionId,
      workflowId: state.workflowId,
      promptHash: state.promptHash,
    });
  appendLedgerEntry(home, state);
  registerChildAgentFromPayload(home, state, payload, startedAt);
  return state;
}

export function clearSessionState(sessionId, options = {}) {
  const validSessionId = requireValidSessionId(sessionId, 'sessionId');
  const state = currentPromptState(options.home, validSessionId);
  if (!state) {
    return { cleared: true, sessionId: validSessionId, ended: false, preservedLedger: false };
  }
  if (state.endedAt === null) {
    const ended = {
      ...state,
      endedAt: new Date(options.now ?? Date.now()).toISOString(),
    };
    ended.stateHash = stateHash(ended);
    writePrivateJson(routingStateFile(options.home, validSessionId), ended);
  }
  return { cleared: true, sessionId: validSessionId, ended: true, preservedLedger: true };
}

function currentPromptState(home, sessionId) {
  const state = readPrivateJson(routingStateFile(home, sessionId), 'Routing state');
  if (!state) return null;
  return state.stateHash === stateHash(state) ? state : null;
}

function startedAtFromPayload(payload, now) {
  return new Date(now ?? payload.timestamp ?? Date.now()).toISOString();
}

function validateChildActivationRecord(record) {
  assert(record && typeof record === 'object' && !Array.isArray(record),
    'Child activation record is invalid');
  assert(typeof record.receiptHash === 'string' && /^[a-f0-9]{64}$/.test(record.receiptHash),
    'Child activation receiptHash invalid');
  assert(typeof record.parentWorkflowId === 'string' && record.parentWorkflowId.length > 0,
    'Child activation parentWorkflowId required');
  assert(typeof record.parentPromptHash === 'string' && /^[a-f0-9]{64}$/.test(record.parentPromptHash),
    'Child activation parentPromptHash invalid');
  assert(typeof record.manifestHash === 'string' && /^[a-f0-9]{64}$/.test(record.manifestHash),
    'Child activation manifestHash invalid');
  assert(DISPATCH_ROLES.has(record.role) && !roleIsReasonOnly(record.role),
    'Child activation role is invalid');
  validateProfile({
    model: record.model,
    effort: record.effort,
    context: record.context,
  }, 'Child activation record profile');
  assert(typeof record.scopeHash === 'string' && /^[a-f0-9]{64}$/.test(record.scopeHash),
    'Child activation scopeHash invalid');
  assert(Number.isInteger(record.scopeEntryCount) && record.scopeEntryCount > 0,
    'Child activation scopeEntryCount invalid');
  assert(Array.isArray(record.allowedToolCategories) &&
    record.allowedToolCategories.every(category => TOOL_CATEGORIES.has(category)),
  'Child activation allowed tool categories are invalid');
  assert(Array.isArray(record.allowedToolNames) &&
    record.allowedToolNames.every(value => typeof value === 'string' && value.length > 0),
  'Child activation allowed tool names are invalid');
  assert(Array.isArray(record.allowedToolNamePrefixes) &&
    record.allowedToolNamePrefixes.every(value => typeof value === 'string' && value.length > 0),
  'Child activation allowed tool name prefixes are invalid');
  assert(Array.isArray(record.allowedQueryHashes) &&
    record.allowedQueryHashes.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) &&
    Number.isInteger(record.allowedQueryCount) &&
    record.allowedQueryCount >= 0,
  'Child activation allowed query hashes are invalid');
  assert(Array.isArray(record.validationHashes) &&
    record.validationHashes.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)),
  'Child activation validation hashes are invalid');
  assert(Number.isInteger(record.validationCount) && record.validationCount >= 0,
    'Child activation validationCount invalid');
  assert(typeof record.childPromptBindingHash === 'string' &&
    /^[a-f0-9]{64}$/.test(record.childPromptBindingHash),
  'Child activation childPromptBindingHash invalid');
  assert(typeof record.issuedAt === 'string' &&
    typeof record.expiresAt === 'string' &&
    Number.isFinite(Date.parse(record.issuedAt)) &&
    Number.isFinite(Date.parse(record.expiresAt)) &&
    Date.parse(record.expiresAt) > Date.parse(record.issuedAt),
  'Child activation validity window invalid');
  if (record.consumedBy !== null) {
    assert(record.consumedBy && typeof record.consumedBy === 'object' &&
      typeof record.consumedBy.childSessionIdHash === 'string' &&
      /^[a-f0-9]{64}$/.test(record.consumedBy.childSessionIdHash) &&
      typeof record.consumedBy.childPromptHash === 'string' &&
      /^[a-f0-9]{64}$/.test(record.consumedBy.childPromptHash) &&
      typeof record.consumedBy.activatedAt === 'string' &&
      Number.isFinite(Date.parse(record.consumedBy.activatedAt)),
    'Child activation consumption record is invalid');
  }
  return {
    ...record,
    consumedBy: record.consumedBy ?? null,
  };
}

function childActivationLedgerRecord(receipt, consumedBy = null) {
  return {
    receiptHash: receipt.receiptHash,
    parentWorkflowId: receipt.parentWorkflowId,
    parentPromptHash: receipt.parentPromptHash,
    manifestHash: receipt.manifestHash,
    role: receipt.role,
    model: receipt.model,
    effort: receipt.effort,
    context: receipt.context,
    scopeHash: receipt.scopeHash,
    scopeEntryCount: receipt.scope.length,
    allowedToolCategories: [...receipt.allowedToolCategories],
    allowedToolNames: [...(receipt.allowedToolNames ?? [])],
    allowedToolNamePrefixes: [...(receipt.allowedToolNamePrefixes ?? [])],
    allowedQueryHashes: listHashes(receipt.allowedQueries ?? []),
    allowedQueryCount: (receipt.allowedQueries ?? []).length,
    validationHashes: listHashes(receipt.validations),
    validationCount: receipt.validations.length,
    childPromptBindingHash: receipt.childPromptBindingHash,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    consumedBy,
  };
}

function childActivationRecordMatchesReceipt(record, receipt) {
  return record.receiptHash === receipt.receiptHash &&
    record.parentWorkflowId === receipt.parentWorkflowId &&
    record.parentPromptHash === receipt.parentPromptHash &&
    record.manifestHash === receipt.manifestHash &&
    record.role === receipt.role &&
    record.model === receipt.model &&
    record.effort === receipt.effort &&
    record.context === receipt.context &&
    record.scopeHash === receipt.scopeHash &&
    record.scopeEntryCount === receipt.scope.length &&
    arraysEqual(record.allowedToolCategories, receipt.allowedToolCategories) &&
    arraysEqual(record.allowedToolNames, receipt.allowedToolNames ?? []) &&
    arraysEqual(record.allowedToolNamePrefixes, receipt.allowedToolNamePrefixes ?? []) &&
    record.allowedQueryCount === (receipt.allowedQueries ?? []).length &&
    arraysEqual(record.allowedQueryHashes, listHashes(receipt.allowedQueries ?? [])) &&
    record.validationCount === receipt.validations.length &&
    arraysEqual(record.validationHashes, listHashes(receipt.validations)) &&
    record.childPromptBindingHash === receipt.childPromptBindingHash &&
    record.issuedAt === receipt.issuedAt &&
    record.expiresAt === receipt.expiresAt;
}

function readChildActivationRecords(home, sessionId) {
  const stored = readPrivateJson(childActivationFile(home, sessionId), 'Child activation store');
  if (!stored) return [];
  assert(stored.version === STATE_VERSION &&
    stored.kind === 'child-activation-store' &&
    stored.sessionIdHash === sha256(sessionId) &&
    Array.isArray(stored.records),
  'Child activation store is invalid');
  return stored.records.map(validateChildActivationRecord);
}

function persistChildActivationRecord(home, sessionId, receipt) {
  const records = readChildActivationRecords(home, sessionId)
    .filter(record => record.receiptHash !== receipt.receiptHash);
  records.push(childActivationLedgerRecord(receipt));
  writeChildActivationRecords(home, sessionId, records);
}

function writeChildActivationRecords(home, sessionId, records) {
  writePrivateJson(childActivationFile(home, sessionId), {
    version: STATE_VERSION,
    kind: 'child-activation-store',
    sessionIdHash: sha256(sessionId),
    records,
  });
}

function validateChildAgentRecord(record) {
  assert(record && typeof record === 'object' && !Array.isArray(record),
    'Child agent registry record is invalid');
  assert(typeof record.agentIdHash === 'string' && /^[a-f0-9]{64}$/.test(record.agentIdHash),
    'Child agent registry agentIdHash invalid');
  const childSessionId = requireValidSessionId(record.childSessionId,
    'Child agent registry childSessionId');
  assert(typeof record.parentWorkflowId === 'string' && record.parentWorkflowId.length > 0,
    'Child agent registry parentWorkflowId required');
  assert(typeof record.parentPromptHash === 'string' && /^[a-f0-9]{64}$/.test(record.parentPromptHash),
    'Child agent registry parentPromptHash invalid');
  assert(typeof record.dispatchManifestHash === 'string' && /^[a-f0-9]{64}$/.test(record.dispatchManifestHash),
    'Child agent registry dispatchManifestHash invalid');
  assert(record.childActivationReceiptHash === null || (
    typeof record.childActivationReceiptHash === 'string' &&
    /^[a-f0-9]{64}$/.test(record.childActivationReceiptHash)
  ), 'Child agent registry childActivationReceiptHash invalid');
  assert(typeof record.registeredAt === 'string' && Number.isFinite(Date.parse(record.registeredAt)),
    'Child agent registry registeredAt invalid');
  return {
    ...record,
    childSessionId,
    childActivationReceiptHash: record.childActivationReceiptHash ?? null,
  };
}

function readChildAgentRegistry(home, sessionId) {
  const stored = readPrivateJson(
    childAgentRegistryFile(home, sessionId),
    'Child agent registry',
  );
  if (!stored) return [];
  assert(stored.version === STATE_VERSION &&
    stored.kind === CHILD_AGENT_REGISTRY_KIND &&
    stored.sessionIdHash === sha256(sessionId) &&
    Array.isArray(stored.records),
  'Child agent registry is invalid');
  return stored.records.map(validateChildAgentRecord);
}

function writeChildAgentRegistry(home, sessionId, records) {
  writePrivateJson(childAgentRegistryFile(home, sessionId), {
    version: STATE_VERSION,
    kind: CHILD_AGENT_REGISTRY_KIND,
    sessionIdHash: sha256(sessionId),
    records,
  });
}

function registerChildAgentFromPayload(home, state, payload, registeredAt) {
  if (!state || state.classification !== 'subagent-active' || !state.parentSessionId) return;
  const metadata = extractHostChildMetadata(payload, {
    requireDispatchManifestHash: state.profileSource !== 'automatic-route-activation',
  });
  if (!metadata?.agentId) return;
  assert(metadata.parentSessionId === state.parentSessionId &&
    metadata.parentWorkflowId === state.parentWorkflowId &&
    metadata.parentPromptHash === state.parentPromptHash &&
    (state.profileSource === 'automatic-route-activation'
      ? metadata.dispatchManifestHash === null || metadata.dispatchManifestHash === state.dispatchManifestHash
      : metadata.dispatchManifestHash === state.dispatchManifestHash),
  'Host child agent metadata does not match the validated child routing state');
  const parentSessionId = state.parentSessionId;
  const records = readChildAgentRegistry(home, parentSessionId).filter(record => (
    record.parentWorkflowId === state.parentWorkflowId &&
    record.parentPromptHash === state.parentPromptHash &&
    record.dispatchManifestHash === state.dispatchManifestHash &&
    record.childSessionId === state.sessionId &&
    record.agentIdHash === sha256(metadata.agentId)
  ) === false);
  records.push({
    agentIdHash: sha256(metadata.agentId),
    childSessionId: state.sessionId,
    parentWorkflowId: state.parentWorkflowId,
    parentPromptHash: state.parentPromptHash,
    dispatchManifestHash: state.dispatchManifestHash,
    childActivationReceiptHash: state.childActivationReceiptHash ?? null,
    registeredAt,
  });
  writeChildAgentRegistry(home, parentSessionId, records);
}

function activateChildReceipt(home, parentSessionId, receipt, childSessionId, childPromptHash, now = new Date().toISOString()) {
  const records = readChildActivationRecords(home, parentSessionId);
  const index = records.findIndex(record => record.receiptHash === receipt.receiptHash);
  if (index < 0) return null;
  const record = records[index];
  if (!childActivationRecordMatchesReceipt(record, receipt)) return false;
  if (Date.parse(record.expiresAt) <= Date.now()) return null;
  const childSessionIdHash = sha256(requireValidSessionId(childSessionId, 'Child activation childSessionId'));
  if (record.consumedBy) {
    return record.consumedBy.childSessionIdHash === childSessionIdHash &&
      record.consumedBy.childPromptHash === childPromptHash
      ? receipt
      : false;
  }
  record.consumedBy = {
    childSessionIdHash,
    childPromptHash,
    activatedAt: now,
  };
  writePrivateJson(childActivationFile(home, parentSessionId), {
    version: STATE_VERSION,
    kind: 'child-activation-store',
    sessionIdHash: sha256(parentSessionId),
    records,
  });
  return receipt;
}

function normalizeActivationPrompt(prompt) {
  return String(prompt ?? '')
    .replace(/```budget-child-activation\s*[\s\S]*?\s*```/, '')
    .trim();
}

function extractHostChildMetadata(payload, { requireDispatchManifestHash = true } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const profile = profileFromObject(payload);
  const parentSessionId = firstDefined(payload, [
    'parentSessionId', 'parent_session_id', 'subagentParentSessionId', 'subagent_parent_session_id',
  ]);
  const parentWorkflowId = firstDefined(payload, [
    'parentWorkflowId', 'parent_workflow_id',
  ]);
  const parentPromptHash = firstDefined(payload, [
    'parentPromptHash', 'parent_prompt_hash',
  ]);
  const dispatchManifestHash = firstDefined(payload, [
    'dispatchManifestHash', 'dispatch_manifest_hash',
  ]);
  const agentId = firstDefined(payload, [
    'agentId', 'agent_id',
  ]);
  if (!profile ||
    [parentSessionId, parentWorkflowId, parentPromptHash]
      .some(value => typeof value !== 'string' || value.length === 0)) {
    return null;
  }
  const normalizedDispatchManifestHash = typeof dispatchManifestHash === 'string' &&
    /^[a-f0-9]{64}$/i.test(dispatchManifestHash)
    ? dispatchManifestHash.toLowerCase()
    : null;
  if (requireDispatchManifestHash && normalizedDispatchManifestHash === null) return null;
  return {
    ...profile,
    parentSessionId,
    parentWorkflowId,
    parentPromptHash,
    dispatchManifestHash: normalizedDispatchManifestHash,
    agentId: typeof agentId === 'string' && agentId.trim().length > 0
      ? requireValidAgentId(agentId, 'Host child metadata agentId')
      : null,
  };
}

function childStateFromManifest(manifest, extras) {
  const active = extras.classification === 'subagent-active';
  return {
    model: manifest.model,
    effort: manifest.effort,
    context: manifest.context,
    profileSource: extras.profileSource,
    classification: extras.classification,
    protectedSession: false,
    role: manifest.role,
    repositoryMode: manifest.repository ? 'cwd-repository-root' : 'none',
    repositoryHash: manifest.repository
      ? sha256(fs.realpathSync(manifest.repository))
      : null,
    scope: manifest.scope,
    scopeHash: manifest.scopeHash,
    allowedToolCategories: active ? manifest.allowedToolCategories : [],
    allowedToolNames: active ? (manifest.allowedToolNames ?? []) : [],
    allowedToolNamePrefixes: active ? (manifest.allowedToolNamePrefixes ?? []) : [],
    allowedQueries: active ? (manifest.allowedQueries ?? []) : [],
    validations: active ? manifest.validations : [],
    allowedQueryHashes: active ? listHashes(manifest.allowedQueries ?? []) : [],
    allowedQueryCount: active ? (manifest.allowedQueries ?? []).length : 0,
    validationHashes: active ? listHashes(manifest.validations) : [],
    validationCount: active ? manifest.validations.length : 0,
    dispatchManifestHash: manifest.manifestHash,
    parentSessionId: manifest.sessionId,
    parentWorkflowId: manifest.workflowId,
    parentPromptHash: manifest.promptHash,
    childActivationReceiptHash: extras.childActivationReceiptHash ?? null,
  };
}

function unresolvedChildStateFromMetadata(metadata, profileSource) {
  return {
    model: metadata.model,
    effort: metadata.effort,
    context: metadata.context,
    profileSource,
    classification: 'subagent-unresolved',
    protectedSession: false,
    role: null,
    repositoryMode: 'none',
    repositoryHash: null,
    scope: [],
    scopeHash: null,
    allowedToolCategories: [],
    allowedToolNames: [],
    allowedToolNamePrefixes: [],
    allowedQueries: [],
    validations: [],
    allowedQueryHashes: [],
    allowedQueryCount: 0,
    validationHashes: [],
    validationCount: 0,
    dispatchManifestHash: metadata.dispatchManifestHash ?? null,
    parentSessionId: metadata.parentSessionId,
    parentWorkflowId: metadata.parentWorkflowId,
    parentPromptHash: metadata.parentPromptHash,
    childActivationReceiptHash: null,
  };
}

function automaticChildStateFromRoute(route, metadata) {
  return {
    model: route.model,
    effort: route.effort,
    context: route.context,
    profileSource: 'automatic-route-activation',
    classification: 'subagent-active',
    protectedSession: false,
    role: route.role,
    repositoryMode: route.repositoryMode ?? 'none',
    repositoryHash: route.repositoryHash ?? null,
    scope: route.scope,
    scopeHash: route.scopeHash,
    allowedToolCategories: [...route.allowedToolCategories],
    allowedToolNames: [...(route.allowedToolNames ?? [])],
    allowedToolNamePrefixes: [...(route.allowedToolNamePrefixes ?? [])],
    allowedQueries: [],
    validations: [],
    allowedQueryHashes: [...(route.allowedQueryHashes ?? [])],
    allowedQueryCount: route.allowedQueryCount ?? (route.allowedQueryHashes ?? []).length,
    validationHashes: [...(route.validationHashes ?? [])],
    validationCount: route.validationCount ?? (route.validationHashes ?? []).length,
    dispatchManifestHash: route.routeHash,
    parentSessionId: metadata.parentSessionId,
    parentWorkflowId: metadata.parentWorkflowId,
    parentPromptHash: metadata.parentPromptHash,
    childActivationReceiptHash: null,
  };
}

function automaticChildActivationRecord(route, childPrompt, issuedAt, expiresAt) {
  const childPromptBindingHash = sha256(normalizeActivationPrompt(childPrompt));
  const unsigned = {
    parentWorkflowId: route.workflowId,
    parentPromptHash: route.promptHash,
    manifestHash: route.routeHash,
    role: route.role,
    model: route.model,
    effort: route.effort,
    context: route.context,
    scopeHash: route.scopeHash,
    scopeEntryCount: route.scope.length,
    allowedToolCategories: [...route.allowedToolCategories],
    allowedToolNames: [...(route.allowedToolNames ?? [])],
    allowedToolNamePrefixes: [...(route.allowedToolNamePrefixes ?? [])],
    allowedQueryHashes: [...(route.allowedQueryHashes ?? [])],
    allowedQueryCount: route.allowedQueryCount ?? (route.allowedQueryHashes ?? []).length,
    validationHashes: [...(route.validationHashes ?? [])],
    validationCount: route.validationCount ?? (route.validationHashes ?? []).length,
    childPromptBindingHash,
    issuedAt,
    expiresAt,
    consumedBy: null,
  };
  return validateChildActivationRecord({
    ...unsigned,
    receiptHash: sha256({
      kind: CHILD_ACTIVATION_KIND,
      parentSessionId: route.sessionId,
      ...unsigned,
    }),
  });
}

function persistAutomaticTaskAcceptance(home, promptState, route, childPrompt, now = new Date().toISOString()) {
  const issuedAt = String(now);
  const expiresAt = new Date(Date.parse(issuedAt) + AUTOMATIC_ROUTE_ACCEPT_WINDOW_MS).toISOString();
  const activationRecord = automaticChildActivationRecord(route, childPrompt, issuedAt, expiresAt);
  const records = readChildActivationRecords(home, promptState.sessionId)
    .filter(record => record.receiptHash !== activationRecord.receiptHash);
  records.push(activationRecord);
  writeChildActivationRecords(home, promptState.sessionId, records);
  return writeAutomaticRouteRecord(home, {
    ...route,
    acceptedAt: issuedAt,
    acceptanceExpiresAt: expiresAt,
    activatedChild: null,
  });
}

function activateAcceptedAutomaticRoute(home, metadata, childSessionId, childPromptHash, now = new Date().toISOString()) {
  const parentState = currentPromptState(home, metadata.parentSessionId);
  if (!parentState ||
    parentState.endedAt !== null ||
    parentState.workflowId !== metadata.parentWorkflowId ||
    parentState.promptHash !== metadata.parentPromptHash) {
    return null;
  }
  let route = null;
  try {
    route = activeAutomaticRoute(home, metadata.parentSessionId, parentState);
  } catch {
    return null;
  }
  if (!route || route.dispatchKind !== 'task') return null;
  if (route.model !== metadata.model ||
    route.effort !== metadata.effort ||
    route.context !== metadata.context) {
    return null;
  }
  const childSessionIdHash = sha256(requireValidSessionId(childSessionId, 'Automatic route childSessionId'));
  if (route.activatedChild) {
    return route.activatedChild.childSessionIdHash === childSessionIdHash &&
      route.activatedChild.childPromptHash === childPromptHash
      ? route
      : null;
  }
  if (route.acceptedAt === null ||
    route.acceptanceExpiresAt === null ||
    Date.parse(route.acceptanceExpiresAt) <= Date.parse(now)) {
    return null;
  }
  const records = readChildActivationRecords(home, metadata.parentSessionId);
  const index = records.findIndex(record =>
    record.parentWorkflowId === route.workflowId &&
    record.parentPromptHash === route.promptHash &&
    record.manifestHash === route.routeHash &&
    record.role === route.role &&
    record.model === route.model &&
    record.effort === route.effort &&
    record.context === route.context &&
    record.childPromptBindingHash === childPromptHash &&
    Date.parse(record.expiresAt) > Date.parse(now));
  if (index < 0) return null;
  const record = records[index];
  if (record.consumedBy) {
    return record.consumedBy.childSessionIdHash === childSessionIdHash &&
      record.consumedBy.childPromptHash === childPromptHash
      ? route
      : null;
  }
  record.consumedBy = {
    childSessionIdHash,
    childPromptHash,
    activatedAt: now,
  };
  writeChildActivationRecords(home, metadata.parentSessionId, records);
  return writeAutomaticRouteRecord(home, {
    ...route,
    acceptanceExpiresAt: null,
    activatedChild: {
      childSessionIdHash,
      childPromptHash,
      activatedAt: now,
    },
  });
}

function deriveChildSessionState({ home, sessionId, prompt, promptHash, payload, startedAt }) {
  const manifest = parseDispatchManifest(prompt);
  if (manifest && manifest.dispatchKind === 'task') {
    const recreated = createDispatchManifest({ ...manifest, plan: manifest.plan ?? null });
    if (recreated.manifestHash !== manifest.manifestHash) {
      return childStateFromManifest(recreated, {
        classification: 'subagent-unresolved',
        profileSource: 'invalid-dispatch-manifest',
      });
    }
    const hostMetadata = extractHostChildMetadata(payload);
    if (hostMetadata &&
      hostMetadata.parentSessionId === manifest.sessionId &&
      hostMetadata.parentWorkflowId === manifest.workflowId &&
      hostMetadata.parentPromptHash === manifest.promptHash &&
      hostMetadata.dispatchManifestHash === manifest.manifestHash &&
      hostMetadata.model === manifest.model &&
      hostMetadata.effort === manifest.effort &&
      hostMetadata.context === manifest.context) {
      return childStateFromManifest(manifest, {
        classification: 'subagent-active',
        profileSource: 'host-agent-metadata',
      });
    }
    const activation = parseChildActivation(prompt);
    if (!activation) {
      return childStateFromManifest(manifest, {
        classification: 'subagent-unresolved',
        profileSource: 'missing-child-activation',
      });
    }
    try {
      const receipt = validateChildActivationReceipt(activation);
      assert(receipt.parentSessionId === manifest.sessionId &&
        receipt.parentWorkflowId === manifest.workflowId &&
        receipt.parentPromptHash === manifest.promptHash,
      'Child activation parent binding mismatch');
      assert(receipt.manifestHash === manifest.manifestHash,
        'Child activation manifest hash mismatch');
      assert(receipt.role === manifest.role &&
        receipt.model === manifest.model &&
        receipt.effort === manifest.effort &&
        receipt.context === manifest.context &&
        receipt.scopeHash === manifest.scopeHash,
      'Child activation role/profile/scope mismatch');
      assert(receipt.childPromptBindingHash === sha256(normalizeActivationPrompt(prompt)),
        'Child activation prompt binding mismatch');
      const consumed = activateChildReceipt(
        home,
        receipt.parentSessionId,
        receipt,
        sessionId,
        promptHash,
        startedAt,
      );
      if (consumed && consumed !== false) {
        return childStateFromManifest(manifest, {
          classification: 'subagent-active',
          profileSource: 'child-activation-receipt',
          childActivationReceiptHash: receipt.receiptHash,
        });
      }
    } catch {
      // Invalid or forged activation receipts remain fail-closed as unresolved child sessions.
    }
    return childStateFromManifest(manifest, {
      classification: 'subagent-unresolved',
      profileSource: 'invalid-or-stale-child-activation',
      childActivationReceiptHash: typeof activation?.receiptHash === 'string'
        ? activation.receiptHash
        : null,
    });
  }
  const automaticHostMetadata = extractHostChildMetadata(payload, {
    requireDispatchManifestHash: false,
  });
  if (automaticHostMetadata) {
    const route = activateAcceptedAutomaticRoute(
      home,
      automaticHostMetadata,
      sessionId,
      promptHash,
      startedAt,
    );
    return route
      ? automaticChildStateFromRoute(route, automaticHostMetadata)
      : unresolvedChildStateFromMetadata(
        automaticHostMetadata,
        'invalid-or-stale-automatic-route-activation',
      );
  }
  return null;
}

function profileForRole(role) {
  const profile = DISPATCH_ROLE_CATALOG[role];
  assert(profile, `Unsupported dispatch role: ${role}`);
  return profile;
}

function roleIsFrontier(role) {
  return ['frontier-research', 'frontier-adjudication', 'tandem-secondary-research'].includes(role);
}

function roleIsReasonOnly(role) {
  return roleIsFrontier(role) || role === INTENT_ACCEPTANCE_ROLE;
}

function normalizeScope(scope) {
  if (typeof scope === 'string' && scope.trim()) return [scope.trim()];
  if (Array.isArray(scope) && scope.length > 0 &&
    scope.every(item => typeof item === 'string' && item.trim())) {
    return [...new Set(scope.map(item => item.trim()))];
  }
  throw new Error('Dispatch scope must contain one or more exact strings');
}

function normalizeExactStringList(values, label, { allowEmpty = false } = {}) {
  if (values === undefined) return [];
  if (allowEmpty && Array.isArray(values) && values.length === 0) return [];
  try {
    return normalizeScope(values);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

function validateDispatchPlan(plan, role, model, effort, context) {
  if (!plan) return null;
  assert(plan && typeof plan === 'object' && typeof plan.status === 'string',
    'Dispatch plan must be an object with status');
  if (['needs-opportunity', 'ambiguous-opportunity'].includes(plan.status)) {
    assert(role === 'implementation-coordinator' &&
      model === LUNA_MEDIUM_DEFAULT_PROFILE.model &&
      effort === LUNA_MEDIUM_DEFAULT_PROFILE.effort &&
      context === LUNA_MEDIUM_DEFAULT_PROFILE.context,
    'Planner ambiguity is terminal for protected sessions except an explicit gpt-5.6-luna medium/default coordinator dispatch');
  }
  return structuredClone(plan);
}

function normalizeManifestIntent(input) {
  const intent = input.intent ?? {};
  const normalized = {
    researchMode: intent.researchMode ?? null,
    tandemRequested: intent.tandemRequested === true,
    historyRequested: intent.historyRequested === true,
    metaAudit: intent.metaAudit === true,
    packetWorkflowVersion: intent.packetWorkflowVersion ?? PACKET_WORKFLOW_VERSION,
  };
  if (normalized.researchMode !== null) {
    assert(RESEARCH_MODES.includes(normalized.researchMode),
      'Manifest researchMode invalid');
  }
  assert(normalized.packetWorkflowVersion === PACKET_WORKFLOW_VERSION,
    'Manifest packet workflow version mismatch');
  return normalized;
}

export function createDispatchManifest(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Dispatch manifest input required');
  const role = input.role;
  assert(DISPATCH_ROLES.has(role), 'Unsupported dispatch role');
  const frontier = roleIsFrontier(role);
  const repository = input.repository ? fs.realpathSync(input.repository) : null;
  const scope = normalizeScope(input.scope);
  const allowedToolCategories = normalizeExactStringList(
    input.allowedToolCategories,
    'allowedToolCategories',
    { allowEmpty: true },
  );
  allowedToolCategories.forEach(category => {
    assert(TOOL_CATEGORIES.has(category), `Unsupported tool category: ${category}`);
  });
  const allowedToolNames = normalizeExactToolNames(
    input.allowedToolNames,
    'allowedToolNames',
  );
  const allowedToolNamePrefixes = normalizeOptionalPrefixes(
    input.allowedToolNamePrefixes,
    'allowedToolNamePrefixes',
  );
  const allowedQueries = normalizeOptionalPrefixes(
    input.allowedQueries,
    'allowedQueries',
  );
  const plan = validateDispatchPlan(input.plan ?? null, role, input.model, input.effort, input.context);
  const effectiveContract = createDispatchEffectiveContract({
    repository,
    project: input.project,
    role,
    plan,
  });
  const selectedRole = effectiveContract.selectedRole;
  const project = effectiveContract.project;
  assert(project.length > 0, 'Dispatch manifest project required');
  const validations = normalizeExactStringList(
    input.validations,
    'validations',
    { allowEmpty: true },
  );
  const model = String(input.model ?? '');
  const effort = String(input.effort ?? '');
  const context = String(input.context ?? '');
  const agentType = input.agentType === undefined || input.agentType === null
    ? null
    : String(input.agentType);
  assert(model && effort && context, 'Dispatch manifest requires explicit model, effort, and context');
  if (role === INTENT_ACCEPTANCE_ROLE) {
    validateProfile({ model, effort, context }, 'Intent acceptance dispatch selected profile');
  } else {
    assert(model === selectedRole.profile.model &&
      effort === selectedRole.profile.effort &&
      context === selectedRole.profile.context,
    `Dispatch role ${role} must use ${selectedRole.profile.model}/${selectedRole.profile.effort}/${selectedRole.profile.context}`);
  }
  if (roleIsReasonOnly(role)) {
    assert(agentType === null, 'Packet-only reason-only dispatch cannot use a task agent type');
    assert(allowedToolCategories.length === 0,
      'Packet-only reason-only dispatch cannot grant repository, shell, browser, or history tools');
    assert(typeof input.evidencePacketHash === 'string' &&
      /^[a-f0-9]{64}$/.test(input.evidencePacketHash),
    'Frontier packet-only dispatch requires an evidencePacketHash');
    assert(typeof input.receiptHash === 'string' &&
      /^[a-f0-9]{64}$/.test(input.receiptHash),
    'Packet-only reason-only dispatch requires a receipt hash');
    if (role === 'tandem-secondary-research') {
      assert(typeof input.tandemPairReceiptHash === 'string' &&
        /^[a-f0-9]{64}$/.test(input.tandemPairReceiptHash),
      'Tandem secondary dispatch requires a tandemPairReceiptHash');
    }
  } else {
    assert(agentType && selectedRole.agentTypes.includes(agentType),
      `Dispatch role ${role} cannot use agent type ${agentType}`);
    assert(!FORBIDDEN_TASK_MODELS.has(model) &&
      !model.startsWith('claude'),
    'Non-research dispatch cannot use frontier, inherit, or Claude models');
  }
  const researchAuthorized = input.researchAuthorized === true;
  const intentAcceptanceAuthorized = input.intentAcceptanceAuthorized === true;
  if (frontier) {
    assert(researchAuthorized, 'Frontier packet-only dispatch requires researchAuthorized=true');
    assert(intentAcceptanceAuthorized === false,
      'Frontier research dispatch cannot declare intentAcceptanceAuthorized');
  } else if (role === INTENT_ACCEPTANCE_ROLE) {
    assert(researchAuthorized === false, 'Intent acceptance dispatch cannot declare research authorization');
    assert(intentAcceptanceAuthorized, 'Intent acceptance dispatch requires intentAcceptanceAuthorized=true');
  } else {
    assert(researchAuthorized === false, 'Non-research dispatch cannot declare research authorization');
    assert(intentAcceptanceAuthorized === false,
      'Non-intent-acceptance dispatch cannot declare intentAcceptanceAuthorized');
  }
  const promptHash = String(input.promptHash ?? '');
  const sessionId = requireValidSessionId(
    firstDefined(input, ['sessionId', 'session_id']),
    'Dispatch manifest sessionId',
  );
  assert(promptHash && /^[a-f0-9]{64}$/.test(promptHash), 'Dispatch manifest promptHash required');
  const unsigned = {
    version: STATE_VERSION,
    kind: DISPATCH_KIND,
    sessionId,
    workflowId: String(input.workflowId ?? ''),
    promptHash,
    project,
    repository,
    scope,
    scopeHash: sha256(scope),
    role,
    dispatchKind: selectedRole.dispatchKind,
    agentType,
    model,
    effort,
    context,
    toolMode: roleIsReasonOnly(role) ? REASON_ONLY_TOOL_MODE : null,
    effectiveContract,
    packetWorkflowVersion: normalizeManifestIntent(input).packetWorkflowVersion,
    intent: normalizeManifestIntent(input),
    allowedToolCategories,
    allowedToolNames,
    allowedToolNamePrefixes,
    allowedQueries,
    validations,
    plan,
    receiptHash: input.receiptHash ?? null,
    evidencePacketHash: input.evidencePacketHash ?? null,
    tandemPairReceiptHash: input.tandemPairReceiptHash ?? null,
    researchAuthorized,
    intentAcceptanceAuthorized,
  };
  assert(unsigned.workflowId.length > 0, 'Dispatch manifest workflowId required');
  return {
    ...unsigned,
    manifestHash: sha256(unsigned),
    promptBlock: `\`\`\`budget-dispatch-manifest\n${JSON.stringify(unsigned, null, 2)}\n\`\`\``,
  };
}

function parseDispatchManifest(prompt) {
  const parsed = parseJsonFence(prompt, 'budget-dispatch-manifest');
  if (!parsed) return null;
  assert(parsed.kind === DISPATCH_KIND, 'Dispatch manifest kind mismatch');
  const recreated = createDispatchManifest({ ...parsed, plan: parsed.plan ?? null });
  return {
    ...parsed,
    manifestHash: recreated.manifestHash,
    promptBlock: recreated.promptBlock,
  };
}

function parseChildActivation(prompt) {
  const parsed = parseJsonFence(prompt, 'budget-child-activation');
  if (!parsed) return null;
  assert(parsed.kind === CHILD_ACTIVATION_KIND, 'Child activation kind mismatch');
  return parsed;
}

export function validateChildActivationReceipt(receipt) {
  assert(receipt && typeof receipt === 'object' && !Array.isArray(receipt),
    'Child activation receipt required');
  assert(receipt.version === STATE_VERSION &&
    receipt.kind === CHILD_ACTIVATION_KIND,
  'Child activation receipt kind/version mismatch');
  assert(typeof receipt.parentSessionId === 'string' && receipt.parentSessionId.length > 0,
    'Child activation parentSessionId required');
  assert(typeof receipt.parentWorkflowId === 'string' && receipt.parentWorkflowId.length > 0,
    'Child activation parentWorkflowId required');
  assert(typeof receipt.parentPromptHash === 'string' &&
    /^[a-f0-9]{64}$/.test(receipt.parentPromptHash),
  'Child activation parentPromptHash invalid');
  assert(typeof receipt.manifestHash === 'string' &&
    /^[a-f0-9]{64}$/.test(receipt.manifestHash),
  'Child activation manifestHash invalid');
  assert(DISPATCH_ROLES.has(receipt.role) && !roleIsReasonOnly(receipt.role),
    'Child activation role is invalid');
  validateProfile({
    model: receipt.model,
    effort: receipt.effort,
    context: receipt.context,
  }, 'Child activation profile');
  assert(Array.isArray(receipt.scope) && receipt.scope.length > 0,
    'Child activation scope required');
  assert(receipt.scopeHash === sha256(receipt.scope),
    'Child activation scope hash mismatch');
  assert(Array.isArray(receipt.allowedToolCategories) &&
    receipt.allowedToolCategories.every(category => TOOL_CATEGORIES.has(category)),
  'Child activation allowed tool categories are invalid');
  assert(Array.isArray(receipt.allowedToolNames) &&
    receipt.allowedToolNames.every(value => typeof value === 'string' && value.length > 0),
  'Child activation allowed tool names are invalid');
  assert(Array.isArray(receipt.allowedToolNamePrefixes) &&
    receipt.allowedToolNamePrefixes.every(value => typeof value === 'string' && value.length > 0),
  'Child activation allowed tool name prefixes are invalid');
  assert(Array.isArray(receipt.allowedQueries) &&
    receipt.allowedQueries.every(value => typeof value === 'string' && value.length > 0),
  'Child activation allowed queries are invalid');
  assert(Array.isArray(receipt.validations) &&
    receipt.validations.every(value => typeof value === 'string' && value.length > 0),
  'Child activation validations are invalid');
  assert(typeof receipt.childPromptBindingHash === 'string' &&
    /^[a-f0-9]{64}$/.test(receipt.childPromptBindingHash),
  'Child activation childPromptBindingHash invalid');
  assert(typeof receipt.issuedAt === 'string' &&
    typeof receipt.expiresAt === 'string' &&
    Number.isFinite(Date.parse(receipt.issuedAt)) &&
    Number.isFinite(Date.parse(receipt.expiresAt)) &&
    Date.parse(receipt.expiresAt) > Date.parse(receipt.issuedAt),
  'Child activation validity window invalid');
  assert(receipt.receiptHash === receiptHash(receipt),
    'Child activation receipt hash mismatch');
  return receipt;
}

export function createChildActivationReceipt(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Child activation input required');
  const parentSessionId = requireValidSessionId(
    firstDefined(input, ['sessionId', 'session_id']),
    'Child activation parent sessionId',
  );
  const state = currentPromptState(options.home, parentSessionId);
  assert(state && state.promptHash === input.promptHash,
    'Child activation input does not match the active parent prompt');
  const manifest = input.dispatchManifest?.manifestHash
    ? input.dispatchManifest
    : createDispatchManifest(input.dispatchManifest);
  assert(manifest.dispatchKind === 'task',
    'Child activation requires a task dispatch manifest');
  assert(manifest.sessionId === state.sessionId &&
    manifest.workflowId === state.workflowId &&
    manifest.promptHash === state.promptHash,
  'Child activation manifest is not bound to the active session, workflow, and prompt');
  const childPrompt = String(input.childPrompt ?? input.taskPrompt ?? '').trim();
  assert(childPrompt.length > 0, 'Child activation requires the exact child prompt text');
  const issuedAt = String(input.issuedAt ?? new Date(options.now ?? Date.now()).toISOString());
  const expiresAt = String(input.expiresAt ?? new Date(Date.parse(issuedAt) + 30 * 60_000).toISOString());
  assert(Number.isFinite(Date.parse(issuedAt)) &&
    Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) > Date.parse(issuedAt),
  'Child activation validity window is invalid');
  const unsigned = {
    version: STATE_VERSION,
    kind: CHILD_ACTIVATION_KIND,
    parentSessionId: manifest.sessionId,
    parentWorkflowId: manifest.workflowId,
    parentPromptHash: manifest.promptHash,
    manifestHash: manifest.manifestHash,
    role: manifest.role,
    model: manifest.model,
    effort: manifest.effort,
    context: manifest.context,
    repository: manifest.repository,
    scope: manifest.scope,
    scopeHash: manifest.scopeHash,
    allowedToolCategories: manifest.allowedToolCategories,
    allowedToolNames: manifest.allowedToolNames,
    allowedToolNamePrefixes: manifest.allowedToolNamePrefixes,
    allowedQueries: manifest.allowedQueries,
    validations: manifest.validations,
    childPromptBindingHash: sha256(normalizeActivationPrompt(childPrompt)),
    issuedAt,
    expiresAt,
  };
  const receipt = {
    ...unsigned,
    receiptHash: sha256(unsigned),
    promptBlock: jsonFence('budget-child-activation', {
      ...unsigned,
      receiptHash: sha256(unsigned),
    }),
  };
  persistChildActivationRecord(options.home, manifest.sessionId, receipt);
  return receipt;
}

function validateOperatorOverrideRecord(record) {
  assert(record && typeof record === 'object' && !Array.isArray(record),
    'Operator override record is invalid');
  assert(typeof record.receiptHash === 'string' && /^[a-f0-9]{64}$/.test(record.receiptHash),
    'Operator override receiptHash invalid');
  assert(typeof record.workflowId === 'string' && record.workflowId.length > 0,
    'Operator override workflowId required');
  assert(typeof record.promptHash === 'string' && /^[a-f0-9]{64}$/.test(record.promptHash),
    'Operator override promptHash invalid');
  assert(Array.isArray(record.allowedToolNames) &&
    record.allowedToolNames.every(value => typeof value === 'string' && value.length > 0),
  'Operator override allowedToolNames invalid');
  assert(Array.isArray(record.allowedToolCategories) &&
    record.allowedToolCategories.every(category => OVERRIDE_TOOL_CATEGORIES.has(category)),
  'Operator override categories invalid');
  assert(Array.isArray(record.pathPrefixHashes) &&
    record.pathPrefixHashes.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) &&
    Number.isInteger(record.pathPrefixCount) &&
    record.pathPrefixCount >= 0,
  'Operator override path prefix metadata invalid');
  assert(Array.isArray(record.commandPrefixHashes) &&
    record.commandPrefixHashes.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) &&
    Number.isInteger(record.commandPrefixCount) &&
    record.commandPrefixCount >= 0,
  'Operator override command prefix metadata invalid');
  assert(Array.isArray(record.scheduleActions) &&
    record.scheduleActions.every(value => typeof value === 'string' && value.length > 0),
  'Operator override scheduleActions invalid');
  assert(Array.isArray(record.queryPrefixHashes) &&
    record.queryPrefixHashes.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) &&
    Number.isInteger(record.queryPrefixCount) &&
    record.queryPrefixCount >= 0,
  'Operator override query prefix metadata invalid');
  assert(Number.isInteger(record.maxUses) && record.maxUses >= 1 && record.maxUses <= 32,
    'Operator override maxUses must be 1-32');
  assert(Number.isInteger(record.usesConsumed) && record.usesConsumed >= 0 &&
    record.usesConsumed <= record.maxUses,
  'Operator override usesConsumed invalid');
  assert(typeof record.allowRelease === 'boolean' &&
    typeof record.allowLive === 'boolean' &&
    typeof record.allowDestructive === 'boolean',
  'Operator override danger flags invalid');
  assert(typeof record.issuedAt === 'string' &&
    typeof record.expiresAt === 'string' &&
    Number.isFinite(Date.parse(record.issuedAt)) &&
    Number.isFinite(Date.parse(record.expiresAt)) &&
    Date.parse(record.expiresAt) > Date.parse(record.issuedAt),
  'Operator override validity window invalid');
  return record;
}

function operatorOverrideLedgerRecord(receipt, usesConsumed = 0) {
  return {
    receiptHash: receipt.receiptHash,
    workflowId: receipt.workflowId,
    promptHash: receipt.promptHash,
    allowedToolNames: [...receipt.allowedToolNames],
    allowedToolCategories: [...receipt.allowedToolCategories],
    pathPrefixHashes: listHashes(receipt.pathPrefixes),
    pathPrefixCount: receipt.pathPrefixes.length,
    commandPrefixHashes: listHashes(receipt.commandPrefixes),
    commandPrefixCount: receipt.commandPrefixes.length,
    scheduleActions: [...receipt.scheduleActions],
    queryPrefixHashes: listHashes(receipt.queryPrefixes),
    queryPrefixCount: receipt.queryPrefixes.length,
    maxUses: receipt.maxUses,
    usesConsumed,
    allowRelease: receipt.allowRelease,
    allowLive: receipt.allowLive,
    allowDestructive: receipt.allowDestructive,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
  };
}

function operatorOverrideRecordMatchesReceipt(record, receipt) {
  return record.receiptHash === receipt.receiptHash &&
    record.workflowId === receipt.workflowId &&
    record.promptHash === receipt.promptHash &&
    arraysEqual(record.allowedToolNames, receipt.allowedToolNames) &&
    arraysEqual(record.allowedToolCategories, receipt.allowedToolCategories) &&
    record.pathPrefixCount === receipt.pathPrefixes.length &&
    arraysEqual(record.pathPrefixHashes, listHashes(receipt.pathPrefixes)) &&
    record.commandPrefixCount === receipt.commandPrefixes.length &&
    arraysEqual(record.commandPrefixHashes, listHashes(receipt.commandPrefixes)) &&
    arraysEqual(record.scheduleActions, receipt.scheduleActions) &&
    record.queryPrefixCount === receipt.queryPrefixes.length &&
    arraysEqual(record.queryPrefixHashes, listHashes(receipt.queryPrefixes)) &&
    record.maxUses === receipt.maxUses &&
    record.allowRelease === receipt.allowRelease &&
    record.allowLive === receipt.allowLive &&
    record.allowDestructive === receipt.allowDestructive &&
    record.issuedAt === receipt.issuedAt &&
    record.expiresAt === receipt.expiresAt;
}

function readOperatorOverrideRecords(home, sessionId) {
  const stored = readPrivateJson(operatorOverrideFile(home, sessionId), 'Operator override store');
  if (!stored) return [];
  assert(stored.version === STATE_VERSION &&
    stored.kind === 'operator-override-store' &&
    stored.sessionIdHash === sha256(sessionId) &&
    Array.isArray(stored.records),
  'Operator override store is invalid');
  return stored.records.map(validateOperatorOverrideRecord);
}

function writeOperatorOverrideRecords(home, sessionId, records) {
  writePrivateJson(operatorOverrideFile(home, sessionId), {
    version: STATE_VERSION,
    kind: 'operator-override-store',
    sessionIdHash: sha256(sessionId),
    records,
  });
}

function normalizeExactToolNames(values, label) {
  const list = normalizeExactStringList(values, label, { allowEmpty: true })
    .map(normalizeToolName);
  assert(list.every(value => value.length > 0), `${label} must contain exact tool names`);
  return [...new Set(list)];
}

function normalizeOptionalPrefixes(values, label) {
  if (values === undefined) return [];
  assert(Array.isArray(values) &&
    values.every(value => typeof value === 'string' && value.trim().length > 0),
  `${label} must be a non-empty string array`);
  return [...new Set(values.map(value => value.trim()))];
}

function commandRisk(command) {
  const text = String(command ?? '').trim().toLowerCase();
  return {
    release: /\b(?:git push|npm publish|gh release|docker push|release-machine|publish)\b/.test(text),
    live: /\b(?:kubectl|ssh|scp|rsync|deploy|systemctl|service |restart |ha_|hass|radarr|sonarr|lidarr|plex)\b/.test(text),
    destructive: /\b(?:rm\b|del\b|mkfs|shutdown|reboot|git reset --hard|drop\s+database)\b/.test(text),
  };
}

export function validateOperatorOverrideReceipt(receipt) {
  assert(receipt && typeof receipt === 'object' && !Array.isArray(receipt),
    'Operator override receipt required');
  assert(receipt.version === STATE_VERSION &&
    receipt.kind === OPERATOR_OVERRIDE_KIND,
  'Operator override receipt kind/version mismatch');
  const sessionId = requireValidSessionId(receipt.sessionId, 'Operator override sessionId');
  assert(typeof receipt.workflowId === 'string' && receipt.workflowId.length > 0,
    'Operator override workflowId required');
  assert(typeof receipt.promptHash === 'string' && /^[a-f0-9]{64}$/.test(receipt.promptHash),
    'Operator override promptHash invalid');
  assert(Array.isArray(receipt.allowedToolNames) &&
    receipt.allowedToolNames.every(value => typeof value === 'string' && value.length > 0),
  'Operator override allowedToolNames invalid');
  assert(Array.isArray(receipt.allowedToolCategories) &&
    receipt.allowedToolCategories.every(category => OVERRIDE_TOOL_CATEGORIES.has(category)),
  'Operator override categories invalid');
  assert(receipt.allowedToolNames.length > 0 || receipt.allowedToolCategories.length > 0,
    'Operator override must authorize at least one exact tool or tool category');
  assert(Array.isArray(receipt.pathPrefixes) &&
    Array.isArray(receipt.commandPrefixes) &&
    Array.isArray(receipt.scheduleActions) &&
    Array.isArray(receipt.queryPrefixes),
  'Operator override constraints are invalid');
  assert(Number.isInteger(receipt.maxUses) && receipt.maxUses >= 1 && receipt.maxUses <= 32,
    'Operator override maxUses must be 1-32');
  assert(typeof receipt.issuedAt === 'string' &&
    typeof receipt.expiresAt === 'string' &&
    Number.isFinite(Date.parse(receipt.issuedAt)) &&
    Number.isFinite(Date.parse(receipt.expiresAt)) &&
    Date.parse(receipt.expiresAt) > Date.parse(receipt.issuedAt),
  'Operator override validity window invalid');
  assert(receipt.receiptHash === receiptHash(receipt),
    'Operator override receipt hash mismatch');
  return {
    ...receipt,
    sessionId,
  };
}

export function authorizeOperatorOverride(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Operator override input required');
  const sessionId = requireValidSessionId(
    firstDefined(input, ['sessionId', 'session_id']),
    'Operator override sessionId',
  );
  const state = currentPromptState(options.home, sessionId);
  assert(state, 'Operator override requires an active prompt binding');
  const promptHash = String(input.promptHash ?? state.promptHash);
  assert(promptHash === state.promptHash,
    'Operator override promptHash does not match the active prompt');
  const allowedToolNames = normalizeExactToolNames(
    input.allowedToolNames ?? input.toolNames,
    'allowedToolNames',
  );
  const allowedToolCategories = normalizeExactStringList(
    input.allowedToolCategories ?? input.toolCategories,
    'allowedToolCategories',
    { allowEmpty: true },
  );
  allowedToolCategories.forEach(category => {
    assert(OVERRIDE_TOOL_CATEGORIES.has(category),
      `Unsupported operator override category: ${category}`);
  });
  const pathPrefixes = normalizeOptionalPrefixes(input.pathPrefixes, 'pathPrefixes');
  const commandPrefixes = normalizeOptionalPrefixes(input.commandPrefixes, 'commandPrefixes');
  const scheduleActions = normalizeOptionalPrefixes(input.scheduleActions, 'scheduleActions');
  const queryPrefixes = normalizeOptionalPrefixes(input.queryPrefixes, 'queryPrefixes');
  const maxUses = Number(input.maxUses ?? 1);
  assert(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 32,
    'Operator override maxUses must be 1-32');
  if (allowedToolNames.includes('bash') || allowedToolNames.includes('powershell') ||
    allowedToolCategories.includes('shell') || allowedToolCategories.includes('tests')) {
    assert(commandPrefixes.length > 0,
      'Operator shell/test overrides require exact commandPrefixes');
  }
  const dangerous = {
    release: input.allowRelease === true,
    live: input.allowLive === true,
    destructive: input.allowDestructive === true,
  };
  for (const prefix of commandPrefixes) {
    const risk = commandRisk(prefix);
    assert(!risk.release || dangerous.release,
      'Release-like operator overrides require allowRelease=true');
    assert(!risk.live || dangerous.live,
      'Live-system operator overrides require allowLive=true');
    assert(!risk.destructive || dangerous.destructive,
      'Destructive operator overrides require allowDestructive=true');
  }
  const issuedAt = String(input.issuedAt ?? new Date(options.now ?? Date.now()).toISOString());
  const expiresAt = String(input.expiresAt ?? new Date(Date.parse(issuedAt) + 30 * 60_000).toISOString());
  assert(Number.isFinite(Date.parse(issuedAt)) &&
    Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) > Date.parse(issuedAt),
  'Operator override validity window invalid');
  const unsigned = {
    version: STATE_VERSION,
    kind: OPERATOR_OVERRIDE_KIND,
    sessionId,
    workflowId: state.workflowId,
    promptHash,
    allowedToolNames,
    allowedToolCategories,
    pathPrefixes,
    commandPrefixes,
    scheduleActions,
    queryPrefixes,
    maxUses,
    allowRelease: dangerous.release,
    allowLive: dangerous.live,
    allowDestructive: dangerous.destructive,
    issuedAt,
    expiresAt,
  };
  const receipt = {
    ...unsigned,
    receiptHash: sha256(unsigned),
  };
  const records = readOperatorOverrideRecords(options.home, sessionId)
    .filter(record => record.receiptHash !== receipt.receiptHash);
  records.push(operatorOverrideLedgerRecord(receipt));
  writeOperatorOverrideRecords(options.home, sessionId, records);
  return receipt;
}

export function routingStatus(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Routing status input required');
  const sessionId = requireValidSessionId(
    firstDefined(input, ['sessionId', 'session_id']),
    'Routing status sessionId',
  );
  const state = currentPromptState(options.home, sessionId);
  const ledger = readRoutingLedger(options.home, sessionId);
  const mode = effectiveRoutingMode({ home: options.home, env: options.env });
  const automaticRoute = state ? readAutomaticRouteRecord(options.home, sessionId) : null;
  const overrides = readOperatorOverrideRecords(options.home, sessionId)
    .filter(record => record.workflowId === state?.workflowId &&
      record.promptHash === state?.promptHash &&
      record.usesConsumed < record.maxUses &&
      Date.parse(record.expiresAt) > (options.now ?? Date.now()));
  const childActivations = readChildActivationRecords(options.home, sessionId)
    .filter(record => record.consumedBy === null &&
      Date.parse(record.expiresAt) > (options.now ?? Date.now()));
  return {
    version: STATE_VERSION,
    mode: mode.mode,
    modeSource: mode.source,
    sessionId,
    active: state
      ? {
        sessionId: state.sessionId,
        workflowId: state.workflowId,
        promptIndex: state.promptIndex,
        promptHash: state.promptHash,
        promptBytes: state.promptBytes,
        model: state.model,
        effort: state.effort,
        context: state.context,
        profileSource: state.profileSource,
        classification: state.classification,
        role: state.role,
        repositoryMode: state.repositoryMode ?? 'none',
        scope: state.scope,
        automaticRoute: automaticRoute
          ? {
            role: automaticRoute.role,
            dispatchKind: automaticRoute.dispatchKind,
            routeClass: automaticRoute.routeClass,
            routeHash: automaticRoute.routeHash,
          }
          : null,
        intent: state.intent,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        dispatchManifestHash: state.dispatchManifestHash,
        parentSessionId: state.parentSessionId,
        parentWorkflowId: state.parentWorkflowId,
        parentPromptHash: state.parentPromptHash,
        childActivationReceiptHash: state.childActivationReceiptHash,
      }
      : null,
    ledger: {
      compactedEntries: ledger.compactedEntries,
      entryCount: ledger.entries.length,
      nextPromptIndex: ledger.nextPromptIndex,
    },
    activeOverrideCount: overrides.length,
    pendingChildActivationCount: childActivations.length,
  };
}

export function routingStatusCurrent(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Routing current status input required');
  const sessionId = requireValidSessionId(
    firstDefined(input, ['sessionId', 'session_id']),
    'Routing current status sessionId',
  );
  const state = currentPromptState(options.home, sessionId);
  assert(state, 'Routing current status requires an active prompt binding');
  return routingStatus({ sessionId }, options);
}

function activeAutomaticRoute(home, sessionId, state) {
  const route = readAutomaticRouteRecord(home, sessionId);
  if (!route) return null;
  assert(route.workflowId === state.workflowId &&
    route.promptHash === state.promptHash &&
    route.sessionId === state.sessionId,
  'Automatic route is not bound to the active prompt');
  return route;
}

export function dispatchCurrent(role, options = {}) {
  const sessionId = requireValidSessionId(options.sessionId, 'dispatch-current sessionId');
  const state = currentPromptState(options.home, sessionId);
  assert(state && state.endedAt === null, 'dispatch-current requires an active prompt binding');
  const route = activeAutomaticRoute(options.home, sessionId, state);
  assert(route, 'dispatch-current requires an active automatic route');
  assert(role === route.role, 'dispatch-current role does not match the active automatic route');
  return {
    deprecated: true,
    message: 'dispatch-current is retired on the model-facing CLI surface; use the exact automatic task pins directly or manifest-from-active-prompt for explicit bounded work.',
    active: routingStatus({ sessionId }, options).active,
    automaticRoute: {
      role: route.role,
      dispatchKind: route.dispatchKind,
      routeClass: route.routeClass,
      routeHash: route.routeHash,
      acceptedAt: route.acceptedAt,
      acceptanceExpiresAt: route.acceptanceExpiresAt,
    },
    dispatchRequest: route.dispatchKind === 'deterministic'
      ? {
        kind: 'deterministic-tool',
        role: route.role,
        toolName: route.toolName,
        routeHash: route.routeHash,
      }
      : {
        kind: DISPATCH_REQUEST_KIND,
        role: route.role,
        routeHash: route.routeHash,
        scopeHash: route.scopeHash,
        model: route.model,
        effort: route.effort,
        context: route.context,
        agentType: route.agentType,
        allowedToolCategories: [...route.allowedToolCategories],
        allowedToolNames: [...(route.allowedToolNames ?? [])],
        allowedToolNamePrefixes: [...(route.allowedToolNamePrefixes ?? [])],
        allowedQueryCount: route.allowedQueryCount,
        validationCount: route.validationCount,
      },
  };
}

function automaticTaskClassAllowed(call, route) {
  const expected = new Set([
    normalizedTaskClass(automaticTaskIdentityForRole(route.role).name),
    normalizedTaskClass(route.role),
    normalizedTaskClass(route.routeClass),
  ]);
  const actual = [
    call.args.taskClass,
    call.args.task_class,
    call.args.name,
  ]
    .map(normalizedTaskClass)
    .filter(Boolean);
  return actual.some(value => expected.has(value));
}

function automaticTaskIdentityAllowed(call, route) {
  const name = String(call.args.name ?? '').trim();
  const description = String(call.args.description ?? '').trim();
  return (
    name.length > 0 &&
    description.length > 0 &&
    sha256(name) === route.taskNameHash &&
    sha256(description) === route.taskDescriptionHash
  ) || automaticTaskClassAllowed(call, route);
}

function validateAutomaticTaskCall(call, envelope, promptState, home) {
  if (!promptState || promptState.endedAt !== null) return null;
  let route = null;
  try {
    route = activeAutomaticRoute(home, envelope.sessionId, promptState);
  } catch (error) {
    return deny(`Budget routing guard: ${error.message}`);
  }
  if (!route || route.dispatchKind !== 'task') return null;
  const prompt = String(call.args.prompt ?? '').trim();
  if (!prompt) {
    return deny('Budget routing guard: automatic route task dispatch requires a non-empty prompt.');
  }
  if (String(call.args.model ?? '') !== route.model ||
    String(call.args.reasoning_effort ?? call.args.reasoningEffort ?? '') !== route.effort ||
    String(call.args.context_tier ?? call.args.contextTier ?? '') !== route.context ||
    String(call.args.agent_type ?? call.args.agentType ?? '') !== route.agentType) {
    return deny('Budget routing guard: automatic route task pins do not match the active stored route.');
  }
  if (!automaticTaskIdentityAllowed(call, route)) {
    return deny('Budget routing guard: automatic route task name/description or normalized task class do not match the stored route.');
  }
  if (route.acceptedAt !== null) {
    return deny('Budget routing guard: automatic route task authorization was already consumed for the active prompt.');
  }
  persistAutomaticTaskAcceptance(home, promptState, route, prompt);
  return {};
}

function assertSafeControlFilename(name) {
  assert(typeof name === 'string' && SAFE_CONTROL_FILENAME_PATTERN.test(name),
    'Control artifact filename must match the registered safe filename pattern');
  return name;
}

function assertSafeControlText(text, label, maximumBytes = CONTROL_ARTIFACT_TEXT_BYTES) {
  assert(typeof text === 'string' && text.trim().length > 0, `${label} text required`);
  assert(Buffer.byteLength(text, 'utf8') <= maximumBytes,
    `${label} text exceeds ${maximumBytes} bytes`);
  assert(!SENSITIVE_MEMORY_PATTERN.test(text), `${label} text contains sensitive content`);
  assert(!/[A-Za-z]:\\|\/home\/|\/tmp\/|\/proc\/|\/sys\/|node\s|\bnpm\s|\bgit\s/.test(text),
    `${label} text must not persist raw paths or commands`);
  return text.trim();
}

function assertNoForbiddenArtifactFields(value, label) {
  const forbiddenKeys = new Set([
    'prompt',
    'promptBlock',
    'toolArgs',
    'toolCalls',
    'command',
    'path',
    'file_path',
    'cwd',
    'root',
    'repositoryRoot',
    'content',
  ]);
  const queue = [[value, label]];
  while (queue.length > 0) {
    const [current, currentLabel] = queue.pop();
    if (typeof current === 'string') {
      assert(!SENSITIVE_MEMORY_PATTERN.test(current), `${currentLabel} contains sensitive text`);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      current.forEach((nested, index) => queue.push([nested, `${currentLabel}[${index}]`]));
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      assert(!forbiddenKeys.has(key), `${currentLabel} contains forbidden field ${key}`);
      queue.push([nested, `${currentLabel}.${key}`]);
    }
  }
}

function sanitizedDispatchArtifact(input) {
  const manifest = input.dispatchManifest?.manifestHash
    ? input.dispatchManifest
    : input.dispatch?.dispatchManifest?.manifestHash
      ? input.dispatch.dispatchManifest
      : null;
  if (manifest) {
    return {
      version: STATE_VERSION,
      kind: DISPATCH_REQUEST_KIND,
      role: manifest.role,
      dispatchKind: manifest.dispatchKind,
      workflowId: manifest.workflowId,
      promptHash: manifest.promptHash,
      scopeHash: manifest.scopeHash,
      model: manifest.model,
      effort: manifest.effort,
      context: manifest.context,
      allowedToolCategories: manifest.allowedToolCategories,
      allowedToolNames: manifest.allowedToolNames ?? [],
      allowedToolNamePrefixes: manifest.allowedToolNamePrefixes ?? [],
      manifestHash: manifest.manifestHash,
      receiptHash: manifest.receiptHash ?? null,
      expiresAt: input.childActivation?.expiresAt ?? input.dispatch?.childActivation?.expiresAt ?? null,
    };
  }
  assertNoForbiddenArtifactFields(input.value ?? input, 'dispatch-request');
  return {
    version: STATE_VERSION,
    kind: DISPATCH_REQUEST_KIND,
    ...(input.value ?? input),
  };
}

function sanitizedReceiptArtifact(input) {
  const candidate = { ...(input.receipt ?? input.value ?? input) };
  delete candidate.promptBlock;
  assert(candidate && typeof candidate === 'object' && !Array.isArray(candidate),
    'Receipt artifact value must be an object');
  assert(/receipt/.test(String(candidate.kind ?? '')),
    'Receipt artifact kind must describe a receipt');
  assertNoForbiddenArtifactFields(candidate, 'receipt');
  return candidate;
}

function sanitizedResultArtifact(input) {
  const candidate = input.value ?? input.result ?? input;
  assert(candidate && typeof candidate === 'object' && !Array.isArray(candidate),
    'Result artifact value must be an object');
  assertNoForbiddenArtifactFields(candidate, 'result-envelope');
  return {
    version: STATE_VERSION,
    kind: 'result-envelope',
    ...candidate,
  };
}

function sanitizedHistoryPacketArtifact(input) {
  const packet = validateFrozenEvidencePacket(input.packet ?? input.value ?? input);
  assert(packet.mode === 'history', 'Safe packet artifacts currently allow history packets only');
  return packet;
}

function controlArtifactText(input) {
  const artifactType = input.artifactType ?? input.kind;
  assert(SAFE_CONTROL_ARTIFACT_TYPES.has(artifactType),
    'Unsupported control artifact type');
  if (artifactType === 'progress-log') {
    const text = Array.isArray(input.entries)
      ? input.entries.map(entry => assertSafeControlText(String(entry), 'progress-log entry')).join('\n')
      : assertSafeControlText(String(input.text ?? input.value ?? ''), 'progress-log');
    return {
      artifactType,
      text: `${text}\n`,
    };
  }
  const value = artifactType === DISPATCH_REQUEST_KIND
    ? sanitizedDispatchArtifact(input)
    : artifactType === 'receipt'
      ? sanitizedReceiptArtifact(input)
      : artifactType === 'result-envelope'
        ? sanitizedResultArtifact(input)
        : sanitizedHistoryPacketArtifact(input);
  const text = `${JSON.stringify({ version: STATE_VERSION, kind: SAFE_CONTROL_ARTIFACT_KIND, artifactType, value }, null, 2)}\n`;
  assert(Buffer.byteLength(text, 'utf8') <= MAX_CONTROL_ARTIFACT_BYTES,
    `Control artifact exceeds ${MAX_CONTROL_ARTIFACT_BYTES} bytes`);
  return { artifactType, text };
}

export function writeControlArtifactCurrent(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Control artifact input required');
  const sessionId = requireValidSessionId(
    firstDefined(input, ['sessionId', 'session_id', 'activeSessionId']),
    'Control artifact sessionId',
  );
  const state = currentPromptState(options.home, sessionId);
  assert(state && state.endedAt === null, 'Control artifact writes require an active prompt binding');
  const promptHash = input.promptHash ?? state.promptHash;
  assert(promptHash === state.promptHash,
    'Control artifact promptHash does not match the active prompt');
  const filename = assertSafeControlFilename(String(input.filename ?? ''));
  const directory = sessionFilesDirectory(options.home, sessionId);
  ensurePrivateDirectory(directory);
  const realDir = fs.realpathSync(directory);
  const target = path.join(realDir, filename);
  const relative = path.relative(realDir, target);
  assert(relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative),
  'Control artifact path escapes the current session files directory');
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  assert(!existing || !existing.isSymbolicLink(),
    'Control artifact destination cannot be a symlink');
  const rendered = controlArtifactText(input);
  writePrivateFileAtomic(target, rendered.text);
  return {
    version: STATE_VERSION,
    kind: CONTROL_ARTIFACT_RESULT_KIND,
    sessionId,
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    artifactType: rendered.artifactType,
    filename,
    file: target,
    bytes: Buffer.byteLength(rendered.text, 'utf8'),
    sha256: sha256(rendered.text),
  };
}

export function manifestFromActivePrompt(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Manifest-from-active-prompt input required');
  const sessionId = requireValidSessionId(
    firstDefined(input, ['sessionId', 'session_id']),
    'Manifest-from-active-prompt sessionId',
  );
  const state = currentPromptState(options.home, sessionId);
  assert(state, 'Manifest-from-active-prompt requires an active prompt binding');
  const manifest = createDispatchManifest({
    ...input,
    sessionId,
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    intent: input.intent ?? state.intent,
  });
  const taskPromptBody = typeof input.taskPromptBody === 'string'
    ? input.taskPromptBody.trim()
    : typeof input.taskPrompt === 'string'
      ? input.taskPrompt.trim()
      : '';
  if (manifest.dispatchKind !== 'task') {
    return {
      active: routingStatus({ sessionId }, options).active,
      dispatchManifest: manifest,
      taskPrompt: taskPromptBody
        ? `${taskPromptBody}\n\n${manifest.promptBlock}`
        : manifest.promptBlock,
    };
  }
  const basePrompt = taskPromptBody
    ? `${taskPromptBody}\n\n${manifest.promptBlock}`
    : manifest.promptBlock;
  const childActivation = createChildActivationReceipt({
    sessionId,
    promptHash: state.promptHash,
    dispatchManifest: manifest,
    childPrompt: basePrompt,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  }, options);
  return {
    active: routingStatus({ sessionId }, options).active,
    dispatchManifest: manifest,
    childActivation,
    taskPrompt: `${basePrompt}\n\n${childActivation.promptBlock}`,
  };
}

function readFrontierReceipts(home, sessionId, now = Date.now()) {
  const stored = readPrivateJson(frontierReceiptFile(home, sessionId), 'Frontier receipt store');
  if (!stored) return [];
  assert(stored.version === STATE_VERSION &&
    stored.sessionId === sessionId &&
    Array.isArray(stored.receipts),
  'Frontier receipt store is invalid');
  return stored.receipts
    .map(validateFrontierDispatchReceipt)
    .filter(receipt => Date.parse(receipt.expiresAt) > now);
}

function persistFrontierReceipt(home, sessionId, receipt, now = Date.now()) {
  const receipts = readFrontierReceipts(home, sessionId, now)
    .filter(existing => existing.receiptHash !== receipt.receiptHash);
  receipts.push(receipt);
  writePrivateJson(frontierReceiptFile(home, sessionId), {
    version: STATE_VERSION,
    sessionId,
    receipts,
  });
}

export function authorizeResearchReceipt(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Frontier dispatch receipt required');
  const sessionId = requireValidSessionId(
    firstDefined(input, ['sessionId', 'session_id']),
    'Frontier dispatch receipt sessionId',
  );
  const state = currentPromptState(options.home, sessionId);
  assert(state && state.promptHash === input.promptHash,
    'Frontier dispatch receipt promptHash does not match the active prompt');
  const role = String(input.role ?? 'frontier-research');
  assert(roleIsFrontier(role), 'Frontier dispatch receipt role is invalid');
  const exact = profileForRole(role);
  const profile = {
    model: input.profile?.model ?? input.model ?? exact.profile.model,
    effort: input.profile?.effort ?? input.effort ?? exact.profile.effort,
    context: input.profile?.context ?? input.context ?? exact.profile.context,
  };
  assert(profile.model === exact.profile.model &&
    profile.effort === exact.profile.effort &&
    profile.context === exact.profile.context,
  'Frontier dispatch receipt must bind the exact approved profile');
  const packet = validateFrozenEvidencePacket(input.evidencePacket);
  assert(packet.workflowId === state.workflowId, 'Frontier dispatch receipt workflow mismatch');
  assert(packet.promptHash === input.promptHash, 'Frontier dispatch receipt packet prompt mismatch');
  const scope = normalizeScope(input.scope ?? packet.scope);
  assert(sha256(scope) === packet.scopeHash, 'Frontier dispatch receipt scope mismatch');
  const issuedAt = String(input.issuedAt ?? new Date().toISOString());
  const expiresAt = String(input.expiresAt ?? packet.expiresAt);
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  const now = options.now ?? Date.now();
  assert(Number.isFinite(issued) && Number.isFinite(expires) && issued <= now && expires > now,
    'Frontier dispatch receipt is not currently valid');
  const receipt = createFrontierDispatchReceipt({
    workflowId: packet.workflowId,
    promptHash: packet.promptHash,
    questionHash: packet.questionBinding.questionHash,
    mode: packet.mode,
    scopeHash: packet.scopeHash,
    packetHash: packet.packetHash,
    role,
    profile,
    evidencePacketReceiptHash: input.evidencePacketReceiptHash,
    tandemPairReceiptHash: input.tandemPairReceiptHash ?? null,
    parentReceiptHash: input.parentReceiptHash ?? input.evidencePacketReceiptHash,
    deltaPacketHash: packet.deltaFromPacketHash,
    usageLineage: input.usageLineage ?? [{
      category: role === 'tandem-secondary-research'
        ? 'gpt6-sol-research'
        : role === 'frontier-adjudication'
          ? 'research-adjudication'
          : 'sol-research',
      usageHash: null,
      reservedCredits: input.reservedCredits ?? 0,
      actualCredits: null,
    }],
    createdAt: issuedAt,
    expiresAt,
  });
  persistFrontierReceipt(options.home, sessionId, receipt, now);
  return receipt;
}

function defaultReasonOnlyPrompt(question, packet) {
  return [
    'Reason only from the supplied frozen evidence packet.',
    'Do not use or request tools.',
    'Return strict JSON only using findings, blocked, or evidence-gap-request.',
    `Question: ${question}`,
    `Packet hash: ${packet.packetHash}`,
    `Packet: ${JSON.stringify(packet)}`,
  ].join('\n');
}

export function createBoundReasonOnlyLeafRequest(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Reason-only request input required');
  const dispatchManifest = input.dispatchManifest?.manifestHash
    ? input.dispatchManifest
    : createDispatchManifest(input.dispatchManifest);
  assert(dispatchManifest.dispatchKind === 'reason-only-leaf',
    'Reason-only request requires a frontier dispatch manifest');
  const role = dispatchManifest.role;
  const packet = reasonOnlyPacketForRole(
    role,
    input.intentAcceptancePacket ?? input.evidencePacket,
  );
  assert(reasonOnlyPacketHash(packet) === dispatchManifest.evidencePacketHash,
    'Reason-only request packet hash mismatch');
  assert(packet.workflowId === dispatchManifest.workflowId &&
    packet.promptHash === dispatchManifest.promptHash &&
    (role === INTENT_ACCEPTANCE_ROLE
      ? sha256(packet.requirementsManifest.scope) === dispatchManifest.scopeHash
      : packet.scopeHash === dispatchManifest.scopeHash),
  'Reason-only request packet binding mismatch');
  let frontierReceipt = null;
  let intentAcceptanceDispatchReceipt = null;
  if (role === INTENT_ACCEPTANCE_ROLE) {
    intentAcceptanceDispatchReceipt = validateIntentAcceptanceDispatchReceipt(
      input.intentAcceptanceDispatchReceipt,
      packet,
    );
    assert(intentAcceptanceDispatchReceipt.kind === INTENT_ACCEPTANCE_DISPATCH_RECEIPT_KIND &&
      intentAcceptanceDispatchReceipt.packetHash === packet.packetHash &&
      intentAcceptanceDispatchReceipt.role === dispatchManifest.role &&
      intentAcceptanceDispatchReceipt.receiptHash === dispatchManifest.receiptHash,
    'Reason-only intent acceptance dispatch receipt mismatch');
    assert(intentAcceptanceDispatchReceipt.profile.model === dispatchManifest.model &&
      intentAcceptanceDispatchReceipt.profile.effort === dispatchManifest.effort &&
      intentAcceptanceDispatchReceipt.profile.context === dispatchManifest.context,
    'Reason-only intent acceptance dispatch profile mismatch');
  } else {
    frontierReceipt = validateFrontierDispatchReceipt(input.frontierReceipt);
    assert(frontierReceipt.kind === FRONTIER_DISPATCH_RECEIPT_KIND &&
      frontierReceipt.packetHash === packet.packetHash &&
      frontierReceipt.role === dispatchManifest.role &&
      frontierReceipt.receiptHash === dispatchManifest.receiptHash,
    'Reason-only frontier dispatch receipt mismatch');
    assert(frontierReceipt.profile.model === dispatchManifest.model &&
      frontierReceipt.profile.effort === dispatchManifest.effort &&
      frontierReceipt.profile.context === dispatchManifest.context,
    'Reason-only frontier dispatch profile mismatch');
  }
  let tandemPairReceipt = null;
  if (dispatchManifest.role === 'tandem-secondary-research' || input.tandemPairReceipt) {
    tandemPairReceipt = validateTandemPairReceipt(input.tandemPairReceipt);
    assert(tandemPairReceipt.packetHash === packet.packetHash,
      'Reason-only tandem pair packet mismatch');
    if (dispatchManifest.role === 'tandem-secondary-research') {
      assert(tandemPairReceipt.secondaryDispatchReceiptHash === frontierReceipt.receiptHash,
        'Reason-only tandem secondary dispatch is not bound to the tandem pair receipt');
      assert(dispatchManifest.tandemPairReceiptHash === tandemPairReceipt.receiptHash,
        'Reason-only tandem secondary dispatch manifest tandem hash mismatch');
    }
    if (dispatchManifest.role === 'frontier-research') {
      assert(tandemPairReceipt.primaryDispatchReceiptHash === frontierReceipt.receiptHash,
        'Reason-only Sol research dispatch is not bound to the tandem pair receipt');
    }
  }
  return {
    prompt: String(input.prompt ?? (
      role === INTENT_ACCEPTANCE_ROLE
        ? defaultIntentAcceptancePrompt(packet, intentAcceptanceDispatchReceipt)
        : defaultReasonOnlyPrompt(input.question ?? '', packet)
    )),
    model: dispatchManifest.model,
    effort: dispatchManifest.effort,
    context: dispatchManifest.context,
    toolMode: REASON_ONLY_TOOL_MODE,
    evidencePacket: packet,
    expectedResultKind: input.expectedResultKind ?? null,
    sanitized: input.sanitized === true,
    maxCredits: Number(input.maxCredits ?? 60),
    timeoutSeconds: Number(input.timeoutSeconds ?? 240),
    ledger: input.ledger ?? null,
    dispatchManifest,
    frontierReceipt,
    tandemPairReceipt,
    intentAcceptanceDispatchReceipt,
  };
}

function tokenizeCommand(command) {
  const matches = String(command ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map(token => token.replace(/^['"]|['"]$/g, ''));
}

function validateTaskCall(call, envelope, payload, promptState, home) {
  const args = call.args;
  const model = args.model;
  const effort = args.reasoning_effort ?? args.reasoningEffort;
  const context = args.context_tier ?? args.contextTier;
  const agentType = args.agent_type ?? args.agentType;
  if ([model, effort, context, agentType].some(value => typeof value !== 'string' || value.length === 0)) {
    return deny('Budget routing guard: every task dispatch must pin model, reasoning_effort, context_tier, and agent_type explicitly.');
  }
  if ([model, effort, context, agentType].includes('inherit')) {
    return deny('Budget routing guard: task dispatch cannot inherit model, effort, context, or agent type.');
  }
  const manifest = parseDispatchManifest(args.prompt ?? '');
  if (!manifest) {
    return validateAutomaticTaskCall(call, envelope, promptState, home) ??
      deny('Budget routing guard: task dispatch requires an inline ```budget-dispatch-manifest``` block created by routing-enforcement.mjs manifest.');
  }
  const created = createDispatchManifest({ ...manifest, plan: manifest.plan ?? null });
  if (created.manifestHash !== sha256({
    version: manifest.version,
    kind: manifest.kind,
    sessionId: manifest.sessionId,
    workflowId: manifest.workflowId,
    promptHash: manifest.promptHash,
    project: manifest.project,
    repository: manifest.repository,
    scope: manifest.scope,
    scopeHash: manifest.scopeHash,
    role: manifest.role,
    dispatchKind: manifest.dispatchKind,
    agentType: manifest.agentType,
    model: manifest.model,
    effort: manifest.effort,
    context: manifest.context,
    toolMode: manifest.toolMode,
    effectiveContract: manifest.effectiveContract,
    packetWorkflowVersion: manifest.packetWorkflowVersion,
    intent: manifest.intent,
    allowedToolCategories: manifest.allowedToolCategories,
    allowedToolNames: manifest.allowedToolNames,
    allowedToolNamePrefixes: manifest.allowedToolNamePrefixes,
    allowedQueries: manifest.allowedQueries,
    validations: manifest.validations,
    plan: manifest.plan,
    receiptHash: manifest.receiptHash,
    evidencePacketHash: manifest.evidencePacketHash,
    tandemPairReceiptHash: manifest.tandemPairReceiptHash,
    researchAuthorized: manifest.researchAuthorized,
    intentAcceptanceAuthorized: manifest.intentAcceptanceAuthorized,
  })) {
    return deny('Budget routing guard: dispatch manifest integrity check failed.');
  }
  if (!promptState) {
    return deny('Budget routing guard: prompt routing state is missing; restart the turn or rerun the prompt under the active hook set.');
  }
  if (manifest.dispatchKind !== 'task') {
    return deny('Budget routing guard: packet-only reason-only roles cannot be launched through task agents because the CLI cannot prove a no-tool task surface; use the reason-only run-leaf path instead.');
  }
  if (manifest.sessionId !== envelope.sessionId ||
    manifest.promptHash !== promptState.promptHash ||
    manifest.workflowId !== promptState.workflowId) {
    return deny('Budget routing guard: dispatch manifest is not bound to the active session, workflow, and prompt.');
  }
  if (model !== manifest.model ||
    effort !== manifest.effort ||
    context !== manifest.context ||
    agentType !== manifest.agentType) {
    return deny('Budget routing guard: task arguments do not match the bound dispatch manifest.');
  }
  if (promptState.classification !== 'approved-root') {
    const activation = parseChildActivation(args.prompt ?? '');
    if (!activation) {
      return deny('Budget routing guard: protected or manifest-bound task dispatch requires an inline ```budget-child-activation``` block created by routing-enforcement.mjs manifest-from-active-prompt.');
    }
    try {
      const receipt = validateChildActivationReceipt(activation);
      assert(receipt.parentSessionId === promptState.sessionId &&
        receipt.parentWorkflowId === promptState.workflowId &&
        receipt.parentPromptHash === promptState.promptHash,
      'Task child activation is not bound to the active parent prompt');
      assert(receipt.manifestHash === manifest.manifestHash,
        'Task child activation manifest binding mismatch');
      assert(receipt.childPromptBindingHash === sha256(normalizeActivationPrompt(args.prompt ?? '')),
        'Task child activation prompt binding mismatch');
      const pending = readChildActivationRecords(home, receipt.parentSessionId)
        .find(record => record.receiptHash === receipt.receiptHash &&
          childActivationRecordMatchesReceipt(record, receipt) &&
          record.consumedBy === null &&
          Date.parse(record.expiresAt) > Date.now());
      if (!pending) {
        return deny('Budget routing guard: task child activation is missing, stale, or already consumed.');
      }
    } catch (error) {
      return deny(`Budget routing guard: ${error.message}`);
    }
  }
  return {};
}

function resolveCommandFile(cwd, candidate) {
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(cwd ?? process.cwd(), candidate);
}

function parseNodeCommand(command, cwd) {
  const text = String(command ?? '').trim();
  if (!text || /[\n\r;|`]|&&/.test(text)) return null;
  const tokens = tokenizeCommand(text);
  if (tokens[0] !== 'node' || tokens.length < 2) return null;
  const scriptFile = resolveCommandFile(cwd, tokens[1]);
  const stat = fs.statSync(scriptFile, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  return {
    text,
    tokens,
    scriptFile,
    realScript: fs.realpathSync(scriptFile),
    operation: tokens[2] ?? '',
    argument: tokens[3] ?? null,
    inputFile: tokens[3] ? resolveCommandFile(cwd, tokens[3]) : null,
  };
}

function readCommandJsonInput(info, label) {
  assert(info.inputFile, `${label} requires an explicit JSON file path`);
  const stat = fs.statSync(info.inputFile, { throwIfNoEntry: false });
  assert(stat?.isFile() && stat.size <= MAX_COMMAND_INPUT_BYTES,
    `${label} requires an explicit JSON file <=${MAX_COMMAND_INPUT_BYTES} bytes`);
  const text = fs.readFileSync(info.inputFile, 'utf8');
  const parsed = JSON.parse(text);
  return objectInfo(parsed, `${label} input`, text);
}

function requireActiveRoutingCommandSession(label, envelope, inputInfo) {
  const requestedSessionId = strictTopLevelSessionId(
    inputInfo,
    `${label} input`,
    { required: false, allowOmitted: true },
  );
  if (!requestedSessionId) return envelope.sessionId;
  assert(requestedSessionId === envelope.sessionId,
    `${label} may only target the active caller session`);
  return requestedSessionId;
}

function validateRoutingCommandCall(call, envelope, payload, promptState) {
  const info = parseNodeCommand(call.args.command, payload.cwd);
  if (!info) return null;
  if (info.realScript === KNOWN_SCRIPT_REALPATHS.runLeaf) return null;
  if (info.realScript === KNOWN_SCRIPT_REALPATHS.research) {
    return ['plan', 'init', 'evidence', 'packet', 'validate-packet'].includes(info.operation)
      ? {}
      : deny('Budget routing guard: only deterministic research planning and packet commands are allowed through protected shell routing.');
  }
  if (info.realScript === KNOWN_SCRIPT_REALPATHS.intentAcceptance) {
    return ['eligibility', 'packet', 'validate-packet', 'validate-result', 'receipt', 'validate-receipt'].includes(info.operation)
      ? {}
      : deny('Budget routing guard: unsupported intent-acceptance command.');
  }
  if (info.realScript === KNOWN_SCRIPT_REALPATHS.opportunities) {
    return ['plan', 'validate'].includes(info.operation)
      ? {}
      : deny('Budget routing guard: unsupported opportunities command.');
  }
  if (info.realScript === KNOWN_SCRIPT_REALPATHS.budget) {
    return ['audit', 'estimate', 'evaluate', 'packet', 'route', 'validate'].includes(info.operation)
      ? {}
      : deny('Budget routing guard: unsupported budget command.');
  }
  if (info.realScript === KNOWN_SCRIPT_REALPATHS.continuousImprovement) {
    return ['status', 'validate'].includes(info.operation)
      ? {}
      : deny('Budget routing guard: unsupported continuous-improvement command.');
  }
  if (info.realScript === KNOWN_SCRIPT_REALPATHS.history) {
    return ['evidence', 'init', 'packet', 'plan', 'run', 'validate-packet'].includes(info.operation)
      ? {}
      : deny('Budget routing guard: unsupported history evidence command.');
  }
  if (info.realScript !== KNOWN_SCRIPT_REALPATHS.routingEnforcement) return null;
  if ([
    'status',
    'status-current',
    'manifest',
    'manifest-from-active-prompt',
    'write-control-artifact-current',
    'authorize-research',
    'authorize-intent-acceptance',
    'authorize-operator',
    'set-mode',
  ].includes(info.operation) && info.tokens.length !== 4) {
    return deny(`Budget routing guard: routing-enforcement.mjs ${info.operation} must use the exact form "node routing-enforcement.mjs ${info.operation} INPUT.json" with no extra arguments.`);
  }
  if (info.operation === 'dispatch-current' && info.tokens.length !== 4) {
    return deny('Budget routing guard: routing-enforcement.mjs dispatch-current must use the exact form "node routing-enforcement.mjs dispatch-current ROLE" with no extra arguments.');
  }
  if (info.operation === 'dispatch-current') {
    return deny('Budget routing guard: routing-enforcement.mjs dispatch-current is retired on the model-facing shell surface; use the exact automatic task pins directly or manifest-from-active-prompt for explicit bounded work.');
  }
  if (info.operation === 'set-mode') {
    return deny('Budget routing guard: routing mode changes require a manual config-file edit plus a fresh CLI restart; protected tool calls cannot run set-mode.');
  }
  if (info.operation === 'authorize-operator') {
    return deny('Budget routing guard: operator override receipts must be minted externally and cannot be created from an in-session tool call.');
  }
  if (info.operation === 'status') {
    return deny('Budget routing guard: protected tool calls cannot read arbitrary session status; use status-current for the active caller session only.');
  }
  if (info.operation === 'prompt-start' || info.operation === 'session-end') {
    return deny('Budget routing guard: lifecycle routing commands are reserved for hook execution.');
  }
  if (info.operation === 'status-current' ||
    info.operation === 'manifest-from-active-prompt' ||
    info.operation === 'write-control-artifact-current' ||
    info.operation === 'authorize-research' ||
    info.operation === 'authorize-intent-acceptance') {
    try {
      assert(promptState && promptState.endedAt === null,
        `routing-enforcement.mjs ${info.operation} requires an active prompt binding`);
      requireActiveRoutingCommandSession(`routing-enforcement.mjs ${info.operation}`, envelope,
        readCommandJsonInput(info, `routing-enforcement.mjs ${info.operation}`));
      return {};
    } catch (error) {
      return deny(`Budget routing guard: ${error.message}`);
    }
  }
  if (info.operation === 'manifest') {
    try {
      assert(promptState && promptState.endedAt === null,
        'routing-enforcement.mjs manifest requires an active prompt binding');
      requireActiveRoutingCommandSession('routing-enforcement.mjs manifest', envelope,
        readCommandJsonInput(info, 'routing-enforcement.mjs manifest'));
      return {};
    } catch (error) {
      return deny(`Budget routing guard: ${error.message}`);
    }
  }
  return deny('Budget routing guard: unsupported routing-enforcement command.');
}

function activeFrontierReceipt(home, sessionId, receiptHash, now = Date.now()) {
  return readFrontierReceipts(home, sessionId, now)
    .find(receipt => receipt.receiptHash === receiptHash) ?? null;
}

function readIntentAcceptanceDispatchRecords(home, sessionId) {
  const stored = readPrivateJson(
    intentAcceptanceReceiptFile(home, sessionId),
    'Intent acceptance receipt store',
  );
  if (!stored) return [];
  assert(stored.version === STATE_VERSION &&
    stored.sessionId === sessionId &&
    Array.isArray(stored.records),
  'Intent acceptance receipt store is invalid');
  return stored.records.map(record => ({
    receipt: validateIntentAcceptanceDispatchReceipt(record.receipt, null, { requireFresh: false, now: Number.MAX_SAFE_INTEGER }),
    usedAt: record.usedAt ?? null,
  }));
}

function persistIntentAcceptanceDispatchRecord(home, sessionId, receipt, usedAt = null) {
  const records = readIntentAcceptanceDispatchRecords(home, sessionId)
    .filter(record => record.receipt.receiptHash !== receipt.receiptHash);
  records.push({ receipt, usedAt });
  writePrivateJson(intentAcceptanceReceiptFile(home, sessionId), {
    version: STATE_VERSION,
    sessionId,
    records,
  });
}

function consumeIntentAcceptanceDispatchReceipt(home, sessionId, receiptHash, now = new Date().toISOString()) {
  const records = readIntentAcceptanceDispatchRecords(home, sessionId);
  const index = records.findIndex(record => record.receipt.receiptHash === receiptHash);
  if (index < 0) return null;
  const record = records[index];
  if (record.usedAt !== null) return false;
  record.usedAt = now;
  writePrivateJson(intentAcceptanceReceiptFile(home, sessionId), {
    version: STATE_VERSION,
    sessionId,
    records,
  });
  return record.receipt;
}

function activeIntentAcceptanceReceipt(home, sessionId, receiptHash, now = Date.now()) {
  return readIntentAcceptanceDispatchRecords(home, sessionId)
    .find(record => record.receipt.receiptHash === receiptHash &&
      record.usedAt === null &&
      Date.parse(record.receipt.expiresAt) > now)?.receipt ?? null;
}

function reasonOnlyPacketForRole(role, packet) {
  if (role === INTENT_ACCEPTANCE_ROLE) return validateIntentAcceptancePacket(packet);
  return validateFrozenEvidencePacket(packet);
}

function reasonOnlyPacketHash(packet) {
  return packet.packetHash;
}

export function authorizeIntentAcceptanceReceipt(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Intent acceptance dispatch input required');
  const sessionId = requireValidSessionId(
    firstDefined(input, ['sessionId', 'session_id']),
    'Intent acceptance dispatch sessionId',
  );
  const state = currentPromptState(options.home, sessionId);
  assert(state && state.promptHash === input.promptHash,
    'Intent acceptance dispatch promptHash does not match the active prompt');
  const profile = resolveSessionProfile(options.home, sessionId);
  assert(profile.model && profile.effort && profile.context,
    'Intent acceptance dispatch is blocked because the selected session model profile is unavailable');
  try {
    validateProfile(profile, 'selected session profile');
  } catch {
    assert(false,
      `Intent acceptance dispatch is blocked because the selected session model is unavailable: ${profile.model}`);
  }
  assert(profile.model === state.model &&
    profile.effort === state.effort &&
    profile.context === state.context,
  'Intent acceptance dispatch must use the exact active prompt/session routing profile');
  const packet = validateIntentAcceptancePacket(input.intentAcceptancePacket ?? input.evidencePacket);
  assert(packet.workflowId === state.workflowId && packet.promptHash === state.promptHash &&
    packet.sessionId === sessionId,
  'Intent acceptance packet binding mismatch');
  assert(packet.selectedProfile.model === profile.model &&
    packet.selectedProfile.effort === profile.effort &&
    packet.selectedProfile.context === profile.context,
  'Intent acceptance packet selected model does not match trusted session routing state');
  const records = readIntentAcceptanceDispatchRecords(options.home, sessionId)
    .filter(record => record.receipt.workflowId === state.workflowId &&
      record.receipt.promptHash === state.promptHash);
  const nextAttempt = Number(input.attempt ?? (records.length + 1));
  assert(nextAttempt >= 1 && nextAttempt <= INTENT_ACCEPTANCE_MAX_ATTEMPTS,
    'Intent acceptance attempts are limited to two total runs');
  assert(records.length < INTENT_ACCEPTANCE_MAX_ATTEMPTS,
    'Intent acceptance attempts are limited to two total runs');
  if (nextAttempt === 2) {
    const priorGap = validateIntentAcceptanceOutcomeReceipt(
      input.previousGapReceipt,
      input.previousPacket,
      { now: options.now ?? Date.now(), requireFresh: false },
    );
    assert(priorGap.kind === 'intent-acceptance-gap-receipt',
      'Second intent-acceptance attempt requires a prior gap receipt');
    assert(priorGap.workflowId === state.workflowId &&
      priorGap.promptHash === state.promptHash &&
      priorGap.sessionId === sessionId &&
      priorGap.terminal === false,
    'Intent acceptance remediation receipt is not bound to the active session, workflow, and prompt');
    assert(priorGap.packetHash !== packet.packetHash,
      'Second intent-acceptance attempt requires a rebuilt packet with a new packet hash');
  } else {
    assert(input.previousGapReceipt === undefined,
      'Initial intent-acceptance dispatch cannot carry a previous gap receipt');
  }
  const receipt = createIntentAcceptanceDispatchReceipt({
    packet,
    sessionId,
    attempt: nextAttempt,
    profile: {
      model: profile.model,
      effort: profile.effort,
      context: profile.context,
    },
    selectedModelSource: profile.source === 'missing-session-events'
      ? 'session-routing-state'
      : 'session-events-tail',
    createdAt: input.issuedAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt ?? packet.expiresAt,
  });
  persistIntentAcceptanceDispatchRecord(options.home, sessionId, receipt);
  return receipt;
}

function validateReasonOnlyLeafCommand(call, envelope, payload, promptState, home) {
  const command = String(call.args.command ?? '').trim();
  const tokens = tokenizeCommand(command);
  if (tokens[0] !== 'node' || tokens.length !== 4) {
    return null;
  }
  const scriptFile = resolveCommandFile(payload.cwd, tokens[1]);
  const scriptStat = fs.statSync(scriptFile, { throwIfNoEntry: false });
  if (!scriptStat?.isFile() ||
    fs.realpathSync(scriptFile) !== KNOWN_SCRIPT_REALPATHS.runLeaf) {
    return null;
  }
  const requestPath = tokens[2];
  const requestFile = path.isAbsolute(requestPath)
    ? requestPath
    : path.resolve(payload.cwd ?? process.cwd(), requestPath);
  const stat = fs.statSync(requestFile, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 200000) {
    return deny('Budget routing guard: reason-only run-leaf requests must use an explicit reviewed JSON file <=200 KB.');
  }
  const request = createBoundReasonOnlyLeafRequest(JSON.parse(fs.readFileSync(requestFile, 'utf8')));
  if (!promptState) {
    return deny('Budget routing guard: prompt routing state is missing; restart the turn or rerun the prompt under the active hook set.');
  }
  if (request.dispatchManifest.sessionId !== envelope.sessionId ||
    request.dispatchManifest.promptHash !== promptState.promptHash ||
    request.dispatchManifest.workflowId !== promptState.workflowId) {
    return deny('Budget routing guard: reason-only run-leaf request is not bound to the active session, workflow, and prompt.');
  }
  if (Date.parse(request.evidencePacket.expiresAt) <= Date.now()) {
    return deny('Budget routing guard: reason-only packet is stale.');
  }
  if (request.dispatchManifest.role === INTENT_ACCEPTANCE_ROLE) {
    const active = activeIntentAcceptanceReceipt(
      home,
      request.dispatchManifest.sessionId,
      request.intentAcceptanceDispatchReceipt.receiptHash,
    );
    if (!active) {
      return deny('Budget routing guard: active user-intent-acceptance dispatch receipt is missing, expired, or already used.');
    }
    const consumed = consumeIntentAcceptanceDispatchReceipt(
      home,
      request.dispatchManifest.sessionId,
      request.intentAcceptanceDispatchReceipt.receiptHash,
    );
    if (consumed === false || !consumed) {
      return deny('Budget routing guard: user-intent-acceptance dispatch receipts are one-shot and limited to two total attempts.');
    }
    return {};
  }
  const active = activeFrontierReceipt(home, request.dispatchManifest.sessionId,
    request.frontierReceipt.receiptHash);
  if (!active) {
    return deny('Budget routing guard: active frontier dispatch receipt is missing or expired.');
  }
  if (request.dispatchManifest.role === 'tandem-secondary-research') {
    if (!request.tandemPairReceipt) {
      return deny('Budget routing guard: tandem secondary dispatch requires a tandem pair receipt.');
    }
    if (request.tandemPairReceipt.secondaryDispatchReceiptHash !==
      request.frontierReceipt.receiptHash) {
      return deny('Budget routing guard: tandem secondary dispatch pair binding mismatch.');
    }
  }
  return {};
}

function individualToolCalls(payload) {
  if (Array.isArray(payload.toolCalls)) {
    return payload.toolCalls.map(call => ({
      id: call?.id ?? null,
      name: normalizeToolName(call.name),
      args: normalizeToolName(call.name) === 'apply_patch' && typeof call.args === 'string'
        ? { __raw: call.args }
        : normalizeArgs(call.args),
    }));
  }
  const name = normalizeToolName(payload.toolName ?? payload.tool_name);
  return [{
    id: null,
    name,
    args: name === 'apply_patch' &&
      typeof (payload.toolArgs ?? payload.tool_input) === 'string'
      ? { __raw: payload.toolArgs ?? payload.tool_input }
      : normalizeArgs(payload.toolArgs ?? payload.tool_input),
  }];
}

function collectTargetPaths(args, cwd) {
  const values = [];
  for (const key of PATH_ARGUMENT_KEYS) {
    if (typeof args[key] === 'string') values.push(args[key]);
  }
  if (Array.isArray(args.paths)) values.push(...args.paths);
  if (values.length === 0) values.push(cwd);
  return values;
}

function looksLikeTestCommand(command) {
  return /\b(?:npm|pnpm|yarn|bun|node|pytest|vitest|jest|go|cargo|dotnet|mix|bundle|rspec)\b.*\btest\b/i.test(command) ||
    /\b(?:vitest|jest|pytest|rspec|go test|cargo test|dotnet test|node --test)\b/i.test(command);
}

function toolCategoryForCall(call) {
  if (REPOSITORY_READ_TOOLS.has(call.name)) return 'repository-read';
  if (REPOSITORY_SEARCH_TOOLS.has(call.name)) return 'repository-search';
  if (REPOSITORY_EDIT_TOOLS.has(call.name)) return 'repository-edit';
  if (call.name === 'sql') return 'workflow-sql';
  if (call.name === 'session_store_sql') return 'history-sql';
  if (call.name === 'fetch_copilot_cli_documentation') return 'documentation';
  if (call.name === 'vote_memory') return 'memory-vote';
  if (call.name === 'store_memory') return 'memory-store';
  if (WEB_TOOLS.has(call.name)) return 'web';
  if (call.name === 'manage_schedule') {
    const action = String(call.args.action ?? '').trim().toLowerCase();
    if (action === 'create') return 'schedule-create';
    if (action === 'wakeup') return 'schedule-wakeup';
  }
  if (call.name === 'bash' || call.name === 'powershell') {
    return looksLikeTestCommand(call.args.command ?? '') ? 'tests' : 'shell';
  }
  if (call.name.startsWith('browser_')) return 'browser';
  if (call.name.startsWith('ha_') ||
    call.name.startsWith('plex_') ||
    call.name.startsWith('arr_') ||
    call.name.startsWith('radarr_') ||
    call.name.startsWith('sonarr_') ||
    call.name.startsWith('lidarr_') ||
    call.name.startsWith('trash_')) return 'mcp';
  if (['search_code', 'search_users', 'get_file_contents', 'get_copilot_space', 'list_copilot_spaces'].includes(call.name)) {
    return 'github';
  }
  return null;
}

function exactValidationCommandAllowed(command, validations = [], validationHashes = []) {
  const text = String(command ?? '').trim();
  return validations.some(validation => validation === text) ||
    validationHashes.includes(sha256(text));
}

function exactAllowedQuery(query, allowedQueries = [], allowedQueryHashes = []) {
  const text = String(query ?? '').trim();
  return text.length > 0 &&
    (allowedQueries.includes(text) || allowedQueryHashes.includes(sha256(text)));
}

function resolvedStateRepositoryRoot(state, payload) {
  if ((state.repositoryMode ?? 'none') !== 'cwd-repository-root') return null;
  const cwd = payload.cwd ?? process.cwd();
  if (!realDirectoryOrNull(cwd)) return null;
  try {
    const repositoryRoot = safeRepositoryRoot(cwd);
    return state.repositoryHash === sha256(repositoryRoot) ? repositoryRoot : null;
  } catch {
    return null;
  }
}

function canonicalPathForScope(candidate) {
  const unresolved = path.resolve(candidate);
  const missing = [];
  let current = unresolved;
  while (true) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })) {
      return path.join(fs.realpathSync(current), ...missing);
    }
    const parent = path.dirname(current);
    if (parent === current) return unresolved;
    missing.unshift(path.basename(current));
    current = parent;
  }
}

function pathAllowedForState(candidate, payload, state, prefixes = state.scope) {
  const cwd = payload.cwd ?? process.cwd();
  const resolved = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(cwd, candidate);
  const absolute = canonicalPathForScope(resolved);
  const repositoryRoot = resolvedStateRepositoryRoot(state, payload);
  if (repositoryRoot) {
    const relativeToRepo = path.relative(repositoryRoot, absolute);
    if (relativeToRepo === '..' ||
      relativeToRepo.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRepo)) {
      return false;
    }
    if (prefixes.length === 0) return true;
    const normalizedRelative = relativeToRepo.replace(/\\/g, '/');
    return prefixes.some(prefix => {
      const normalizedPrefix = prefix.replace(/^[./]+/, '').replace(/\\/g, '/');
      if (!normalizedPrefix) return true;
      return normalizedRelative === normalizedPrefix ||
        normalizedRelative.startsWith(`${normalizedPrefix}/`) ||
        path.basename(normalizedRelative) === normalizedPrefix;
    });
  }
  if (prefixes.length === 0) return true;
  return prefixes.some(prefix => {
    const scopeRoot = canonicalPathForScope(path.resolve(cwd, prefix));
    const relativeToScope = path.relative(scopeRoot, absolute);
    return relativeToScope === '' ||
      (relativeToScope !== '..' &&
        !relativeToScope.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeToScope));
  });
}

function callFitsPathConstraints(call, payload, prefixes) {
  if (prefixes.length === 0) return true;
  const paths = collectTargetPaths(call.args, payload.cwd ?? process.cwd());
  return paths.every(value => typeof value === 'string' && pathAllowedForState(value, payload, {
    repositoryMode: 'none',
    repositoryHash: null,
    scope: prefixes,
  }, prefixes));
}

function childDispatchAllowsCall(call, payload, state) {
  const category = toolCategoryForCall(call);
  const exactNameAllowed = (state.allowedToolNames ?? []).includes(call.name);
  const prefixedAllowed = (state.allowedToolNamePrefixes ?? [])
    .some(prefix => call.name.startsWith(prefix));
  if (!category ||
    (!state.allowedToolCategories.includes(category) && !exactNameAllowed && !prefixedAllowed)) return false;
  if (category === 'repository-read' ||
    category === 'repository-search' ||
    category === 'repository-edit') {
    const targets = collectTargetPaths(call.args, payload.cwd ?? process.cwd());
    return targets.every(value => typeof value === 'string' &&
      pathAllowedForState(value, payload, state));
  }
  if (category === 'tests' || category === 'shell') {
    return exactValidationCommandAllowed(
      call.args.command ?? '',
      state.validations ?? [],
      state.validationHashes ?? [],
    );
  }
  if (category === 'history-sql') {
    const query = String(call.args.query ?? call.args.sql ?? '').trim();
    return exactAllowedQuery(query, state.allowedQueries ?? [], state.allowedQueryHashes ?? []);
  }
  if (['documentation', 'web', 'github', 'browser', 'mcp', 'memory-vote'].includes(category)) {
    return exactNameAllowed || prefixedAllowed || state.allowedToolCategories.includes(category);
  }
  return false;
}

function normalizedAgentIdSet(call) {
  const hasAgentId = call.args.agent_id !== undefined || call.args.agentId !== undefined;
  const hasAgentIds = call.args.agent_ids !== undefined || call.args.agentIds !== undefined;
  assert(!(hasAgentId && hasAgentIds),
    'write_agent must use either agent_id or agent_ids, not both');
  if (hasAgentId) {
    return [requireValidAgentId(
      firstDefined(call.args, ['agent_id', 'agentId']),
      'write_agent agent_id',
    )];
  }
  if (hasAgentIds) {
    const supplied = firstDefined(call.args, ['agent_ids', 'agentIds']);
    assert(Array.isArray(supplied) && supplied.length > 0 && supplied.length <= 16,
      'write_agent agent_ids must be a non-empty array of at most 16 recipients');
    const ids = supplied.map((value, index) =>
      requireValidAgentId(value, `write_agent agent_ids[${index}]`));
    assert(new Set(ids).size === ids.length,
      'write_agent agent_ids must not contain duplicates');
    return ids;
  }
  return [];
}

function registeredChildAgentAllowed(home, promptState, agentId) {
  const matches = readChildAgentRegistry(home, promptState.sessionId)
    .filter(record => record.parentWorkflowId === promptState.workflowId &&
      record.parentPromptHash === promptState.promptHash &&
      record.agentIdHash === sha256(agentId));
  return matches.some(record => {
    const childState = currentPromptState(home, record.childSessionId);
    return childState &&
      childState.endedAt === null &&
      childState.classification === 'subagent-active' &&
      childState.parentSessionId === promptState.sessionId &&
      childState.parentWorkflowId === promptState.workflowId &&
      childState.parentPromptHash === promptState.promptHash &&
      childState.dispatchManifestHash === record.dispatchManifestHash &&
      childState.childActivationReceiptHash === record.childActivationReceiptHash;
  });
}

function validateWriteAgentCall(call, promptState, home) {
  assert(typeof call.args.message === 'string' && call.args.message.trim().length > 0,
    'write_agent requires a non-empty message');
  assert(promptState && promptState.endedAt === null,
    'write_agent requires an active prompt binding');
  const hasScope = call.args.scope !== undefined;
  const recipientIds = normalizedAgentIdSet(call);
  assert(!(hasScope && recipientIds.length > 0),
    'write_agent cannot mix explicit agent recipients with scope');
  if (hasScope) {
    const scope = String(call.args.scope ?? '').trim();
    assert(scope === 'children',
      'write_agent only supports scope: children through the protected routing surface');
    return {};
  }
  assert(recipientIds.length > 0,
    'write_agent requires scope: children or registered current child agent IDs');
  const unknown = recipientIds.filter(agentId =>
    !registeredChildAgentAllowed(home, promptState, agentId));
  assert(unknown.length === 0,
    'write_agent may target only registered current child agents bound to the active prompt');
  return {};
}

function controlPlaneDecision(call) {
  if (SAFE_CONTROL_PLANE_TOOLS.has(call.name)) return {};
  if (call.name === 'store_memory') {
    return deny('Budget routing guard: store_memory remains gated until the sensitive-data policy can be mechanically validated.');
  }
  if (call.name === 'skill') {
    return typeof call.args.skill === 'string' && call.args.skill.trim().length > 0
      ? {}
      : deny('Budget routing guard: skill loading requires an explicit installed or declared skill name.');
  }
  if (CONTROL_PLANE_TOOLS.has(call.name)) return {};
  if (call.name === 'manage_schedule') {
    const action = String(call.args.action ?? '').trim().toLowerCase();
    if (action === 'list' || action === 'stop') return {};
    if (action === 'create' || action === 'wakeup') {
      return deny('Budget routing guard: manage_schedule create and wakeup require an explicit operator override receipt bound to the active prompt.');
    }
    return deny('Budget routing guard: manage_schedule requires an explicit visible action.');
  }
  return null;
}

function inlineOperatorOverrideReceipt(call, payload) {
  return firstDefined(call.args, [
    'operatorOverrideReceipt',
    'operator_override_receipt',
  ]) ?? firstDefined(payload, [
    'operatorOverrideReceipt',
    'operator_override_receipt',
  ]);
}

function validateInlineOperatorOverride(home, sessionId, promptState, call, payload, now = Date.now()) {
  if (!promptState) return null;
  const provided = inlineOperatorOverrideReceipt(call, payload);
  if (provided === undefined) return null;
  let receipt;
  try {
    receipt = validateOperatorOverrideReceipt(provided);
  } catch (error) {
    return { decision: deny(`Budget routing guard: ${error.message}`) };
  }
  if (receipt.sessionId !== sessionId) {
    return { decision: deny('Budget routing guard: operator override receipt is not bound to the active session.') };
  }
  const records = readOperatorOverrideRecords(home, sessionId);
  const record = records.find(value => value.receiptHash === receipt.receiptHash);
  if (!record || !operatorOverrideRecordMatchesReceipt(record, receipt)) {
    return { decision: deny('Budget routing guard: operator override receipt is missing, forged, or no longer registered.') };
  }
  const category = toolCategoryForCall(call);
  if (record.workflowId !== promptState.workflowId ||
    record.promptHash !== promptState.promptHash) {
    return { decision: deny('Budget routing guard: operator override receipt is not bound to the active prompt.') };
  }
  if (record.usesConsumed >= record.maxUses || Date.parse(record.expiresAt) <= now) {
    return { decision: deny('Budget routing guard: operator override receipt is stale, expired, or exhausted.') };
  }
  const toolAllowed = receipt.allowedToolNames.includes(call.name) ||
    (category !== null && receipt.allowedToolCategories.includes(category));
  if (!toolAllowed) {
    return { decision: deny('Budget routing guard: operator override receipt does not allow this tool.') };
  }
  const pathConstrained = REPOSITORY_READ_TOOLS.has(call.name) ||
    REPOSITORY_SEARCH_TOOLS.has(call.name) ||
    REPOSITORY_EDIT_TOOLS.has(call.name);
  if (pathConstrained &&
    receipt.pathPrefixes.length > 0 &&
    !callFitsPathConstraints(call, payload, receipt.pathPrefixes)) {
    return { decision: deny('Budget routing guard: operator override receipt does not cover this path scope.') };
  }
  if (receipt.commandPrefixes.length > 0) {
    const command = String(call.args.command ?? '').trim();
    if (!receipt.commandPrefixes.some(prefix => command.startsWith(prefix))) {
      return { decision: deny('Budget routing guard: operator override receipt does not cover this command.') };
    }
  }
  if (call.name === 'manage_schedule' && receipt.scheduleActions.length > 0) {
    const action = String(call.args.action ?? '').trim();
    if (!receipt.scheduleActions.includes(action)) {
      return { decision: deny('Budget routing guard: operator override receipt does not cover this schedule action.') };
    }
  }
  if ((call.name === 'sql' || call.name === 'session_store_sql') &&
    receipt.queryPrefixes.length > 0) {
    const query = String(call.args.query ?? call.args.sql ?? '').trim();
    if (!receipt.queryPrefixes.some(prefix => query.startsWith(prefix))) {
      return { decision: deny('Budget routing guard: operator override receipt does not cover this query.') };
    }
  }
  return { receiptHash: receipt.receiptHash };
}

function consumeOperatorOverride(home, sessionId, receiptHashValue) {
  const records = readOperatorOverrideRecords(home, sessionId);
  const index = records.findIndex(record => record.receiptHash === receiptHashValue);
  if (index < 0) return false;
  const record = records[index];
  if (record.usesConsumed >= record.maxUses) return false;
  record.usesConsumed += 1;
  writeOperatorOverrideRecords(home, sessionId, records);
  return true;
}

function sanitizedAuditEntry(payload, promptState, call, decision, mode) {
  const targets = collectTargetPaths(call.args, payload.cwd ?? process.cwd());
  return {
    timestamp: new Date().toISOString(),
    mode,
    sessionIdHash: sha256(resolveSessionId(payload)),
    workflowId: promptState?.workflowId ?? null,
    promptHash: promptState?.promptHash ?? null,
    classification: promptState?.classification ?? null,
    tool: call.name,
    category: toolCategoryForCall(call),
    argsShape: Object.keys(call.args ?? {}).sort(),
    pathHashes: targets.map(value => sha256(String(value))).slice(0, 6),
    commandHash: typeof call.args.command === 'string'
      ? sha256(String(call.args.command).trim().replace(/\s+/g, ' '))
      : null,
    reasonHash: sha256(decision.permissionDecisionReason ?? 'denied'),
  };
}

function deny(reason) {
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  };
}

function decisionForCall(call, envelope, payload, promptState, sessionProfile, home) {
  if (call.name === 'write_agent') {
    try {
      return validateWriteAgentCall(call, promptState, home);
    } catch (error) {
      return deny(`Budget routing guard: ${error.message}`);
    }
  }
  const control = controlPlaneDecision(call);
  if (control && control.permissionDecision !== 'deny') return {};
  if (call.name === 'bash' || call.name === 'powershell') {
    const leaf = validateReasonOnlyLeafCommand(call, envelope, payload, promptState, home);
    if (leaf) return leaf;
    const routing = validateRoutingCommandCall(call, envelope, payload, promptState);
    if (routing) return routing;
  }
  if (call.name === 'task') return validateTaskCall(call, envelope, payload, promptState, home);
  if (promptState?.classification === 'subagent-active' &&
    childDispatchAllowsCall(call, payload, promptState)) {
    return {};
  }
  const override = validateInlineOperatorOverride(
    home,
    envelope.sessionId,
    promptState,
    call,
    payload,
  );
  if (override?.decision) return override.decision;
  if (override?.receiptHash &&
    consumeOperatorOverride(home, envelope.sessionId, override.receiptHash)) {
    return {};
  }
  if (control?.permissionDecision === 'deny') return control;
  if ((promptState?.classification === 'approved-root' || promptState === null) &&
    APPROVED_ROOT_MODELS.has(promptState?.model ?? sessionProfile.model)) {
    return oversizedReadDecision({
      cwd: payload.cwd,
      toolName: call.name,
      toolArgs: call.args,
    });
  }
  if (promptState?.classification === 'subagent-unresolved') {
    return deny('Budget routing guard: unresolved subagent activation may use control-plane routing only until routing-enforcement.mjs activates an exact bound child dispatch.');
  }
  if (promptState?.classification === 'subagent-active') {
    return deny('Budget routing guard: manifest-bound child sessions may use only control-plane tools plus the exact repository/tool categories, scope, and validations granted by the validated dispatch.');
  }
  return deny('Budget routing guard: protected root sessions may only route, manage workflow state, run deterministic history/packet planning, dispatch explicitly pinned cheaper task manifests, or launch exact reason-only packet-bound frontier leaves. Direct repository, shell, edit, review, release, MCP, browser, web, GitHub, SQL, and Git work is blocked.');
}

export function hookDecision(payload, options = {}) {
  const mode = effectiveRoutingMode({ home: options.home, env: options.env });
  let calls;
  try {
    calls = individualToolCalls(payload);
  } catch (error) {
    if (mode.mode === 'audit') return {};
    return deny(`Budget routing guard: ${error.message}`);
  }
  let envelope;
  try {
    envelope = validateHookEnvelope(payload, options);
  } catch (error) {
    const decision = deny(`Budget routing guard: ${error.message}`);
    if (mode.mode === 'audit') return {};
    if (calls.some(call => call.id)) {
      const keyed = Object.fromEntries(
        calls
          .filter(call => call.id)
          .map(call => [call.id, decision]),
      );
      return Object.keys(keyed).length > 0 ? keyed : decision;
    }
    return decision;
  }
  const promptState = currentPromptState(options.home, envelope.sessionId);
  const sessionProfile = resolveSessionProfile(options.home, envelope.sessionId, { payload });
  const denials = {};
  for (const call of calls) {
    const decision = decisionForCall(
      call,
      envelope,
      payload,
      promptState,
      sessionProfile,
      options.home,
    );
    if (decision.permissionDecision === 'deny') {
      if (mode.mode === 'audit') {
        try {
          appendAuditEntry(options.home, sanitizedAuditEntry(payload, promptState, call, decision, mode.mode));
        } catch {
          // Audit mode must never convert a would-deny record or logging issue into a denial.
        }
        continue;
      }
      if (call.id) denials[call.id] = decision;
      else return decision;
    }
  }
  return calls.some(call => call.id) ? denials : {};
}

export function projectedFrontierReduction(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Projection input required');
  const baseline = Number(input.baselineFrontierCredits);
  const baselineResearch = Number(input.baselineResearchFrontierCredits ?? 0);
  const candidateResearch = Number(input.candidateResearchFrontierCredits ?? 0);
  const candidateNonResearch = Number(input.candidateNonResearchFrontierCredits);
  for (const [label, value] of [
    ['baselineFrontierCredits', baseline],
    ['baselineResearchFrontierCredits', baselineResearch],
    ['candidateResearchFrontierCredits', candidateResearch],
    ['candidateNonResearchFrontierCredits', candidateNonResearch],
  ]) {
    assert(Number.isFinite(value) && value >= 0, `${label} must be a finite number >= 0`);
  }
  const baselineNonResearch = baseline - baselineResearch;
  assert(baselineNonResearch > 0,
    'Baseline must include positive non-research frontier credits');
  return {
    version: STATE_VERSION,
    estimated: true,
    baselineFrontierCredits: baseline,
    baselineResearchFrontierCredits: baselineResearch,
    baselineNonResearchFrontierCredits: baselineNonResearch,
    candidateResearchFrontierCredits: candidateResearch,
    candidateNonResearchFrontierCredits: candidateNonResearch,
    nonResearchFrontierCreditReduction:
      1 - candidateNonResearch / baselineNonResearch,
    researchFrontierShareOfCandidate:
      candidateResearch + candidateNonResearch === 0
        ? 0
        : candidateResearch / (candidateResearch + candidateNonResearch),
    assumptions: String(input.assumptions ?? ''),
  };
}

function parseStdin() {
  const text = fs.readFileSync(0, 'utf8');
  return {
    text,
    value: text.trim() ? JSON.parse(text) : {},
  };
}

function usage() {
  return 'Usage: routing-enforcement.mjs hook | prompt-start | session-end | status INPUT.json | status-current INPUT.json | manifest INPUT.json | manifest-from-active-prompt INPUT.json | write-control-artifact-current INPUT.json | authorize-research INPUT.json | authorize-intent-acceptance INPUT.json | authorize-operator INPUT.json | project INPUT.json';
}

function writeCompatCliError(code, message, details = {}) {
  const text = `${JSON.stringify({
    ok: false,
    code,
    message,
    ...details,
  }, null, 2)}\n`;
  assert(Buffer.byteLength(text, 'utf8') <= DISPATCH_CURRENT_COMPAT_OUTPUT_BYTES,
    'Compatibility CLI error exceeds the bounded output cap');
  process.stdout.write(text);
}

async function main(argv = process.argv.slice(2)) {
  const [command, file] = argv;
  if (command === 'hook') {
    const stdin = parseStdin();
    process.stdout.write(`${JSON.stringify(hookDecision(stdin.value, { rawPayloadText: stdin.text }), null, 2)}\n`);
    return;
  }
  if (command === 'prompt-start') {
    const payload = parseStdin().value;
    let routing = {};
    try {
      routing = promptStartState(payload);
    } catch {
      routing = {};
    }
    try {
      recordLifecyclePromptStart(payload, {
        workflowState: routing?.workflowId ? routing : undefined,
        modelProfile: routing?.model && routing?.effort
          ? {
            model: routing.model,
            effort: routing.effort,
            context: routing.context ?? 'default',
          }
          : null,
      });
    } catch {
      // Session start/resume must never fail because lifecycle reporting is unavailable.
    }
    process.stdout.write(`${JSON.stringify(routing, null, 2)}\n`);
    return;
  }
  if (command === 'session-end') {
    const payload = parseStdin().value;
    let cleared = {};
    try {
      const sessionId = resolveSessionId(payload);
      cleared = sessionId ? clearSessionState(sessionId) : {};
    } catch {
      cleared = {};
    }
    let lifecycle = null;
    try {
      lifecycle = recordLifecycleSessionEnd(payload);
    } catch {
      lifecycle = {
        recorded: false,
        eventRecorded: false,
        complianceRecorded: false,
        reportingFailures: [{
          stage: 'session-end-reporting',
          classification: 'unexpected',
        }],
      };
    }
    process.stdout.write(`${JSON.stringify(
      lifecycle ? { ...cleared, ...lifecycle } : cleared,
      null,
      2,
    )}\n`);
    return;
  }
  if (command === 'status') {
    assert(file, usage());
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(routingStatus(input), null, 2)}\n`);
    return;
  }
  if (command === 'status-current') {
    assert(file, usage());
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(routingStatusCurrent(input), null, 2)}\n`);
    return;
  }
  if (command === 'dispatch-current') {
    writeCompatCliError(
      'dispatch-current-retired',
      'dispatch-current is retired on the model-facing CLI surface. Automatic reader routes are accepted directly by the hook, and explicit bounded work must use manifest-from-active-prompt.',
      { role: typeof file === 'string' && file.trim().length > 0 ? file.trim() : null },
    );
    process.exitCode = 1;
    return;
  }
  if (command === 'manifest') {
    assert(file, usage());
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(createDispatchManifest(input), null, 2)}\n`);
    return;
  }
  if (command === 'manifest-from-active-prompt') {
    assert(file, usage());
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(manifestFromActivePrompt(input), null, 2)}\n`);
    return;
  }
  if (command === 'write-control-artifact-current') {
    assert(file, usage());
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(writeControlArtifactCurrent(input), null, 2)}\n`);
    return;
  }
  if (command === 'authorize-research') {
    assert(file, usage());
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(authorizeResearchReceipt(input), null, 2)}\n`);
    return;
  }
  if (command === 'authorize-intent-acceptance') {
    assert(file, usage());
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(authorizeIntentAcceptanceReceipt(input), null, 2)}\n`);
    return;
  }
  if (command === 'authorize-operator') {
    assert(file, usage());
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(authorizeOperatorOverride(input), null, 2)}\n`);
    return;
  }
  if (command === 'project') {
    assert(file, usage());
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(projectedFrontierReduction(input), null, 2)}\n`);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    console.error(`routing-enforcement: ${error.message}`);
    process.exitCode = 1;
  }
}
