import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import { opportunityPlan, readOpportunityPolicy } from '../skills/budget-workflow/scripts/opportunities.mjs';
import { executeOpportunityPhase } from '../skills/budget-workflow/scripts/opportunities.mjs';
import { sha256 } from '../skills/budget-workflow/scripts/workflow.mjs';
import { makeScratch } from './helpers/scratch.mjs';

const policy = {
  project: 'sample',
  opportunities: [
    {
      id: 'test-generation',
      label: 'Focused tests',
      triggers: ['focused test'],
      strategy: 'bounded-worker',
      evidence: 'repository',
      primary: { model: 'mai-code-1.1-flash', effort: 'medium', context: 'default' },
      skills: [],
      tools: ['affected test'],
      gates: ['deterministic validator'],
      authorization: 'none',
      delegationClass: 'test-generation',
      rationale: 'Bounded and machine-checkable.',
    },
    {
      id: 'release',
      label: 'Release',
      triggers: ['release'],
      strategy: 'explicit-release',
      evidence: 'runtime',
      primary: { model: 'gpt-5.6-sol', effort: 'max', context: 'long_context' },
      skills: ['release-skill'],
      tools: ['release preflight'],
      gates: ['explicit authorization'],
      authorization: 'release',
      rationale: 'Consequential runtime work.',
    },
  ],
};

test('opportunity planner selects one exact profile without a model classifier', () => {
  const focused = opportunityPlan({ question: 'Generate a focused test' }, policy);
  assert.deepEqual(focused.primary,
    { model: 'mai-code-1.1-flash', effort: 'medium', context: 'default' });
  assert.deepEqual(focused.workflow.deterministicSteps, ['affected test']);
  assert.deepEqual(focused.workflow.acceptanceGates, ['deterministic validator']);
  assert.deepEqual(focused.workflow.escalationTriggers, []);
  assert.equal(opportunityPlan({ question: 'Do work', opportunity: 'release' }, policy).strategy,
    'explicit-release');
});

test('opportunity planner reserves escalation for explicit deterministic failures', () => {
  const release = opportunityPlan({ question: 'release' }, policy);
  assert.equal(release.workflow.order.at(-1), 'escalate-if-triggered');
  assert.match(release.workflow.instruction, /Complete deterministic discovery/);
  assert.equal(release.workflow.authorizationBoundary, 'release');
});

test('opportunity planner refuses absent and ambiguous matches', () => {
  assert.equal(opportunityPlan({ question: 'unknown' }, policy).status, 'needs-opportunity');
  const ambiguous = { ...policy, opportunities: policy.opportunities.map(item => ({
    ...item, triggers: ['work'],
  })) };
  assert.equal(opportunityPlan({ question: 'work' }, ambiguous).status, 'ambiguous-opportunity');
  assert.equal(opportunityPlan({ question: 'work', opportunity: 'missing' }, policy).status, 'needs-opportunity');
});

test('version 2 plans expose phase executors and derived authorization', () => {
  const registry = {
    version: 1,
    project: 'sample',
    tools: [{
      id: 'publish-release',
      kind: 'command',
      argv: ['node', '--version'],
      cwd: '.',
      timeoutSeconds: 30,
      sideEffect: 'production',
      environment: [],
    }],
  };
  const v2 = {
    version: 2,
    project: 'sample',
    qualification: {
      status: 'provisional',
      automaticApplication: false,
      minimumPromotionCases: 30,
    },
    toolRegistry: registry,
    opportunities: [{
      id: 'release',
      label: 'Release',
      triggers: ['release'],
      semanticOwner: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
      phases: [
        { id: 'authorize', executor: 'frontier', sideEffect: 'none' },
        {
          id: 'publish',
          executor: 'deterministic',
          tool: 'publish-release',
          sideEffect: 'production',
        },
      ],
    }],
  };
  const result = opportunityPlan({ question: 'release' }, v2);
  assert.equal(result.version, 2);
  assert.equal(result.requiredSideEffect, 'production');
  assert.equal(result.phases[1].executor, 'deterministic');
  assert.equal(result.planHash.length, 64);
});

