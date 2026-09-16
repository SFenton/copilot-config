import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './helpers/scratch.mjs';
import {
  scanRegisteredWorktrees,
} from '../scripts/scan-registered-worktree-policies.mjs';
import { loadProjectManifest } from '../scripts/project-manifest.mjs';

const projectManifest = process.env.BUDGET_PROJECT_MANIFEST;

const CURRENT_HOOK = `${JSON.stringify({
  version: 1,
  hooks: {
    userPromptSubmitted: [{
      type: 'command',
      bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/routing-enforcement.mjs" prompt-start',
      timeoutSec: 5,
    }],
    sessionEnd: [{
      type: 'command',
      bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/routing-enforcement.mjs" session-end',
      timeoutSec: 5,
    }],
  },
}, null, 2)}\n`;
const STALE_HOOK = `${JSON.stringify({
  version: 1,
  hooks: {
    preToolUse: [{
      type: 'command',
      bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/budget.mjs" hook',
      timeoutSec: 5,
    }],
  },
}, null, 2)}\n`;
const CURRENT_SKILL = `---
name: release-dashboard
description: Explicitly invoked dashboard release scope-review workflow for the operator-authorized deterministic release machine; it does not itself commit, push, merge, deploy, or mutate Home Assistant.
metadata:
  model: gpt-5.4
  reasoning_effort: medium
  context_tier: default
---

# Release Dashboard

Use this skill only when the operator invokes \`release-dashboard\` directly.
That invocation requests release scope review. It does not itself create the
operator authorization receipt required by the deterministic release machine
and never grants a model permission to commit, push, merge, deploy, mutate Home
Assistant, or restart it.

The version 3 \`release-machine.json\` is disabled while any required GitHub, HA,
production verification, rollback, or cleanup driver remains disabled. Until
all deterministic drivers are implemented and fault-tested, the skill must
stop after local read-only scope review and deterministic preflight, emit a
blocked result, and leave the worktree unchanged. Routine scope review uses the
release opportunity's \`gpt-5.4\` medium/default reviewer.
\`gpt-5.6-sol\` high/default research may review only an evidence-bound
\`ha-release-rollback-or-host-conflict\` trigger after the preceding release
receipt. No model runs build, Git/PR, deployment, verification, rollback, or
cleanup steps on behalf of the deterministic machine.

## Disabled-machine stop gate

1. Return \`blocked: release-machine-disabled\`.

Do not fall back to the former manual Git/PR/deploy procedure. A medium model
cannot substitute for a disabled deterministic driver.
`;
const ABSENT_MACHINE_SKILL = `---
name: release-dashboard
description: Explicitly invoked dashboard release scope-review workflow for a future operator-authorized deterministic release machine; it does not itself commit, push, merge, deploy, or mutate Home Assistant.
metadata:
  model: gpt-5.4
  reasoning_effort: medium
  context_tier: default
---

# Release Dashboard

Use this skill only when the operator invokes \`release-dashboard\` directly.
That invocation requests release scope review. It does not itself authorize
release execution and never grants a model permission to commit, push, merge,
deploy, mutate Home Assistant, or restart it.

This worktree does not contain \`.github/release-machine.json\`, so release is
blocked until a separately reviewed version 3 deterministic machine is added
with matching adapter references and kept disabled by default. Routine scope
review still uses the release opportunity's \`gpt-5.4\` medium/default reviewer.
\`gpt-5.6-sol\` high/default research may review only a future evidence-bound
\`ha-release-rollback-or-host-conflict\` trigger after the preceding release
receipt once that machine exists. No model runs build, Git/PR, deployment,
verification, rollback, or cleanup steps on behalf of a missing machine.

## Missing-machine stop gate

1. Return \`blocked: release-machine-absent\`.

Do not fall back to the former manual Git/PR/deploy procedure. A medium model
cannot substitute for a missing deterministic driver.
`;
const STALE_SKILL = `---
name: release-dashboard
description: Explicitly invoked dashboard release workflow that commits, pushes, merges, deploys, and verifies the release.
metadata:
  model: gpt-5.6-sol
  reasoning_effort: max
  context_tier: long_context
---

# Release Dashboard

Use this skill only when the operator invokes \`release-dashboard\` directly.
That invocation authorizes the current completed dashboard change to be
committed, pushed, merged to \`master\`, built, deployed, and verified.

## Git and GitHub release

1. Stage an exact patch.
2. Run \`git add\` for the approved files.
`;

