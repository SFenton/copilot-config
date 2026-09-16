#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  LUNA_MEDIUM_DEFAULT_PROFILE,
  SUPPORTED_CONTEXT_VALUES,
  SUPPORTED_EFFORT_VALUES,
} from './model-catalog.mjs';

import {
  PACKET_LIMITS,
  PACKET_WORKFLOW_VERSION,
  canonicalJson,
  sha256,
  validateProfile,
} from './evidence/schemas.mjs';
import { createIntentAcceptanceUsageRecord } from './usage.mjs';

export const INTENT_ACCEPTANCE_ROLE = 'user-intent-acceptance';
export const INTENT_ACCEPTANCE_PACKET_VERSION = 1;
export const INTENT_ACCEPTANCE_RESULT_VERSION = 1;
export const INTENT_ACCEPTANCE_MAX_ATTEMPTS = 2;
export const INTENT_REQUIREMENTS_MANIFEST_KIND = 'user-intent-requirements-manifest';
export const INTENT_ACCEPTANCE_PACKET_KIND = 'user-intent-acceptance-packet';
export const INTENT_ACCEPTANCE_DISPATCH_RECEIPT_KIND = 'intent-acceptance-dispatch-receipt';
export const INTENT_ACCEPTANCE_RECEIPT_KIND = 'intent-acceptance-receipt';
export const INTENT_ACCEPTANCE_GAP_RECEIPT_KIND = 'intent-acceptance-gap-receipt';

export const INTENT_ACCEPTANCE_LIMITS = Object.freeze({
  targetSerializedBytes: 20 * 1024,
  maxSerializedBytes: PACKET_LIMITS.maxSerializedBytes,
  maxRequirements: 24,
  maxScopeItems: 12,
  maxExclusions: 12,
  maxNonGoals: 12,
  maxImplementationRefs: 16,
  maxEvidenceRefs: 24,
  maxReviewRefs: 24,
  maxKnownLimitations: 8,
  maxRequirementReasonBytes: 280,
  maxGapTextBytes: 220,
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_ID_PATTERN = /^[0-9a-f-]+$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const REVISION_PATTERN = /^[a-f0-9]{40,64}$/i;
const KEBAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const behaviorEvidenceKinds = new Set([
  'test',
  'build',
  'policy-validator',
  'runtime-observation',
  'screenshot',
  'media-reference',
]);
const effortSchema = z.enum(SUPPORTED_EFFORT_VALUES);
const contextSchema = z.enum(SUPPORTED_CONTEXT_VALUES);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const hashSchema = z.string().regex(HASH_PATTERN);
const isoDateSchema = z.string().regex(ISO_DATE_PATTERN);
const revisionSchema = z.string().regex(REVISION_PATTERN);
const kebabSchema = z.string().regex(KEBAB_PATTERN);

const stableTextSchema = z.object({
  exactText: z.string().min(1).max(600).optional(),
  exactTextHash: hashSchema,
  displayText: z.string().min(1).max(180),
}).strict().superRefine((value, ctx) => {
  if (!value.exactText && !value.exactTextHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Exact text or exactTextHash required',
    });
  }
  if (value.exactText && sha256(value.exactText) !== value.exactTextHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Exact text hash mismatch',
    });
  }
});

const requirementSchema = stableTextSchema.extend({
  id: kebabSchema,
  priority: z.enum(['must', 'should', 'optional']),
  acceptance: z.string().min(1).max(240),
  successCondition: z.boolean(),
}).strict();

const exclusionSchema = stableTextSchema.extend({
  id: kebabSchema,
}).strict();

const taskMetadataSchema = z.object({
  hasImplementation: z.boolean(),
  changeClass: z.enum([
    'substantive',
    'mechanical',
    'docs-only',
    'copy-only',
    'no-implementation',
  ]),
  riskLevel: z.enum(['low', 'medium', 'high']),
  surfaceCount: z.number().int().min(1).max(20),
  repositoryCount: z.number().int().min(1).max(10),
  uxOrRuntimeBehavior: z.boolean(),
  safetySensitive: z.boolean(),
  releaseBound: z.boolean(),
  deterministicEvidenceSufficient: z.boolean(),
}).strict();

