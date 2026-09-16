import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFrozenEvidencePacket,
  sha256,
} from '../evidence/schemas.mjs';
import { createDispatchManifest } from '../routing-enforcement.mjs';
import { createIntentAcceptanceDispatchReceipt, buildIntentAcceptancePacket, createIntentRequirementsManifest, INTENT_ACCEPTANCE_ROLE } from '../intent-acceptance.mjs';
import {
  invocation,
  verifyFrozenEvidencePacket,
} from '../run-leaf.mjs';
import { resolvedToolTelemetry } from '../workflow.mjs';

function packet(overrides = {}) {
  const createdAt = overrides.createdAt ?? new Date().toISOString();
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
  return buildFrozenEvidencePacket({
    workflowId: 'workflow-1',
    promptHash: sha256('prompt'),
    question: 'What does the validator do?',
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
      text: '1: validator rejects unknown keys',
      textHash: sha256('1: validator rejects unknown keys'),
    }],
    createdAt,
    expiresAt,
  });
}

function intentPacket(overrides = {}) {
  const requirementsManifest = createIntentRequirementsManifest({
    workflowId: 'workflow-1',
    sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    promptHash: sha256('prompt'),
    captureSource: 'session-routing-state',
    capturePhase: 'pre-implementation',
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
    scope: ['api', 'ui'],
    requirements: [
      {
        id: 'must-show-error',
        exactText: 'Show the invalid-save error.',
        displayText: 'Show the invalid-save error.',
        priority: 'must',
        acceptance: 'The invalid save path shows the requested error.',
        successCondition: true,
      },
      {
        id: 'must-preserve-success',
        exactText: 'Preserve the successful save path.',
        displayText: 'Preserve the successful save path.',
        priority: 'must',
        acceptance: 'The success path still works.',
        successCondition: true,
      },
    ],
    exclusions: [],
    nonGoals: [],
  });
  return buildIntentAcceptancePacket({
    requirementsManifest,
    policyVersion: 'intent-acceptance-policy-v1',
    selectedProfile: { model: 'gpt-5.4', effort: 'medium', context: 'default' },
    selectedModelSource: 'session-routing-state',
    implementationRefs: [{ id: 'impl', kind: 'code', label: 'Accepted implementation' }],
    evidenceRefs: [{ id: 'unit-tests', kind: 'test', summary: 'Targeted tests pass' }],
    reviewRefs: [{ id: 'review-accepted', kind: 'review-acceptance', summary: 'Review accepted' }],
    coverageMatrix: [
      {
        requirementId: 'must-show-error',
        implementationIds: ['impl'],
        evidenceIds: ['unit-tests'],
        summary: 'Covered.',
      },
      {
        requirementId: 'must-preserve-success',
        implementationIds: ['impl'],
        evidenceIds: ['unit-tests'],
        summary: 'Covered.',
      },
    ],
    changeSummary: 'Add invalid-save feedback.',
    reviewAcceptance: {
      role: 'independent-gpt-5.4-review',
      reviewerProfile: { model: 'gpt-5.4', effort: 'medium', context: 'default' },
      acceptanceRefId: 'review-accepted',
      resolvedFindingRefIds: [],
    },
    knownLimitations: [],
    baseRevision: 'a'.repeat(40),
    baseTreeHash: 'b'.repeat(40),
    acceptedRevision: 'c'.repeat(40),
    acceptedTreeHash: 'd'.repeat(40),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  });
}

test('reason-only invocation exposes no usable research or broker tools', () => {
  const evidencePacket = packet();
  const args = invocation({
    prompt: `Reason only.\nPacket hash: ${evidencePacket.packetHash}\nPacket: ${JSON.stringify(evidencePacket)}`,
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
    toolMode: 'reason-only',
    evidencePacket,
    sanitized: true,
    maxCredits: 30,
    timeoutSeconds: 60,
  }, '/tmp/run-leaf-test');
  const availableIndex = args.indexOf('--available-tools');
  assert.ok(availableIndex >= 0);
  assert.deepEqual(args.slice(availableIndex + 1, availableIndex + 2), ['fetch_copilot_cli_documentation']);
  assert.ok(args.includes('--deny-tool=fetch_copilot_cli_documentation'));
  assert.ok(!args.includes('view'));
  assert.ok(!args.includes('rg'));
  assert.ok(!args.includes('budget_evidence'));
});

