import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PACKET_LIMITS,
  buildDeltaPacket,
  buildFrozenEvidencePacket,
  createEvidencePacketReceipt,
  createFrontierDispatchReceipt,
  createTandemPairReceipt,
  validateEvidencePacketReceipt,
  validateFrontierDispatchReceipt,
  validateFrozenEvidencePacket,
  validateReasonOnlyResearchResult,
  validateTandemPairReceipt,
  sha256,
} from '../evidence/schemas.mjs';

function makeRepositoryPacketInput(extra = {}) {
  return {
    workflowId: 'workflow-1',
    promptHash: sha256('prompt'),
    question: 'How should the validator behave?',
    mode: 'repository',
    scope: ['api', 'tests'],
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
      end: 2,
      sha256: sha256('line one\nline two\n'),
      openedAt: new Date().toISOString(),
      completeUnit: true,
    }],
    excerpts: [{
      sourceId: 'r_api',
      citation: {
        kind: 'repository',
        path: 'api/example.ts',
        start: 1,
        end: 2,
      },
      text: '1: line one\n2: line two',
      textHash: sha256('1: line one\n2: line two'),
    }],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  };
}

test('frozen packets dedupe deterministically and bind receipts', () => {
  const input = makeRepositoryPacketInput({
    sourceCatalog: [
      ...makeRepositoryPacketInput().sourceCatalog,
      ...makeRepositoryPacketInput().sourceCatalog,
    ],
    excerpts: [
      ...makeRepositoryPacketInput().excerpts,
      ...makeRepositoryPacketInput().excerpts,
    ],
  });
  const packet = buildFrozenEvidencePacket(input, { overflowStrategy: 'trim' });
  assert.equal(packet.sourceCatalog.length, 1);
  assert.equal(packet.excerpts.length, 1);
  assert.equal(packet.compaction.dedupedSources, 1);
  assert.equal(packet.compaction.dedupedExcerpts, 1);
  const receipt = createEvidencePacketReceipt(packet);
  assert.equal(validateEvidencePacketReceipt(receipt).packetHash, packet.packetHash);
});

test('packets fail closed when excerpt text budget exceeds the cap', () => {
  const oversizedText = 'x'.repeat(PACKET_LIMITS.maxExcerptTextBytes + 1);
  assert.throws(() => buildFrozenEvidencePacket(makeRepositoryPacketInput({
    excerpts: [{
      sourceId: 'r_api',
      citation: {
        kind: 'repository',
        path: 'api/example.ts',
        start: 1,
        end: 1,
      },
      text: oversizedText,
      textHash: sha256(oversizedText),
    }],
  }), {
    overflowStrategy: 'fail',
  }), /1500|narrow the evidence set/);
});

test('reason-only results reject unsupported citations', () => {
  const packet = buildFrozenEvidencePacket(makeRepositoryPacketInput());
  const valid = validateReasonOnlyResearchResult({
    version: 2,
    kind: 'findings',
    packetHash: packet.packetHash,
    findings: [{
      id: 'finding-1',
      summary: 'The validator rejects invalid keys.',
      confidence: 'high',
      citations: [{ sourceId: 'r_api', quote: 'line one' }],
    }],
    remainingUncertainty: [],
  }, packet);
  assert.equal(valid.kind, 'findings');

  assert.throws(() => validateReasonOnlyResearchResult({
    version: 2,
    kind: 'findings',
    packetHash: packet.packetHash,
    findings: [{
      id: 'finding-2',
      summary: 'Unsupported citation.',
      confidence: 'high',
      citations: [{ sourceId: 'missing', quote: 'oops' }],
    }],
    remainingUncertainty: [],
  }, packet), /Unsupported citation sourceId/);
});