export const intentRequirementsManifestSchema = z.object({
  version: z.literal(INTENT_ACCEPTANCE_PACKET_VERSION),
  kind: z.literal(INTENT_REQUIREMENTS_MANIFEST_KIND),
  workflowId: z.string().min(1).max(120),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  promptHash: hashSchema,
  promptBindingHash: hashSchema,
  captureSource: z.enum(['session-routing-state', 'session-events-tail']),
  capturePhase: z.enum(['pre-implementation', 'post-implementation']),
  taskMetadata: taskMetadataSchema,
  scope: z.array(z.string().min(1).max(180)).min(1).max(INTENT_ACCEPTANCE_LIMITS.maxScopeItems),
  requirements: z.array(requirementSchema).min(1).max(INTENT_ACCEPTANCE_LIMITS.maxRequirements),
  exclusions: z.array(exclusionSchema).max(INTENT_ACCEPTANCE_LIMITS.maxExclusions),
  nonGoals: z.array(exclusionSchema).max(INTENT_ACCEPTANCE_LIMITS.maxNonGoals),
  createdAt: isoDateSchema,
  manifestHash: hashSchema,
}).strict().superRefine((manifest, ctx) => {
  if (manifest.promptBindingHash !== sha256({
    workflowId: manifest.workflowId,
    sessionId: manifest.sessionId,
    promptHash: manifest.promptHash,
  })) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Prompt binding hash mismatch',
    });
  }
  const requirementIds = manifest.requirements.map(item => item.id);
  if (new Set(requirementIds).size !== requirementIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Requirement IDs must be unique',
    });
  }
  const duplicateExactIds = new Set();
  for (const item of [...manifest.exclusions, ...manifest.nonGoals]) {
    if (duplicateExactIds.has(item.id) || requirementIds.includes(item.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate requirement/exclusion ID: ${item.id}`,
      });
    }
    duplicateExactIds.add(item.id);
  }
  const created = Date.parse(manifest.createdAt);
  if (!Number.isFinite(created)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Manifest createdAt is invalid',
    });
  }
  const { manifestHash, ...unsigned } = manifest;
  if (manifestHash !== sha256(unsigned)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Manifest hash mismatch',
    });
  }
});

const implementationRefSchema = z.object({
  id: kebabSchema,
  kind: z.enum(['code', 'config', 'test', 'ui', 'runtime', 'policy', 'docs']),
  label: z.string().min(1).max(180),
}).strict();

const evidenceRefSchema = z.object({
  id: kebabSchema,
  kind: z.enum([
    'test',
    'build',
    'policy-validator',
    'runtime-observation',
    'screenshot',
    'media-reference',
  ]),
  summary: z.string().min(1).max(240),
}).strict();

const reviewRefSchema = z.object({
  id: kebabSchema,
  kind: z.enum(['review-acceptance', 'resolved-finding']),
  summary: z.string().min(1).max(240),
}).strict();

const coverageEntrySchema = z.object({
  requirementId: kebabSchema,
  implementationIds: z.array(kebabSchema).max(6),
  evidenceIds: z.array(kebabSchema).max(6),
  summary: z.string().min(1).max(220),
}).strict();

const knownLimitationSchema = z.object({
  id: kebabSchema,
  summary: z.string().min(1).max(220),
  requirementIds: z.array(kebabSchema).max(8),
}).strict();

const reviewAcceptanceSchema = z.object({
  role: z.literal('independent-review'),
  reviewerProfile: z.object({
    model: z.string().min(1).max(80),
    effort: effortSchema,
    context: contextSchema,
  }).strict(),
  acceptanceRefId: kebabSchema,
  resolvedFindingRefIds: z.array(kebabSchema).max(8),
}).strict();

export const intentAcceptancePacketSchema = z.object({
  version: z.literal(INTENT_ACCEPTANCE_PACKET_VERSION),
  kind: z.literal(INTENT_ACCEPTANCE_PACKET_KIND),
  packetWorkflowVersion: z.literal(PACKET_WORKFLOW_VERSION),
  policyVersion: z.string().min(1).max(80),
  workflowId: z.string().min(1).max(120),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  promptHash: hashSchema,
  requirementsManifest: intentRequirementsManifestSchema,
  requirementsManifestHash: hashSchema,
  selectedProfile: z.object({
    model: z.string().min(1).max(80),
    effort: effortSchema,
    context: contextSchema,
  }).strict(),
  selectedModelSource: z.enum(['session-routing-state', 'session-events-tail']),
  scopeHash: hashSchema,
  implementationRefs: z.array(implementationRefSchema)
    .min(1).max(INTENT_ACCEPTANCE_LIMITS.maxImplementationRefs),
  evidenceRefs: z.array(evidenceRefSchema)
    .min(1).max(INTENT_ACCEPTANCE_LIMITS.maxEvidenceRefs),
  reviewRefs: z.array(reviewRefSchema)
    .min(1).max(INTENT_ACCEPTANCE_LIMITS.maxReviewRefs),
  coverageMatrix: z.array(coverageEntrySchema)
    .min(1).max(INTENT_ACCEPTANCE_LIMITS.maxRequirements),
  changeSummary: z.string().min(1).max(600),
  reviewAcceptance: reviewAcceptanceSchema,
  knownLimitations: z.array(knownLimitationSchema).max(INTENT_ACCEPTANCE_LIMITS.maxKnownLimitations),
  baseRevision: revisionSchema,
  baseTreeHash: revisionSchema,
  acceptedRevision: revisionSchema,
  acceptedTreeHash: revisionSchema,
  revisionBindingHash: hashSchema,
  requirementsHash: hashSchema,
  evidenceHash: hashSchema,
  coverageHash: hashSchema,
  serializedBytes: z.number().int().min(1).max(INTENT_ACCEPTANCE_LIMITS.maxSerializedBytes),
  targetSerializedBytes: z.literal(INTENT_ACCEPTANCE_LIMITS.targetSerializedBytes),
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
  packetHash: hashSchema,
}).strict().superRefine((packet, ctx) => {
  if (packet.workflowId !== packet.requirementsManifest.workflowId ||
    packet.sessionId !== packet.requirementsManifest.sessionId ||
    packet.promptHash !== packet.requirementsManifest.promptHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Packet/manifest binding mismatch',
    });
  }
  if (packet.requirementsManifestHash !== packet.requirementsManifest.manifestHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'requirementsManifestHash mismatch',
    });
  }
  if (packet.scopeHash !== sha256(packet.requirementsManifest.scope)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Packet scopeHash mismatch',
    });
  }
  if (packet.reviewAcceptance.reviewerProfile.model !== LUNA_MEDIUM_DEFAULT_PROFILE.model ||
    packet.reviewAcceptance.reviewerProfile.effort !== LUNA_MEDIUM_DEFAULT_PROFILE.effort ||
    packet.reviewAcceptance.reviewerProfile.context !== LUNA_MEDIUM_DEFAULT_PROFILE.context) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Independent reviewer must be gpt-5.6-luna medium/default',
    });
  }
  if (packet.requirementsManifest.capturePhase !== 'pre-implementation') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Intent acceptance requires a prompt-bound requirements manifest captured before implementation',
    });
  }
  const implementationIds = new Set(packet.implementationRefs.map(item => item.id));
  if (implementationIds.size !== packet.implementationRefs.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Implementation IDs must be unique',
    });
  }
  const evidenceIds = new Set(packet.evidenceRefs.map(item => item.id));
  if (evidenceIds.size !== packet.evidenceRefs.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Evidence IDs must be unique',
    });
  }
  const reviewRefMap = new Map(packet.reviewRefs.map(item => [item.id, item.kind]));
  if (reviewRefMap.size !== packet.reviewRefs.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Review reference IDs must be unique',
    });
  }
  if (reviewRefMap.get(packet.reviewAcceptance.acceptanceRefId) !== 'review-acceptance') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Review acceptance reference is missing',
    });
  }
  for (const id of packet.reviewAcceptance.resolvedFindingRefIds) {
    if (reviewRefMap.get(id) !== 'resolved-finding') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Resolved finding reference is missing: ${id}`,
      });
    }
  }
  const requirementIds = packet.requirementsManifest.requirements.map(item => item.id);
  const coverageEntries = new Map(packet.coverageMatrix.map(entry => [entry.requirementId, entry]));
  if (coverageEntries.size !== packet.coverageMatrix.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Coverage matrix requirement IDs must be unique',
    });
  }
  for (const requirementId of requirementIds) {
    if (!coverageEntries.has(requirementId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Coverage matrix omits requirement: ${requirementId}`,
      });
    }
  }
  for (const entry of packet.coverageMatrix) {
    if (!requirementIds.includes(entry.requirementId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Coverage matrix references an unknown requirement: ${entry.requirementId}`,
      });
    }
    for (const id of entry.implementationIds) {
      if (!implementationIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Coverage matrix references unknown implementation ID: ${id}`,
        });
      }
    }
    for (const id of entry.evidenceIds) {
      if (!evidenceIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Coverage matrix references unknown evidence ID: ${id}`,
        });
      }
    }
  }
  const limitationIds = new Set();
  for (const limitation of packet.knownLimitations) {
    if (limitationIds.has(limitation.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Known limitation IDs must be unique: ${limitation.id}`,
      });
    }
    limitationIds.add(limitation.id);
    for (const requirementId of limitation.requirementIds) {
      if (!requirementIds.includes(requirementId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Known limitation references unknown requirement: ${requirementId}`,
        });
      }
    }
  }
  if (packet.revisionBindingHash !== sha256({
    baseRevision: packet.baseRevision,
    baseTreeHash: packet.baseTreeHash,
    acceptedRevision: packet.acceptedRevision,
    acceptedTreeHash: packet.acceptedTreeHash,
  })) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'revisionBindingHash mismatch',
    });
  }
  if (packet.requirementsHash !== sha256(packet.requirementsManifest.requirements)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'requirementsHash mismatch',
    });
  }
  if (packet.evidenceHash !== sha256(packet.evidenceRefs)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'evidenceHash mismatch',
    });
  }
  if (packet.coverageHash !== sha256(packet.coverageMatrix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'coverageHash mismatch',
    });
  }
  const unsigned = Object.fromEntries(
    Object.entries(packet).filter(([key]) => key !== 'packetHash'),
  );
  const serialized = canonicalJson(unsigned);
  if (Buffer.byteLength(serialized) !== packet.serializedBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Packet serializedBytes mismatch',
    });
  }
  if (packet.packetHash !== sha256(unsigned)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Packet hash mismatch',
    });
  }
  const created = Date.parse(packet.createdAt);
  const expires = Date.parse(packet.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Packet timestamps are invalid',
    });
  }
});

