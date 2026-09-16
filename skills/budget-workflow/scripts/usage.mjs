#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PACKET_LIMITS, USAGE_ACCOUNTING_CATEGORIES } from './evidence/schemas.mjs';

function nonnegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}

function category(value) {
  if (!USAGE_ACCOUNTING_CATEGORIES.includes(value)) throw new Error(`Invalid usage category: ${value}`);
  return value;
}

export function normalizeUsage(raw) {
  const reportedNoCalls = raw.tokenDetails === undefined && raw.totalNanoAiu === 0 &&
    raw.totalUserRequests === 0 && raw.totalApiDurationMs === 0 &&
    raw.modelMetrics && Object.keys(raw.modelMetrics).length === 0;
  if (reportedNoCalls) return {
    input: 0, cache_read: 0, cache_write: 0, output: 0, totalTokens: 0,
    credits: 0, totalNanoAiu: 0, models: [],
    warning: 'Runtime explicitly reported no calls and zero usage; not a successful result.',
  };
  const counts = {};
  for (const key of ['input', 'cache_read', 'cache_write', 'output']) {
    counts[key] = nonnegative(raw.tokenDetails?.[key]?.tokenCount, `${key} token count`);
  }
  const nano = nonnegative(raw.totalNanoAiu, 'totalNanoAiu');
  return {
    ...counts, totalTokens: Object.values(counts).reduce((sum, count) => sum + count, 0),
    credits: nano / 1e9, totalNanoAiu: nano,
    models: Object.keys(raw.modelMetrics ?? {}),
    warning: 'Uses disjoint billed tokenDetails, not inclusive usage.inputTokens. Does not add agentMetrics to totals.',
  };
}

export function initializeLedger(file, limitCredits, spentCredits, month = new Date().toISOString().slice(0, 7)) {
  nonnegative(limitCredits, 'limitCredits');
  nonnegative(spentCredits, 'spentCredits');
  if (limitCredits === 0 || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Positive limit and UTC YYYY-MM month required');
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    month,
    limitCredits,
    spentCredits,
    reservations: {},
  }, null, 2),
    { flag: 'wx', mode: 0o600 });
}

function reservation(value) {
  if (typeof value === 'number') return { cap: nonnegative(value, 'reservation'), status: 'active' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid reservation');
  }
  nonnegative(value.cap, 'reservation cap');
  if (!['active', 'unreconciled'].includes(value.status)) {
    throw new Error('Invalid reservation status');
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    throw new Error('Invalid reservation reason');
  }
  return value;
}

function transaction(file, action) {
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, 'wx', 0o600);
  let temporary;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (![1, 2].includes(data.version) || data.month !== new Date().toISOString().slice(0, 7)) {
      throw new Error('Ledger version/month mismatch: initialize a new month explicitly');
    }
    nonnegative(data.limitCredits, 'ledger limit');
    nonnegative(data.spentCredits, 'ledger spend');
    if (!data.reservations || typeof data.reservations !== 'object' || Array.isArray(data.reservations)) {
      throw new Error('Invalid ledger reservations');
    }
    for (const [id, value] of Object.entries(data.reservations)) {
      data.reservations[id] = reservation(value);
    }
    data.version = 2;
    const result = action(data);
    temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    temporary = undefined;
    return result;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function reserve(file, id, cap) {
  nonnegative(cap, 'reservation cap');
  if (!id || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid reservation id');
  return transaction(file, data => {
    if (Object.hasOwn(data.reservations, id)) throw new Error('Duplicate reservation');
    const reserved = Object.values(data.reservations)
      .reduce((sum, value) => sum + reservation(value).cap, 0);
    if (data.spentCredits + reserved + cap > data.limitCredits) throw new Error('Shared ledger budget exhausted');
    data.reservations[id] = { cap, status: 'active' };
    return { id, reserved: cap };
  });
}

export function settle(file, id, actualCredits) {
  nonnegative(actualCredits, 'actual credits');
  return transaction(file, data => {
    if (!Object.hasOwn(data.reservations, id)) throw new Error('Unknown reservation');
    delete data.reservations[id];
    data.spentCredits += actualCredits;
    return { spentCredits: data.spentCredits, overBudget: data.spentCredits > data.limitCredits };
  });
}

export function markUnknown(file, id, reason) {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Unknown usage reason required');
  return transaction(file, data => {
    if (!Object.hasOwn(data.reservations, id)) throw new Error('Unknown reservation');
    const value = reservation(data.reservations[id]);
    data.reservations[id] = { cap: value.cap, status: 'unreconciled', reason };
    return { id, unreconciled: value.cap };
  });
}

export function ledgerStatus(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const values = Object.values(data.reservations ?? {}).map(reservation);
  const activeReservedCredits = values.filter(value => value.status === 'active')
    .reduce((sum, value) => sum + value.cap, 0);
  const unreconciledReservedCredits = values.filter(value => value.status === 'unreconciled')
    .reduce((sum, value) => sum + value.cap, 0);
  return {
    version: data.version,
    month: data.month,
    limitCredits: data.limitCredits,
    knownSpentCredits: data.spentCredits,
    activeReservedCredits,
    unreconciledReservedCredits,
    reservedExposure: activeReservedCredits + unreconciledReservedCredits,
    savingsEligible: activeReservedCredits === 0 &&
      unreconciledReservedCredits === 0,
  };
}

export function normalizeUsageLineage(lineage) {
  if (!Array.isArray(lineage)) throw new Error('Usage lineage array required');
  return lineage.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Usage lineage entry must be an object');
    }
    const normalized = {
      category: category(entry.category),
      actualCredits: entry.actualCredits === null || entry.actualCredits === undefined
        ? null
        : nonnegative(entry.actualCredits, `${entry.category} actual credits`),
      reservedCredits: entry.reservedCredits === null || entry.reservedCredits === undefined
        ? null
        : nonnegative(entry.reservedCredits, `${entry.category} reserved credits`),
      usageHash: entry.usageHash ?? null,
    };
    if (normalized.actualCredits === null && normalized.reservedCredits === null) {
      throw new Error(`Usage lineage ${entry.category} needs actualCredits or reservedCredits`);
    }
    return normalized;
  });
}