test('delta packets stay bounded and point at the parent hash', () => {
  const parent = buildFrozenEvidencePacket(makeRepositoryPacketInput());
  const delta = buildDeltaPacket(parent, {
    sourceCatalog: [{
      id: 'r_tests',
      kind: 'repository',
      path: 'tests/example.test.ts',
      start: 1,
      end: 1,
      sha256: sha256('expect(true).toBe(true);\n'),
      openedAt: new Date().toISOString(),
      completeUnit: true,
    }],
    excerpts: [{
      sourceId: 'r_tests',
      citation: {
        kind: 'repository',
        path: 'tests/example.test.ts',
        start: 1,
        end: 1,
      },
      text: '1: expect(true).toBe(true);',
      textHash: sha256('1: expect(true).toBe(true);'),
    }],
    createdAt: new Date().toISOString(),
    expiresAt: parent.expiresAt,
  });
  assert.equal(validateFrozenEvidencePacket(delta).parentPacketHash, parent.packetHash);
  assert.ok(delta.serializedBytes <= PACKET_LIMITS.maxDeltaPacketBytes);
});

test('frontier and tandem receipts reject stale Opus or wrong-effort profile pins', () => {
  const packet = buildFrozenEvidencePacket(makeRepositoryPacketInput());
  const packetReceipt = createEvidencePacketReceipt(packet);
  assert.throws(() => createFrontierDispatchReceipt({
    workflowId: packet.workflowId,
    promptHash: packet.promptHash,
    questionHash: packet.questionBinding.questionHash,
    mode: packet.mode,
    scopeHash: packet.scopeHash,
    packetHash: packet.packetHash,
    role: 'frontier-research',
    profile: { model: 'claude-opus-5', effort: 'medium', context: 'default' },
    evidencePacketReceiptHash: packetReceipt.receiptHash,
    createdAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  }), /must use gpt-5\.6-sol\/max\/default/);

  const validFrontier = createFrontierDispatchReceipt({
    workflowId: packet.workflowId,
    promptHash: packet.promptHash,
    questionHash: packet.questionBinding.questionHash,
    mode: packet.mode,
    scopeHash: packet.scopeHash,
    packetHash: packet.packetHash,
    role: 'frontier-research',
    profile: { model: 'gpt-5.6-sol', effort: 'max', context: 'default' },
    evidencePacketReceiptHash: packetReceipt.receiptHash,
    createdAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  });
  const tamperedFrontier = {
    ...validFrontier,
    profile: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
  };
  tamperedFrontier.receiptHash = sha256(Object.fromEntries(
    Object.entries(tamperedFrontier).filter(([key]) => key !== 'receiptHash'),
  ));
  assert.throws(() => validateFrontierDispatchReceipt(tamperedFrontier),
    /must use gpt-5\.6-sol\/max\/default/);

  assert.throws(() => createTandemPairReceipt({
    workflowId: packet.workflowId,
    promptHash: packet.promptHash,
    questionHash: packet.questionBinding.questionHash,
    mode: packet.mode,
    scopeHash: packet.scopeHash,
    packetHash: packet.packetHash,
    primaryProfile: { model: 'gpt-5.6-sol', effort: 'max', context: 'default' },
    secondaryProfile: { model: 'gpt-6-astra', effort: 'high', context: 'default' },
    primaryDispatchReceiptHash: validFrontier.receiptHash,
    secondaryDispatchReceiptHash: 'b'.repeat(64),
    gapLoops: 0,
    createdAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  }), /must use gpt-6-astra\/medium\/default/);

  const validPair = createTandemPairReceipt({
    workflowId: packet.workflowId,
    promptHash: packet.promptHash,
    questionHash: packet.questionBinding.questionHash,
    mode: packet.mode,
    scopeHash: packet.scopeHash,
    packetHash: packet.packetHash,
    primaryProfile: { model: 'gpt-5.6-sol', effort: 'max', context: 'default' },
    secondaryProfile: { model: 'gpt-6-astra', effort: 'medium', context: 'default' },
    primaryDispatchReceiptHash: validFrontier.receiptHash,
    secondaryDispatchReceiptHash: 'b'.repeat(64),
    gapLoops: 0,
    createdAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  });
  const tamperedPair = {
    ...validPair,
    secondaryProfile: { model: 'claude-opus-5', effort: 'medium', context: 'default' },
  };
  tamperedPair.receiptHash = sha256(Object.fromEntries(
    Object.entries(tamperedPair).filter(([key]) => key !== 'receiptHash'),
  ));
  assert.throws(() => validateTandemPairReceipt(tamperedPair),
    /must use gpt-6-astra\/medium\/default/);
});