const requirementResultSchema = z.object({
  requirementId: kebabSchema,
  status: z.enum(['covered', 'missing', 'ambiguous']),
  reason: z.string().min(1).max(220),
  evidenceIds: z.array(kebabSchema).max(6),
}).strict();

const gapSchema = z.object({
  requirementId: kebabSchema,
  type: z.enum(['missing', 'ambiguous']),
  neededEvidence: z.string().min(1).max(INTENT_ACCEPTANCE_LIMITS.maxGapTextBytes).nullable(),
  neededChange: z.string().min(1).max(INTENT_ACCEPTANCE_LIMITS.maxGapTextBytes).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.neededEvidence === null && value.neededChange === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Each gap requires neededEvidence or neededChange',
    });
  }
});

export const intentAcceptanceResultSchema = z.object({
  version: z.literal(INTENT_ACCEPTANCE_RESULT_VERSION),
  role: z.literal(INTENT_ACCEPTANCE_ROLE),
  packetHash: hashSchema,
  attempt: z.number().int().min(1).max(INTENT_ACCEPTANCE_MAX_ATTEMPTS),
  decision: z.enum(['accepted', 'missing', 'ambiguous']),
  requirementResults: z.array(requirementResultSchema).min(1).max(INTENT_ACCEPTANCE_LIMITS.maxRequirements),
  gaps: z.array(gapSchema).max(INTENT_ACCEPTANCE_LIMITS.maxRequirements),
  acknowledgedLimitations: z.array(kebabSchema).max(INTENT_ACCEPTANCE_LIMITS.maxKnownLimitations),
  implementationAuthority: z.literal(false),
  reviewAuthority: z.literal(false),
  releaseAuthority: z.literal(false),
}).strict();

const intentAcceptanceDispatchReceiptSchema = z.object({
  version: z.literal(INTENT_ACCEPTANCE_PACKET_VERSION),
  kind: z.literal(INTENT_ACCEPTANCE_DISPATCH_RECEIPT_KIND),
  workflowId: z.string().min(1).max(120),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  promptHash: hashSchema,
  role: z.literal(INTENT_ACCEPTANCE_ROLE),
  attempt: z.number().int().min(1).max(INTENT_ACCEPTANCE_MAX_ATTEMPTS),
  maxAttempts: z.literal(INTENT_ACCEPTANCE_MAX_ATTEMPTS),
  profile: z.object({
    model: z.string().min(1).max(80),
    effort: effortSchema,
    context: contextSchema,
  }).strict(),
  selectedModelSource: z.enum(['session-routing-state', 'session-events-tail']),
  requirementsManifestHash: hashSchema,
  packetHash: hashSchema,
  packetBytes: z.number().int().min(1).max(INTENT_ACCEPTANCE_LIMITS.maxSerializedBytes),
  requirementsHash: hashSchema,
  evidenceHash: hashSchema,
  coverageHash: hashSchema,
  revisionBindingHash: hashSchema,
  baseRevision: revisionSchema,
  baseTreeHash: revisionSchema,
  acceptedRevision: revisionSchema,
  acceptedTreeHash: revisionSchema,
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
  receiptHash: hashSchema,
}).strict();

const acceptedReceiptSchema = z.object({
  version: z.literal(INTENT_ACCEPTANCE_PACKET_VERSION),
  kind: z.literal(INTENT_ACCEPTANCE_RECEIPT_KIND),
  workflowId: z.string().min(1).max(120),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  promptHash: hashSchema,
  role: z.literal(INTENT_ACCEPTANCE_ROLE),
  attempt: z.number().int().min(1).max(INTENT_ACCEPTANCE_MAX_ATTEMPTS),
  dispatchReceiptHash: hashSchema,
  packetHash: hashSchema,
  resultHash: hashSchema,
  requirementsManifestHash: hashSchema,
  requirementsHash: hashSchema,
  evidenceHash: hashSchema,
  coverageHash: hashSchema,
  revisionBindingHash: hashSchema,
  baseRevision: revisionSchema,
  baseTreeHash: revisionSchema,
  acceptedRevision: revisionSchema,
  acceptedTreeHash: revisionSchema,
  coveredRequirementIds: z.array(kebabSchema).min(1).max(INTENT_ACCEPTANCE_LIMITS.maxRequirements),
  acknowledgedLimitationIds: z.array(kebabSchema).max(INTENT_ACCEPTANCE_LIMITS.maxKnownLimitations),
  completionEligibilityGranted: z.literal(true),
  releaseEligibilityGranted: z.literal(true),
  implementationAuthority: z.literal(false),
  reviewAuthority: z.literal(false),
  releaseAuthority: z.literal(false),
  usage: z.object({
    category: z.literal('user-intent-acceptance'),
    selectedModel: z.string().min(1).max(80),
    attemptCount: z.number().int().min(1).max(INTENT_ACCEPTANCE_MAX_ATTEMPTS),
    packetBytes: z.number().int().min(1).max(INTENT_ACCEPTANCE_LIMITS.maxSerializedBytes),
    outcome: z.literal('accepted'),
    credits: z.number().nonnegative(),
    projected: z.boolean(),
    pricingAssumption: z.string().min(1).max(240).nullable(),
  }).strict(),
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
  receiptHash: hashSchema,
}).strict();

