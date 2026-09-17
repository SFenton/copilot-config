#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contained, readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import { readOpportunityPolicy } from '../skills/budget-workflow/scripts/opportunities.mjs';
import { readReleaseMachine } from '../skills/budget-workflow/scripts/release-machine.mjs';
import {
  instructionContractCheck,
  loadProjectManifest,
} from './project-manifest.mjs';

export const ADAPTER_PATH = path.join('.github', 'agent-budget.json');
export const BUDGET_HOOK_PATH = path.join('.github', 'hooks', 'budget-reads.json');
export const RELEASE_MACHINE_PATH = path.join('.github', 'release-machine.json');
export const RELEASE_SKILL_PATH = path.join('.github', 'skills', 'release-dashboard', 'SKILL.md');
export const REQUIRED_ADAPTER_KEYS = Object.freeze([
  'learningPolicy',
  'opportunityPolicy',
  'toolRegistry',
  'opportunityEvaluation',
  'workerEvaluation',
  'capabilityEvaluation',
  'sandboxProfiles',
  'releaseMachine',
]);
const UNSAFE_SKILL_REASONS = new Set([
  'invocation-authorizes-release',
  'manual-release-section',
  'manual-stage-instructions',
  'manual-git-add',
]);
const MACHINE_REVIEWER_REASONS = new Set([
  'stale-reviewer-profile',
  'reviewer-policy-mismatch',
]);
const MACHINE_EXCEPTION_REASONS = new Set([
  'invalid-sol-exception-gate',
  'stale-sol-exception-profile',
  'missing-sol-trigger-support',
]);
const SESSION_END_HOOK = {
  type: 'command',
  bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/routing-enforcement.mjs" session-end',
  timeoutSec: 5,
};

function exactHookMatch(candidate, expected) {
  return candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    candidate.type === expected.type &&
    candidate.bash === expected.bash &&
    candidate.timeoutSec === expected.timeoutSec;
}