export function summarizeUsageLineage(lineage) {
  const normalized = normalizeUsageLineage(lineage);
  const totals = Object.fromEntries(USAGE_ACCOUNTING_CATEGORIES.map(name => [name, 0]));
  let unreconciled = 0;
  for (const entry of normalized) {
    const value = entry.actualCredits ?? entry.reservedCredits ?? 0;
    totals[entry.category] += value;
    if (entry.actualCredits === null) unreconciled += value;
  }
  return {
    categories: totals,
    totalCredits: Object.values(totals).reduce((sum, value) => sum + value, 0),
    unreconciledCredits: unreconciled,
    frontierResearchCredits: totals['sol-research'] + totals['astra-research'] + totals['research-adjudication'],
    intentAcceptanceCredits: totals['user-intent-acceptance'],
    deterministicEvidenceCredits: totals['deterministic-evidence'] + totals['history-curation'],
  };
}

export function createIntentAcceptanceUsageRecord(input) {
  const selectedModel = String(input.selectedModel ?? '');
  if (!selectedModel) throw new Error('Intent acceptance selectedModel required');
  const attemptCount = Number(input.attemptCount);
  if (!Number.isInteger(attemptCount) || attemptCount < 1 || attemptCount > 2) {
    throw new Error('Intent acceptance attemptCount must be 1 or 2');
  }
  const packetBytes = Number(input.packetBytes);
  if (!Number.isInteger(packetBytes) || packetBytes < 1 || packetBytes > PACKET_LIMITS.maxSerializedBytes) {
    throw new Error(`Intent acceptance packetBytes must be 1-${PACKET_LIMITS.maxSerializedBytes}`);
  }
  const outcome = String(input.outcome ?? '');
  if (!['accepted', 'missing', 'ambiguous', 'blocked'].includes(outcome)) {
    throw new Error('Intent acceptance outcome is invalid');
  }
  const credits = nonnegative(Number(input.credits), 'intent acceptance credits');
  const projected = input.projected === true;
  const pricingAssumption = input.pricingAssumption === null || input.pricingAssumption === undefined
    ? null
    : String(input.pricingAssumption);
  if (pricingAssumption !== null && pricingAssumption.length === 0) {
    throw new Error('Intent acceptance pricingAssumption cannot be empty');
  }
  return {
    category: 'user-intent-acceptance',
    selectedModel,
    attemptCount,
    packetBytes,
    outcome,
    credits,
    projected,
    pricingAssumption,
  };
}

export function projectResearchCreditReduction(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new Error('Projection shape required');
  const baseline = summarizeUsageLineage(shape.baseline ?? []);
  const candidate = summarizeUsageLineage(shape.candidate ?? []);
  const baselineFrontierNonResearch = nonnegative(shape.baselineNonResearchFrontierCredits, 'baselineNonResearchFrontierCredits');
  const candidateFrontierNonResearch = nonnegative(shape.candidateNonResearchFrontierCredits, 'candidateNonResearchFrontierCredits');
  const baselineTotal = baseline.totalCredits + baselineFrontierNonResearch;
  const candidateTotal = candidate.totalCredits + candidateFrontierNonResearch;
  if (baselineTotal <= 0) throw new Error('Baseline total credits must be positive');
  if (baselineFrontierNonResearch <= 0) throw new Error('Baseline non-research frontier credits must be positive');
  return {
    version: 2,
    estimated: true,
    scenario: shape.scenario ?? 'unnamed-scenario',
    baseline,
    candidate,
    baselineNonResearchFrontierCredits: baselineFrontierNonResearch,
    candidateNonResearchFrontierCredits: candidateFrontierNonResearch,
    nonResearchFrontierReduction: 1 - candidateFrontierNonResearch / baselineFrontierNonResearch,
    totalCreditReduction: 1 - candidateTotal / baselineTotal,
    qualityParityEvidence: shape.qualityParityEvidence ?? 'deterministic-packet-and-citation-validation',
    assumptions: String(shape.assumptions ?? ''),
  };
}