test('version 2 deterministic opportunity phases execute only registered authorized tools', t => {
  const root = makeScratch('opportunity-execute-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.com',
    'commit', '-qm', 'fixture',
  ], { cwd: root });
  const currentRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const registry = {
    version: 1,
    project: 'sample',
    tools: [{
      id: 'inspect',
      kind: 'command',
      argv: [process.execPath, '-e', 'process.stdout.write("inspected")'],
      cwd: '.',
      timeoutSeconds: 30,
      sideEffect: 'none',
      environment: [],
    }],
  };
  const policy = {
    version: 2,
    project: 'sample',
    qualification: {
      status: 'provisional',
      automaticApplication: false,
      minimumPromotionCases: 30,
    },
    toolRegistry: registry,
    opportunities: [{
      id: 'inspect',
      label: 'Inspect',
      triggers: ['inspect'],
      semanticOwner: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
      phases: [{
        id: 'inspect',
        executor: 'deterministic',
        sideEffect: 'none',
        tool: 'inspect',
      }],
    }],
  };
  const resolvedConfigurationEvents = [{
    type: 'subagent.configured',
    data: {
      model: policy.opportunities[0].semanticOwner.model,
      reasoningEffort: policy.opportunities[0].semanticOwner.effort,
      contextTier: policy.opportunities[0].semanticOwner.context,
    },
  }];
  const authorization = {
    version: 1,
    kind: 'frontier-authorization',
    workflowId: 'inspect-1',
    opportunityId: 'inspect',
    project: 'sample',
    repository: root,
    baseRevision: currentRevision,
    scopeHash: 'a'.repeat(64),
    nonce: 'nonce',
    issuedAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-09T00:00:00.000Z',
    resolvedConfigurationEvidenceHash:
      sha256(resolvedConfigurationEvents[0]),
    allowedSideEffect: 'none',
    toolIds: ['inspect'],
    owner: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
  };
  const result = executeOpportunityPhase(
    root,
    policy,
    { question: 'inspect' },
    'inspect',
    authorization,
    {
      execute: true,
      allowedSideEffects: ['none'],
      now: Date.parse('2026-09-08T12:00:00.000Z'),
      currentRevision: authorization.baseRevision,
      scopeHash: authorization.scopeHash,
      resolvedConfigurationEvidenceHash: authorization.resolvedConfigurationEvidenceHash,
      resolvedConfigurationEvents,
      beforeStateHash: 'c'.repeat(64),
      afterStateHash: 'c'.repeat(64),
    },
  );
  assert.equal(result.execution.stdout, 'inspected');
  assert.equal(result.receipt.status, 'accepted');
  assert.equal(result.receipt.toolId, 'inspect');
});

const projectManifest = process.env.BUDGET_PROJECT_MANIFEST;
test('real project opportunity triggers are unique and cheap work stays bounded',
  { skip: !projectManifest }, () => {
    const data = JSON.parse(fs.readFileSync(projectManifest, 'utf8'));
    let opportunityCount = 0;
    for (const project of data.cases) {
      const policy = readOpportunityPolicy(project.root, readAdapter(project.root));
      assert.equal(policy.version, 3, `${project.id}: opportunity policy must be version 3`);
      opportunityCount += policy.opportunities.length;
      for (const entry of policy.opportunities) {
        const explicit = opportunityPlan({
          question: 'explicit selection',
          opportunity: entry.id,
        }, policy);
        assert.equal(explicit.opportunity, entry.id);
        if (entry.variants) {
          assert.equal(explicit.status, 'needs-variant');
          for (const variant of entry.variants) {
            const variantPlan = opportunityPlan({
              question: 'explicit selection',
              opportunity: entry.id,
              variant,
            }, policy);
            assert.equal(variantPlan.status, entry.enabled ? 'ready' : 'disabled');
            if (variant === 'destructive-maintenance') {
              assert.equal(variantPlan.requiredSideEffect, 'destructive');
            }
            if (variant === 'application-release') {
              assert.equal(variantPlan.requiredSideEffect, 'production');
            }
          }
        }
        for (const trigger of entry.triggers) {
          const plan = opportunityPlan({ question: trigger }, policy);
          assert.equal(plan.status, entry.variants
            ? 'needs-variant'
            : entry.enabled ? 'ready' : 'disabled',
            `${project.id}:${entry.id}:${trigger}`);
          assert.equal(plan.opportunity, entry.id, `${project.id}:${entry.id}:${trigger}`);
        }
        const boundedPhase = entry.phases?.find(phase => phase.kind === 'cheap-worker');
        const worker = entry.team.workerCandidate;
        assert.equal(worker.authority, 'staging-only');
        assert.equal(entry.team.maxRevisions, 1);
        assert.equal(entry.phases.some(phase =>
          ['research-frontier', 'spec-planner', 'risk-triggered-frontier-review']
            .includes(phase.kind) && !phase.condition), false);
        for (const conditional of entry.conditionalProfiles) {
          assert.equal(conditional.requiresTriggerReceipt, true);
          assert.ok(conditional.triggerIds.length > 0);
          if (conditional.profile.effort === 'max' ||
            conditional.profile.context === 'long_context') {
            assert.equal(conditional.kind, 'risk-triggered-frontier-review');
            assert.equal(conditional.profile.model, 'gpt-5.6-sol');
            assert.equal(conditional.profile.effort, 'max');
            assert.equal(conditional.profile.context, 'long_context');
          }
        }
        if (boundedPhase) {
          assert.equal(entry.id, 'focused-tests');
          assert.equal(entry.evidence, 'repository');
          assert.equal(worker.delegationClass, 'test-generation');
          assert.equal(new Set([
            'mai-code-1.1-flash',
            'gemini-3.7-flash',
            'gpt-5-mini',
            'gpt-5.4-mini',
          ]).has(worker.profile.model), true);
          assert.equal(boundedPhase.enabled, worker.enabled);
        }
        for (const skill of entry.skills) {
          assert.equal(fs.existsSync(path.join(project.root, '.github', 'skills', skill, 'SKILL.md')),
            true, `${project.id}:${entry.id} missing skill ${skill}`);
        }
      }
    }
    assert.equal(opportunityCount, 44);
  });