const gapReceiptSchema = z.object({
  version: z.literal(INTENT_ACCEPTANCE_PACKET_VERSION),
  kind: z.literal(INTENT_ACCEPTANCE_GAP_RECEIPT_KIND),
  workflowId: z.string().min(1).max(120),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  promptHash: hashSchema,
  role: z.literal(INTENT_ACCEPTANCE_ROLE),
  attempt: z.number().int().min(1).max(INTENT_ACCEPTANCE_MAX_ATTEMPTS),
  dispatchReceiptHash: hashSchema,
  packetHash: hashSchema,
  resultHash: hashSchema,
  requirementsManifestHash: hashSchema,
  requirementsHash: hashSchema,
  evidenceHash: hashSchema,
  coverageHash: hashSchema,
  revisionBindingHash: hashSchema,
  baseRevision: revisionSchema,
  baseTreeHash: revisionSchema,
  acceptedRevision: revisionSchema,
  acceptedTreeHash: revisionSchema,
  decision: z.enum(['missing', 'ambiguous']),
  gapRequirementIds: z.array(kebabSchema).min(1).max(INTENT_ACCEPTANCE_LIMITS.maxRequirements),
  gaps: z.array(gapSchema).min(1).max(INTENT_ACCEPTANCE_LIMITS.maxRequirements),
  acknowledgedLimitationIds: z.array(kebabSchema).max(INTENT_ACCEPTANCE_LIMITS.maxKnownLimitations),
  terminal: z.boolean(),
  nextAction: z.enum([
    'return-to-implementation-owner',
    'user-or-operator-resolution-required',
  ]),
  completionEligibilityGranted: z.literal(false),
  releaseEligibilityGranted: z.literal(false),
  implementationAuthority: z.literal(false),
  reviewAuthority: z.literal(false),
  releaseAuthority: z.literal(false),
  usage: z.object({
    category: z.literal('user-intent-acceptance'),
    selectedModel: z.string().min(1).max(80),
    attemptCount: z.number().int().min(1).max(INTENT_ACCEPTANCE_MAX_ATTEMPTS),
    packetBytes: z.number().int().min(1).max(INTENT_ACCEPTANCE_LIMITS.maxSerializedBytes),
    outcome: z.enum(['missing', 'ambiguous']),
    credits: z.number().nonnegative(),
    projected: z.boolean(),
    pricingAssumption: z.string().min(1).max(240).nullable(),
  }).strict(),
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
  receiptHash: hashSchema,
}).strict();

function dedupeIds(values, label) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function withExactTextHash(value) {
  return {
    ...value,
    exactTextHash: value.exactTextHash ?? sha256(value.exactText ?? ''),
  };
}

function finalize(schema, value, hashField) {
  const receipt = schema.parse({
    ...value,
    [hashField]: sha256(value),
  });
  const unsigned = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== hashField),
  );
  assert(receipt[hashField] === sha256(unsigned), `${hashField} mismatch`);
  return receipt;
}

export function createIntentRequirementsManifest(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Intent requirements manifest input required');
  const scope = dedupeIds(
    (input.scope ?? []).map(value => {
      assert(typeof value === 'string' && value.trim().length > 0, 'Scope entries must be non-empty strings');
      return value.trim();
    }),
    'scope entry',
  );
  const requirements = (input.requirements ?? []).map(item => withExactTextHash(item));
  const seenRequirementIds = new Set();
  for (const requirement of requirements) {
    assert(typeof requirement.id === 'string' && requirement.id.length > 0,
      'Requirement id required');
    assert(!seenRequirementIds.has(requirement.id),
      `Duplicate requirement id: ${requirement.id}`);
    seenRequirementIds.add(requirement.id);
  }
  const exclusions = (input.exclusions ?? []).map(item => withExactTextHash(item));
  const nonGoals = (input.nonGoals ?? []).map(item => withExactTextHash(item));
  const unsigned = {
    version: INTENT_ACCEPTANCE_PACKET_VERSION,
    kind: INTENT_REQUIREMENTS_MANIFEST_KIND,
    workflowId: String(input.workflowId ?? ''),
    sessionId: String(input.sessionId ?? ''),
    promptHash: String(input.promptHash ?? ''),
    promptBindingHash: sha256({
      workflowId: String(input.workflowId ?? ''),
      sessionId: String(input.sessionId ?? ''),
      promptHash: String(input.promptHash ?? ''),
    }),
    captureSource: input.captureSource ?? 'session-routing-state',
    capturePhase: input.capturePhase ?? 'pre-implementation',
    taskMetadata: input.taskMetadata,
    scope,
    requirements,
    exclusions,
    nonGoals,
    createdAt: String(input.createdAt ?? new Date().toISOString()),
  };
  return intentRequirementsManifestSchema.parse({
    ...unsigned,
    manifestHash: sha256(unsigned),
  });
}

export function validateIntentRequirementsManifest(manifest) {
  return intentRequirementsManifestSchema.parse(manifest);
}