export function projectResearchCreditReductionSet(fixture) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) throw new Error('Projection fixture required');
  const scenarios = Object.entries(fixture.scenarios ?? {});
  if (scenarios.length === 0) throw new Error('Projection fixture scenarios required');
  return {
    version: 2,
    estimated: true,
    assumptions: fixture.assumptions ?? '',
    scenarios: Object.fromEntries(scenarios.map(([name, value]) => [
      name,
      projectResearchCreditReduction({
        scenario: name,
        assumptions: value.assumptions ?? fixture.assumptions ?? '',
        ...value,
      }),
    ])),
  };
}

export function projectIntentAcceptanceCostSet(fixture) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error('Intent acceptance projection fixture required');
  }
  const scenarios = Object.entries(fixture.scenarios ?? {});
  if (scenarios.length === 0) {
    throw new Error('Intent acceptance projection scenarios required');
  }
  return {
    version: 1,
    assumptions: String(fixture.assumptions ?? ''),
    scenarios: Object.fromEntries(scenarios.map(([name, value]) => {
      const baseCredits = nonnegative(Number(value.baseCredits), `${name} baseCredits`);
      const observedMultiplier = nonnegative(Number(value.observedMultiplier), `${name} observedMultiplier`);
      const projectedCredits = baseCredits * observedMultiplier * Number(value.attemptCount);
      if (Number(value.toolCalls ?? 0) !== 0) {
        throw new Error(`${name} requires zero selected-model tool calls`);
      }
      const usage = createIntentAcceptanceUsageRecord({
        selectedModel: value.selectedModel,
        attemptCount: value.attemptCount,
        packetBytes: value.packetBytes,
        outcome: value.outcome,
        credits: Number(value.projectedCredits ?? projectedCredits),
        projected: true,
        pricingAssumption: value.pricingAssumption,
      });
      if (Math.abs(usage.credits - projectedCredits) > 1e-9) {
        throw new Error(`${name} projectedCredits do not match baseCredits * observedMultiplier * attemptCount`);
      }
      return [name, {
        ...usage,
        observedMultiplier,
        baseCredits,
        projectedCredits: usage.credits,
        packetTargetMet: usage.packetBytes <= 20 * 1024,
        hardPacketCapMet: usage.packetBytes <= PACKET_LIMITS.maxSerializedBytes,
        toolCalls: 0,
      }];
    })),
  };
}

export function summary(directories) {
  const seen = new Set();
  const runs = directories.map(directory => {
    const root = fs.realpathSync(directory);
    if (seen.has(root)) throw new Error('Duplicate run directory');
    seen.add(root);
    const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
    const file = path.join(root, 'usage.json');
    return { directory: root, complete: result.code === 0 && !result.timedOut && result.toolIsolationVerified === true &&
      result.scopeVerified !== false && !result.eventLogTruncated &&
      (!result.workspace || result.toolCalls > 0 || result.packetVerified === true),
      durationMs: result.durationMs, usage: fs.existsSync(file) ? normalizeUsage(JSON.parse(fs.readFileSync(file, 'utf8'))) : null };
  });
  const knownCredits = runs.reduce((sum, run) => sum + (run.usage?.credits ?? 0), 0);
  const unknownUsageRuns = runs.filter(run => run.usage === null).length;
  return {
    runs,
    credits: knownCredits,
    knownCredits,
    creditsLowerBound: knownCredits,
    unknownUsageRuns,
    savingsEligible: unknownUsageRuns === 0,
    warning: 'Credits are a known-usage lower bound. Missing usage remains unreconciled and makes savings ineligible; it is neither zero nor cap-valued actual spend.',
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'init') initializeLedger(args[0], Number(args[1]), Number(args[2]));
    else if (command === 'summary') console.log(JSON.stringify(summary(args), null, 2));
    else if (command === 'ledger') console.log(JSON.stringify(ledgerStatus(args[0]), null, 2));
    else if (command === 'project') console.log(JSON.stringify(projectResearchCreditReductionSet(JSON.parse(fs.readFileSync(args[0], 'utf8'))), null, 2));
    else throw new Error('Usage: usage.mjs init FILE LIMIT_CREDITS SPENT_CREDITS | summary RUN_DIR... | ledger FILE | project FIXTURE.json');
  } catch (error) { console.error(`usage: ${error.message}`); process.exitCode = 1; }
}