const TOOL_REGISTRY = {
  version: 1,
  project: 'fixture',
  tools: [
    {
      id: 'validate-fixture',
      kind: 'command',
      argv: ['node', '--version'],
      cwd: '.',
      timeoutSeconds: 10,
      sideEffect: 'workspace',
      environment: [],
    },
    {
      id: 'verify-release-disabled',
      kind: 'disabled',
      reason: 'Verification driver is not implemented',
      sideEffect: 'production',
      environment: [],
    },
    {
      id: 'rollback-release-disabled',
      kind: 'disabled',
      reason: 'Rollback driver is not implemented',
      sideEffect: 'production',
      environment: [],
    },
    {
      id: 'cleanup-release-disabled',
      kind: 'disabled',
      reason: 'Cleanup driver is not implemented',
      sideEffect: 'workspace',
      environment: [],
    },
  ],
};
const OPPORTUNITY_POLICY = {
  version: 1,
  project: 'fixture',
  qualification: {
    status: 'provisional',
    caseCountPerOpportunity: 3,
    minimumPromotionCases: 30,
    automaticApplication: false,
  },
  opportunities: [
    {
      id: 'release',
      label: 'Fixture release',
      triggers: ['release'],
      strategy: 'explicit-release',
      evidence: 'repository',
      primary: {
        model: 'gpt-5.4',
        effort: 'medium',
        context: 'default',
      },
      escalation: {
        model: 'gpt-5.6-sol',
        effort: 'high',
        context: 'default',
      },
      escalationTriggers: ['fixture-release-conflict'],
      skills: ['release-dashboard'],
      tools: ['validate-fixture'],
      gates: ['Read the release contract'],
      authorization: 'release',
      delegationClass: null,
      rationale: 'Fixture release pipeline.',
    },
  ],
};
const CURRENT_MACHINE = {
  version: 3,
  project: 'fixture',
  opportunity: 'release',
  enabled: false,
  operatorAuthorizationRequired: true,
  reviewer: {
    role: 'medium-review',
    profile: {
      model: 'gpt-5.4',
      effort: 'medium',
      context: 'default',
    },
    authority: 'review-only',
  },
  exception: {
    role: 'research-frontier',
    profile: {
      model: 'gpt-5.6-sol',
      effort: 'high',
      context: 'default',
    },
    triggerIds: ['fixture-release-conflict'],
    requiresTriggerReceipt: true,
  },
  steps: [
    {
      id: 'validate-release',
      label: 'Validate fixture release',
      executor: 'deterministic',
      operation: 'command',
      tool: 'validate-fixture',
      failure: 'rejected',
      evidence: ['validation'],
    },
    {
      id: 'verify-release',
      label: 'Verify fixture release',
      executor: 'deterministic',
      operation: 'verify',
      tool: 'verify-release-disabled',
      failure: 'rollback-release',
      evidence: ['verification'],
    },
    {
      id: 'rollback-release',
      label: 'Rollback fixture release',
      executor: 'deterministic',
      operation: 'rollback',
      tool: 'rollback-release-disabled',
      rollbackOnly: true,
      rollbackVerificationTool: 'verify-release-disabled',
      failure: 'abnormal',
      evidence: ['rollback'],
    },
    {
      id: 'cleanup-release',
      label: 'Cleanup fixture release',
      executor: 'deterministic',
      operation: 'cleanup',
      tool: 'cleanup-release-disabled',
      failure: 'abnormal',
      evidence: ['cleanup'],
    },
  ],
};
const STALE_MACHINE = {
  ...CURRENT_MACHINE,
  reviewer: {
    role: 'medium-review',
    profile: {
      model: 'gpt-5.6-sol',
      effort: 'medium',
      context: 'default',
    },
    authority: 'review-only',
  },
  exception: {
    role: 'risk-triggered-frontier-review',
    profile: {
      model: 'gpt-5.6-sol',
      effort: 'max',
      context: 'long_context',
    },
    triggerIds: ['fixture-release-conflict'],
    requiresTriggerReceipt: true,
  },
};