export function evaluateIntentAcceptanceEligibility(input) {
  const manifest = input?.kind === INTENT_REQUIREMENTS_MANIFEST_KIND
    ? validateIntentRequirementsManifest(input)
    : createIntentRequirementsManifest(input);
  const { taskMetadata } = manifest;
  const mustCount = manifest.requirements.filter(item => item.priority === 'must').length;
  const successConditionShoulds = manifest.requirements
    .filter(item => item.priority === 'should' && item.successCondition).length;
  const reasons = [];
  if (!taskMetadata.hasImplementation || taskMetadata.changeClass === 'no-implementation') {
    reasons.push('no-implementation');
    return {
      version: INTENT_ACCEPTANCE_PACKET_VERSION,
      eligible: false,
      skip: true,
      reasonCodes: reasons,
      completionGateRequired: false,
      releaseGateRequired: false,
      mustCount,
      successConditionShoulds,
    };
  }
  if ((taskMetadata.changeClass === 'docs-only' || taskMetadata.changeClass === 'copy-only') &&
    taskMetadata.deterministicEvidenceSufficient) {
    reasons.push('docs-or-copy-only-with-sufficient-deterministic-evidence');
    return {
      version: INTENT_ACCEPTANCE_PACKET_VERSION,
      eligible: false,
      skip: true,
      reasonCodes: reasons,
      completionGateRequired: false,
      releaseGateRequired: false,
      mustCount,
      successConditionShoulds,
    };
  }
  if (taskMetadata.changeClass === 'mechanical' &&
    manifest.requirements.length === 1 &&
    taskMetadata.riskLevel === 'low' &&
    !taskMetadata.uxOrRuntimeBehavior &&
    taskMetadata.surfaceCount === 1 &&
    taskMetadata.repositoryCount === 1 &&
    manifest.exclusions.length === 0 &&
    manifest.nonGoals.length === 0 &&
    !taskMetadata.safetySensitive &&
    !taskMetadata.releaseBound &&
    taskMetadata.deterministicEvidenceSufficient) {
    reasons.push('single-low-risk-mechanical-requirement');
    return {
      version: INTENT_ACCEPTANCE_PACKET_VERSION,
      eligible: false,
      skip: true,
      reasonCodes: reasons,
      completionGateRequired: false,
      releaseGateRequired: false,
      mustCount,
      successConditionShoulds,
    };
  }
  const qualifyingReasons = [];
  if (mustCount >= 2) qualifyingReasons.push('multiple-must-requirements');
  if (manifest.exclusions.length > 0 || manifest.nonGoals.length > 0) {
    qualifyingReasons.push('explicit-exclusions-or-non-goals');
  }
  if (taskMetadata.uxOrRuntimeBehavior) qualifyingReasons.push('ux-or-runtime-behavior');
  if (taskMetadata.surfaceCount >= 2 || taskMetadata.repositoryCount >= 2) {
    qualifyingReasons.push('multi-surface-or-multi-repository');
  }
  if (taskMetadata.safetySensitive) qualifyingReasons.push('safety-or-compliance-sensitive');
  if (taskMetadata.releaseBound) qualifyingReasons.push('release-bound');
  return {
    version: INTENT_ACCEPTANCE_PACKET_VERSION,
    eligible: qualifyingReasons.length > 0,
    skip: qualifyingReasons.length === 0,
    reasonCodes: qualifyingReasons.length > 0
      ? qualifyingReasons
      : ['single-low-risk-requirement'],
    completionGateRequired: qualifyingReasons.length > 0,
    releaseGateRequired: qualifyingReasons.length > 0,
    mustCount,
    successConditionShoulds,
  };
}

export function buildIntentAcceptancePacket(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Intent acceptance packet input required');
  const requirementsManifest = input.requirementsManifest?.kind === INTENT_REQUIREMENTS_MANIFEST_KIND
    ? validateIntentRequirementsManifest(input.requirementsManifest)
    : createIntentRequirementsManifest(input.requirementsManifest ?? input);
  const eligibility = evaluateIntentAcceptanceEligibility(requirementsManifest);
  assert(eligibility.eligible,
    `Intent acceptance runs only for qualifying substantive tasks: ${eligibility.reasonCodes.join(', ')}`);
  const implementationRefs = (input.implementationRefs ?? []).map(item => implementationRefSchema.parse(item));
  const evidenceRefs = (input.evidenceRefs ?? []).map(item => evidenceRefSchema.parse(item));
  const reviewRefs = (input.reviewRefs ?? []).map(item => reviewRefSchema.parse(item));
  const coverageMatrix = (input.coverageMatrix ?? []).map(item => coverageEntrySchema.parse(item));
  const knownLimitations = (input.knownLimitations ?? []).map(item => knownLimitationSchema.parse(item));
  const selectedProfile = validateProfile(input.selectedProfile, 'selectedProfile');
  const unsigned = {
    version: INTENT_ACCEPTANCE_PACKET_VERSION,
    kind: INTENT_ACCEPTANCE_PACKET_KIND,
    packetWorkflowVersion: PACKET_WORKFLOW_VERSION,
    policyVersion: String(input.policyVersion ?? ''),
    workflowId: requirementsManifest.workflowId,
    sessionId: requirementsManifest.sessionId,
    promptHash: requirementsManifest.promptHash,
    requirementsManifest,
    requirementsManifestHash: requirementsManifest.manifestHash,
    selectedProfile,
    selectedModelSource: input.selectedModelSource ?? requirementsManifest.captureSource,
    scopeHash: sha256(requirementsManifest.scope),
    implementationRefs,
    evidenceRefs,
    reviewRefs,
    coverageMatrix,
    changeSummary: String(input.changeSummary ?? ''),
    reviewAcceptance: reviewAcceptanceSchema.parse(input.reviewAcceptance),
    knownLimitations,
    baseRevision: String(input.baseRevision ?? ''),
    baseTreeHash: String(input.baseTreeHash ?? ''),
    acceptedRevision: String(input.acceptedRevision ?? ''),
    acceptedTreeHash: String(input.acceptedTreeHash ?? ''),
    revisionBindingHash: sha256({
      baseRevision: String(input.baseRevision ?? ''),
      baseTreeHash: String(input.baseTreeHash ?? ''),
      acceptedRevision: String(input.acceptedRevision ?? ''),
      acceptedTreeHash: String(input.acceptedTreeHash ?? ''),
    }),
    requirementsHash: sha256(requirementsManifest.requirements),
    evidenceHash: sha256(evidenceRefs),
    coverageHash: sha256(coverageMatrix),
    serializedBytes: 0,
    targetSerializedBytes: INTENT_ACCEPTANCE_LIMITS.targetSerializedBytes,
    createdAt: String(input.createdAt ?? new Date().toISOString()),
    expiresAt: String(input.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString()),
  };
  let serializedBytes = 0;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const next = Buffer.byteLength(canonicalJson({
      ...unsigned,
      serializedBytes,
    }));
    if (next === serializedBytes) break;
    serializedBytes = next;
  }
  assert(serializedBytes <= INTENT_ACCEPTANCE_LIMITS.maxSerializedBytes,
    `Intent acceptance packet exceeds ${INTENT_ACCEPTANCE_LIMITS.maxSerializedBytes} bytes; narrow the requirement or evidence set`);
  return intentAcceptancePacketSchema.parse({
    ...unsigned,
    serializedBytes,
    packetHash: sha256({ ...unsigned, serializedBytes }),
  });
}

export function validateIntentAcceptancePacket(packet, options = {}) {
  const parsed = intentAcceptancePacketSchema.parse(packet);
  if (options.requireFresh !== false) {
    const now = options.now ?? Date.now();
    assert(Date.parse(parsed.expiresAt) > now, 'Intent acceptance packet is stale');
  }
  return parsed;
}

function evidenceKindMap(packet) {
  return new Map(packet.evidenceRefs.map(item => [item.id, item.kind]));
}

function coverageByRequirement(packet) {
  return new Map(packet.coverageMatrix.map(entry => [entry.requirementId, entry]));
}