function isRegularFile(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

function normalizeRoot(root) {
  const resolved = path.resolve(root);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function manifestCaseId(item, index) {
  return typeof item?.id === 'string' && item.id.length > 0
    ? item.id
    : `case-${index + 1}`;
}

function manifestProjectId(item, caseId) {
  return typeof item?.project === 'string' && item.project.length > 0
    ? item.project
    : caseId;
}

function validateManifestRef({
  exec = execFileSync,
  manifestPath,
  item,
  index,
  ref,
  root,
  value = item?.[ref],
}) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    exec('git', [
      '-C', root,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${value}^{commit}`,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch {
    const caseId = manifestCaseId(item, index);
    return {
      type: 'manifest-ref',
      manifest: manifestPath,
      root,
      case: caseId,
      project: manifestProjectId(item, caseId),
      ref,
      value,
      reasons: ['invalid-manifest-ref'],
      detail: `Manifest ${manifestPath} case ${caseId} ${ref} does not resolve in ${root}`,
    };
  }
}

function missingAdapterKeys(adapter) {
  const missing = REQUIRED_ADAPTER_KEYS.filter(key =>
    typeof adapter?.[key] !== 'string' || adapter[key].length === 0);
  if (!adapter?.delegation || typeof adapter.delegation !== 'object' || Array.isArray(adapter.delegation)) {
    missing.push('delegation');
  }
  return missing;
}

export function parseWorktreePorcelain(text) {
  const entries = [];
  let current = null;
  const push = () => {
    if (current?.path) entries.push(current);
    current = null;
  };
  for (const line of text.split('\n')) {
    if (!line) {
      push();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      push();
      current = { path: value };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'prunable') current.prunable = value || true;
    else current[key] = value || true;
  }
  push();
  return entries;
}

export function rootsFromManifest(manifestPath, {
  exec = execFileSync,
  failures = [],
} = {}) {
  if (!isRegularFile(manifestPath)) {
    throw new Error(`Manifest is not a regular file: ${manifestPath}`);
  }
  const manifest = loadProjectManifest(manifestPath);
  return manifest.cases.map((item, index) => {
    if (!item || typeof item.root !== 'string' || item.root.length === 0) {
      throw new Error(`Manifest ${manifestPath} contains a case without a root`);
    }
    const root = normalizeRoot(item.root);
    const instruction = instructionContractCheck(item);
    for (const ref of [
      ['instructionContract.baselineRef', instruction?.baselineRef],
      ['instructionContract.migrationRef', instruction?.migrationRef],
    ]) {
      const failure = validateManifestRef({
        exec,
        manifestPath,
        item,
        index,
        ref: ref[0],
        root,
        value: ref[1],
      });
      if (failure) failures.push(failure);
    }
    return item.root;
  });
}

export function collectRoots(inputs, {
  exec = execFileSync,
  manifestFailures = [],
} = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('Provide at least one repository root or manifest path');
  }
  const roots = [];
  const seen = new Set();
  for (const input of inputs) {
    const resolved = path.resolve(input);
    let manifestRoots;
    if (isRegularFile(resolved)) {
      manifestRoots = rootsFromManifest(resolved, {
        exec,
        failures: manifestFailures,
      });
    } else {
      manifestRoots = [input];
    }
    for (const root of manifestRoots.map(normalizeRoot)) {
      if (seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

export function inspectBudgetHook(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reasons: ['invalid-json'],
      detail: error instanceof Error ? error.message : String(error),
      hasPreToolUse: false,
      hasPromptStart: false,
      hasSessionEnd: false,
    };
  }
  const hooks = parsed?.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
    ? parsed.hooks
    : {};
  const hasPreToolUse = Array.isArray(hooks.preToolUse) && hooks.preToolUse.length > 0;
  const hasPromptStart = Array.isArray(hooks.userPromptSubmitted) &&
    hooks.userPromptSubmitted.length > 0;
  const hasSessionEnd = Array.isArray(hooks.sessionEnd) &&
    hooks.sessionEnd.some(entry => exactHookMatch(entry, SESSION_END_HOOK));
  const reasons = [];
  if (hasPreToolUse) reasons.push('preToolUse');
  if (hasPromptStart) reasons.push('prompt-start-enabled');
  if (!hasSessionEnd) reasons.push('missing-session-end');
  return {
    ok: reasons.length === 0,
    reasons,
    version: parsed?.version ?? null,
    hasPreToolUse,
    hasPromptStart,
    hasSessionEnd,
  };
}

export function inspectReleaseSkill(text) {
  const reasons = [];
  const hasDisabledBlock = /blocked: release-machine-disabled/.test(text);
  const hasAbsentBlock = /blocked: release-machine-absent/.test(text);
  if (/That invocation authorizes/.test(text)) reasons.push('invocation-authorizes-release');
  if (/^## Git and GitHub release$/m.test(text)) reasons.push('manual-release-section');
  if (/\bstage an exact patch\b/i.test(text)) reasons.push('manual-stage-instructions');
  if (/\bgit add\b/i.test(text)) reasons.push('manual-git-add');
  if (hasDisabledBlock === hasAbsentBlock) reasons.push('missing-machine-block-state');
  if (!/medium model\s+cannot substitute/i.test(text)) reasons.push('missing-machine-warning');
  if (!/ha-release-rollback-or-host-conflict/.test(text)) reasons.push('missing-sol-trigger');
  if (!/^\s*model:\s*gpt-5\.6-luna\s*$/m.test(text)) reasons.push('missing-luna-reviewer');
  if (!/`gpt-5\.6-sol` high\/default research may review only/i.test(text)) {
    reasons.push('missing-sol-exception-semantics');
  }
  if (hasAbsentBlock &&
    !/(release-machine\.json[\s\S]{0,400}absent|does not contain\s+`?\.github\/release-machine\.json`?)/i.test(text)) {
    reasons.push('missing-absent-machine-wording');
  }
  if (hasDisabledBlock && !/release-machine\.json` is disabled/i.test(text)) {
    reasons.push('missing-disabled-machine-wording');
  }
  return {
    ok: reasons.length === 0,
    reasons,
    blockingState: hasAbsentBlock ? 'absent' : hasDisabledBlock ? 'disabled' : null,
    unsafeAuthorization: reasons.some(reason => UNSAFE_SKILL_REASONS.has(reason)),
  };
}

export function inspectAdapter(root, { requireComplete = true } = {}) {
  const file = path.join(root, ADAPTER_PATH);
  if (!isRegularFile(file)) {
    return {
      ok: false,
      reasons: ['missing-adapter'],
      detail: `Missing ${file}`,
      file,
      adapter: null,
    };
  }
  let adapter;
  try {
    adapter = readAdapter(root);
  } catch (error) {
    return {
      ok: false,
      reasons: ['invalid-adapter'],
      detail: error instanceof Error ? error.message : String(error),
      file,
      adapter: null,
    };
  }
  const missing = requireComplete ? missingAdapterKeys(adapter) : [];
  const reasons = missing.map(key => `missing-${key}`);
  let resolvedReleaseMachinePath = null;
  if (typeof adapter.releaseMachine === 'string' && adapter.releaseMachine.length > 0) {
    try {
      resolvedReleaseMachinePath = normalizeRoot(contained(root, adapter.releaseMachine));
    } catch (error) {
      reasons.push('invalid-release-machine-reference');
      return {
        ok: false,
        reasons,
        detail: error instanceof Error ? error.message : String(error),
        file,
        adapter,
        resolvedReleaseMachinePath: null,
      };
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
    file,
    adapter,
    resolvedReleaseMachinePath,
  };
}

export function inspectReleaseMachine(worktreePath, adapterResult = null) {
  const file = path.join(worktreePath, RELEASE_MACHINE_PATH);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      reasons: ['invalid-machine-json'],
      detail: error instanceof Error ? error.message : String(error),
      file,
      staleReviewer: false,
      staleException: false,
    };
  }
  const reasons = [];
  if (raw?.enabled !== false) reasons.push('machine-enabled');
  if (raw?.operatorAuthorizationRequired !== true) reasons.push('missing-operator-authorization');
  if (raw?.reviewer?.profile?.model !== 'gpt-5.6-luna' ||
    raw?.reviewer?.profile?.effort !== 'medium' ||
    raw?.reviewer?.profile?.context !== 'default') {
    reasons.push('stale-reviewer-profile');
  }
  if (raw?.exception?.role !== 'research-frontier' ||
    raw?.exception?.requiresTriggerReceipt !== true) {
    reasons.push('invalid-sol-exception-gate');
  }
  if (raw?.exception?.profile?.model !== 'gpt-5.6-sol' ||
    raw?.exception?.profile?.effort !== 'high' ||
    raw?.exception?.profile?.context !== 'default') {
    reasons.push('stale-sol-exception-profile');
  }
  if (!Array.isArray(raw?.exception?.triggerIds) || raw.exception.triggerIds.length === 0) {
    reasons.push('missing-sol-trigger-support');
  }
  if (!adapterResult?.ok || !adapterResult.adapter) {
    reasons.push('invalid-machine-adapter');
    return {
      ok: false,
      reasons,
      detail: adapterResult?.detail ?? 'Release machine requires a complete adapter',
      file,
      staleReviewer: reasons.some(reason => MACHINE_REVIEWER_REASONS.has(reason)),
      staleException: reasons.some(reason => MACHINE_EXCEPTION_REASONS.has(reason)),
    };
  }
  if (adapterResult.resolvedReleaseMachinePath !== normalizeRoot(file)) {
    reasons.push('release-machine-reference-mismatch');
  }
  let machine;
  try {
    machine = readReleaseMachine(worktreePath, adapterResult.adapter);
  } catch (error) {
    return {
      ok: false,
      reasons: [...reasons, 'invalid-machine-contract'],
      detail: error instanceof Error ? error.message : String(error),
      file,
      staleReviewer: reasons.some(reason => MACHINE_REVIEWER_REASONS.has(reason)),
      staleException: reasons.some(reason => MACHINE_EXCEPTION_REASONS.has(reason)),
    };
  }
  try {
    const policy = readOpportunityPolicy(worktreePath, adapterResult.adapter);
    const releaseOpportunity = policy.opportunities.find(item => item.id === machine.opportunity);
    if (!releaseOpportunity) {
      reasons.push('missing-release-opportunity');
    } else {
      const reviewerProfile = releaseOpportunity.team?.reviewer?.profile ?? null;
      if (reviewerProfile &&
        JSON.stringify(reviewerProfile) !== JSON.stringify(machine.reviewer.profile)) {
        reasons.push('reviewer-policy-mismatch');
      }
      if (Array.isArray(releaseOpportunity.conditionalProfiles)) {
        const triggerProfiles = releaseOpportunity.conditionalProfiles.filter(profile =>
          ['research-frontier', 'risk-triggered-frontier-review'].includes(profile.kind) &&
          profile.requiresTriggerReceipt === true &&
          profile.profile?.model === 'gpt-5.6-sol' &&
          profile.profile?.effort === 'high' &&
          profile.profile?.context === 'default');
        if (!machine.exception.triggerIds.every(trigger =>
          triggerProfiles.some(profile => profile.triggerIds?.includes(trigger)))) {
          reasons.push('missing-sol-trigger-support');
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      reasons: [...reasons, 'invalid-opportunity-policy'],
      detail: error instanceof Error ? error.message : String(error),
      file,
      staleReviewer: reasons.some(reason => MACHINE_REVIEWER_REASONS.has(reason)),
      staleException: reasons.some(reason => MACHINE_EXCEPTION_REASONS.has(reason)),
    };
  }
  return {
    ok: reasons.length === 0,
    reasons,
    file,
    staleReviewer: reasons.some(reason => MACHINE_REVIEWER_REASONS.has(reason)),
    staleException: reasons.some(reason => MACHINE_EXCEPTION_REASONS.has(reason)),
  };
}

export function scanRegisteredWorktrees({
  inputs,
  exec = execFileSync,
} = {}) {
  const manifestFailures = [];
  const roots = collectRoots(inputs, { exec, manifestFailures });
  const report = {
    ok: true,
    inputs: [...inputs],
    roots: [],
    rootCount: roots.length,
    worktreeCount: 0,
    hookCount: 0,
    skillCount: 0,
    machineCount: 0,
    rootAdapterCount: 0,
    failingHookCount: 0,
    failingSkillCount: 0,
    failingMachineCount: 0,
    failingRootAdapterCount: 0,
    activePreToolUseCount: 0,
    unsafeSkillAuthorizationCount: 0,
    staleReviewerCount: 0,
    staleExceptionCount: 0,
    unaccountedSkillWithoutMachineCount: 0,
    failures: [],
  };
  for (const failure of manifestFailures) {
    report.ok = false;
    report.failures.push(failure);
  }
  for (const root of roots) {
    const rootPath = normalizeRoot(root);
    const rootResult = { root: rootPath, adapter: null, worktrees: [], error: null };
    try {
      const output = exec('git', ['-C', rootPath, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
      });
      const worktrees = parseWorktreePorcelain(output);
      report.worktreeCount += worktrees.length;
      for (const worktree of worktrees) {
        const worktreePath = normalizeRoot(worktree.path);
        const hookPath = path.join(worktreePath, BUDGET_HOOK_PATH);
        const skillPath = path.join(worktreePath, RELEASE_SKILL_PATH);
        const machinePath = path.join(worktreePath, RELEASE_MACHINE_PATH);
        const worktreeResult = {
          path: worktreePath,
          branch: worktree.branch ?? null,
          detached: Boolean(worktree.detached),
          prunable: worktree.prunable ?? null,
          hook: null,
          releaseSkill: null,
          releaseMachine: null,
        };
        if (worktreePath === rootPath) {
          report.rootAdapterCount += 1;
          const adapter = inspectAdapter(worktreePath, { requireComplete: true });
          rootResult.adapter = adapter;
          if (!adapter.ok) {
            report.ok = false;
            report.failingRootAdapterCount += 1;
            report.failures.push({
              type: 'root-adapter',
              root: rootPath,
              worktree: worktreePath,
              file: adapter.file,
              reasons: adapter.reasons,
              detail: adapter.detail ?? null,
            });
          }
        }
        if (isRegularFile(hookPath)) {
          report.hookCount += 1;
          const hook = inspectBudgetHook(fs.readFileSync(hookPath, 'utf8'));
          worktreeResult.hook = { file: hookPath, ...hook };
          if (hook.hasPreToolUse) report.activePreToolUseCount += 1;
          if (!hook.ok) {
            report.ok = false;
            report.failingHookCount += 1;
            report.failures.push({
              type: 'budget-hook',
              root: rootPath,
              worktree: worktreePath,
              file: hookPath,
              reasons: hook.reasons,
              detail: hook.detail ?? null,
            });
          }
        }
        const hasMachine = isRegularFile(machinePath);
        const hasSkill = isRegularFile(skillPath);
        if (hasMachine) {
          report.machineCount += 1;
          const adapter = inspectAdapter(worktreePath, { requireComplete: true });
          const machine = inspectReleaseMachine(worktreePath, adapter);
          worktreeResult.releaseMachine = { file: machinePath, adapterFile: adapter.file, ...machine };
          if (machine.staleReviewer) report.staleReviewerCount += 1;
          if (machine.staleException) report.staleExceptionCount += 1;
          if (!machine.ok) {
            report.ok = false;
            report.failingMachineCount += 1;
            report.failures.push({
              type: 'release-machine',
              root: rootPath,
              worktree: worktreePath,
              file: machinePath,
              reasons: machine.reasons,
              detail: machine.detail ?? null,
            });
          }
        }
        if (hasSkill) {
          report.skillCount += 1;
          const skill = inspectReleaseSkill(fs.readFileSync(skillPath, 'utf8'));
          const reasons = [...skill.reasons];
          if (hasMachine && skill.blockingState !== 'disabled') {
            reasons.push('machine-present-skill-must-block-disabled');
          }
          if (!hasMachine && skill.blockingState !== 'absent') {
            reasons.push('machine-absent-skill-must-block-absent');
          }
          const ok = reasons.length === 0;
          worktreeResult.releaseSkill = { file: skillPath, ...skill, ok, reasons };
          if (skill.unsafeAuthorization) report.unsafeSkillAuthorizationCount += 1;
          if (!hasMachine && skill.blockingState !== 'absent') {
            report.unaccountedSkillWithoutMachineCount += 1;
          }
          if (!ok) {
            report.ok = false;
            report.failingSkillCount += 1;
            report.failures.push({
              type: 'release-skill',
              root: rootPath,
              worktree: worktreePath,
              file: skillPath,
              reasons,
            });
          }
        }
        rootResult.worktrees.push(worktreeResult);
      }
    } catch (error) {
      report.ok = false;
      rootResult.error = error instanceof Error ? error.message : String(error);
      report.failures.push({
        type: 'root-scan',
        root: rootPath,
        reasons: ['git-worktree-list-failed'],
        detail: rootResult.error,
      });
    }
    report.roots.push(rootResult);
  }
  return report;
}

export function writeReport(report, outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

export function summarizeReport(report) {
  return {
    ok: report.ok,
    roots: report.rootCount,
    worktrees: report.worktreeCount,
    hooks: {
      scanned: report.hookCount,
      failing: report.failingHookCount,
      activePreToolUse: report.activePreToolUseCount,
    },
    releaseSkills: {
      scanned: report.skillCount,
      failing: report.failingSkillCount,
      unsafeAuthorization: report.unsafeSkillAuthorizationCount,
      unaccountedWithoutMachine: report.unaccountedSkillWithoutMachineCount,
    },
    releaseMachines: {
      scanned: report.machineCount,
      failing: report.failingMachineCount,
      staleReviewer: report.staleReviewerCount,
      staleException: report.staleExceptionCount,
    },
    rootAdapters: {
      scanned: report.rootAdapterCount,
      failing: report.failingRootAdapterCount,
    },
    failures: report.failures.map(item => ({
      type: item.type,
      file: item.file ?? null,
      manifest: item.manifest ?? null,
      root: item.root ?? null,
      case: item.case ?? null,
      project: item.project ?? null,
      ref: item.ref ?? null,
      value: item.value ?? null,
      reasons: item.reasons,
    })),
  };
}

function parseCli(argv) {
  const inputs = [];
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      output = argv[index + 1];
      index += 1;
      continue;
    }
    inputs.push(arg);
  }
  return { inputs, output };
}

function main(argv) {
  const { inputs, output } = parseCli(argv);
  const report = scanRegisteredWorktrees({ inputs });
  if (output) writeReport(report, output);
  process.stdout.write(`${JSON.stringify(summarizeReport(report), null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