function write(relativeRoot, relativePath, content) {
  const target = path.join(relativeRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function addWorktree(root, branchName, suffix) {
  const target = `${root}-${suffix}`;
  execFileSync('git', ['worktree', 'add', '-q', '-b', branchName, target, 'HEAD'], { cwd: root });
  return target;
}

function initFixture(t, { rootName = null } = {}) {
  const scratch = makeScratch('registered-worktree-');
  const root = rootName ? path.join(scratch, rootName) : scratch;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (rootName) fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return {
    root,
    add(branchName, suffix) {
      const worktree = addWorktree(root, branchName, suffix);
      t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
      return worktree;
    },
  };
}

function notApplicable(reason, absentPaths) {
  return {
    applicable: false,
    reason,
    ...(absentPaths ? { absentPaths } : {}),
  };
}

function fixtureConformance(root, overrides = {}) {
  const hasOpportunityPolicy = fs.existsSync(path.join(root, '.github/agent-opportunities.json'));
  const hasInstructionContract = fs.existsSync(path.join(root, '.github/reference/fixture-contract.md'));
  const hasReleaseSkill = fs.existsSync(path.join(root, '.github/skills/release-dashboard/SKILL.md'));
  return {
    version: 2,
    surfaces: {
      'expected-opportunity-ids': hasOpportunityPolicy
        ? { applicable: true, ids: ['release'] }
        : notApplicable('fixture repository has no routed opportunity inventory'),
      'instruction-contract': hasInstructionContract
        ? { applicable: true, path: '.github/reference/fixture-contract.md' }
        : notApplicable('fixture repository has no relocated instruction contract'),
      'release-skill': hasReleaseSkill
        ? { applicable: true, path: '.github/skills/release-dashboard/SKILL.md' }
        : notApplicable('fixture repository has no release dashboard skill'),
      'repository-local-phase-checks': notApplicable(
        'fixture repository has no deterministic none-side-effect phase probes'),
      'compatibility-checks': notApplicable(
        'fixture repository has no compatibility contract artifact'),
      ...overrides,
    },
  };
}

function writeManifest(root, name, cases) {
  const manifest = path.join(root, name);
  fs.writeFileSync(manifest, JSON.stringify({
    cases: cases.map(item => ({
      conformance: fixtureConformance(item.root ?? root),
      ...item,
    })),
  }, null, 2));
  return manifest;
}

function manifestRefFailures(report) {
  return report.failures
    .filter(item => item.type === 'manifest-ref')
    .map(item => ({
      manifest: item.manifest,
      root: item.root,
      case: item.case,
      project: item.project,
      ref: item.ref,
      value: item.value,
      reasons: item.reasons,
    }));
}

function writeAdapter(root, complete = true) {
  const adapter = complete
    ? {
      version: 1,
      project: 'fixture',
      instructions: [
        '.github/copilot-instructions.md',
        '.github/skills/fixture-budget-workflow/SKILL.md',
      ],
      riskTerms: ['release'],
      gates: ['Read the release contract'],
      learningPolicy: '.github/agent-learning.json',
      opportunityPolicy: '.github/agent-opportunities.json',
      toolRegistry: '.github/agent-tools.json',
      opportunityEvaluation: '.github/evals/agent-opportunity-cases.json',
      workerEvaluation: '.github/evals/agent-worker-cases.json',
      capabilityEvaluation: '.github/evals/capability-qualification.json',
      sandboxProfiles: '.github/sandbox-profiles.json',
      releaseMachine: '.github/release-machine.json',
      delegation: {
        allowedClasses: ['test-generation'],
        requireCleanTargets: true,
        requireDeterministicValidator: true,
      },
    }
    : {
      version: 1,
      project: 'fixture',
      instructions: [
        '.github/copilot-instructions.md',
        '.github/skills/fixture-budget-workflow/SKILL.md',
      ],
      riskTerms: ['release'],
      gates: ['Read the release contract'],
    };
  write(root, '.github/agent-budget.json', `${JSON.stringify(adapter, null, 2)}\n`);
}

function writePolicyBundle(root, {
  completeAdapter = true,
  machine = 'current',
  skill = null,
  hook = null,
} = {}) {
  write(root, '.github/copilot-instructions.md', 'Fixture instructions.\n');
  write(root, '.github/reference/fixture-contract.md', '# Fixture contract\n');
  write(root, '.github/skills/fixture-budget-workflow/SKILL.md', '# Fixture budget workflow\n');
  write(root, '.github/agent-learning.json', '{}\n');
  write(root, '.github/agent-opportunities.json', `${JSON.stringify(OPPORTUNITY_POLICY, null, 2)}\n`);
  write(root, '.github/agent-tools.json', `${JSON.stringify(TOOL_REGISTRY, null, 2)}\n`);
  write(root, '.github/evals/agent-opportunity-cases.json', '{}\n');
  write(root, '.github/evals/agent-worker-cases.json', '{}\n');
  write(root, '.github/evals/capability-qualification.json', '{}\n');
  write(root, '.github/sandbox-profiles.json', '{}\n');
  writeAdapter(root, completeAdapter);
  if (machine === 'current') {
    write(root, '.github/release-machine.json', `${JSON.stringify(CURRENT_MACHINE, null, 2)}\n`);
  } else if (machine === 'stale') {
    write(root, '.github/release-machine.json', `${JSON.stringify(STALE_MACHINE, null, 2)}\n`);
  }
  if (skill === 'current') {
    write(root, '.github/skills/release-dashboard/SKILL.md', CURRENT_SKILL);
  } else if (skill === 'stale') {
    write(root, '.github/skills/release-dashboard/SKILL.md', STALE_SKILL);
  } else if (skill === 'absent') {
    write(root, '.github/skills/release-dashboard/SKILL.md', ABSENT_MACHINE_SKILL);
  }
  if (hook === 'current') {
    write(root, '.github/hooks/budget-reads.json', CURRENT_HOOK);
  } else if (hook === 'stale') {
    write(root, '.github/hooks/budget-reads.json', STALE_HOOK);
  }
}

test('registered worktree scan CLI accepts manifest files without a .json suffix', t => {
  const fixture = initFixture(t, { rootName: 'fixture with spaces' });
  const branchWorktree = fixture.add('feature-clean', 'worktree-clean');
  writePolicyBundle(fixture.root, {
    completeAdapter: true,
    machine: 'current',
    skill: 'current',
    hook: 'current',
  });
  writePolicyBundle(branchWorktree, {
    completeAdapter: false,
    machine: 'none',
    skill: 'absent',
    hook: 'current',
  });
  const manifest = writeManifest(fixture.root, 'project manifest', [{
    id: 'fixture',
    root: fixture.root,
    conformance: fixtureConformance(fixture.root, {
      'instruction-contract': {
        applicable: true,
        path: '.github/reference/fixture-contract.md',
        baselineRef: 'HEAD',
        migrationRef: 'HEAD',
      },
    }),
  }]);

  const reportPath = path.join(fixture.root, 'worktree-report.json');
  const script = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'scan-registered-worktree-policies.mjs',
  );
  const result = spawnSync(process.execPath, [script, '--output', reportPath, manifest], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const summary = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.rootCount, 1);
  assert.equal(report.worktreeCount, 2);
  assert.equal(report.hookCount, 2);
  assert.equal(report.skillCount, 2);
  assert.equal(report.machineCount, 1);
  assert.equal(report.failingHookCount, 0);
  assert.equal(report.failingSkillCount, 0);
  assert.equal(report.failingMachineCount, 0);
  assert.equal(report.failingRootAdapterCount, 0);
  assert.deepEqual(summary, {
    ok: true,
    roots: 1,
    worktrees: 2,
    hooks: {
      scanned: 2,
      failing: 0,
      activePreToolUse: 0,
    },
    releaseSkills: {
      scanned: 2,
      failing: 0,
      unsafeAuthorization: 0,
      unaccountedWithoutMachine: 0,
    },
    releaseMachines: {
      scanned: 1,
      failing: 0,
      staleReviewer: 0,
      staleException: 0,
    },
    rootAdapters: {
      scanned: 1,
      failing: 0,
    },
    failures: [],
  });
});

test('registered worktree scan reports a nonexistent baseline ref with deterministic diagnostics', t => {
  const fixture = initFixture(t);
  writePolicyBundle(fixture.root, {
    completeAdapter: true,
    machine: 'current',
    skill: 'current',
    hook: 'current',
  });
  const manifest = writeManifest(fixture.root, 'manifest.json', [{
    id: 'fixture',
    root: fixture.root,
    conformance: fixtureConformance(fixture.root, {
      'instruction-contract': {
        applicable: true,
        path: '.github/reference/fixture-contract.md',
        baselineRef: 'missing-baseline-ref',
      },
    }),
  }]);

  const report = scanRegisteredWorktrees({ inputs: [manifest] });
  assert.equal(report.ok, false);
  assert.deepEqual(manifestRefFailures(report), [{
    manifest,
    root: fixture.root,
    case: 'fixture',
    project: 'fixture',
    ref: 'instructionContract.baselineRef',
    value: 'missing-baseline-ref',
    reasons: ['invalid-manifest-ref'],
  }]);
});

test('registered worktree scan reports a nonexistent migration ref and exits nonzero', t => {
  const fixture = initFixture(t);
  writePolicyBundle(fixture.root, {
    completeAdapter: true,
    machine: 'current',
    skill: 'current',
    hook: 'current',
  });
  const manifest = writeManifest(fixture.root, 'manifest.json', [{
    id: 'fixture',
    root: fixture.root,
    conformance: fixtureConformance(fixture.root, {
      'instruction-contract': {
        applicable: true,
        path: '.github/reference/fixture-contract.md',
        migrationRef: 'missing-migration-ref',
      },
    }),
  }]);
  const reportPath = path.join(fixture.root, 'worktree-report.json');
  const script = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'scan-registered-worktree-policies.mjs',
  );

  const result = spawnSync(process.execPath, [script, '--output', reportPath, manifest], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.deepEqual(
    manifestRefFailures(JSON.parse(fs.readFileSync(reportPath, 'utf8'))),
    [{
      manifest,
      root: fixture.root,
      case: 'fixture',
      project: 'fixture',
      ref: 'instructionContract.migrationRef',
      value: 'missing-migration-ref',
      reasons: ['invalid-manifest-ref'],
    }],
  );
});

test('registered worktree scan allows absent optional refs and deduplicates repeated manifest cases', t => {
  const fixture = initFixture(t);
  const branchWorktree = fixture.add('feature-duplicate-roots', 'worktree-duplicate-roots');
  writePolicyBundle(fixture.root, {
    completeAdapter: true,
    machine: 'current',
    skill: 'current',
    hook: 'current',
  });
  writePolicyBundle(branchWorktree, {
    completeAdapter: false,
    machine: 'none',
    skill: 'absent',
    hook: 'current',
  });
  const manifest = writeManifest(fixture.root, 'project-manifest', [
    { id: 'fixture', root: fixture.root },
    { id: 'fixture', root: fixture.root },
  ]);

  const report = scanRegisteredWorktrees({ inputs: [manifest] });
  assert.equal(report.ok, true);
  assert.equal(report.rootCount, 1);
  assert.equal(report.worktreeCount, 2);
  assert.deepEqual(manifestRefFailures(report), []);
});

test('registered worktree scan rejects malformed optional manifest refs', t => {
  const fixture = initFixture(t);
  writePolicyBundle(fixture.root, {
    completeAdapter: true,
    machine: 'current',
    skill: 'current',
    hook: 'current',
  });
  const manifest = writeManifest(fixture.root, 'manifest.json', [{
    id: 'fixture',
    root: fixture.root,
    conformance: fixtureConformance(fixture.root, {
      'instruction-contract': {
        applicable: true,
        path: '.github/reference/fixture-contract.md',
        baselineRef: 'not a valid ref',
      },
    }),
  }]);

  const report = scanRegisteredWorktrees({ inputs: [manifest] });
  assert.equal(report.ok, false);
  assert.deepEqual(manifestRefFailures(report), [{
    manifest,
    root: fixture.root,
    case: 'fixture',
    project: 'fixture',
    ref: 'instructionContract.baselineRef',
    value: 'not a valid ref',
    reasons: ['invalid-manifest-ref'],
  }]);
});

test('registered worktree scan catches stale hook and manual release skill from manifest roots', t => {
  const fixture = initFixture(t);
  const branchWorktree = fixture.add('feature-stale-skill', 'worktree-stale-skill');
  writePolicyBundle(fixture.root, {
    completeAdapter: true,
    machine: 'current',
    skill: 'current',
    hook: 'current',
  });
  writePolicyBundle(branchWorktree, {
    completeAdapter: false,
    machine: 'none',
    skill: 'stale',
    hook: 'stale',
  });
  const manifest = path.join(fixture.root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    cases: [{
      id: 'fixture',
      root: fixture.root,
      conformance: fixtureConformance(fixture.root),
    }],
  }, null, 2));

  const report = scanRegisteredWorktrees({ inputs: [manifest] });
  assert.equal(report.ok, false);
  assert.equal(report.failingHookCount, 1);
  assert.equal(report.failingSkillCount, 1);
  assert.equal(report.activePreToolUseCount, 1);
  assert.equal(report.unsafeSkillAuthorizationCount, 1);
  assert.equal(report.unaccountedSkillWithoutMachineCount, 1);
  assert.deepEqual(report.failures.filter(item => item.type === 'budget-hook').map(item => item.reasons), [
    ['preToolUse', 'missing-prompt-start', 'missing-session-end'],
  ]);
  assert.deepEqual(report.failures.filter(item => item.type === 'release-skill').map(item => item.reasons), [
    [
      'invocation-authorizes-release',
      'manual-release-section',
      'manual-stage-instructions',
      'manual-git-add',
      'missing-machine-block-state',
      'missing-machine-warning',
      'missing-sol-trigger',
      'missing-gpt-5.4-reviewer',
      'missing-sol-exception-semantics',
      'machine-absent-skill-must-block-absent',
    ],
  ]);
});