export function validateIntentAcceptanceResult(result, packetInput, options = {}) {
  const packet = validateIntentAcceptancePacket(packetInput, options);
  const parsed = typeof result === 'string'
    ? intentAcceptanceResultSchema.parse(JSON.parse(result))
    : intentAcceptanceResultSchema.parse(result);
  assert(parsed.packetHash === packet.packetHash, 'Intent acceptance result packetHash mismatch');
  if (options.expectedAttempt !== undefined) {
    assert(parsed.attempt === options.expectedAttempt, 'Intent acceptance result attempt mismatch');
  }
  const requirementMap = new Map(packet.requirementsManifest.requirements.map(item => [item.id, item]));
  const coverageMap = coverageByRequirement(packet);
  const evidenceMap = evidenceKindMap(packet);
  const limitationIds = new Set(packet.knownLimitations.map(item => item.id));
  for (const id of parsed.acknowledgedLimitations) {
    assert(limitationIds.has(id), `Unknown limitation ID: ${id}`);
  }
  const seenGapRequirements = new Set();
  for (const gap of parsed.gaps) {
    assert(requirementMap.has(gap.requirementId),
      `Unsupported gap requirement: ${gap.requirementId}`);
    assert(!seenGapRequirements.has(gap.requirementId),
      `Duplicate gap requirement: ${gap.requirementId}`);
    seenGapRequirements.add(gap.requirementId);
  }
  const seenRequirements = new Set();
  const gapByRequirement = new Map(parsed.gaps.map(gap => [gap.requirementId, gap]));
  for (const requirementResult of parsed.requirementResults) {
    assert(requirementMap.has(requirementResult.requirementId),
      `Unsupported requirement: ${requirementResult.requirementId}`);
    assert(!seenRequirements.has(requirementResult.requirementId),
      `Duplicate requirement result: ${requirementResult.requirementId}`);
    seenRequirements.add(requirementResult.requirementId);
    const requirement = requirementMap.get(requirementResult.requirementId);
    const coverage = coverageMap.get(requirementResult.requirementId);
    const evidenceIds = dedupeIds(requirementResult.evidenceIds, 'result evidence id');
    for (const evidenceId of evidenceIds) {
      assert(evidenceMap.has(evidenceId), `Unknown evidence ID: ${evidenceId}`);
      assert(coverage.evidenceIds.includes(evidenceId),
        `Requirement result cites evidence not present in the packet coverage matrix: ${evidenceId}`);
    }
    if (requirementResult.status === 'covered') {
      assert(evidenceIds.length > 0,
        `Covered requirement needs at least one packet evidence ID: ${requirementResult.requirementId}`);
      assert(evidenceIds.some(id => behaviorEvidenceKinds.has(evidenceMap.get(id))),
        `Covered requirement needs behavioral evidence, not reviewer references alone: ${requirementResult.requirementId}`);
      assert(!gapByRequirement.has(requirementResult.requirementId),
        `Covered requirement cannot also declare a gap: ${requirementResult.requirementId}`);
    } else {
      const gap = gapByRequirement.get(requirementResult.requirementId);
      if (parsed.decision === 'accepted') {
        const acknowledged = packet.knownLimitations.some(item =>
          parsed.acknowledgedLimitations.includes(item.id) &&
          item.requirementIds.includes(requirementResult.requirementId));
        assert(acknowledged,
          `Accepted results must acknowledge uncovered requirement limitations: ${requirementResult.requirementId}`);
      } else {
        assert(gap, `Missing or ambiguous requirements need an exact gap: ${requirementResult.requirementId}`);
        assert(gap.type === requirementResult.status,
          `Gap type mismatch for requirement: ${requirementResult.requirementId}`);
      }
    }
    if ((requirement.priority === 'must' ||
      (requirement.priority === 'should' && requirement.successCondition)) &&
      parsed.decision === 'accepted') {
      assert(requirementResult.status === 'covered',
        `Accepted result must cover ${requirement.id}`);
    }
  }
  assert(seenRequirements.size === requirementMap.size,
    'Intent acceptance result must address every requirement exactly once');
  if (parsed.decision === 'accepted') {
    assert(parsed.gaps.length === 0, 'Accepted intent acceptance results cannot carry gaps');
  } else {
    assert(parsed.gaps.length > 0, 'Missing or ambiguous intent acceptance results require gaps');
    assert(parsed.requirementResults.some(item => item.status === parsed.decision),
      `Decision ${parsed.decision} requires at least one ${parsed.decision} requirement`);
  }
  return parsed;
}

function validateSharedReceiptHash(receipt, hashField = 'receiptHash') {
  const unsigned = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== hashField),
  );
  assert(receipt[hashField] === sha256(unsigned), `${hashField} mismatch`);
  return receipt;
}

function assertOutcomeReceiptMatchesPacket(receipt, packet, label) {
  assert(receipt.workflowId === packet.workflowId, `${label} workflow mismatch`);
  assert(receipt.sessionId === packet.sessionId, `${label} session mismatch`);
  assert(receipt.promptHash === packet.promptHash, `${label} prompt mismatch`);
  assert(receipt.packetHash === packet.packetHash, `${label} packet mismatch`);
  assert(receipt.requirementsManifestHash === packet.requirementsManifestHash,
    `${label} requirements manifest mismatch`);
  assert(receipt.requirementsHash === packet.requirementsHash, `${label} requirements mismatch`);
  assert(receipt.evidenceHash === packet.evidenceHash, `${label} evidence mismatch`);
  assert(receipt.coverageHash === packet.coverageHash, `${label} coverage mismatch`);
  assert(receipt.revisionBindingHash === packet.revisionBindingHash, `${label} revision mismatch`);
  assert(receipt.baseRevision === packet.baseRevision &&
    receipt.baseTreeHash === packet.baseTreeHash &&
    receipt.acceptedRevision === packet.acceptedRevision &&
    receipt.acceptedTreeHash === packet.acceptedTreeHash,
  `${label} revision fields mismatch`);
}

export function createIntentAcceptanceDispatchReceipt(input) {
  const packet = validateIntentAcceptancePacket(input.packet ?? input.intentAcceptancePacket);
  const profile = validateProfile(input.profile);
  assert(canonicalJson(profile) === canonicalJson(packet.selectedProfile),
    'Intent acceptance dispatch receipt profile must match the packet selected profile');
  return finalize(intentAcceptanceDispatchReceiptSchema, {
    version: INTENT_ACCEPTANCE_PACKET_VERSION,
    kind: INTENT_ACCEPTANCE_DISPATCH_RECEIPT_KIND,
    workflowId: packet.workflowId,
    sessionId: String(input.sessionId ?? packet.sessionId),
    promptHash: packet.promptHash,
    role: INTENT_ACCEPTANCE_ROLE,
    attempt: Number(input.attempt ?? 1),
    maxAttempts: INTENT_ACCEPTANCE_MAX_ATTEMPTS,
    profile,
    selectedModelSource: input.selectedModelSource ?? packet.selectedModelSource,
    requirementsManifestHash: packet.requirementsManifestHash,
    packetHash: packet.packetHash,
    packetBytes: packet.serializedBytes,
    requirementsHash: packet.requirementsHash,
    evidenceHash: packet.evidenceHash,
    coverageHash: packet.coverageHash,
    revisionBindingHash: packet.revisionBindingHash,
    baseRevision: packet.baseRevision,
    baseTreeHash: packet.baseTreeHash,
    acceptedRevision: packet.acceptedRevision,
    acceptedTreeHash: packet.acceptedTreeHash,
    createdAt: String(input.createdAt ?? new Date().toISOString()),
    expiresAt: String(input.expiresAt ?? packet.expiresAt),
  }, 'receiptHash');
}