test('tampering with a frozen packet fails hash verification', () => {
  const evidencePacket = packet();
  assert.equal(verifyFrozenEvidencePacket(evidencePacket).packetHash, evidencePacket.packetHash);
  assert.throws(() => verifyFrozenEvidencePacket({
    ...evidencePacket,
    excerpts: [{
      ...evidencePacket.excerpts[0],
      text: 'tampered',
    }],
  }), /hash mismatch|text hash mismatch/);
});

test('reason-only invocation rejects stale frozen packets before launch', () => {
  const evidencePacket = packet({
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.throws(() => invocation({
    prompt: `Reason only.\nPacket hash: ${evidencePacket.packetHash}\nPacket: ${JSON.stringify(evidencePacket)}`,
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
    toolMode: 'reason-only',
    evidencePacket,
    sanitized: true,
    maxCredits: 30,
    timeoutSeconds: 60,
  }, '/tmp/run-leaf-test'), /non-stale frozen evidence packet/);
});

test('intent-acceptance reason-only invocation stays tool-free with explicit selected profile', () => {
  const evidencePacket = intentPacket();
  const dispatchReceipt = createIntentAcceptanceDispatchReceipt({
    packet: evidencePacket,
    profile: { model: 'gpt-5.4', effort: 'medium', context: 'default' },
    attempt: 1,
    createdAt: evidencePacket.createdAt,
    expiresAt: evidencePacket.expiresAt,
  });
  const dispatchManifest = createDispatchManifest({
    sessionId: evidencePacket.sessionId,
    workflowId: evidencePacket.workflowId,
    promptHash: evidencePacket.promptHash,
    project: 'personal-budget-workflow',
    scope: evidencePacket.requirementsManifest.scope,
    role: INTENT_ACCEPTANCE_ROLE,
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: [],
    validations: ['strict-json-output'],
    evidencePacketHash: evidencePacket.packetHash,
    receiptHash: dispatchReceipt.receiptHash,
    researchAuthorized: false,
    intentAcceptanceAuthorized: true,
    intent: { packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'user-intent-acceptance' },
  });
  const args = invocation({
    prompt: `Packet hash: ${evidencePacket.packetHash}\nPacket: ${JSON.stringify(evidencePacket)}`,
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
    toolMode: 'reason-only',
    evidencePacket,
    dispatchManifest,
    intentAcceptanceDispatchReceipt: dispatchReceipt,
    sanitized: true,
    maxCredits: 30,
    timeoutSeconds: 60,
  }, '/tmp/run-leaf-test');
  const availableIndex = args.indexOf('--available-tools');
  assert.ok(availableIndex >= 0);
  assert.deepEqual(args.slice(availableIndex + 1, availableIndex + 2), ['fetch_copilot_cli_documentation']);
  assert.ok(args.includes('--deny-tool=fetch_copilot_cli_documentation'));
});

test('reason-only isolation requires exact current CLI telemetry and rejects missing tool evidence', () => {
  assert.throws(() => resolvedToolTelemetry([{
    type: 'subagent.configured',
    data: {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
      contextTier: 'default',
    },
  }], 'gpt-5.4'), /session\.tools_updated/);
  assert.throws(() => resolvedToolTelemetry([
    {
      type: 'session.tools_updated',
      data: {
        tools: [{ name: 'fetch_copilot_cli_documentation' }],
      },
    },
    {
      type: 'session.usage_checkpoint',
      data: {
        promptCacheBreakState: [],
      },
    },
  ], 'gpt-5.4'), /promptCacheBreakState/);
});
