#!/usr/bin/env node
import {
  PACKET_LIMITS,
  REASON_ONLY_TOOL_MODE,
  buildDeltaPacket,
  createFrontierDispatchReceipt,
  createTandemPairReceipt,
  normalizedQuestionBinding,
  sha256,
  validateEvidencePacketReceipt,
  validateFrozenEvidencePacket,
  validateReasonOnlyResearchResult,
  validateTandemPairReceipt,
} from '../../budget-workflow/scripts/evidence/schemas.mjs';

const STANDARD_PRIMARY_PROFILE = Object.freeze({
  model: 'gpt-5.6-sol',
  effort: 'max',
  context: 'default',
});

const STANDARD_SECONDARY_PROFILE = Object.freeze({
  model: 'gpt-6-astra',
  effort: 'medium',
  context: 'default',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeFindingKey(finding) {
  return String(finding.summary ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function classification(primary, secondary) {
  if (primary && secondary) {
    return normalizeFindingKey(primary) === normalizeFindingKey(secondary)
      ? 'agreed and verified'
      : 'disputed interpretation';
  }
  if (primary || secondary) return 'unique high-value finding';
  return 'unknown / needs probe';
}

function standardProfiles(options = {}) {
  assert(options.maxLongTriggerReceiptHash === undefined ||
    options.maxLongTriggerReceiptHash === null,
  'Tandem context remains explicitly pinned; trigger-only max/long escalation is not qualified');
  return {
    primary: STANDARD_PRIMARY_PROFILE,
    secondary: STANDARD_SECONDARY_PROFILE,
  };
}

export function createPacketOnlyTandemDispatches(input) {
  const packet = validateFrozenEvidencePacket(input.packet);
  const packetReceipt = validateEvidencePacketReceipt(input.packetReceipt);
  assert(packetReceipt.packetHash === packet.packetHash,
    'Packet receipt hash does not match the packet');
  const questionBinding = input.questionBinding
    ? normalizedQuestionBinding(input.questionBinding.normalized ?? input.question)
    : packet.questionBinding;
  assert(questionBinding.questionHash === packet.questionBinding.questionHash,
    'Question binding does not match the packet');
  const createdAt = input.createdAt ?? packet.createdAt;
  const expiresAt = input.expiresAt ?? packet.expiresAt;
  const profiles = standardProfiles(input);
  const primaryDispatch = createFrontierDispatchReceipt({
    workflowId: packet.workflowId,
    promptHash: packet.promptHash,
    questionHash: packet.questionBinding.questionHash,
    mode: packet.mode,
    scopeHash: packet.scopeHash,
    packetHash: packet.packetHash,
    role: 'frontier-research',
    profile: profiles.primary,
    evidencePacketReceiptHash: packetReceipt.receiptHash,
    tandemPairReceiptHash: null,
    parentReceiptHash: input.parentReceiptHash ?? packetReceipt.receiptHash,
    deltaPacketHash: packet.deltaFromPacketHash,
    usageLineage: [{
      category: 'sol-research',
      usageHash: null,
      reservedCredits: input.primaryReservedCredits ?? 0,
      actualCredits: null,
    }],
    createdAt,
    expiresAt,
  });
  const secondaryDispatch = createFrontierDispatchReceipt({
    workflowId: packet.workflowId,
    promptHash: packet.promptHash,
    questionHash: packet.questionBinding.questionHash,
    mode: packet.mode,
    scopeHash: packet.scopeHash,
    packetHash: packet.packetHash,
    role: 'tandem-secondary-research',
    profile: profiles.secondary,
    evidencePacketReceiptHash: packetReceipt.receiptHash,
    tandemPairReceiptHash: null,
    parentReceiptHash: primaryDispatch.receiptHash,
    deltaPacketHash: packet.deltaFromPacketHash,
    usageLineage: [{
      category: 'astra-research',
      usageHash: null,
      reservedCredits: input.secondaryReservedCredits ?? 0,
      actualCredits: null,
    }],
    createdAt,
    expiresAt,
  });
  const pairReceipt = createTandemPairReceipt({
    workflowId: packet.workflowId,
    promptHash: packet.promptHash,
    questionHash: packet.questionBinding.questionHash,
    mode: packet.mode,
    scopeHash: packet.scopeHash,
    packetHash: packet.packetHash,
    primaryProfile: profiles.primary,
    secondaryProfile: profiles.secondary,
    primaryDispatchReceiptHash: primaryDispatch.receiptHash,
    secondaryDispatchReceiptHash: secondaryDispatch.receiptHash,
    gapLoops: 0,
    comparisonMatrixHash: null,
    adjudicationDispatchReceiptHash: null,
    createdAt,
    expiresAt,
  });
  return {
    packetHash: packet.packetHash,
    toolMode: REASON_ONLY_TOOL_MODE,
    primaryDispatch,
    secondaryDispatch,
    pairReceipt,
  };
}

export function buildComparisonMatrix(primaryResult, secondaryResult, packet) {
  const verifiedPacket = validateFrozenEvidencePacket(packet);
  const primary = validateReasonOnlyResearchResult(primaryResult, verifiedPacket);
  const secondary = validateReasonOnlyResearchResult(secondaryResult, verifiedPacket);
  const primaryFindings = primary.kind === 'evidence-gap-request' ? [] : primary.findings ?? [];
  const secondaryFindings = secondary.kind === 'evidence-gap-request' ? [] : secondary.findings ?? [];
  const byKey = new Map();
  for (const finding of primaryFindings) {
    byKey.set(normalizeFindingKey(finding), {
      key: normalizeFindingKey(finding),
      primaryFinding: finding,
      secondaryFinding: null,
    });
  }
  for (const finding of secondaryFindings) {
    const key = normalizeFindingKey(finding);
    const current = byKey.get(key) ?? {
      key,
      primaryFinding: null,
      secondaryFinding: null,
    };
    current.secondaryFinding = finding;
    byKey.set(key, current);
  }
  const rows = [...byKey.values()].map(entry => ({
    claim: entry.key,
    primaryFindingId: entry.primaryFinding?.id ?? null,
    primaryCitations: entry.primaryFinding?.citations ?? [],
    secondaryFindingId: entry.secondaryFinding?.id ?? null,
    secondaryCitations: entry.secondaryFinding?.citations ?? [],
    agreement: entry.primaryFinding && entry.secondaryFinding,
    confidence: entry.primaryFinding?.confidence ?? entry.secondaryFinding?.confidence ?? 'low',
    classification: classification(entry.primaryFinding, entry.secondaryFinding),
    adjudicationNeeded: entry.primaryFinding === null ||
      entry.secondaryFinding === null ||
      normalizeFindingKey(entry.primaryFinding) !== normalizeFindingKey(entry.secondaryFinding),
  }));
  return {
    version: 1,
    packetHash: verifiedPacket.packetHash,
    rows: rows.sort((a, b) => a.claim.localeCompare(b.claim)),
    matrixHash: sha256(rows),
  };
}

function gapKey(request) {
  return JSON.stringify([
    request.mode,
    request.query ?? null,
    request.path ?? null,
    request.focus ?? null,
    request.template ?? null,
    request.maxBytes,
  ]);
}

export function mergeEvidenceGapRequests(primaryGap, secondaryGap, packet, loopIndex) {
  const verifiedPacket = validateFrozenEvidencePacket(packet);
  const primary = validateReasonOnlyResearchResult(primaryGap, verifiedPacket, {
    expectedKind: 'evidence-gap-request',
  });
  const secondary = validateReasonOnlyResearchResult(secondaryGap, verifiedPacket, {
    expectedKind: 'evidence-gap-request',
  });
  assert(loopIndex >= 1 && loopIndex <= PACKET_LIMITS.maxGapLoops,
    'Gap loop index is invalid');
  assert(primary.loop === loopIndex && secondary.loop === loopIndex,
    'Gap loop mismatch');
  const merged = [];
  const seen = new Set();
  for (const request of [...primary.requests, ...secondary.requests]) {
    const key = gapKey(request);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(request);
  }
  assert(merged.length <= PACKET_LIMITS.maxGapRequests,
    'Merged evidence gap requests exceed the bounded loop limit');
  return {
    version: 1,
    packetHash: verifiedPacket.packetHash,
    loop: loopIndex,
    expectedDecisionImpact: primary.expectedDecisionImpact,
    requests: merged,
    requestHash: sha256(merged),
  };
}

export function buildIdenticalDeltaPacket(parentPacket, additions, currentLoop) {
  assert(currentLoop >= 0 && currentLoop < PACKET_LIMITS.maxGapLoops,
    'Gap loop budget exhausted');
  return buildDeltaPacket(parentPacket, additions, {
    overflowStrategy: 'trim',
  });
}

export function planAdjudication(input) {
  const packet = validateFrozenEvidencePacket(input.packet);
  const matrix = buildComparisonMatrix(input.primaryResult, input.secondaryResult, packet);
  const pair = validateTandemPairReceipt(input.pairReceipt);
  assert(pair.packetHash === packet.packetHash, 'Pair receipt packet mismatch');
  return {
    version: 1,
    packetHash: packet.packetHash,
    matrix,
    adjudicationDispatch: createFrontierDispatchReceipt({
      workflowId: packet.workflowId,
      promptHash: packet.promptHash,
      questionHash: packet.questionBinding.questionHash,
      mode: packet.mode,
      scopeHash: packet.scopeHash,
      packetHash: packet.packetHash,
      role: 'frontier-adjudication',
      profile: STANDARD_PRIMARY_PROFILE,
      evidencePacketReceiptHash: input.packetReceiptHash,
      tandemPairReceiptHash: pair.receiptHash,
      parentReceiptHash: pair.receiptHash,
      deltaPacketHash: packet.deltaFromPacketHash,
      usageLineage: [{
        category: 'research-adjudication',
        usageHash: null,
        reservedCredits: input.reservedCredits ?? 0,
        actualCredits: null,
      }],
      createdAt: packet.createdAt,
      expiresAt: packet.expiresAt,
    }),
  };
}
