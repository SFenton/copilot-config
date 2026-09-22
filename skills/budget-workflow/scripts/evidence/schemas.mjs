import crypto from 'node:crypto';
import { z } from 'zod';
import {
  SUPPORTED_CONTEXT_VALUES,
  SUPPORTED_EFFORT_VALUES,
} from '../model-catalog.mjs';

export const EVIDENCE_PACKET_VERSION = 2;
export const RECEIPT_VERSION = 2;
export const PACKET_WORKFLOW_VERSION = 2;
export const RESEARCH_PACKET_KIND = 'frozen-research-evidence-packet';
export const EVIDENCE_PACKET_RECEIPT_KIND = 'evidence-packet-receipt';
export const FRONTIER_DISPATCH_RECEIPT_KIND = 'frontier-dispatch-receipt';
export const HISTORY_QUERY_RECEIPT_KIND = 'history-query-receipt';
export const TANDEM_PAIR_RECEIPT_KIND = 'tandem-pair-receipt';

export const RESEARCH_MODES = Object.freeze([
  'repository',
  'external',
  'hybrid',
  'history',
]);

export const REASON_ONLY_TOOL_MODE = 'reason-only';
export const REASON_ONLY_RESULT_KINDS = Object.freeze([
  'findings',
  'blocked',
  'evidence-gap-request',
]);

export const PACKET_LIMITS = Object.freeze({
  maxSerializedBytes: 48 * 1024,
  maxSources: 12,
  maxExcerpts: 32,
  maxExcerptCharacters: 1500,
  maxExcerptTextBytes: 28 * 1024,
  maxDeltaPacketBytes: 16 * 1024,
  maxGapRequests: 6,
  maxGapLoops: 2,
});

export const USAGE_ACCOUNTING_CATEGORIES = Object.freeze([
  'deterministic-evidence',
  'cheap-curation',
  'history-curation',
  'sol-research',
  'gpt6-sol-research',
  'astra-research',
  'research-adjudication',
  'user-intent-acceptance',
  'downstream-implementation',
]);

export const FRONTIER_REASONING_ROLES = Object.freeze([
  'frontier-research',
  'frontier-adjudication',
  'tandem-secondary-research',
]);

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const effortSchema = z.enum(SUPPORTED_EFFORT_VALUES);
const contextSchema = z.enum(SUPPORTED_CONTEXT_VALUES);
const citationKindSchema = z.enum(['repository', 'external', 'history']);
const sourceKindSchema = z.enum(['repository', 'external', 'history']);
const researchModeSchema = z.enum(RESEARCH_MODES);
const usageCategorySchema = z.enum(USAGE_ACCOUNTING_CATEGORIES);
const frontierRoleSchema = z.enum(FRONTIER_REASONING_ROLES);
const hashSchema = z.string().regex(HASH_PATTERN);
const isoDateSchema = z.string().regex(ISO_DATE_PATTERN);
const EXACT_FRONTIER_PROFILES = Object.freeze({
  'frontier-research': Object.freeze({
    model: 'gpt-5.6-sol',
    effort: 'max',
    context: 'default',
  }),
  'frontier-adjudication': Object.freeze({
    model: 'gpt-5.6-sol',
    effort: 'max',
    context: 'default',
  }),
  'tandem-secondary-research': Object.freeze({
    model: 'gpt-6-sol',
    effort: 'max',
    context: 'default',
  }),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonicalValue(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value)
      ? value
      : canonicalJson(value))
    .digest('hex');
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function exactProfileMatches(profile, expected) {
  return profile.model === expected.model &&
    profile.effort === expected.effort &&
    profile.context === expected.context;
}

function exactFrontierProfile(role) {
  const profile = EXACT_FRONTIER_PROFILES[role];
  assert(profile, `Unsupported frontier role: ${role}`);
  return profile;
}

function exactProfileIssue(ctx, label, expected) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `${label} must use ${expected.model}/${expected.effort}/${expected.context}`,
  });
}

export function normalizedQuestionBinding(question) {
  const normalized = normalizeText(question);
  assert(normalized.length > 0, 'Question required');
  const safeNormalized = normalized.length <= 600 ? normalized : null;
  return {
    normalized: safeNormalized,
    questionHash: sha256(safeNormalized ?? normalized),
  };
}

