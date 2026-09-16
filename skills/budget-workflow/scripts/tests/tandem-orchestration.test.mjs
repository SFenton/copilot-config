import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFrozenEvidencePacket,
  createEvidencePacketReceipt,
  createTandemPairReceipt,
  validateTandemPairReceipt,
  sha256,
} from '../evidence/schemas.mjs';
import {
  buildComparisonMatrix,
  buildIdenticalDeltaPacket,
  createPacketOnlyTandemDispatches,
  mergeEvidenceGapRequests,
  planAdjudication,
} from '../../../tandem-research/scripts/orchestration.mjs';

function packet() {
  return buildFrozenEvidencePacket({
    workflowId: 'workflow-1',
    promptHash: sha256('prompt'),
    question: 'Should the validator reject unknown fields?',
    mode: 'repository',
    scope: ['api'],
    repository: {
      root: '/tmp/repo',
      baseRevision: 'abc123',
      policyHash: sha256('policy'),
    },
    sourceCatalog: [{
      id: 'r_api',
      kind: 'repository',
      path: 'api/example.ts',
      start: 1,
      end: 1,
      sha256: sha256('line\n'),
      openedAt: new Date().toISOString(),
      completeUnit: true,
    }],
    excerpts: [{
      sourceId: 'r_api',
      citation: { kind: 'repository', path: 'api/example.ts', start: 1, end: 1 },
      text: '1: validator rejects unknown fields',
      textHash: sha256('1: validator rejects unknown fields'),
    }],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

function findings(packetHash, summary = 'Validator rejects unknown fields') {
  return {
    version: 2,
    kind: 'findings',
    packetHash,
    findings: [{
      id: 'finding-1',
      summary,
      confidence: 'high',
      citations: [{ sourceId: 'r_api', quote: 'rejects unknown fields' }],
    }],
    remainingUncertainty: [],
  };
}

test('packet-only tandem dispatches bind the identical packet hash', () => {
  const evidencePacket = packet();
  const packetReceipt = createEvidencePacketReceipt(evidencePacket);
  const dispatches = createPacketOnlyTandemDispatches({
    packet: evidencePacket,
    packetReceipt,
    createdAt: evidencePacket.createdAt,
    expiresAt: evidencePacket.expiresAt,
  });
  assert.equal(dispatches.primaryDispatch.packetHash, evidencePacket.packetHash);
  assert.equal(dispatches.secondaryDispatch.packetHash, evidencePacket.packetHash);
  assert.equal(dispatches.primaryDispatch.profile.model, 'gpt-5.6-sol');
  assert.equal(dispatches.primaryDispatch.profile.effort, 'max');
  assert.equal(dispatches.primaryDispatch.profile.context, 'default');
  assert.equal(dispatches.secondaryDispatch.role, 'tandem-secondary-research');
  assert.equal(dispatches.secondaryDispatch.profile.model, 'gpt-6-astra');
  assert.equal(dispatches.secondaryDispatch.profile.effort, 'medium');
  assert.equal(dispatches.secondaryDispatch.profile.context, 'default');
  assert.equal(dispatches.pairReceipt.secondaryRole, 'tandem-secondary-research');
  assert.equal(dispatches.pairReceipt.packetHash, evidencePacket.packetHash);
});

test('tandem orchestration rejects stale long-context escalation and stale Opus role ids', () => {
  const evidencePacket = packet();
  const packetReceipt = createEvidencePacketReceipt(evidencePacket);
  assert.throws(() => createPacketOnlyTandemDispatches({
    packet: evidencePacket,
    packetReceipt,
    maxLongTriggerReceiptHash: sha256('trigger'),
    createdAt: evidencePacket.createdAt,
    expiresAt: evidencePacket.expiresAt,
  }), /context remains explicitly pinned|not qualified/);
  const dispatches = createPacketOnlyTandemDispatches({
    packet: evidencePacket,
    packetReceipt,
    createdAt: evidencePacket.createdAt,
    expiresAt: evidencePacket.expiresAt,
  });
  const stalePairReceipt = {
    ...dispatches.pairReceipt,
    secondaryRole: 'tandem-opus-research',
  };
  stalePairReceipt.receiptHash = sha256(Object.fromEntries(
    Object.entries(stalePairReceipt).filter(([key]) => key !== 'receiptHash'),
  ));
  assert.throws(() => validateTandemPairReceipt(stalePairReceipt));
});

test('comparison matrix classifies agreement and disputes deterministically', () => {
  const evidencePacket = packet();
  const matrix = buildComparisonMatrix(
    findings(evidencePacket.packetHash),
    findings(evidencePacket.packetHash, 'Validator accepts unknown fields'),
    evidencePacket,
  );
  assert.equal(matrix.rows.length, 2);
  assert.ok(matrix.rows.some(row => row.classification === 'unique high-value finding'));
});

test('merged evidence gap requests dedupe exact requests and cap loop count', () => {
  const evidencePacket = packet();
  const gap = {
    version: 2,
    kind: 'evidence-gap-request',
    packetHash: evidencePacket.packetHash,
    loop: 1,
    expectedDecisionImpact: 'resolve dispute',
    requests: [{
      mode: 'repository',
      path: 'api/example.ts',
      focus: 'validator behavior',
      maxBytes: 4096,
    }],
  };
  const merged = mergeEvidenceGapRequests(gap, gap, evidencePacket, 1);
  assert.equal(merged.requests.length, 1);
  assert.throws(() => mergeEvidenceGapRequests(
    { ...gap, loop: 3 },
    { ...gap, loop: 3 },
    evidencePacket,
    3,
  ), /loop|Gap loop/);
});

test('delta packets and adjudication remain packet-only', () => {
  const evidencePacket = packet();
  const packetReceipt = createEvidencePacketReceipt(evidencePacket);
  const dispatches = createPacketOnlyTandemDispatches({
    packet: evidencePacket,
    packetReceipt,
    createdAt: evidencePacket.createdAt,
    expiresAt: evidencePacket.expiresAt,
  });
  const pairReceipt = createTandemPairReceipt({
    workflowId: evidencePacket.workflowId,
    promptHash: evidencePacket.promptHash,
    questionHash: evidencePacket.questionBinding.questionHash,
    mode: evidencePacket.mode,
    scopeHash: evidencePacket.scopeHash,
    packetHash: evidencePacket.packetHash,
    primaryProfile: { model: 'gpt-5.6-sol', effort: 'max', context: 'default' },
    secondaryProfile: { model: 'gpt-6-astra', effort: 'medium', context: 'default' },
    primaryDispatchReceiptHash: dispatches.primaryDispatch.receiptHash,
    secondaryDispatchReceiptHash: dispatches.secondaryDispatch.receiptHash,
    gapLoops: 0,
    createdAt: evidencePacket.createdAt,
    expiresAt: evidencePacket.expiresAt,
  });
  const delta = buildIdenticalDeltaPacket(evidencePacket, {
    sourceCatalog: [{
      id: 'r_tests',
      kind: 'repository',
      path: 'tests/example.test.ts',
      start: 1,
      end: 1,
      sha256: sha256('test\n'),
      openedAt: new Date().toISOString(),
      completeUnit: true,
    }],
    excerpts: [{
      sourceId: 'r_tests',
      citation: { kind: 'repository', path: 'tests/example.test.ts', start: 1, end: 1 },
      text: '1: new test evidence',
      textHash: sha256('1: new test evidence'),
    }],
  }, 0);
  assert.equal(delta.parentPacketHash, evidencePacket.packetHash);
  const adjudication = planAdjudication({
    packet: evidencePacket,
    pairReceipt,
    packetReceiptHash: packetReceipt.receiptHash,
    primaryResult: findings(evidencePacket.packetHash),
    secondaryResult: findings(evidencePacket.packetHash),
  });
  assert.equal(adjudication.adjudicationDispatch.profile.model, 'gpt-5.6-sol');
  assert.equal(adjudication.adjudicationDispatch.profile.effort, 'max');
  assert.equal(adjudication.adjudicationDispatch.profile.context, 'default');
  assert.equal(adjudication.adjudicationDispatch.toolMode, 'reason-only');

  const tamperedPair = {
    ...pairReceipt,
    secondaryProfile: { model: 'claude-opus-5', effort: 'medium', context: 'default' },
  };
  tamperedPair.receiptHash = sha256(Object.fromEntries(
    Object.entries(tamperedPair).filter(([key]) => key !== 'receiptHash'),
  ));
  assert.throws(() => planAdjudication({
    packet: evidencePacket,
    pairReceipt: tamperedPair,
    packetReceiptHash: packetReceipt.receiptHash,
    primaryResult: findings(evidencePacket.packetHash),
    secondaryResult: findings(evidencePacket.packetHash),
  }), /must use gpt-6-astra\/medium\/default/);
});
