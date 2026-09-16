#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PACKET_LIMITS,
  buildFrozenEvidencePacket,
  createHistoryQueryReceipt,
  normalizedQuestionBinding,
  normalizeExactScope,
  sha256,
  validateFrozenEvidencePacket,
} from './schemas.mjs';

const LOOKBACK_WINDOWS = Object.freeze([7, 30, 90]);
const MAX_HISTORY_SESSIONS = 20;
const MAX_HISTORY_SNIPPETS = 10;
const MAX_HISTORY_SNIPPET_CHARS = 500;
const CLOUD = 'cloud';
const LOCAL = 'local';
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

const TEMPLATE_REGISTRY = Object.freeze({
  'recent-sessions': {
    description: 'Recent session summaries',
    buildQuery: request => buildRecentSessionsQuery(request),
    packetize: (rows, plan) => packetizeRecentSessions(rows, plan),
  },
  'repo-date-sessions': {
    description: 'Repository/date session summaries',
    buildQuery: request => buildRepoDateSessionsQuery(request),
    packetize: (rows, plan) => packetizeRecentSessions(rows, plan),
  },
  'named-session-lookup': {
    description: 'Named session summaries',
    buildQuery: request => buildNamedSessionLookupQuery(request),
    packetize: (rows, plan) => packetizeRecentSessions(rows, plan),
  },
  'pr-issue-refs': {
    description: 'PR/issue-linked sessions',
    buildQuery: request => buildRefSessionsQuery(request),
    packetize: (rows, plan) => packetizeRefSessions(rows, plan),
  },
  'turn-snippets': {
    description: 'Bounded turn snippets',
    buildQuery: request => buildTurnSnippetsQuery(request),
    packetize: (rows, plan) => packetizeTurnSnippets(rows, plan),
  },
  'files-touched': {
    description: 'Files touched by sessions',
    buildQuery: request => buildFilesTouchedQuery(request),
    packetize: (rows, plan) => packetizeFilesTouched(rows, plan),
  },
  'model-tool-usage': {
    description: 'Model and tool usage by session',
    buildQuery: request => buildModelToolUsageQuery(request),
    packetize: (rows, plan) => packetizeUsage(rows, plan),
  },
  'prior-approach': {
    description: 'Prior approach summaries',
    buildQuery: request => buildPriorApproachQuery(request),
    packetize: (rows, plan) => packetizePriorApproach(rows, plan),
  },
  'checkpoint-summaries': {
    description: 'Checkpoint summaries',
    buildQuery: request => buildCheckpointSummariesQuery(request),
    packetize: (rows, plan) => packetizeCheckpointSummaries(rows, plan),
  },
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}

function exactString(value, label) {
  assert(typeof value === 'string' && value.trim().length > 0,
    `${label} required`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function lookbackDays(request) {
  if (request.lookbackDays === undefined) return 7;
  assert(Number.isInteger(request.lookbackDays) &&
    LOOKBACK_WINDOWS.includes(request.lookbackDays),
  `lookbackDays must be one of ${LOOKBACK_WINDOWS.join(', ')}`);
  return request.lookbackDays;
}

function limitValue(request, maximum = MAX_HISTORY_SESSIONS, fallback = maximum) {
  if (request.limit === undefined) return fallback;
  assert(Number.isInteger(request.limit) && request.limit >= 1 && request.limit <= maximum,
    `limit must be 1-${maximum}`);
  return request.limit;
}

function resolvedTemplate(request) {
  const templateId = exactString(request.templateId, 'templateId');
  const template = TEMPLATE_REGISTRY[templateId];
  assert(template, `Unknown history template: ${templateId}`);
  return { templateId, template };
}

function resolvedSource(request) {
  const source = request.source ?? CLOUD;
  assert([CLOUD, LOCAL].includes(source), 'History source must be cloud or local');
  return source;
}

function cloudTimeFilter(column, days) {
  return `${column} > now() - INTERVAL '${days} days'`;
}

function localDayFilter(column, days) {
  return `substr(${column}, 1, 10) >= date('now', '-${days} days')`;
}

function timeFilter(column, source, days) {
  return source === CLOUD
    ? cloudTimeFilter(column, days)
    : localDayFilter(column, days);
}

function sqlLikePattern(pattern) {
  return `%${escapeSql(pattern).replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function exactRepository(request, required = false) {
  const repository = optionalString(request.repository);
  if (required) assert(repository, 'Exact repository filter required');
  return repository;
}

function resolvedSessions(request, required = false) {
  if (request.resolvedSessions === undefined) {
    assert(!required, 'Resolved sessions required');
    return [];
  }
  assert(Array.isArray(request.resolvedSessions) &&
    request.resolvedSessions.length > 0 &&
    request.resolvedSessions.length <= MAX_HISTORY_SESSIONS,
  `resolvedSessions must contain 1-${MAX_HISTORY_SESSIONS} items`);
  return request.resolvedSessions.map(entry => {
    assert(entry && typeof entry === 'object' && !Array.isArray(entry),
      'Resolved session entry must be an object');
    return {
      sessionRef: exactString(entry.sessionRef, 'sessionRef'),
      sessionId: exactString(entry.sessionId, 'sessionId'),
    };
  });
}

function inList(column, values) {
  return `${column} IN (${values.map(value => `'${escapeSql(value)}'`).join(', ')})`;
}

function sessionScope(request) {
  const sessions = resolvedSessions(request, false);
  if (sessions.length > 0) return {
    sessions,
    clause: inList('session_id', sessions.map(entry => entry.sessionId)),
  };
  const repository = exactRepository(request, false);
  return {
    sessions: [],
    clause: repository ? `repository = '${escapeSql(repository)}'` : null,
  };
}

function planScope(request, plan) {
  const scope = [
    `history:${plan.templateId}`,
    `source:${plan.source}`,
    ...(plan.repository ? [`repository:${plan.repository}`] : []),
    ...(plan.refType && plan.refValue ? [`ref:${plan.refType}:${plan.refValue}`] : []),
    ...plan.sessionBindings.map(entry => `session:${entry.sessionRef}`),
  ];
  return normalizeExactScope(scope);
}

function validatePlanFilters(plan, needsTextScan = false) {
  assert(plan.lookbackDays === 7 || plan.lookbackDays === 30 || plan.lookbackDays === 90,
    'History lookback must stay within the approved widening windows');
  if (needsTextScan) {
    assert(plan.repository || plan.sessionBindings.length > 0,
      'History text scans require an exact repository or pre-resolved session narrowing');
  }
}

function buildRecentSessionsQuery(request) {
  const source = resolvedSource(request);
  const lookback = lookbackDays(request);
  const limit = limitValue(request);
  const repository = exactRepository(request, false);
  const where = [timeFilter('created_at', source, lookback)];
  if (repository) where.push(`repository = '${escapeSql(repository)}'`);
  return {
    source,
    lookbackDays: lookback,
    limit,
    repository,
    query: `SELECT id AS session_id, repository, branch, COALESCE(summary, '') AS summary, created_at, updated_at
FROM sessions
WHERE ${where.join(' AND ')}
ORDER BY updated_at DESC
LIMIT ${limit}`,
    sessionBindings: [],
  };
}

function buildRepoDateSessionsQuery(request) {
  const repository = exactRepository(request, true);
  return {
    ...buildRecentSessionsQuery({ ...request, repository }),
    repository,
  };
}

function buildNamedSessionLookupQuery(request) {
  const source = resolvedSource(request);
  const lookback = lookbackDays({ ...request, lookbackDays: request.lookbackDays ?? 30 });
  const limit = limitValue(request, 10, 5);
  const sessionLabel = exactString(
    request.sessionLabel ?? request.session_label ?? request.pattern,
    'sessionLabel',
  );
  const predicate = source === CLOUD
    ? `COALESCE(summary, '') ILIKE '${sqlLikePattern(sessionLabel)}'`
    : `COALESCE(summary, '') LIKE '${sqlLikePattern(sessionLabel)}' ESCAPE '\\'`;
  return {
    source,
    lookbackDays: lookback,
    limit,
    repository: null,
    pattern: sessionLabel,
    sessionBindings: [],
    query: `SELECT id AS session_id, repository, branch, COALESCE(summary, '') AS summary, created_at, updated_at
FROM sessions
WHERE ${timeFilter('updated_at', source, lookback)}
  AND ${predicate}
ORDER BY updated_at DESC
LIMIT ${limit}`,
  };
}

function buildRefSessionsQuery(request) {
  const source = resolvedSource(request);
  const lookback = lookbackDays(request);
  const limit = limitValue(request);
  const refType = exactString(request.refType, 'refType');
  assert(['pr', 'issue'].includes(refType), 'refType must be pr or issue');
  const refValue = exactString(request.refValue, 'refValue');
  return {
    source,
    lookbackDays: lookback,
    limit,
    repository: null,
    refType,
    refValue,
    sessionBindings: [],
    query: `SELECT session_refs.session_id, session_refs.ref_type, session_refs.ref_value,
  COALESCE(sessions.repository, '') AS repository,
  COALESCE(sessions.summary, '') AS summary,
  session_refs.created_at
FROM session_refs
JOIN sessions ON sessions.id = session_refs.session_id
WHERE session_refs.ref_type = '${escapeSql(refType)}'
  AND session_refs.ref_value = '${escapeSql(refValue)}'
  AND ${timeFilter('session_refs.created_at', source, lookback)}
ORDER BY session_refs.created_at DESC
LIMIT ${limit}`,
  };
}

function buildTurnSnippetsQuery(request) {
  const source = resolvedSource(request);
  const lookback = lookbackDays(request);
  const sessions = resolvedSessions(request, true);
  const limit = limitValue(request, MAX_HISTORY_SNIPPETS, MAX_HISTORY_SNIPPETS);
  const pattern = optionalString(request.pattern);
  const where = [inList('session_id', sessions.map(entry => entry.sessionId)),
    timeFilter('timestamp', source, lookback)];
  if (pattern) {
    const fieldPattern = sqlLikePattern(pattern);
    where.push(source === CLOUD
      ? `(COALESCE(user_message, '') ILIKE '${fieldPattern}' OR COALESCE(assistant_response, '') ILIKE '${fieldPattern}')`
      : `(COALESCE(user_message, '') LIKE '${fieldPattern}' ESCAPE '\\' OR COALESCE(assistant_response, '') LIKE '${fieldPattern}' ESCAPE '\\')`);
  }
  return {
    source,
    lookbackDays: lookback,
    limit,
    repository: null,
    pattern,
    sessionBindings: sessions,
    query: `SELECT session_id, turn_index, COALESCE(user_message, '') AS user_message,
  COALESCE(assistant_response, '') AS assistant_response, timestamp
FROM turns
WHERE ${where.join(' AND ')}
ORDER BY timestamp DESC
LIMIT ${limit}`,
  };
}

function buildFilesTouchedQuery(request) {
  const source = resolvedSource(request);
  const lookback = lookbackDays(request);
  const limit = limitValue(request, 50, 24);
  const repository = exactRepository(request, false);
  const sessions = resolvedSessions(request, false);
  const where = [timeFilter('session_files.first_seen_at', source, lookback)];
  if (sessions.length > 0) where.push(inList('session_files.session_id', sessions.map(entry => entry.sessionId)));
  else {
    assert(repository, 'files-touched requires an exact repository or pre-resolved sessions');
    where.push(`sessions.repository = '${escapeSql(repository)}'`);
  }
  return {
    source,
    lookbackDays: lookback,
    limit,
    repository,
    sessionBindings: sessions,
    query: `SELECT session_files.session_id, session_files.file_path, session_files.tool_name,
  session_files.turn_index, session_files.first_seen_at,
  COALESCE(sessions.repository, '') AS repository,
  COALESCE(sessions.summary, '') AS summary
FROM session_files
JOIN sessions ON sessions.id = session_files.session_id
WHERE ${where.join(' AND ')}
ORDER BY session_files.first_seen_at DESC
LIMIT ${limit}`,
  };
}

function buildModelToolUsageQuery(request) {
  const source = resolvedSource(request);
  const lookback = lookbackDays(request);
  const limit = limitValue(request);
  const repository = exactRepository(request, false);
  const sessions = resolvedSessions(request, false);
  const sessionFilter = sessions.length > 0
    ? inList('su.session_id', sessions.map(entry => entry.sessionId))
    : repository
      ? `sessions.repository = '${escapeSql(repository)}'`
      : null;
  assert(sessionFilter, 'model-tool-usage requires an exact repository or pre-resolved sessions');
  if (source === CLOUD) {
    return {
      source,
      lookbackDays: lookback,
      limit,
      repository,
      sessionBindings: sessions,
      query: `SELECT su.session_id, COALESCE(sessions.repository, '') AS repository,
  COALESCE(sessions.summary, '') AS summary, su.usage_model,
  COALESCE(su.api_call_count, 0) AS api_call_count,
  COALESCE(su.input_tokens, 0) AS input_tokens,
  COALESCE(su.output_tokens, 0) AS output_tokens,
  COALESCE(su.cost, 0) AS cost,
  COALESCE(te.tool_calls, 0) AS tool_calls,
  su.last_used_at
FROM session_usage su
JOIN sessions ON sessions.id = su.session_id
LEFT JOIN (
  SELECT session_id, COUNT(*) AS tool_calls
  FROM tool_executions
  WHERE completed_at >= started_at
    AND ${cloudTimeFilter('started_at', lookback)}
  GROUP BY session_id
) te ON te.session_id = su.session_id
WHERE ${sessionFilter}
  AND ${cloudTimeFilter('su.last_used_at', lookback)}
ORDER BY su.last_used_at DESC
LIMIT ${limit}`,
    };
  }
  return {
    source,
    lookbackDays: lookback,
    limit,
    repository,
    sessionBindings: sessions,
    query: `SELECT aue.session_id, COALESCE(sessions.repository, '') AS repository,
  COALESCE(sessions.summary, '') AS summary, COALESCE(aue.model, '') AS usage_model,
  COUNT(*) AS api_call_count,
  COALESCE(SUM(aue.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(aue.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(aue.total_nano_aiu), 0) / 1000000000.0 AS cost,
  0 AS tool_calls,
  MAX(sessions.updated_at) AS last_used_at
FROM assistant_usage_events aue
JOIN sessions ON sessions.id = aue.session_id
WHERE ${sessions.length > 0
    ? inList('aue.session_id', sessions.map(entry => entry.sessionId))
    : `sessions.repository = '${escapeSql(repository)}'`}
  AND ${localDayFilter('sessions.updated_at', lookback)}
GROUP BY aue.session_id, sessions.repository, sessions.summary, aue.model
ORDER BY last_used_at DESC
LIMIT ${limit}`,
  };
}

function buildPriorApproachQuery(request) {
  const source = resolvedSource(request);
  const lookback = lookbackDays(request);
  const repository = exactRepository(request, true);
  const pattern = optionalString(request.pattern);
  const limit = limitValue(request, 20, 12);
  validatePlanFilters({
    repository,
    sessionBindings: [],
    lookbackDays: lookback,
  }, pattern !== null);
  const sessionPredicate = pattern
    ? source === CLOUD
      ? `COALESCE(sessions.summary, '') ILIKE '${sqlLikePattern(pattern)}'`
      : `COALESCE(sessions.summary, '') LIKE '${sqlLikePattern(pattern)}' ESCAPE '\\'`
    : 'TRUE';
  const checkpointPredicate = pattern
    ? source === CLOUD
      ? `(COALESCE(checkpoints.title, '') ILIKE '${sqlLikePattern(pattern)}' OR COALESCE(checkpoints.overview, '') ILIKE '${sqlLikePattern(pattern)}')`
      : `(COALESCE(checkpoints.title, '') LIKE '${sqlLikePattern(pattern)}' ESCAPE '\\' OR COALESCE(checkpoints.overview, '') LIKE '${sqlLikePattern(pattern)}' ESCAPE '\\')`
    : 'TRUE';
  return {
    source,
    lookbackDays: lookback,
    limit,
    repository,
    pattern,
    sessionBindings: [],
    query: `WITH session_matches AS (
  SELECT id AS session_id, COALESCE(summary, '') AS summary,
    NULL AS title, NULL AS overview, updated_at AS timestamp, 'session' AS row_kind
  FROM sessions
  WHERE repository = '${escapeSql(repository)}'
    AND ${timeFilter('updated_at', source, lookback)}
    AND ${sessionPredicate}
  ORDER BY updated_at DESC
  LIMIT ${limit}
), checkpoint_matches AS (
  SELECT checkpoints.session_id, COALESCE(sessions.summary, '') AS summary,
    COALESCE(checkpoints.title, '') AS title,
    COALESCE(checkpoints.overview, '') AS overview,
    checkpoints.created_at AS timestamp, 'checkpoint' AS row_kind
  FROM checkpoints
  JOIN sessions ON sessions.id = checkpoints.session_id
  WHERE sessions.repository = '${escapeSql(repository)}'
    AND ${timeFilter('checkpoints.created_at', source, lookback)}
    AND ${checkpointPredicate}
  ORDER BY checkpoints.created_at DESC
  LIMIT ${limit}
)
SELECT *
FROM (
  SELECT * FROM session_matches
  UNION ALL
  SELECT * FROM checkpoint_matches
)
ORDER BY timestamp DESC
LIMIT ${limit}`,
  };
}

function buildCheckpointSummariesQuery(request) {
  const source = resolvedSource(request);
  const lookback = lookbackDays(request);
  const repository = exactRepository(request, true);
  const limit = limitValue(request, 20, 12);
  return {
    source,
    lookbackDays: lookback,
    limit,
    repository,
    sessionBindings: [],
    query: `SELECT checkpoints.session_id, COALESCE(sessions.summary, '') AS summary,
  COALESCE(checkpoints.title, '') AS title,
  COALESCE(checkpoints.overview, '') AS overview,
  checkpoints.created_at
FROM checkpoints
JOIN sessions ON sessions.id = checkpoints.session_id
WHERE sessions.repository = '${escapeSql(repository)}'
  AND ${timeFilter('checkpoints.created_at', source, lookback)}
ORDER BY checkpoints.created_at DESC
LIMIT ${limit}`,
  };
}

function credentialLike(value) {
  return /(?:password|passwd|secret|api[-_ ]?key|bearer\s+[a-z0-9._-]{12,}|gh[pousr]_[a-z0-9]{20,}|sk-[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i
    .test(value);
}

function sanitizeText(value, maximum = 240) {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  if (credentialLike(normalized)) return null;
  return normalized.slice(0, maximum);
}

function sanitizeSnippet(value) {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || credentialLike(normalized)) return null;
  return normalized.slice(0, MAX_HISTORY_SNIPPET_CHARS);
}

function sessionAliasMap(plan, rows) {
  const known = new Map((plan.sessionBindings ?? []).map(entry => [entry.sessionId, entry.sessionRef]));
  let counter = 1;
  for (const row of rows) {
    const sessionId = optionalString(row.session_id ?? row.sessionId);
    if (!sessionId || known.has(sessionId)) continue;
    known.set(sessionId, `hs_${String(counter).padStart(2, '0')}`);
    counter += 1;
  }
  return known;
}

function occurredAt(row, key = 'created_at') {
  const value = row[key] ?? row.created_at ?? row.updated_at ?? row.timestamp ?? row.first_seen_at ?? row.last_used_at;
  const time = new Date(value).toISOString();
  assert(ISO_DATE(time), 'History row timestamp invalid');
  return time;
}

function ISO_DATE(value) {
  return ISO_DATE_PATTERN.test(value);
}

function packetBase(plan, rows) {
  const aliases = sessionAliasMap(plan, rows);
  return {
    aliases,
    sourceEntries: [],
    excerpts: [],
    queryHash: sha256(plan.query),
  };
}

function addSessionSource(state, row, plan, summary) {
  const sessionId = optionalString(row.session_id ?? row.sessionId);
  const sessionRef = sessionId ? state.aliases.get(sessionId) : `hs_${String(state.sourceEntries.length + 1).padStart(2, '0')}`;
  const sourceId = `h_${sessionRef}`;
  if (state.sourceEntries.some(entry => entry.id === sourceId)) return sourceId;
  state.sourceEntries.push({
    id: sourceId,
    kind: 'history',
    templateId: plan.templateId,
    sessionRef,
    summary: summary ?? 'History evidence',
    occurredAt: occurredAt(row),
    queryHash: state.queryHash,
  });
  return sourceId;
}

function pushExcerpt(state, sourceId, citation, text, focus = null) {
  const sanitized = sanitizeSnippet(text);
  if (!sanitized) return;
  state.excerpts.push({
    id: `hx_${String(state.excerpts.length + 1).padStart(2, '0')}`,
    sourceId,
    citation,
    text: sanitized,
    textHash: sha256(sanitized),
    focus,
  });
}

function packetizeRecentSessions(rows, plan) {
  const state = packetBase(plan, rows.slice(0, MAX_HISTORY_SESSIONS));
  for (const row of rows.slice(0, MAX_HISTORY_SESSIONS)) {
    const summary = sanitizeText(row.summary ?? 'Session summary', 180) ?? 'Session summary';
    const sourceId = addSessionSource(state, row, plan, summary);
    const description = [
      summary,
      sanitizeText(row.repository, 120),
      sanitizeText(row.branch, 80),
    ].filter(Boolean).join(' | ');
    pushExcerpt(state, sourceId, {
      kind: 'history',
      sessionRef: state.aliases.get(row.session_id) ?? sourceId.slice(2),
      templateId: plan.templateId,
      snippetId: `${sourceId}:summary`,
    }, description || 'Recent session summary');
  }
  return state;
}

function packetizeRefSessions(rows, plan) {
  const state = packetBase(plan, rows.slice(0, MAX_HISTORY_SESSIONS));
  for (const row of rows.slice(0, MAX_HISTORY_SESSIONS)) {
    const summary = sanitizeText(row.summary, 180) ?? `${row.ref_type} ${row.ref_value}`;
    const sourceId = addSessionSource(state, row, plan, summary);
    pushExcerpt(state, sourceId, {
      kind: 'history',
      sessionRef: state.aliases.get(row.session_id) ?? sourceId.slice(2),
      templateId: plan.templateId,
      snippetId: `${sourceId}:${row.ref_type}:${row.ref_value}`,
    }, `${row.ref_type} ${row.ref_value} | ${summary}`);
  }
  return state;
}

function packetizeTurnSnippets(rows, plan) {
  const state = packetBase(plan, rows.slice(0, MAX_HISTORY_SNIPPETS));
  for (const row of rows.slice(0, MAX_HISTORY_SNIPPETS)) {
    const summary = `Turn ${row.turn_index}`;
    const sourceId = addSessionSource(state, row, plan, summary);
    const user = sanitizeSnippet(row.user_message);
    const assistant = sanitizeSnippet(row.assistant_response);
    const text = [user ? `User: ${user}` : null, assistant ? `Assistant: ${assistant}` : null]
      .filter(Boolean).join(' | ');
    pushExcerpt(state, sourceId, {
      kind: 'history',
      sessionRef: state.aliases.get(row.session_id) ?? sourceId.slice(2),
      templateId: plan.templateId,
      snippetId: `${sourceId}:turn:${row.turn_index}`,
    }, text || `Turn ${row.turn_index}`);
  }
  return state;
}

function packetizeFilesTouched(rows, plan) {
  const state = packetBase(plan, rows.slice(0, MAX_HISTORY_SESSIONS));
  for (const row of rows.slice(0, MAX_HISTORY_SESSIONS)) {
    const summary = sanitizeText(row.summary, 180) ?? sanitizeText(row.repository, 120) ?? 'Files touched';
    const sourceId = addSessionSource(state, row, plan, summary);
    pushExcerpt(state, sourceId, {
      kind: 'history',
      sessionRef: state.aliases.get(row.session_id) ?? sourceId.slice(2),
      templateId: plan.templateId,
      snippetId: `${sourceId}:file:${state.excerpts.length + 1}`,
    }, `${row.tool_name ?? 'tool'} ${row.file_path ?? 'unknown-path'} (turn ${row.turn_index ?? '?'})`);
  }
  return state;
}

function packetizeUsage(rows, plan) {
  const state = packetBase(plan, rows.slice(0, MAX_HISTORY_SESSIONS));
  for (const row of rows.slice(0, MAX_HISTORY_SESSIONS)) {
    const summary = sanitizeText(row.summary, 180) ?? sanitizeText(row.repository, 120) ?? 'Usage summary';
    const sourceId = addSessionSource(state, row, plan, summary);
    pushExcerpt(state, sourceId, {
      kind: 'history',
      sessionRef: state.aliases.get(row.session_id) ?? sourceId.slice(2),
      templateId: plan.templateId,
      snippetId: `${sourceId}:usage:${sanitizeText(row.usage_model, 40) ?? 'model'}`,
    }, `${row.usage_model}: calls=${row.api_call_count} input=${row.input_tokens} output=${row.output_tokens} credits=${row.cost} tools=${row.tool_calls}`);
  }
  return state;
}

function packetizePriorApproach(rows, plan) {
  const state = packetBase(plan, rows.slice(0, MAX_HISTORY_SESSIONS));
  for (const row of rows.slice(0, MAX_HISTORY_SESSIONS)) {
    const summary = sanitizeText(row.summary, 180) ?? 'Prior approach';
    const sourceId = addSessionSource(state, row, plan, summary);
    const text = [summary, sanitizeSnippet(row.title), sanitizeSnippet(row.overview)]
      .filter(Boolean)
      .join(' | ');
    pushExcerpt(state, sourceId, {
      kind: 'history',
      sessionRef: state.aliases.get(row.session_id) ?? sourceId.slice(2),
      templateId: plan.templateId,
      snippetId: `${sourceId}:${row.row_kind ?? 'history'}:${state.excerpts.length + 1}`,
    }, text || summary);
  }
  return state;
}

function packetizeCheckpointSummaries(rows, plan) {
  const state = packetBase(plan, rows.slice(0, MAX_HISTORY_SESSIONS));
  for (const row of rows.slice(0, MAX_HISTORY_SESSIONS)) {
    const summary = sanitizeText(row.summary, 180) ?? sanitizeText(row.title, 120) ?? 'Checkpoint summary';
    const sourceId = addSessionSource(state, row, plan, summary);
    const text = [sanitizeSnippet(row.title), sanitizeSnippet(row.overview)]
      .filter(Boolean)
      .join(' | ');
    pushExcerpt(state, sourceId, {
      kind: 'history',
      sessionRef: state.aliases.get(row.session_id) ?? sourceId.slice(2),
      templateId: plan.templateId,
      snippetId: `${sourceId}:checkpoint:${state.excerpts.length + 1}`,
    }, text || summary);
  }
  return state;
}

export function planHistoryQuery(request) {
  assert(request && typeof request === 'object' && !Array.isArray(request),
    'History request required');
  const { templateId, template } = resolvedTemplate(request);
  const built = template.buildQuery(request);
  const plan = {
    version: 1,
    templateId,
    description: template.description,
    source: built.source,
    lookbackDays: built.lookbackDays,
    limit: built.limit,
    repository: built.repository ?? null,
    refType: built.refType ?? null,
    refValue: built.refValue ?? null,
    pattern: built.pattern ?? null,
    sessionBindings: built.sessionBindings ?? [],
    query: built.query,
    queryHash: sha256(built.query),
  };
  validatePlanFilters(plan, templateId === 'turn-snippets' || templateId === 'prior-approach');
  return plan;
}

function buildPacketFromRows(request, plan, rows) {
  assert(Array.isArray(rows), 'History rows must be an array');
  const packetized = TEMPLATE_REGISTRY[plan.templateId].packetize(rows, plan);
  const createdAt = request.createdAt ?? new Date().toISOString();
  const expiresAt = request.expiresAt ?? new Date(Date.parse(createdAt) + 30 * 60 * 1000).toISOString();
  const scope = planScope(request, plan);
  const packet = buildFrozenEvidencePacket({
    workflowId: exactString(request.workflowId, 'workflowId'),
    promptHash: exactString(request.promptHash, 'promptHash'),
    questionBinding: request.questionBinding ?? normalizedQuestionBinding(request.question),
    mode: 'history',
    scope,
    repository: null,
    sourceCatalog: packetized.sourceEntries,
    excerpts: packetized.excerpts,
    createdAt,
    expiresAt,
    parentPacketHash: request.parentPacketHash ?? null,
    deltaFromPacketHash: request.deltaFromPacketHash ?? null,
  }, {
    overflowStrategy: 'trim',
  });
  return {
    packet,
    sessionBindings: [...packetized.aliases.entries()].slice(0, MAX_HISTORY_SESSIONS)
      .map(([sessionId, sessionRef]) => ({ sessionId, sessionRef })),
    rowCount: rows.length,
  };
}

export async function runHistoryQuery(request, executeQuery) {
  assert(typeof executeQuery === 'function',
    'History query execution function required');
  const plan = planHistoryQuery(request);
  const rows = await executeQuery({
    description: plan.description,
    query: plan.query,
    source: plan.source,
  });
  const { packet, sessionBindings, rowCount } = buildPacketFromRows(request, plan, rows);
  const receipt = createHistoryQueryReceipt({
    workflowId: packet.workflowId,
    promptHash: packet.promptHash,
    questionHash: packet.questionBinding.questionHash,
    scopeHash: packet.scopeHash,
    packetHash: packet.packetHash,
    templateId: plan.templateId,
    queryHash: plan.queryHash,
    source: plan.source,
    sessionBindings,
    parentReceiptHash: request.parentReceiptHash ?? null,
    deltaPacketHash: packet.deltaFromPacketHash,
    usageLineage: [{
      category: 'history-curation',
      usageHash: null,
      reservedCredits: 0,
      actualCredits: 0,
    }],
    createdAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  });
  return {
    version: 1,
    plan,
    rowCount,
    sessionBindings,
    packet,
    receipt,
  };
}

export function packetFromHistoryRows(request, rows) {
  const plan = planHistoryQuery(request);
  return buildPacketFromRows(request, plan, rows).packet;
}

export function validateHistoryPacket(packet) {
  const verified = validateFrozenEvidencePacket(packet);
  assert(verified.mode === 'history', 'History packet required');
  return verified;
}

if (process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, requestFile, rowsFile] = process.argv.slice(2);
    if (command === 'plan') {
      const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      console.log(JSON.stringify(planHistoryQuery(request), null, 2));
    } else if (command === 'run') {
      const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8'));
      console.log(JSON.stringify(await runHistoryQuery(request, async () => rows), null, 2));
    } else if (command === 'packet') {
      const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8'));
      console.log(JSON.stringify(packetFromHistoryRows(request, rows), null, 2));
    } else if (command === 'validate') {
      const packet = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      console.log(JSON.stringify(validateHistoryPacket(packet), null, 2));
    } else {
      throw new Error('Usage: history.mjs plan REQUEST.json | run REQUEST.json ROWS.json | packet REQUEST.json ROWS.json | validate PACKET.json');
    }
  } catch (error) {
    console.error(`history: ${error.message}`);
    process.exitCode = 1;
  }
}