export function validateIntentAcceptanceDispatchReceipt(receipt, packetInput, options = {}) {
  const parsed = validateSharedReceiptHash(
    intentAcceptanceDispatchReceiptSchema.parse(receipt),
  );
  const packet = packetInput ? validateIntentAcceptancePacket(packetInput, options) : null;
  if (packet) {
    assert(parsed.workflowId === packet.workflowId, 'Intent acceptance dispatch workflow mismatch');
    assert(parsed.sessionId === packet.sessionId, 'Intent acceptance dispatch session mismatch');
    assert(parsed.promptHash === packet.promptHash, 'Intent acceptance dispatch prompt mismatch');
    assert(parsed.packetHash === packet.packetHash, 'Intent acceptance dispatch packet mismatch');
    assert(parsed.packetBytes === packet.serializedBytes, 'Intent acceptance dispatch packet size mismatch');
    assert(parsed.requirementsManifestHash === packet.requirementsManifestHash,
      'Intent acceptance dispatch requirements manifest mismatch');
    assert(parsed.requirementsHash === packet.requirementsHash,
      'Intent acceptance dispatch requirements hash mismatch');
    assert(parsed.evidenceHash === packet.evidenceHash,
      'Intent acceptance dispatch evidence hash mismatch');
    assert(parsed.coverageHash === packet.coverageHash,
      'Intent acceptance dispatch coverage hash mismatch');
    assert(parsed.revisionBindingHash === packet.revisionBindingHash,
      'Intent acceptance dispatch revision binding mismatch');
    assert(canonicalJson(parsed.profile) === canonicalJson(packet.selectedProfile),
      'Intent acceptance dispatch selected profile mismatch');
    assert(parsed.acceptedRevision === packet.acceptedRevision &&
      parsed.acceptedTreeHash === packet.acceptedTreeHash &&
      parsed.baseRevision === packet.baseRevision &&
      parsed.baseTreeHash === packet.baseTreeHash,
    'Intent acceptance dispatch revision fields mismatch');
  }
  if (options.requireFresh !== false) {
    const now = options.now ?? Date.now();
    assert(Date.parse(parsed.expiresAt) > now, 'Intent acceptance dispatch receipt is stale');
  }
  if (options.expectedProfile) {
    const expectedProfile = validateProfile(options.expectedProfile, 'expectedProfile');
    assert(canonicalJson(parsed.profile) === canonicalJson(expectedProfile),
      'Intent acceptance dispatch profile mismatch');
  }
  return parsed;
}

function sharedOutcomeFields(dispatchReceipt, packet, result, usage, input = {}) {
  return {
    version: INTENT_ACCEPTANCE_PACKET_VERSION,
    workflowId: packet.workflowId,
    sessionId: packet.sessionId,
    promptHash: packet.promptHash,
    role: INTENT_ACCEPTANCE_ROLE,
    attempt: dispatchReceipt.attempt,
    dispatchReceiptHash: dispatchReceipt.receiptHash,
    packetHash: packet.packetHash,
    resultHash: sha256(result),
    requirementsManifestHash: packet.requirementsManifestHash,
    requirementsHash: packet.requirementsHash,
    evidenceHash: packet.evidenceHash,
    coverageHash: packet.coverageHash,
    revisionBindingHash: packet.revisionBindingHash,
    baseRevision: packet.baseRevision,
    baseTreeHash: packet.baseTreeHash,
    acceptedRevision: packet.acceptedRevision,
    acceptedTreeHash: packet.acceptedTreeHash,
    acknowledgedLimitationIds: result.acknowledgedLimitations,
    implementationAuthority: false,
    reviewAuthority: false,
    releaseAuthority: false,
    usage,
    createdAt: String(input.createdAt ?? new Date().toISOString()),
    expiresAt: String(input.expiresAt ?? packet.expiresAt),
  };
}

export function createIntentAcceptanceOutcomeReceipt(input) {
  const packet = validateIntentAcceptancePacket(input.packet ?? input.intentAcceptancePacket);
  const dispatchReceipt = validateIntentAcceptanceDispatchReceipt(input.dispatchReceipt, packet, {
    now: input.now,
  });
  const result = validateIntentAcceptanceResult(input.result, packet, {
    now: input.now,
    expectedAttempt: dispatchReceipt.attempt,
  });
  const usage = createIntentAcceptanceUsageRecord({
    selectedModel: dispatchReceipt.profile.model,
    attemptCount: dispatchReceipt.attempt,
    packetBytes: packet.serializedBytes,
    outcome: result.decision,
    credits: Number(input.credits ?? 0),
    projected: input.projected === true,
    pricingAssumption: input.pricingAssumption ?? null,
  });
  if (result.decision === 'accepted') {
    return finalize(acceptedReceiptSchema, {
      ...sharedOutcomeFields(dispatchReceipt, packet, result, usage, input),
      kind: INTENT_ACCEPTANCE_RECEIPT_KIND,
      coveredRequirementIds: result.requirementResults
        .filter(item => item.status === 'covered')
        .map(item => item.requirementId),
      completionEligibilityGranted: true,
      releaseEligibilityGranted: true,
    }, 'receiptHash');
  }
  return finalize(gapReceiptSchema, {
    ...sharedOutcomeFields(dispatchReceipt, packet, result, usage, input),
    kind: INTENT_ACCEPTANCE_GAP_RECEIPT_KIND,
    decision: result.decision,
    gapRequirementIds: result.gaps.map(gap => gap.requirementId),
    gaps: result.gaps,
    terminal: dispatchReceipt.attempt >= INTENT_ACCEPTANCE_MAX_ATTEMPTS,
    nextAction: dispatchReceipt.attempt >= INTENT_ACCEPTANCE_MAX_ATTEMPTS
      ? 'user-or-operator-resolution-required'
      : 'return-to-implementation-owner',
    completionEligibilityGranted: false,
    releaseEligibilityGranted: false,
  }, 'receiptHash');
}