export function normalizeExactScope(scope) {
  if (typeof scope === 'string' && scope.trim()) return [scope.trim()];
  assert(Array.isArray(scope) && scope.length > 0,
    'Scope must contain one or more exact strings');
  const values = scope.map(value => {
    assert(typeof value === 'string' && value.trim().length > 0,
      'Scope entries must be non-empty strings');
    return value.trim();
  });
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

const profileSchema = z.object({
  model: z.string().min(1).max(80),
  effort: effortSchema,
  context: contextSchema,
}).strict();

const questionBindingSchema = z.object({
  normalized: z.string().min(1).max(600).nullable().optional(),
  questionHash: hashSchema,
}).strict().superRefine((value, ctx) => {
  if (value.normalized !== undefined && value.normalized !== null) {
    if (sha256(value.normalized) !== value.questionHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Question binding hash mismatch',
      });
    }
  }
});

const repositoryCitationSchema = z.object({
  kind: z.literal('repository'),
  path: z.string().min(1).max(400),
  start: z.number().int().min(1),
  end: z.number().int().min(1),
}).strict().superRefine((value, ctx) => {
  if (value.end < value.start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Repository citation range is invalid',
    });
  }
});

const externalCitationSchema = z.object({
  kind: z.literal('external'),
  paragraphIds: z.array(z.string().min(1).max(120)).min(1).max(12),
}).strict();

const historyCitationSchema = z.object({
  kind: z.literal('history'),
  sessionRef: z.string().min(1).max(40),
  templateId: z.string().min(1).max(80),
  snippetId: z.string().min(1).max(80),
}).strict();

const citationSchema = z.discriminatedUnion('kind', [
  repositoryCitationSchema,
  externalCitationSchema,
  historyCitationSchema,
]);

const repositorySourceSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.literal('repository'),
  path: z.string().min(1).max(400),
  start: z.number().int().min(1),
  end: z.number().int().min(1),
  sha256: hashSchema,
  openedAt: isoDateSchema,
  completeUnit: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.end < value.start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Repository source range is invalid',
    });
  }
});

const externalSourceSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.literal('external'),
  url: z.string().url().max(2000),
  title: z.string().min(1).max(240),
  sha256: hashSchema,
  verifiedAt: isoDateSchema,
  paragraphIds: z.array(z.string().min(1).max(120)).min(1).max(12),
}).strict();

const historySourceSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.literal('history'),
  templateId: z.string().min(1).max(80),
  sessionRef: z.string().min(1).max(40),
  summary: z.string().min(1).max(240),
  occurredAt: isoDateSchema,
  queryHash: hashSchema,
}).strict();

const sourceCatalogEntrySchema = z.discriminatedUnion('kind', [
  repositorySourceSchema,
  externalSourceSchema,
  historySourceSchema,
]);

const excerptSchema = z.object({
  id: z.string().min(1).max(80),
  sourceId: z.string().min(1).max(80),
  citation: citationSchema,
  text: z.string().min(1).max(PACKET_LIMITS.maxExcerptCharacters),
  textHash: hashSchema,
  focus: z.string().min(1).max(240).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (sha256(value.text) !== value.textHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Excerpt text hash mismatch',
    });
  }
});

const compactionSchema = z.object({
  dedupedSources: z.number().int().min(0),
  dedupedExcerpts: z.number().int().min(0),
  trimmedSourceIds: z.array(z.string().min(1).max(80)).max(64),
  trimmedExcerptIds: z.array(z.string().min(1).max(80)).max(128),
}).strict();

