import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authorizeIntentAcceptanceReceipt,
  createBoundReasonOnlyLeafRequest,
  createDispatchManifest,
  hookDecision,
  promptStartState,
} from '../routing-enforcement.mjs';
import { resolvedConfiguration, SUPPORTED_MODEL_IDS, SUPPORTED_MODELS } from '../workflow.mjs';
import {
  INTENT_ACCEPTANCE_GAP_RECEIPT_KIND,
  INTENT_ACCEPTANCE_RECEIPT_KIND,
  INTENT_ACCEPTANCE_ROLE,
  buildIntentAcceptancePacket,
  createIntentAcceptanceOutcomeReceipt,
  createIntentRequirementsManifest,
  evaluateIntentAcceptanceEligibility,
  evaluateIntentAcceptanceGate,
  validateIntentAcceptanceOutcomeReceipt,
  validateIntentAcceptancePacket,
  validateIntentAcceptanceResult,
} from '../intent-acceptance.mjs';
import { sha256 } from '../evidence/schemas.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const SCRIPT_DIR = path.dirname(fileURLToPath(new URL('../routing-enforcement.mjs', import.meta.url)));
const RUN_LEAF_SCRIPT = path.join(SCRIPT_DIR, 'run-leaf.mjs');
const OPPORTUNITIES_SCRIPT = path.join(SCRIPT_DIR, 'opportunities.mjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSessionEvents(home, sessionId, model, effort = 'medium', context = 'default') {
  const file = path.join(home, 'session-state', sessionId, 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'session.start',
    data: {
      sessionId,
      selectedModel: model,
      reasoningEffort: effort,
      contextTier: context,
    },
  })}\n`);
}

function setupIntentSession({
  model = 'gpt-5.4',
  effort = 'medium',
  context = 'default',
  prompt = 'intent gate',
  sessionId = '77777777-7777-4777-8777-777777777777',
} = {}) {
  const home = makeTempDir('intent-home-');
  writeSessionEvents(home, sessionId, model, effort, context);
  const state = promptStartState({ sessionId, prompt }, { home });
  return { home, sessionId, state };
}

function makeIntentManifest(overrides = {}) {
  const workflowId = overrides.workflowId ?? 'workflow-intent';
  const sessionId = overrides.sessionId ?? '77777777-7777-4777-8777-777777777777';
  const promptHash = overrides.promptHash ?? sha256('user prompt');
  return createIntentRequirementsManifest({
    workflowId,
    sessionId,
    promptHash,
    captureSource: overrides.captureSource ?? 'session-routing-state',
    capturePhase: overrides.capturePhase ?? 'pre-implementation',
    taskMetadata: overrides.taskMetadata ?? {
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
    scope: overrides.scope ?? ['api', 'ui'],
    requirements: overrides.requirements ?? [
      {
        id: 'must-show-error',
        exactText: 'Show the user a clear inline validation error when saving invalid input.',
        displayText: 'Show inline validation error on invalid save.',
        priority: 'must',
        acceptance: 'The invalid save path visibly shows the requested validation error.',
        successCondition: true,
      },
      {
        id: 'must-preserve-success',
        exactText: 'Preserve the successful save path and do not regress existing success behavior.',
        displayText: 'Preserve the successful save path.',
        priority: 'must',
        acceptance: 'Successful save still works after the change.',
        successCondition: true,
      },
      {
        id: 'should-keep-copy-stable',
        exactText: 'Keep the surrounding help copy unchanged unless it is required for the new behavior.',
        displayText: 'Keep existing help copy stable.',
        priority: 'should',
        acceptance: 'No extra copy changes unless required.',
        successCondition: false,
      },
    ],
    exclusions: overrides.exclusions ?? [{
      id: 'exclude-analytics',
      exactText: 'Do not add analytics, telemetry, or tracking to this change.',
      displayText: 'Exclude analytics changes.',
    }],
    nonGoals: overrides.nonGoals ?? [{
      id: 'non-goal-redesign',
      exactText: 'Do not redesign unrelated settings pages.',
      displayText: 'No unrelated settings redesign.',
    }],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  });
}

function makeIntentPacket(overrides = {}) {
  const manifest = overrides.requirementsManifest ?? makeIntentManifest(overrides);
  return buildIntentAcceptancePacket({
    requirementsManifest: manifest,
    policyVersion: overrides.policyVersion ?? 'intent-acceptance-policy-v1',
    selectedProfile: overrides.selectedProfile ?? {
      model: 'gpt-5.4',
      effort: 'medium',
      context: 'default',
    },
    selectedModelSource: overrides.selectedModelSource ?? 'session-routing-state',
    implementationRefs: overrides.implementationRefs ?? [
      { id: 'api-validator', kind: 'code', label: 'Validation branch in API save handler' },
      { id: 'settings-form', kind: 'ui', label: 'Settings form inline error rendering' },
    ],
    evidenceRefs: overrides.evidenceRefs ?? [
      { id: 'unit-tests', kind: 'test', summary: 'Targeted validation tests pass' },
      { id: 'runtime-observation', kind: 'runtime-observation', summary: 'Observed invalid save shows the inline error' },
      { id: 'build-check', kind: 'build', summary: 'Build succeeds for the changed surface' },
    ],
    reviewRefs: overrides.reviewRefs ?? [
      { id: 'review-accepted', kind: 'review-acceptance', summary: 'Independent review accepted the substantive change' },
      { id: 'resolved-finding-1', kind: 'resolved-finding', summary: 'Resolved reviewer finding about validation state reset' },
    ],
    coverageMatrix: overrides.coverageMatrix ?? [
      {
        requirementId: 'must-show-error',
        implementationIds: ['api-validator', 'settings-form'],
        evidenceIds: ['unit-tests', 'runtime-observation'],
        summary: 'Invalid-save error path is implemented and observed.',
      },
      {
        requirementId: 'must-preserve-success',
        implementationIds: ['api-validator'],
        evidenceIds: ['unit-tests', 'build-check'],
        summary: 'Success path remains covered by targeted tests and build.',
      },
      {
        requirementId: 'should-keep-copy-stable',
        implementationIds: [],
        evidenceIds: [],
        summary: 'No accepted implementation reference claims copy changes.',
      },
    ],
    changeSummary: overrides.changeSummary ?? 'Add inline invalid-save feedback without changing the successful save path.',
    reviewAcceptance: overrides.reviewAcceptance ?? {
      role: 'independent-review',
      reviewerProfile: { model: 'gpt-5.6-luna', effort: 'medium', context: 'default' },
      acceptanceRefId: 'review-accepted',
      resolvedFindingRefIds: ['resolved-finding-1'],
    },
    knownLimitations: overrides.knownLimitations ?? [{
      id: 'copy-unchanged',
      summary: 'No extra copy changes were implemented because they were not required for the accepted behavior.',
      requirementIds: ['should-keep-copy-stable'],
    }],
    baseRevision: overrides.baseRevision ?? 'a'.repeat(40),
    baseTreeHash: overrides.baseTreeHash ?? 'b'.repeat(40),
    acceptedRevision: overrides.acceptedRevision ?? 'c'.repeat(40),
    acceptedTreeHash: overrides.acceptedTreeHash ?? 'd'.repeat(40),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  });
}

function makeAcceptedResult(packet, overrides = {}) {
  return {
    version: 1,
    role: INTENT_ACCEPTANCE_ROLE,
    packetHash: packet.packetHash,
    attempt: overrides.attempt ?? 1,
    decision: overrides.decision ?? 'accepted',
    requirementResults: overrides.requirementResults ?? [
      {
        requirementId: 'must-show-error',
        status: 'covered',
        reason: 'The packet includes implementation and runtime evidence for the invalid-save error.',
        evidenceIds: ['runtime-observation', 'unit-tests'],
      },
      {
        requirementId: 'must-preserve-success',
        status: 'covered',
        reason: 'The packet includes tests and build evidence for the success path.',
        evidenceIds: ['unit-tests', 'build-check'],
      },
      {
        requirementId: 'should-keep-copy-stable',
        status: 'missing',
        reason: 'The packet does not claim a copy audit beyond the accepted behavior scope.',
        evidenceIds: [],
      },
    ],
    gaps: overrides.gaps ?? [],
    acknowledgedLimitations: overrides.acknowledgedLimitations ?? ['copy-unchanged'],
    implementationAuthority: false,
    reviewAuthority: false,
    releaseAuthority: false,
  };
}

test('packets enforce prompt-bound manifests, hashes, and the hard size cap', () => {
  const packet = makeIntentPacket();
  assert.equal(validateIntentAcceptancePacket(packet).packetHash, packet.packetHash);
  assert.throws(() => makeIntentPacket({
    requirementsManifest: makeIntentManifest({ capturePhase: 'post-implementation' }),
  }), /captured before implementation/);
  const oversizedRequirements = Array.from({ length: 24 }, (_, index) => ({
    id: `must-${index + 1}`,
    exactText: 'x'.repeat(600),
    displayText: `Requirement ${index + 1}`,
    priority: 'must',
    acceptance: 'Covered exactly.',
    successCondition: true,
  }));
  assert.throws(() => makeIntentPacket({
    requirementsManifest: makeIntentManifest({
      requirements: oversizedRequirements,
      exclusions: Array.from({ length: 12 }, (_, index) => ({
        id: `exclude-${index + 1}`,
        exactText: 'y'.repeat(600),
        displayText: `Exclude ${index + 1}`,
      })),
      nonGoals: Array.from({ length: 12 }, (_, index) => ({
        id: `non-goal-${index + 1}`,
        exactText: 'z'.repeat(600),
        displayText: `Non-goal ${index + 1}`,
      })),
      taskMetadata: {
        hasImplementation: true,
        changeClass: 'substantive',
        riskLevel: 'medium',
        surfaceCount: 4,
        repositoryCount: 2,
        uxOrRuntimeBehavior: true,
        safetySensitive: true,
        releaseBound: true,
        deterministicEvidenceSufficient: true,
      },
    }),
    implementationRefs: Array.from({ length: 16 }, (_, index) => ({
      id: `impl-${index + 1}`,
      kind: 'code',
      label: `Implementation ${index + 1} ${'i'.repeat(140)}`,
    })),
    evidenceRefs: Array.from({ length: 24 }, (_, index) => ({
      id: `evidence-${index + 1}`,
      kind: index % 2 === 0 ? 'test' : 'runtime-observation',
      summary: `Evidence ${index + 1} ${'e'.repeat(200)}`,
    })),
    reviewRefs: [
      { id: 'review-accepted', kind: 'review-acceptance', summary: `accepted ${'r'.repeat(180)}` },
      ...Array.from({ length: 23 }, (_, index) => ({
        id: `resolved-finding-${index + 1}`,
        kind: 'resolved-finding',
        summary: `Resolved finding ${index + 1} ${'f'.repeat(170)}`,
      })),
    ],
    coverageMatrix: oversizedRequirements.map(item => ({
      requirementId: item.id,
      implementationIds: ['impl-1'],
      evidenceIds: ['evidence-1'],
      summary: `Covered ${'c'.repeat(180)}`,
    })),
    reviewAcceptance: {
      role: 'independent-review',
      reviewerProfile: { model: 'gpt-5.6-luna', effort: 'medium', context: 'default' },
      acceptanceRefId: 'review-accepted',
      resolvedFindingRefIds: ['resolved-finding-1'],
    },
    knownLimitations: Array.from({ length: 8 }, (_, index) => ({
      id: `limitation-${index + 1}`,
      summary: `Limitation ${index + 1} ${'l'.repeat(170)}`,
      requirementIds: [oversizedRequirements[index].id],
    })),
  }), /exceeds 49152 bytes/);
});

test('eligibility deterministically skips trivial work and qualifies substantive multi-requirement changes', () => {
  const substantive = evaluateIntentAcceptanceEligibility(makeIntentManifest());
  assert.equal(substantive.eligible, true);
  assert.ok(substantive.reasonCodes.includes('multiple-must-requirements'));
  const trivial = evaluateIntentAcceptanceEligibility(makeIntentManifest({
    taskMetadata: {
      hasImplementation: true,
      changeClass: 'mechanical',
      riskLevel: 'low',
      surfaceCount: 1,
      repositoryCount: 1,
      uxOrRuntimeBehavior: false,
      safetySensitive: false,
      releaseBound: false,
      deterministicEvidenceSufficient: true,
    },
    requirements: [{
      id: 'must-rename-constant',
      exactText: 'Rename the internal constant to match the new lint rule.',
      displayText: 'Rename one internal constant.',
      priority: 'must',
      acceptance: 'The internal constant name changes.',
      successCondition: false,
    }],
    exclusions: [],
    nonGoals: [],
    scope: ['api'],
  }));
  assert.equal(trivial.eligible, false);
  assert.ok(trivial.reasonCodes.includes('single-low-risk-mechanical-requirement'));
});

test('accepted results require valid evidence for must and success-condition requirements', () => {
  const packet = makeIntentPacket();
  const accepted = validateIntentAcceptanceResult(makeAcceptedResult(packet), packet);
  assert.equal(accepted.decision, 'accepted');
  assert.throws(() => validateIntentAcceptanceResult(makeAcceptedResult(packet, {
    requirementResults: [
      {
        requirementId: 'must-show-error',
        status: 'covered',
        reason: 'Claims unsupported evidence.',
        evidenceIds: ['unknown-evidence'],
      },
      {
        requirementId: 'must-preserve-success',
        status: 'covered',
        reason: 'Still covered.',
        evidenceIds: ['unit-tests'],
      },
      {
        requirementId: 'should-keep-copy-stable',
        status: 'missing',
        reason: 'Not evaluated.',
        evidenceIds: [],
      },
    ],
  }), packet), /Unknown evidence ID/);
  assert.throws(() => validateIntentAcceptanceResult(makeAcceptedResult(packet, {
    requirementResults: [
      {
        requirementId: 'must-show-error',
        status: 'covered',
        reason: 'Covered.',
        evidenceIds: ['runtime-observation'],
      },
      {
        requirementId: 'must-preserve-success',
        status: 'missing',
        reason: 'Not covered.',
        evidenceIds: [],
      },
      {
        requirementId: 'should-keep-copy-stable',
        status: 'missing',
        reason: 'Not evaluated.',
        evidenceIds: [],
      },
    ],
  }), packet), /must-preserve-success/);
  assert.throws(() => validateIntentAcceptanceResult({
    version: 1,
    role: INTENT_ACCEPTANCE_ROLE,
    packetHash: packet.packetHash,
    attempt: 1,
    decision: 'missing',
    requirementResults: [
      {
        requirementId: 'must-show-error',
        status: 'missing',
        reason: 'Missing.',
        evidenceIds: [],
      },
      {
        requirementId: 'must-preserve-success',
        status: 'covered',
        reason: 'Covered.',
        evidenceIds: ['unit-tests'],
      },
      {
        requirementId: 'should-keep-copy-stable',
        status: 'missing',
        reason: 'Not evaluated.',
        evidenceIds: [],
      },
    ],
    gaps: [
      {
        requirementId: 'must-show-error',
        type: 'missing',
        neededEvidence: 'Add the missing runtime proof.',
        neededChange: null,
      },
      {
        requirementId: 'unknown-gap',
        type: 'missing',
        neededEvidence: 'Unexpected extra gap.',
        neededChange: null,
      },
    ],
    acknowledgedLimitations: ['copy-unchanged'],
    implementationAuthority: false,
    reviewAuthority: false,
    releaseAuthority: false,
  }, packet), /Unsupported gap requirement/);
});

test('missing and ambiguous results require exact gaps and produce bounded remediation receipts', () => {
  const first = setupIntentSession();
  const packet = makeIntentPacket({
    workflowId: first.state.workflowId,
    sessionId: first.sessionId,
    promptHash: first.state.promptHash,
  });
  const dispatchReceipt = authorizeIntentAcceptanceReceipt({
    sessionId: first.sessionId,
    promptHash: first.state.promptHash,
    intentAcceptancePacket: packet,
    issuedAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  }, { home: first.home });
  const missing = validateIntentAcceptanceResult({
    version: 1,
    role: INTENT_ACCEPTANCE_ROLE,
    packetHash: packet.packetHash,
    attempt: 1,
    decision: 'missing',
    requirementResults: [
      {
        requirementId: 'must-show-error',
        status: 'missing',
        reason: 'The packet does not show accepted runtime evidence for the invalid-save path.',
        evidenceIds: [],
      },
      {
        requirementId: 'must-preserve-success',
        status: 'covered',
        reason: 'The packet includes tests for the success path.',
        evidenceIds: ['unit-tests'],
      },
      {
        requirementId: 'should-keep-copy-stable',
        status: 'missing',
        reason: 'The packet does not claim copy audit evidence.',
        evidenceIds: [],
      },
    ],
    gaps: [
      {
        requirementId: 'must-show-error',
        type: 'missing',
        neededEvidence: 'Add deterministic runtime or visual evidence for the invalid-save error state.',
        neededChange: null,
      },
      {
        requirementId: 'should-keep-copy-stable',
        type: 'missing',
        neededEvidence: 'Add a deterministic copy audit reference if this should requirement is a release condition.',
        neededChange: null,
      },
    ],
    acknowledgedLimitations: ['copy-unchanged'],
    implementationAuthority: false,
    reviewAuthority: false,
    releaseAuthority: false,
  }, packet, { expectedAttempt: 1 });
  assert.equal(missing.decision, 'missing');
  const gapReceipt = createIntentAcceptanceOutcomeReceipt({
    packet,
    dispatchReceipt,
    result: missing,
    credits: 0.7,
  });
  assert.equal(gapReceipt.kind, INTENT_ACCEPTANCE_GAP_RECEIPT_KIND);
  assert.equal(gapReceipt.terminal, false);
  const rebuiltPacket = makeIntentPacket({
    workflowId: first.state.workflowId,
    sessionId: first.sessionId,
    promptHash: first.state.promptHash,
    acceptedRevision: 'e'.repeat(40),
    acceptedTreeHash: 'f'.repeat(40),
    selectedProfile: { model: 'gpt-5.4', effort: 'medium', context: 'default' },
  });
  const retryReceipt = authorizeIntentAcceptanceReceipt({
    sessionId: rebuiltPacket.sessionId,
    promptHash: first.state.promptHash,
    intentAcceptancePacket: rebuiltPacket,
    previousGapReceipt: gapReceipt,
    previousPacket: packet,
    attempt: 2,
    issuedAt: rebuiltPacket.createdAt,
    expiresAt: rebuiltPacket.expiresAt,
  }, { home: first.home });
  assert.equal(retryReceipt.attempt, 2);
  const secondGapReceipt = createIntentAcceptanceOutcomeReceipt({
    packet: rebuiltPacket,
    dispatchReceipt: retryReceipt,
    result: {
      ...missing,
      packetHash: rebuiltPacket.packetHash,
      attempt: 2,
    },
    credits: 0.8,
  });
  assert.equal(secondGapReceipt.terminal, true);
  assert.throws(() => authorizeIntentAcceptanceReceipt({
    sessionId: rebuiltPacket.sessionId,
    promptHash: first.state.promptHash,
    intentAcceptancePacket: rebuiltPacket,
    previousGapReceipt: secondGapReceipt,
    previousPacket: rebuiltPacket,
    attempt: 3,
  }, { home: first.home }), /limited to two total runs/);
});

test('selected-model dispatch binds the trusted session profile and allows Sol or Opus only for this role', () => {
  for (const model of ['gpt-5.6-sol', 'claude-opus-5']) {
    const home = makeTempDir('intent-home-');
    const sessionId = '88888888-8888-4888-8888-888888888888';
    writeSessionEvents(home, sessionId, model, 'high', 'default');
    const state = promptStartState({ sessionId, prompt: 'intent gate with explicit selected model' }, { home });
    const packet = makeIntentPacket({
      workflowId: state.workflowId,
      sessionId,
      promptHash: state.promptHash,
      selectedProfile: { model, effort: 'high', context: 'default' },
      selectedModelSource: 'session-events-tail',
    });
    const dispatchReceipt = authorizeIntentAcceptanceReceipt({
      sessionId,
      promptHash: state.promptHash,
      intentAcceptancePacket: packet,
      issuedAt: packet.createdAt,
      expiresAt: packet.expiresAt,
    }, { home });
    const manifest = createDispatchManifest({
      sessionId,
      workflowId: state.workflowId,
      promptHash: state.promptHash,
      project: 'personal-budget-workflow',
      scope: packet.requirementsManifest.scope,
      role: INTENT_ACCEPTANCE_ROLE,
      model,
      effort: 'high',
      context: 'default',
      allowedToolCategories: [],
      validations: ['strict-json-output'],
      evidencePacketHash: packet.packetHash,
      receiptHash: dispatchReceipt.receiptHash,
      researchAuthorized: false,
      intentAcceptanceAuthorized: true,
      intent: { packetWorkflowVersion: 2 },
      plan: { status: 'ready', opportunity: 'user-intent-acceptance' },
    });
    const request = createBoundReasonOnlyLeafRequest({
      dispatchManifest: manifest,
      intentAcceptancePacket: packet,
      intentAcceptanceDispatchReceipt: dispatchReceipt,
      sanitized: true,
      maxCredits: 60,
      timeoutSeconds: 60,
    });
    assert.equal(request.model, model);
    assert.equal(request.dispatchManifest.role, INTENT_ACCEPTANCE_ROLE);
  }
  assert.throws(() => createDispatchManifest({
    sessionId: '99999999-9999-4999-8999-999999999999',
    workflowId: 'workflow',
    promptHash: sha256('review role'),
    project: 'personal-budget-workflow',
    scope: ['intent-acceptance'],
    role: 'reviewer',
    model: 'claude-opus-5',
    effort: 'high',
    context: 'default',
    agentType: 'code-review',
    allowedToolCategories: ['review'],
    validations: ['review'],
    researchAuthorized: false,
    intentAcceptanceAuthorized: false,
    intent: { packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'review' },
  }), /must use gpt-5\.6-luna\/medium\/default/);
});

test('supported selected model ids stay aligned with the current local catalog for intent acceptance', () => {
  assert.deepEqual([...SUPPORTED_MODEL_IDS], [
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-opus-4.8',
    'claude-opus-4.7',
    'claude-haiku-4.5',
    'gpt-5.6-sol',
    'gpt-5.6-sol-fast',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5-mini',
    'mai-code-1.1-flash',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'grok-4.5',
    'gpt-6-astra',
    'grok-4.6',
  ]);
  assert.equal(SUPPORTED_MODELS.has('claude-opus-5'), true);
  assert.equal(SUPPORTED_MODELS.has('claude-opus-4.7'), true);
  assert.equal(SUPPORTED_MODELS.has('claude-sonnet-4.6'), false);
  assert.equal(SUPPORTED_MODELS.has('mai-code-1-flash-picker'), false);
});

test('explicitly selected Astra xhigh sessions are accepted only for user-intent-acceptance', () => {
  const home = makeTempDir('intent-home-');
  const sessionId = 'a5a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5';
  writeSessionEvents(home, sessionId, 'gpt-6-astra', 'xhigh', 'long_context');
  const state = promptStartState({ sessionId, prompt: 'intent gate with explicit astra selection' }, { home });
  const packet = makeIntentPacket({
    workflowId: state.workflowId,
    sessionId,
    promptHash: state.promptHash,
    selectedProfile: { model: 'gpt-6-astra', effort: 'xhigh', context: 'long_context' },
    selectedModelSource: 'session-events-tail',
  });
  const dispatchReceipt = authorizeIntentAcceptanceReceipt({
    sessionId,
    promptHash: state.promptHash,
    intentAcceptancePacket: packet,
    issuedAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  }, { home });
  const manifest = createDispatchManifest({
    sessionId,
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    project: 'personal-budget-workflow',
    scope: packet.requirementsManifest.scope,
    role: INTENT_ACCEPTANCE_ROLE,
    model: 'gpt-6-astra',
    effort: 'xhigh',
    context: 'long_context',
    allowedToolCategories: [],
    validations: ['strict-json-output'],
    evidencePacketHash: packet.packetHash,
    receiptHash: dispatchReceipt.receiptHash,
    researchAuthorized: false,
    intentAcceptanceAuthorized: true,
    intent: { packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'user-intent-acceptance' },
  });
  const request = createBoundReasonOnlyLeafRequest({
    dispatchManifest: manifest,
    intentAcceptancePacket: packet,
    intentAcceptanceDispatchReceipt: dispatchReceipt,
    sanitized: true,
    maxCredits: 60,
    timeoutSeconds: 60,
  });
  assert.equal(request.model, 'gpt-6-astra');
  assert.equal(request.effort, 'xhigh');
  assert.equal(request.context, 'long_context');
  assert.throws(() => createDispatchManifest({
    sessionId,
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    project: 'personal-budget-workflow',
    scope: packet.requirementsManifest.scope,
    role: 'reviewer',
    model: 'gpt-6-astra',
    effort: 'xhigh',
    context: 'long_context',
    agentType: 'code-review',
    allowedToolCategories: ['review'],
    validations: ['review'],
    researchAuthorized: false,
    intentAcceptanceAuthorized: false,
    intent: { packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'review' },
  }), /must use gpt-5\.6-luna\/medium\/default/);
});

test('unavailable or mismatched selected models fail closed without substitution', () => {
  const home = makeTempDir('intent-home-');
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeSessionEvents(home, sessionId, 'unknown-model', 'medium', 'default');
  const state = promptStartState({ sessionId, prompt: 'blocked model' }, { home });
  const packet = makeIntentPacket({
    workflowId: state.workflowId,
    sessionId,
    promptHash: state.promptHash,
    selectedProfile: { model: 'unknown-model', effort: 'medium', context: 'default' },
  });
  assert.throws(() => authorizeIntentAcceptanceReceipt({
    sessionId,
    promptHash: state.promptHash,
    intentAcceptancePacket: packet,
  }, { home }), /selected session model is unavailable/);

  const mismatchHome = makeTempDir('intent-home-');
  const mismatchSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  writeSessionEvents(mismatchHome, mismatchSession, 'gpt-5.4', 'medium', 'default');
  const mismatchState = promptStartState({ sessionId: mismatchSession, prompt: 'mismatch model' }, { home: mismatchHome });
  const mismatchPacket = makeIntentPacket({
    workflowId: mismatchState.workflowId,
    sessionId: mismatchSession,
    promptHash: mismatchState.promptHash,
    selectedProfile: { model: 'gpt-5.4-mini', effort: 'low', context: 'default' },
  });
  assert.throws(() => authorizeIntentAcceptanceReceipt({
    sessionId: mismatchSession,
    promptHash: mismatchState.promptHash,
    intentAcceptancePacket: mismatchPacket,
  }, { home: mismatchHome }), /does not match trusted session routing state/);

  for (const model of ['claude-sonnet-4.6', 'mai-code-1-flash-picker']) {
    const staleHome = makeTempDir('intent-home-');
    const staleSessionId = crypto.randomUUID();
    writeSessionEvents(staleHome, staleSessionId, model, 'medium', 'default');
    const staleState = promptStartState({ sessionId: staleSessionId, prompt: `blocked stale model ${model}` }, { home: staleHome });
    assert.throws(() => authorizeIntentAcceptanceReceipt({
      sessionId: staleSessionId,
      promptHash: staleState.promptHash,
      intentAcceptancePacket: makeIntentPacket({
        workflowId: staleState.workflowId,
        sessionId: staleSessionId,
        promptHash: staleState.promptHash,
      }),
    }, { home: staleHome }), new RegExp(`unavailable: ${model.replace(/\./g, '\\.')}`));
  }
});

test('user-intent-acceptance is reason-only, one-shot, and denied through task agents', () => {
  const home = makeTempDir('intent-home-');
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  writeSessionEvents(home, sessionId, 'gpt-5.4', 'medium', 'default');
  const state = promptStartState({ sessionId, prompt: 'intent gate request' }, { home });
  const packet = makeIntentPacket({
    workflowId: state.workflowId,
    sessionId,
    promptHash: state.promptHash,
  });
  const dispatchReceipt = authorizeIntentAcceptanceReceipt({
    sessionId,
    promptHash: state.promptHash,
    intentAcceptancePacket: packet,
    issuedAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  }, { home });
  const manifest = createDispatchManifest({
    sessionId,
    workflowId: state.workflowId,
    promptHash: state.promptHash,
    project: 'personal-budget-workflow',
    scope: packet.requirementsManifest.scope,
    role: INTENT_ACCEPTANCE_ROLE,
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
    allowedToolCategories: [],
    validations: ['strict-json-output'],
    evidencePacketHash: packet.packetHash,
    receiptHash: dispatchReceipt.receiptHash,
    researchAuthorized: false,
    intentAcceptanceAuthorized: true,
    intent: { packetWorkflowVersion: 2 },
    plan: { status: 'ready', opportunity: 'user-intent-acceptance' },
  });
  const taskDenied = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'task',
    toolArgs: {
      prompt: manifest.promptBlock,
      model: 'gpt-5.4',
      agent_type: 'general-purpose',
      context_tier: 'default',
      reasoning_effort: 'medium',
    },
  }, { home });
  assert.equal(taskDenied.permissionDecision, 'deny');

  const request = createBoundReasonOnlyLeafRequest({
    dispatchManifest: manifest,
    intentAcceptancePacket: packet,
    intentAcceptanceDispatchReceipt: dispatchReceipt,
    sanitized: true,
    maxCredits: 60,
    timeoutSeconds: 60,
  });
  const requestFile = path.join(home, 'intent-request.json');
  writeJson(requestFile, request);
  const command = `node ${RUN_LEAF_SCRIPT} ${requestFile} ${path.join(home, 'out')}`;
  assert.deepEqual(hookDecision({
    sessionId,
    cwd: home,
    toolName: 'bash',
    toolArgs: { command },
  }, { home }), {});
  const secondAttempt = hookDecision({
    sessionId,
    cwd: home,
    toolName: 'bash',
    toolArgs: { command },
  }, { home });
  assert.equal(secondAttempt.permissionDecision, 'deny');
  assert.match(secondAttempt.permissionDecisionReason, /already used|one-shot/);
});

test('accepted receipts gate completion and release eligibility without granting release authority', () => {
  const session = setupIntentSession();
  const packet = makeIntentPacket({
    workflowId: session.state.workflowId,
    sessionId: session.sessionId,
    promptHash: session.state.promptHash,
  });
  const dispatchReceipt = authorizeIntentAcceptanceReceipt({
    sessionId: session.sessionId,
    promptHash: session.state.promptHash,
    intentAcceptancePacket: packet,
    issuedAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  }, { home: session.home });
  const pending = evaluateIntentAcceptanceGate({
    packet,
    deterministicValidationAccepted: true,
    independentReviewAccepted: true,
  });
  assert.equal(pending.completionEligible, false);
  const receipt = createIntentAcceptanceOutcomeReceipt({
    packet,
    dispatchReceipt,
    result: makeAcceptedResult(packet),
    credits: 0.6,
  });
  assert.equal(receipt.kind, INTENT_ACCEPTANCE_RECEIPT_KIND);
  const allowed = evaluateIntentAcceptanceGate({
    packet,
    receipt,
    deterministicValidationAccepted: true,
    independentReviewAccepted: true,
  });
  assert.equal(allowed.completionEligible, true);
  assert.equal(allowed.releaseEligible, true);
  assert.equal(allowed.releaseAuthority, false);
});

test('receipts become stale when tree, requirements, or evidence bindings change', () => {
  const session = setupIntentSession();
  const packet = makeIntentPacket({
    workflowId: session.state.workflowId,
    sessionId: session.sessionId,
    promptHash: session.state.promptHash,
  });
  const dispatchReceipt = authorizeIntentAcceptanceReceipt({
    sessionId: session.sessionId,
    promptHash: session.state.promptHash,
    intentAcceptancePacket: packet,
    issuedAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  }, { home: session.home });
  const receipt = createIntentAcceptanceOutcomeReceipt({
    packet,
    dispatchReceipt,
    result: makeAcceptedResult(packet),
    credits: 0.5,
  });
  validateIntentAcceptanceOutcomeReceipt(receipt, packet);
  const changedTreePacket = makeIntentPacket({
    workflowId: session.state.workflowId,
    sessionId: session.sessionId,
    promptHash: session.state.promptHash,
    acceptedTreeHash: 'e'.repeat(40),
  });
  assert.throws(() => validateIntentAcceptanceOutcomeReceipt(receipt, changedTreePacket), /packet mismatch|revision mismatch|revision fields mismatch/);
  const changedEvidencePacket = makeIntentPacket({
    workflowId: session.state.workflowId,
    sessionId: session.sessionId,
    promptHash: session.state.promptHash,
    evidenceRefs: [
      { id: 'unit-tests', kind: 'test', summary: 'Targeted validation tests pass' },
      { id: 'runtime-observation', kind: 'runtime-observation', summary: 'Observed invalid save shows the inline error' },
      { id: 'policy-validator', kind: 'policy-validator', summary: 'Policy validator confirms no excluded analytics work' },
    ],
    coverageMatrix: [
      {
        requirementId: 'must-show-error',
        implementationIds: ['api-validator', 'settings-form'],
        evidenceIds: ['unit-tests', 'runtime-observation'],
        summary: 'Invalid-save error path is implemented and observed.',
      },
      {
        requirementId: 'must-preserve-success',
        implementationIds: ['api-validator'],
        evidenceIds: ['unit-tests'],
        summary: 'Success path remains covered by targeted tests.',
      },
      {
        requirementId: 'should-keep-copy-stable',
        implementationIds: [],
        evidenceIds: ['policy-validator'],
        summary: 'Policy validation confirms no analytics work was added.',
      },
    ],
  });
  assert.throws(() => validateIntentAcceptanceOutcomeReceipt(receipt, changedEvidencePacket), /packet mismatch|evidence mismatch|coverage mismatch/);

  const tamperedWorkflowReceipt = {
    ...receipt,
    workflowId: 'other-workflow',
  };
  tamperedWorkflowReceipt.receiptHash = sha256(Object.fromEntries(
    Object.entries(tamperedWorkflowReceipt).filter(([key]) => key !== 'receiptHash'),
  ));
  assert.throws(() => validateIntentAcceptanceOutcomeReceipt(tamperedWorkflowReceipt, packet), /workflow mismatch/);
});

test('resolved runtime profiles fail closed when the model does not match the exact dispatch profile', () => {
  assert.throws(() => resolvedConfiguration([{
    type: 'subagent.configured',
    data: {
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      contextTier: 'default',
    },
  }], {
    model: 'gpt-5.4',
    effort: 'medium',
    context: 'default',
  }), /Resolved model mismatch/);
});

test('selected Opus 4.7 sessions are accepted for user-intent-acceptance dispatch', () => {
  const home = makeTempDir('intent-home-');
  const sessionId = 'efefefef-efef-4fef-8fef-efefefefefef';
  writeSessionEvents(home, sessionId, 'claude-opus-4.7', 'high', 'default');
  const state = promptStartState({ sessionId, prompt: 'intent gate with selected opus 4.7' }, { home });
  const packet = makeIntentPacket({
    workflowId: state.workflowId,
    sessionId,
    promptHash: state.promptHash,
    selectedProfile: { model: 'claude-opus-4.7', effort: 'high', context: 'default' },
    selectedModelSource: 'session-events-tail',
  });
  const dispatchReceipt = authorizeIntentAcceptanceReceipt({
    sessionId,
    promptHash: state.promptHash,
    intentAcceptancePacket: packet,
    issuedAt: packet.createdAt,
    expiresAt: packet.expiresAt,
  }, { home });
  assert.equal(dispatchReceipt.profile.model, 'claude-opus-4.7');
});

test('hook timing stays bounded across 200 evaluations with large session history', () => {
  const home = makeTempDir('intent-home-');
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  writeSessionEvents(home, sessionId, 'gpt-5.4', 'medium', 'default');
  const file = path.join(home, 'session-state', sessionId, 'events.jsonl');
  for (let index = 0; index < 50_000; index += 1) {
    fs.appendFileSync(file, `${JSON.stringify({
      type: 'assistant.message',
      data: { content: `line ${index}` },
    })}\n`);
  }
  promptStartState({ sessionId, prompt: 'perf gate' }, { home });
  const payload = {
    sessionId,
    cwd: home,
    toolCalls: [
      { id: 'view', name: 'view', args: { path: file, view_range: [1, 3] } },
      { id: 'bash', name: 'bash', args: { command: `node ${OPPORTUNITIES_SCRIPT} plan /tmp/root /tmp/task.json` } },
    ],
  };
  const samples = [];
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    hookDecision(payload, { home });
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const max = sorted.at(-1);
  assert.ok(p95 < 50, `expected p95 < 50ms, received ${p95}`);
  assert.ok(max < 200, `expected max < 200ms, received ${max}`);
});