export function validateIntentAcceptanceOutcomeReceipt(receipt, packetInput, options = {}) {
  const packet = validateIntentAcceptancePacket(packetInput, options);
  if (receipt?.kind === INTENT_ACCEPTANCE_RECEIPT_KIND) {
    const parsed = validateSharedReceiptHash(acceptedReceiptSchema.parse(receipt));
    assertOutcomeReceiptMatchesPacket(parsed, packet, 'Intent acceptance receipt');
    if (options.requireFresh !== false) {
      const now = options.now ?? Date.now();
      assert(Date.parse(parsed.expiresAt) > now, 'Intent acceptance receipt is stale');
    }
    if (options.currentAcceptedRevision) {
      assert(parsed.acceptedRevision === options.currentAcceptedRevision,
        'Intent acceptance receipt acceptedRevision is stale');
    }
    if (options.currentAcceptedTreeHash) {
      assert(parsed.acceptedTreeHash === options.currentAcceptedTreeHash,
        'Intent acceptance receipt acceptedTreeHash is stale');
    }
    return parsed;
  }
  const parsed = validateSharedReceiptHash(gapReceiptSchema.parse(receipt));
  assertOutcomeReceiptMatchesPacket(parsed, packet, 'Intent acceptance gap receipt');
  if (options.requireFresh !== false) {
    const now = options.now ?? Date.now();
    assert(Date.parse(parsed.expiresAt) > now, 'Intent acceptance gap receipt is stale');
  }
  return parsed;
}

export function evaluateIntentAcceptanceGate(input) {
  const packet = validateIntentAcceptancePacket(input.packet, {
    now: input.now,
    requireFresh: false,
  });
  const eligibility = evaluateIntentAcceptanceEligibility(packet.requirementsManifest);
  if (!eligibility.eligible) {
    return {
      required: false,
      completionEligible: true,
      releaseEligible: true,
      releaseAuthority: false,
      reasons: eligibility.reasonCodes,
    };
  }
  const reasons = [];
  if (input.deterministicValidationAccepted !== true) {
    reasons.push('deterministic validation has not accepted the change');
  }
  if (input.independentReviewAccepted !== true) {
    reasons.push('independent review has not accepted the change');
  }
  if (!input.receipt) {
    reasons.push('user-intent-acceptance has not accepted the packet');
    return {
      required: true,
      completionEligible: false,
      releaseEligible: false,
      releaseAuthority: false,
      reasons,
    };
  }
  const receipt = validateIntentAcceptanceOutcomeReceipt(input.receipt, packet, {
    now: input.now,
    currentAcceptedRevision: input.currentAcceptedRevision ?? packet.acceptedRevision,
    currentAcceptedTreeHash: input.currentAcceptedTreeHash ?? packet.acceptedTreeHash,
  });
  if (receipt.kind !== INTENT_ACCEPTANCE_RECEIPT_KIND) {
    reasons.push(receipt.terminal
      ? 'user-intent-acceptance failed twice and requires user or operator resolution'
      : 'user-intent-acceptance returned exact gaps that require one remediation loop');
  }
  return {
    required: true,
    completionEligible: reasons.length === 0 && receipt.kind === INTENT_ACCEPTANCE_RECEIPT_KIND,
    releaseEligible: reasons.length === 0 && receipt.kind === INTENT_ACCEPTANCE_RECEIPT_KIND,
    releaseAuthority: false,
    reasons,
  };
}

export function defaultIntentAcceptancePrompt(packet, dispatchReceipt) {
  return [
    'Determine only whether the accepted result covers the user request.',
    'This is not code review, implementation, architecture, or release approval.',
    'Do not use or request tools.',
    'Return exact JSON only with this schema:',
    `{"version":1,"role":"${INTENT_ACCEPTANCE_ROLE}","packetHash":"${packet.packetHash}","attempt":${dispatchReceipt.attempt},"decision":"accepted|missing|ambiguous","requirementResults":[{"requirementId":"...","status":"covered|missing|ambiguous","reason":"...","evidenceIds":["packet-evidence-id"]}],"gaps":[{"requirementId":"...","type":"missing|ambiguous","neededEvidence":"... or null","neededChange":"... or null"}],"acknowledgedLimitations":["packet-limitation-id"],"implementationAuthority":false,"reviewAuthority":false,"releaseAuthority":false}`,
    'Every must requirement and every should requirement marked as a success condition must be covered for accepted.',
    'Use only packet evidence IDs. Do not suggest extras or quality improvements.',
    `Packet hash: ${packet.packetHash}`,
    `Packet: ${JSON.stringify(packet)}`,
  ].join('\n');
}

function usage() {
  return 'Usage: intent-acceptance.mjs eligibility INPUT.json | packet INPUT.json | validate-packet INPUT.json | validate-result RESULT.json PACKET.json | receipt INPUT.json | validate-receipt RECEIPT.json PACKET.json';
}

function main(argv = process.argv.slice(2)) {
  const [command, file, packetFile] = argv;
  assert(command, usage());
  if (command === 'eligibility') {
    assert(file, usage());
    process.stdout.write(`${JSON.stringify(evaluateIntentAcceptanceEligibility(
      JSON.parse(fs.readFileSync(file, 'utf8')),
    ), null, 2)}\n`);
    return;
  }
  if (command === 'packet') {
    assert(file, usage());
    process.stdout.write(`${JSON.stringify(buildIntentAcceptancePacket(
      JSON.parse(fs.readFileSync(file, 'utf8')),
    ), null, 2)}\n`);
    return;
  }
  if (command === 'validate-packet') {
    assert(file, usage());
    process.stdout.write(`${JSON.stringify(validateIntentAcceptancePacket(
      JSON.parse(fs.readFileSync(file, 'utf8')),
    ), null, 2)}\n`);
    return;
  }
  if (command === 'validate-result') {
    assert(file && packetFile, usage());
    process.stdout.write(`${JSON.stringify(validateIntentAcceptanceResult(
      JSON.parse(fs.readFileSync(file, 'utf8')),
      JSON.parse(fs.readFileSync(packetFile, 'utf8')),
    ), null, 2)}\n`);
    return;
  }
  if (command === 'receipt') {
    assert(file, usage());
    process.stdout.write(`${JSON.stringify(createIntentAcceptanceOutcomeReceipt(
      JSON.parse(fs.readFileSync(file, 'utf8')),
    ), null, 2)}\n`);
    return;
  }
  if (command === 'validate-receipt') {
    assert(file && packetFile, usage());
    process.stdout.write(`${JSON.stringify(validateIntentAcceptanceOutcomeReceipt(
      JSON.parse(fs.readFileSync(file, 'utf8')),
      JSON.parse(fs.readFileSync(packetFile, 'utf8')),
    ), null, 2)}\n`);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`intent-acceptance: ${error.message}`);
    process.exitCode = 1;
  }
}