export const frozenResearchEvidencePacketSchema = z.object({
  version: z.literal(EVIDENCE_PACKET_VERSION),
  kind: z.literal(RESEARCH_PACKET_KIND),
  packetWorkflowVersion: z.literal(PACKET_WORKFLOW_VERSION),
  workflowId: z.string().min(1).max(120),
  promptHash: hashSchema,
  questionBinding: questionBindingSchema,
  mode: researchModeSchema,
  scope: z.array(z.string().min(1).max(240)).min(1).max(20),
  scopeHash: hashSchema,
  repository: z.object({
    root: z.string().min(1).max(1200),
    baseRevision: z.string().min(1).max(128),
    policyHash: hashSchema,
  }).strict().nullable(),
  sourceCatalog: z.array(sourceCatalogEntrySchema).min(1).max(PACKET_LIMITS.maxSources),
  excerpts: z.array(excerptSchema).min(1).max(PACKET_LIMITS.maxExcerpts),
  excerptTextBytes: z.number().int().min(1).max(PACKET_LIMITS.maxExcerptTextBytes),
  serializedBytes: z.number().int().min(1).max(PACKET_LIMITS.maxSerializedBytes),
  compaction: compactionSchema,
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
  parentPacketHash: hashSchema.nullable(),
  deltaFromPacketHash: hashSchema.nullable(),
  packetHash: hashSchema,
}).strict().superRefine((packet, ctx) => {
  if (packet.scopeHash !== sha256(packet.scope)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Packet scopeHash mismatch',
    });
  }
  if (packet.mode === 'external' && packet.repository !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'External packets cannot carry repository bindings',
    });
  }
  if (packet.mode !== 'external' && packet.mode !== 'history' &&
    packet.repository === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Repository and hybrid packets require repository bindings',
    });
  }
  if (packet.mode === 'history' && packet.repository !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'History packets cannot carry repository bindings',
    });
  }
  const sourceIds = new Set(packet.sourceCatalog.map(source => source.id));
  if (sourceIds.size !== packet.sourceCatalog.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Packet source IDs must be unique',
    });
  }
  for (const excerpt of packet.excerpts) {
    if (!sourceIds.has(excerpt.sourceId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Excerpt source is absent from the source catalog: ${excerpt.sourceId}`,
      });
    }
  }
  const excerptBytes = packet.excerpts.reduce((sum, excerpt) =>
    sum + Buffer.byteLength(excerpt.text), 0);
  if (excerptBytes !== packet.excerptTextBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Packet excerptTextBytes mismatch',
    });
  }
  const { packetHash, ...unsigned } = packet;
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
  if (packet.deltaFromPacketHash !== null && packet.parentPacketHash === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Delta packets require a parentPacketHash',
    });
  }
});

const usageLineageEntrySchema = z.object({
  category: usageCategorySchema,
  usageHash: hashSchema.nullable(),
  reservedCredits: z.number().nonnegative().nullable(),
  actualCredits: z.number().nonnegative().nullable(),
}).strict();

const sharedReceiptSchema = z.object({
  version: z.literal(RECEIPT_VERSION),
  workflowId: z.string().min(1).max(120),
  promptHash: hashSchema,
  questionHash: hashSchema,
  mode: researchModeSchema,
  scopeHash: hashSchema,
  packetWorkflowVersion: z.literal(PACKET_WORKFLOW_VERSION),
  packetHash: hashSchema,
  toolMode: z.literal(REASON_ONLY_TOOL_MODE),
  parentReceiptHash: hashSchema.nullable(),
  deltaPacketHash: hashSchema.nullable(),
  usageLineage: z.array(usageLineageEntrySchema).max(12),
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
}).strict();

export const evidencePacketReceiptSchema = sharedReceiptSchema.extend({
  kind: z.literal(EVIDENCE_PACKET_RECEIPT_KIND),
  repositoryRoot: z.string().min(1).max(1200).nullable(),
  baseRevision: z.string().min(1).max(128).nullable(),
  policyHash: hashSchema.nullable(),
  sourceCatalogHash: hashSchema,
  excerptHash: hashSchema,
  packetCreatedAt: isoDateSchema,
  packetExpiresAt: isoDateSchema,
  packetParentHash: hashSchema.nullable(),
  packetDeltaHash: hashSchema.nullable(),
  receiptHash: hashSchema,
}).strict();

export const frontierDispatchReceiptSchema = sharedReceiptSchema.extend({
  kind: z.literal(FRONTIER_DISPATCH_RECEIPT_KIND),
  role: frontierRoleSchema,
  profile: profileSchema,
  evidencePacketReceiptHash: hashSchema,
  tandemPairReceiptHash: hashSchema.nullable(),
  receiptHash: hashSchema,
}).strict().superRefine((receipt, ctx) => {
  const expected = exactFrontierProfile(receipt.role);
  if (!exactProfileMatches(receipt.profile, expected)) {
    exactProfileIssue(ctx, `Frontier dispatch receipt role ${receipt.role}`, expected);
  }
});

export const tandemPairReceiptSchema = z.object({
  version: z.literal(RECEIPT_VERSION),
  kind: z.literal(TANDEM_PAIR_RECEIPT_KIND),
  workflowId: z.string().min(1).max(120),
  promptHash: hashSchema,
  questionHash: hashSchema,
  mode: researchModeSchema,
  scopeHash: hashSchema,
  packetWorkflowVersion: z.literal(PACKET_WORKFLOW_VERSION),
  packetHash: hashSchema,
  toolMode: z.literal(REASON_ONLY_TOOL_MODE),
  primaryRole: z.literal('frontier-research'),
  primaryProfile: profileSchema,
  secondaryRole: z.literal('tandem-secondary-research'),
  secondaryProfile: profileSchema,
  primaryDispatchReceiptHash: hashSchema,
  secondaryDispatchReceiptHash: hashSchema,
  gapLoops: z.number().int().min(0).max(PACKET_LIMITS.maxGapLoops),
  comparisonMatrixHash: hashSchema.nullable(),
  adjudicationDispatchReceiptHash: hashSchema.nullable(),
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
  receiptHash: hashSchema,
}).strict().superRefine((receipt, ctx) => {
  const primary = exactFrontierProfile('frontier-research');
  if (!exactProfileMatches(receipt.primaryProfile, primary)) {
    exactProfileIssue(ctx, 'Tandem pair primary profile', primary);
  }
  const secondary = exactFrontierProfile('tandem-secondary-research');
  if (!exactProfileMatches(receipt.secondaryProfile, secondary)) {
    exactProfileIssue(ctx, 'Tandem pair secondary profile', secondary);
  }
});

export const historyQueryReceiptSchema = z.object({
  version: z.literal(RECEIPT_VERSION),
  kind: z.literal(HISTORY_QUERY_RECEIPT_KIND),
  workflowId: z.string().min(1).max(120),
  promptHash: hashSchema,
  questionHash: hashSchema,
  mode: z.literal('history'),
  scopeHash: hashSchema,
  packetWorkflowVersion: z.literal(PACKET_WORKFLOW_VERSION),
  packetHash: hashSchema,
  templateId: z.string().min(1).max(80),
  queryHash: hashSchema,
  source: z.enum(['cloud', 'local']),
  sessionBindings: z.array(z.object({
    sessionRef: z.string().min(1).max(40),
    sessionId: z.string().min(1).max(160),
  }).strict()).max(20),
  toolMode: z.literal(REASON_ONLY_TOOL_MODE),
  parentReceiptHash: hashSchema.nullable(),
  deltaPacketHash: hashSchema.nullable(),
  usageLineage: z.array(usageLineageEntrySchema).max(12),
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
  receiptHash: hashSchema,
}).strict();

const supportedCitationSchema = z.object({
  sourceId: z.string().min(1).max(80),
  quote: z.string().min(1).max(240).optional(),
}).strict();

const researchFindingSchema = z.object({
  id: z.string().min(1).max(80),
  summary: z.string().min(1).max(600),
  confidence: z.enum(['low', 'medium', 'high']),
  citations: z.array(supportedCitationSchema).min(1).max(6),
}).strict();

export const evidenceGapRequestSchema = z.object({
  version: z.literal(EVIDENCE_PACKET_VERSION),
  kind: z.literal('evidence-gap-request'),
  packetHash: hashSchema,
  loop: z.number().int().min(1).max(PACKET_LIMITS.maxGapLoops),
  expectedDecisionImpact: z.string().min(1).max(300),
  requests: z.array(z.object({
    mode: researchModeSchema,
    query: z.string().min(1).max(240).optional(),
    path: z.string().min(1).max(400).optional(),
    focus: z.string().min(1).max(240).optional(),
    template: z.string().min(1).max(80).optional(),
    maxBytes: z.number().int().min(256).max(PACKET_LIMITS.maxDeltaPacketBytes),
  }).strict().superRefine((value, ctx) => {
    const selected = ['query', 'path', 'focus', 'template']
      .filter(key => value[key] !== undefined);
    if (selected.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence gap requests need at least one exact field',
      });
    }
  })).min(1).max(PACKET_LIMITS.maxGapRequests),
}).strict();

export const reasonOnlyFindingsSchema = z.object({
  version: z.literal(EVIDENCE_PACKET_VERSION),
  kind: z.literal('findings'),
  packetHash: hashSchema,
  findings: z.array(researchFindingSchema).min(1).max(12),
  blockedReason: z.null().optional(),
  remainingUncertainty: z.array(z.string().min(1).max(240)).max(8).default([]),
}).strict();

export const reasonOnlyBlockedSchema = z.object({
  version: z.literal(EVIDENCE_PACKET_VERSION),
  kind: z.literal('blocked'),
  packetHash: hashSchema,
  blockedReason: z.string().min(1).max(600),
  findings: z.array(researchFindingSchema).max(6).default([]),
  remainingUncertainty: z.array(z.string().min(1).max(240)).max(8).default([]),
}).strict();

export const reasonOnlyResearchResultSchema = z.discriminatedUnion('kind', [
  reasonOnlyFindingsSchema,
  reasonOnlyBlockedSchema,
  evidenceGapRequestSchema,
]);

export function validateProfile(value, label = 'profile') {
  return profileSchema.parse(value, { path: [label] });
}

function dedupeBy(values, keyFor) {
  const kept = [];
  const duplicates = [];
  const seen = new Set();
  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) {
      duplicates.push(value);
      continue;
    }
    seen.add(key);
    kept.push(value);
  }
  return { kept, duplicates };
}

function packetRepositoryBinding(mode, repository) {
  if (mode === 'external' || mode === 'history') {
    assert(repository === null || repository === undefined,
      `${mode} packets cannot carry repository bindings`);
    return null;
  }
  assert(repository && typeof repository === 'object' && !Array.isArray(repository),
    'Repository and hybrid packets require repository bindings');
  return {
    root: String(repository.root ?? ''),
    baseRevision: String(repository.baseRevision ?? ''),
    policyHash: String(repository.policyHash ?? ''),
  };
}

function citationKey(citation) {
  return canonicalJson(citation);
}

function excerptId(index, sourceId) {
  return `x_${String(index + 1).padStart(2, '0')}_${sourceId.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48)}`;
}

export function buildFrozenEvidencePacket(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    'Packet input required');
  const mode = researchModeSchema.parse(input.mode);
  const questionBinding = input.questionBinding
    ? questionBindingSchema.parse(input.questionBinding)
    : normalizedQuestionBinding(input.question);
  const scope = normalizeExactScope(input.scope);
  const createdAt = String(input.createdAt ?? new Date().toISOString());
  const expiresAt = String(input.expiresAt ?? new Date(Date.parse(createdAt) + 30 * 60 * 1000).toISOString());
  const catalog = dedupeBy((input.sourceCatalog ?? []).map(entry =>
    sourceCatalogEntrySchema.parse(entry)), entry => entry.id);
  const excerpts = dedupeBy((input.excerpts ?? []).map((excerpt, index) => {
    const parsed = excerptSchema.parse({
      ...excerpt,
      id: excerpt.id ?? excerptId(index, String(excerpt.sourceId ?? 'source')),
      textHash: excerpt.textHash ?? sha256(excerpt.text ?? ''),
    });
    return parsed;
  }), excerpt => `${excerpt.sourceId}:${citationKey(excerpt.citation)}:${excerpt.textHash}`);
  let trimmedSourceIds = [];
  let trimmedExcerptIds = [];
  const overflowStrategy = options.overflowStrategy ?? 'fail';
  let sourceCatalog = catalog.kept;
  let excerptEntries = excerpts.kept;
  if (sourceCatalog.length > PACKET_LIMITS.maxSources) {
    if (overflowStrategy !== 'trim') {
      throw new Error(`Packet source count exceeds ${PACKET_LIMITS.maxSources}; narrow the evidence set`);
    }
    trimmedSourceIds = sourceCatalog.slice(PACKET_LIMITS.maxSources).map(source => source.id);
    sourceCatalog = sourceCatalog.slice(0, PACKET_LIMITS.maxSources);
    const allowed = new Set(sourceCatalog.map(source => source.id));
    excerptEntries = excerptEntries.filter(excerpt => allowed.has(excerpt.sourceId));
  }
  if (excerptEntries.length > PACKET_LIMITS.maxExcerpts) {
    if (overflowStrategy !== 'trim') {
      throw new Error(`Packet excerpt count exceeds ${PACKET_LIMITS.maxExcerpts}; narrow the evidence set`);
    }
    trimmedExcerptIds = excerptEntries.slice(PACKET_LIMITS.maxExcerpts).map(excerpt => excerpt.id);
    excerptEntries = excerptEntries.slice(0, PACKET_LIMITS.maxExcerpts);
  }
  const excerptTextBytes = excerptEntries.reduce((sum, excerpt) =>
    sum + Buffer.byteLength(excerpt.text), 0);
  assert(excerptTextBytes <= PACKET_LIMITS.maxExcerptTextBytes,
    `Packet excerpt text exceeds ${PACKET_LIMITS.maxExcerptTextBytes} bytes; narrow the evidence set`);
  const repository = packetRepositoryBinding(mode, input.repository ?? null);
  const unsigned = {
    version: EVIDENCE_PACKET_VERSION,
    kind: RESEARCH_PACKET_KIND,
    packetWorkflowVersion: PACKET_WORKFLOW_VERSION,
    workflowId: String(input.workflowId ?? ''),
    promptHash: String(input.promptHash ?? ''),
    questionBinding,
    mode,
    scope,
    scopeHash: sha256(scope),
    repository,
    sourceCatalog,
    excerpts: excerptEntries,
    excerptTextBytes,
    serializedBytes: 0,
    compaction: {
      dedupedSources: catalog.duplicates.length,
      dedupedExcerpts: excerpts.duplicates.length,
      trimmedSourceIds,
      trimmedExcerptIds,
    },
    createdAt,
    expiresAt,
    parentPacketHash: input.parentPacketHash ?? null,
    deltaFromPacketHash: input.deltaFromPacketHash ?? null,
  };
  assert(hashSchema.safeParse(unsigned.promptHash).success,
    'Packet promptHash required');
  assert(typeof unsigned.workflowId === 'string' && unsigned.workflowId.length > 0,
    'Packet workflowId required');
  let serializedBytes = 0;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const next = Buffer.byteLength(canonicalJson({
      ...unsigned,
      serializedBytes,
    }));
    if (next === serializedBytes) break;
    serializedBytes = next;
  }
  assert(serializedBytes <= PACKET_LIMITS.maxSerializedBytes,
    `Packet serialized size exceeds ${PACKET_LIMITS.maxSerializedBytes} bytes; narrow the evidence set`);
  const packet = {
    ...unsigned,
    serializedBytes,
    packetHash: sha256({ ...unsigned, serializedBytes }),
  };
  return frozenResearchEvidencePacketSchema.parse(packet);
}

export function validateFrozenEvidencePacket(packet) {
  return frozenResearchEvidencePacketSchema.parse(packet);
}

function sharedReceiptFields(kind, input) {
  const fields = {
    version: RECEIPT_VERSION,
    kind,
    workflowId: input.workflowId,
    promptHash: input.promptHash,
    questionHash: input.questionHash,
    mode: input.mode,
    scopeHash: input.scopeHash,
    packetWorkflowVersion: PACKET_WORKFLOW_VERSION,
    packetHash: input.packetHash,
    toolMode: REASON_ONLY_TOOL_MODE,
    parentReceiptHash: input.parentReceiptHash ?? null,
    deltaPacketHash: input.deltaPacketHash ?? null,
    usageLineage: input.usageLineage ?? [],
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  return fields;
}

function finalizeReceipt(schema, value) {
  const receipt = schema.parse({
    ...value,
    receiptHash: sha256(value),
  });
  assert(receipt.receiptHash === sha256(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptHash'),
  )), 'Receipt hash mismatch');
  return receipt;
}

export function createEvidencePacketReceipt(packet, input = {}) {
  const verified = validateFrozenEvidencePacket(packet);
  return finalizeReceipt(evidencePacketReceiptSchema, {
    ...sharedReceiptFields(EVIDENCE_PACKET_RECEIPT_KIND, {
      workflowId: verified.workflowId,
      promptHash: verified.promptHash,
      questionHash: verified.questionBinding.questionHash,
      mode: verified.mode,
      scopeHash: verified.scopeHash,
      packetHash: verified.packetHash,
      parentReceiptHash: input.parentReceiptHash ?? null,
      deltaPacketHash: verified.deltaFromPacketHash,
      usageLineage: input.usageLineage ?? [{
        category: verified.mode === 'history' ? 'history-curation' : 'deterministic-evidence',
        usageHash: input.usageHash ?? null,
        reservedCredits: 0,
        actualCredits: 0,
      }],
      createdAt: input.createdAt ?? verified.createdAt,
      expiresAt: input.expiresAt ?? verified.expiresAt,
    }),
    repositoryRoot: verified.repository?.root ?? null,
    baseRevision: verified.repository?.baseRevision ?? null,
    policyHash: verified.repository?.policyHash ?? null,
    sourceCatalogHash: sha256(verified.sourceCatalog),
    excerptHash: sha256(verified.excerpts),
    packetCreatedAt: verified.createdAt,
    packetExpiresAt: verified.expiresAt,
    packetParentHash: verified.parentPacketHash,
    packetDeltaHash: verified.deltaFromPacketHash,
  });
}

export function createFrontierDispatchReceipt(input) {
  const role = frontierRoleSchema.parse(input.role);
  const profile = validateProfile(input.profile);
  const expected = exactFrontierProfile(role);
  assert(exactProfileMatches(profile, expected),
    `Frontier dispatch receipt role ${role} must use ${expected.model}/${expected.effort}/${expected.context}`);
  return finalizeReceipt(frontierDispatchReceiptSchema, {
    ...sharedReceiptFields(FRONTIER_DISPATCH_RECEIPT_KIND, input),
    role,
    profile,
    evidencePacketReceiptHash: input.evidencePacketReceiptHash,
    tandemPairReceiptHash: input.tandemPairReceiptHash ?? null,
  });
}

export function createTandemPairReceipt(input) {
  const primaryProfile = validateProfile(input.primaryProfile);
  const expectedPrimary = exactFrontierProfile('frontier-research');
  assert(exactProfileMatches(primaryProfile, expectedPrimary),
    `Tandem pair primary profile must use ${expectedPrimary.model}/${expectedPrimary.effort}/${expectedPrimary.context}`);
  const secondaryProfile = validateProfile(input.secondaryProfile);
  const expectedSecondary = exactFrontierProfile('tandem-secondary-research');
  assert(exactProfileMatches(secondaryProfile, expectedSecondary),
    `Tandem pair secondary profile must use ${expectedSecondary.model}/${expectedSecondary.effort}/${expectedSecondary.context}`);
  return finalizeReceipt(tandemPairReceiptSchema, {
    version: RECEIPT_VERSION,
    kind: TANDEM_PAIR_RECEIPT_KIND,
    workflowId: input.workflowId,
    promptHash: input.promptHash,
    questionHash: input.questionHash,
    mode: researchModeSchema.parse(input.mode),
    scopeHash: input.scopeHash,
    packetWorkflowVersion: PACKET_WORKFLOW_VERSION,
    packetHash: input.packetHash,
    toolMode: REASON_ONLY_TOOL_MODE,
    primaryRole: 'frontier-research',
    primaryProfile,
    secondaryRole: 'tandem-secondary-research',
    secondaryProfile,
    primaryDispatchReceiptHash: input.primaryDispatchReceiptHash,
    secondaryDispatchReceiptHash: input.secondaryDispatchReceiptHash,
    gapLoops: input.gapLoops ?? 0,
    comparisonMatrixHash: input.comparisonMatrixHash ?? null,
    adjudicationDispatchReceiptHash: input.adjudicationDispatchReceiptHash ?? null,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}

export function createHistoryQueryReceipt(input) {
  return finalizeReceipt(historyQueryReceiptSchema, {
    ...sharedReceiptFields(HISTORY_QUERY_RECEIPT_KIND, {
      ...input,
      mode: 'history',
    }),
    templateId: input.templateId,
    queryHash: input.queryHash,
    source: input.source,
    sessionBindings: input.sessionBindings ?? [],
  });
}

function verifyReceipt(schema, receipt) {
  const parsed = schema.parse(receipt);
  const { receiptHash, ...unsigned } = parsed;
  assert(receiptHash === sha256(unsigned), 'Receipt hash mismatch');
  return parsed;
}

export function validateEvidencePacketReceipt(receipt) {
  return verifyReceipt(evidencePacketReceiptSchema, receipt);
}

export function validateFrontierDispatchReceipt(receipt) {
  return verifyReceipt(frontierDispatchReceiptSchema, receipt);
}

export function validateTandemPairReceipt(receipt) {
  return verifyReceipt(tandemPairReceiptSchema, receipt);
}

export function validateHistoryQueryReceipt(receipt) {
  return verifyReceipt(historyQueryReceiptSchema, receipt);
}

export function validateEvidenceGapRequest(request, packet, loop = request?.loop) {
  const parsed = evidenceGapRequestSchema.parse(request);
  const verified = validateFrozenEvidencePacket(packet);
  assert(parsed.packetHash === verified.packetHash,
    'Evidence gap request packetHash mismatch');
  assert(parsed.loop === loop, 'Evidence gap loop mismatch');
  return parsed;
}

export function validateReasonOnlyResearchResult(result, packet, options = {}) {
  const parsed = typeof result === 'string'
    ? reasonOnlyResearchResultSchema.parse(JSON.parse(result))
    : reasonOnlyResearchResultSchema.parse(result);
  const verified = validateFrozenEvidencePacket(packet);
  assert(parsed.packetHash === verified.packetHash,
    'Reason-only result packetHash mismatch');
  if (parsed.kind === 'evidence-gap-request') {
    return validateEvidenceGapRequest(parsed, verified, parsed.loop);
  }
  const allowedSourceIds = new Set(verified.sourceCatalog.map(source => source.id));
  for (const finding of parsed.findings ?? []) {
    for (const citation of finding.citations) {
      assert(allowedSourceIds.has(citation.sourceId),
        `Unsupported citation sourceId: ${citation.sourceId}`);
    }
  }
  if (options.expectedKind) {
    assert(parsed.kind === options.expectedKind,
      `Expected a ${options.expectedKind} result`);
  }
  return parsed;
}

export function buildDeltaPacket(parentPacket, additions, options = {}) {
  const parent = validateFrozenEvidencePacket(parentPacket);
  const delta = buildFrozenEvidencePacket({
    workflowId: parent.workflowId,
    promptHash: parent.promptHash,
    questionBinding: parent.questionBinding,
    mode: parent.mode,
    scope: parent.scope,
    repository: parent.repository,
    sourceCatalog: additions.sourceCatalog ?? [],
    excerpts: additions.excerpts ?? [],
    createdAt: additions.createdAt ?? new Date().toISOString(),
    expiresAt: additions.expiresAt ?? parent.expiresAt,
    parentPacketHash: parent.packetHash,
    deltaFromPacketHash: parent.packetHash,
  }, {
    overflowStrategy: options.overflowStrategy ?? 'trim',
  });
  assert(delta.serializedBytes <= PACKET_LIMITS.maxDeltaPacketBytes,
    `Delta packet exceeds ${PACKET_LIMITS.maxDeltaPacketBytes} bytes`);
  return delta;
}

export function evidenceSchemas(mode) {
  const repo = mode !== 'external';
  const web = mode !== 'repository' && mode !== 'history';
  return {
    find: {
      scope: z.enum(repo && web ? ['repository', 'external'] : repo ? ['repository'] : ['external']),
      ...(repo ? { query: z.string().max(160).optional() } : {}),
      ...(web ? { queryId: z.string().max(40).optional() } : {}),
      limit: z.number().int().min(1).max(8).optional(),
    },
    open: {
      id: web && !repo ? z.string().min(1).max(80) : z.string().max(80).optional(),
      ...(repo ? {
        path: z.string().max(300).optional(),
        symbol: z.string().max(120).optional(),
        start: z.number().int().min(1).optional(),
        end: z.number().int().min(1).optional(),
      } : {}),
      ...(web ? { focus: z.string().max(160).optional(), refresh: z.boolean().optional() } : {}),
      maxCharacters: z.number().int().min(500).max(64000).optional(),
      reopen: z.boolean().optional(),
    },
  };
}