test('registered worktree scan catches incomplete root adapters and stale machine pins', t => {
  const fixture = initFixture(t);
  const staleMachineWorktree = fixture.add('feature-stale-machine', 'worktree-stale-machine');
  writePolicyBundle(fixture.root, {
    completeAdapter: false,
    machine: 'none',
    skill: null,
    hook: 'current',
  });
  writePolicyBundle(staleMachineWorktree, {
    completeAdapter: true,
    machine: 'stale',
    skill: 'current',
    hook: null,
  });

  const report = scanRegisteredWorktrees({ inputs: [fixture.root] });
  assert.equal(report.ok, false);
  assert.equal(report.rootAdapterCount, 1);
  assert.equal(report.failingRootAdapterCount, 1);
  assert.equal(report.machineCount, 1);
  assert.equal(report.failingMachineCount, 1);
  assert.equal(report.staleReviewerCount, 1);
  assert.equal(report.staleExceptionCount, 1);
  assert.deepEqual(report.failures.filter(item => item.type === 'root-adapter').map(item => item.reasons), [[
    'missing-learningPolicy',
    'missing-opportunityPolicy',
    'missing-toolRegistry',
    'missing-opportunityEvaluation',
    'missing-workerEvaluation',
    'missing-capabilityEvaluation',
    'missing-sandboxProfiles',
    'missing-releaseMachine',
    'missing-delegation',
  ]]);
  assert.deepEqual(report.failures.filter(item => item.type === 'release-machine').map(item => item.reasons), [[
    'stale-reviewer-profile',
    'invalid-sol-exception-gate',
    'stale-sol-exception-profile',
    'invalid-machine-contract',
  ]]);
});

test('registered worktree scan rejects stale repo-local hooks, unsafe skill authorization, stale pins, and incomplete adapters across project manifests', {
  skip: !projectManifest,
}, () => {
  const manifest = loadProjectManifest(projectManifest);
  const report = scanRegisteredWorktrees({ inputs: [projectManifest] });
  assert.equal(report.ok, true, JSON.stringify(report.failures, null, 2));
  assert.equal(report.failingHookCount, 0);
  assert.equal(report.activePreToolUseCount, 0);
  assert.equal(report.failingSkillCount, 0);
  assert.equal(report.unsafeSkillAuthorizationCount, 0);
  assert.equal(report.unaccountedSkillWithoutMachineCount, 0);
  assert.equal(report.failingMachineCount, 0);
  assert.equal(report.staleReviewerCount, 0);
  assert.equal(report.staleExceptionCount, 0);
  assert.equal(report.failingRootAdapterCount, 0);
  assert.equal(report.rootCount, manifest.cases.length);
  assert.ok(report.worktreeCount >= report.rootCount);
});
