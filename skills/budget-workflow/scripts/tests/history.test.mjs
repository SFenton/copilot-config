import test from 'node:test';
import assert from 'node:assert/strict';

import {
  packetFromHistoryRows,
  planHistoryQuery,
  runHistoryQuery,
  validateHistoryPacket,
} from '../evidence/history.mjs';

const REQUEST = {
  workflowId: 'workflow-history',
  promptHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  question: 'Have I solved this before?',
};

test('history templates use bounded cloud queries with time filters and limits', () => {
  const plan = planHistoryQuery({
    ...REQUEST,
    templateId: 'recent-sessions',
    source: 'cloud',
  });
  assert.match(plan.query, /created_at > now\(\) - INTERVAL '7 days'/);
  assert.match(plan.query, /LIMIT 20/);
});

test('named session lookups stay bounded and use summary matching', () => {
  const plan = planHistoryQuery({
    ...REQUEST,
    templateId: 'named-session-lookup',
    source: 'cloud',
    sessionLabel: 'Optimize Vacuum UI Elements',
  });
  assert.match(plan.query, /updated_at > now\(\) - INTERVAL '30 days'/);
  assert.match(plan.query, /ILIKE '%Optimize Vacuum UI Elements%'/);
  assert.match(plan.query, /LIMIT 5/);
});

test('history local text scans use SQLite-safe filters and exact narrowing', () => {
  const plan = planHistoryQuery({
    ...REQUEST,
    templateId: 'prior-approach',
    source: 'local',
    repository: 'github.com/example/repo',
    pattern: 'validator',
    lookbackDays: 30,
  });
  assert.match(plan.query, /substr\(checkpoints\.created_at, 1, 10\) >= date\('now', '-30 days'\)/);
  assert.match(plan.query, /LIKE '%validator%'/);
  assert.doesNotMatch(plan.query, /ILIKE/);
});

test('history packets pseudonymize sessions and drop credential-like snippets', async () => {
  const result = await runHistoryQuery({
    ...REQUEST,
    templateId: 'turn-snippets',
    source: 'cloud',
    resolvedSessions: [{ sessionRef: 'hs_existing', sessionId: 'session-real-1' }],
  }, async () => [
    {
      session_id: 'session-real-1',
      turn_index: 1,
      user_message: 'explain validator',
      assistant_response: 'bearer sk-secret-value should never survive',
      timestamp: new Date().toISOString(),
    },
    {
      session_id: 'session-real-1',
      turn_index: 2,
      user_message: 'show summary',
      assistant_response: 'the validator rejects unknown fields',
      timestamp: new Date().toISOString(),
    },
  ]);
  const packet = validateHistoryPacket(result.packet);
  assert.equal(packet.mode, 'history');
  assert.equal(packet.sourceCatalog[0].sessionRef, 'hs_existing');
  assert.ok(packet.excerpts.every(excerpt => !excerpt.text.includes('session-real-1')));
  assert.ok(packet.excerpts.every(excerpt => !excerpt.text.includes('sk-secret-value')));
  assert.equal(result.receipt.sessionBindings[0].sessionId, 'session-real-1');
});

test('history bounds keep snippets small and packetize deterministic session aliases', () => {
  const rows = Array.from({ length: 15 }, (_, index) => ({
    session_id: `session-${index}`,
    turn_index: index + 1,
    user_message: 'x'.repeat(700),
    assistant_response: `answer ${index}`,
    timestamp: new Date().toISOString(),
  }));
  const packet = packetFromHistoryRows({
    ...REQUEST,
    templateId: 'turn-snippets',
    source: 'cloud',
    resolvedSessions: rows.map((row, index) => ({
      sessionRef: `alias-${index}`,
      sessionId: row.session_id,
    })),
  }, rows);
  assert.equal(packet.excerpts.length, 10);
  assert.ok(packet.excerpts.every(excerpt => excerpt.text.length <= 500));
  assert.ok(packet.sourceCatalog.every(source => source.sessionRef.startsWith('alias-')));
});
