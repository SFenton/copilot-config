import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import {
  loadProjectManifest,
  repositoryLocalPhaseChecks,
} from '../scripts/project-manifest.mjs';
import {
  executeOpportunityPhase,
  opportunityPlan,
  readOpportunityPolicy,
} from '../skills/budget-workflow/scripts/opportunities.mjs';
import { createPipelineLegReceipt }
  from '../skills/budget-workflow/scripts/team-pipeline.mjs';
import { sha256 } from '../skills/budget-workflow/scripts/workflow.mjs';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;

test('repository-local no-side-effect project drivers execute with zero model authorization', {
  skip: !manifest,
}, () => {
  const manifestData = loadProjectManifest(manifest);
  const projects = new Map(manifestData.cases
    .map(item => [item.id, item.root]));
  const cases = manifestData.cases.flatMap(project =>
    repositoryLocalPhaseChecks(project).map(check => ({
      project: project.id,
      ...check,
    })));
  assert.ok(cases.length > 0, 'Manifest must declare at least one repositoryLocalPhaseChecks entry');
  for (const item of cases) {
    const root = projects.get(item.project);
    const adapter = readAdapter(root);
    const policy = readOpportunityPolicy(root, adapter);
    const opportunity = policy.opportunities.find(entry => entry.id === item.opportunity);
    const phase = opportunity.phases.find(entry =>
      entry.id === item.phase && (!entry.variant || entry.variant === item.variant));
    const task = {
      question: 'explicit repository-local validation',
      opportunity: item.opportunity,
      variant: item.variant,
    };
    const plan = opportunityPlan(task, policy);
    const currentRevision = execFileSync(
      'git',
      ['-C', root, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    ).trim();
    const workflowId = `project-tool-${item.project}-${item.phase}`;
    const scopeHash = sha256({
      project: policy.project,
      opportunity: item.opportunity,
      variant: item.variant ?? null,
      phase: item.phase,
    });
    const baseReceipt = {
      workflowId,
      pipelineHash: plan.pipelineHash,
      pipelineId: plan.pipelineId,
      teamId: plan.team.id,
      project: plan.project,
      opportunityId: plan.opportunity,
      repository: fs.realpathSync(root),
      baseRevision: currentRevision,
      scopeHash,
      trustTier: plan.team.trustTier,
      attempt: 1,
      profile: null,
      configurationEvidence: null,
      usage: { state: 'deterministic', modelCalls: 0, credits: 0 },
      state: 'executed',
      outcome: 'accepted',
      startedAt: '2026-09-08T00:00:00.000Z',
      completedAt: '2026-09-08T00:00:01.000Z',
    };
    const route = createPipelineLegReceipt({
      ...baseReceipt,
      phaseId: 'route-opportunity',
      phaseKind: 'deterministic',
      role: 'deterministic-router',
      authority: 'deterministic-local',
      toolEvidence: { builtin: 'deterministic-router' },
      previousReceiptHash: null,
    });
    const evidence = createPipelineLegReceipt({
      ...baseReceipt,
      phaseId: 'collect-evidence',
      phaseKind: 'deterministic',
      role: 'deterministic-evidence',
      authority: 'deterministic-local',
      toolEvidence: { builtin: 'bounded-evidence-collector' },
      previousReceiptHash: route.receiptHash,
    });
    const result = executeOpportunityPhase(
      root,
      policy,
      task,
      item.phase,
      null,
      {
        execute: true,
        allowedSideEffects: ['none'],
        allowDisabledDeterministic: true,
        workflowId,
        currentRevision,
        scopeHash,
        beforeStateHash: 'c'.repeat(64),
        afterStateHash: 'c'.repeat(64),
        receipts: plan.status === 'ready' ? [route, evidence] : [],
      },
    );
    assert.equal(result.execution.status, 'accepted',
      `${item.project}/${item.opportunity}/${item.phase}`);
    assert.equal(result.receipt.toolEvidence.toolId, phase.tool);
    assert.equal(result.receipt.usage.modelCalls, 0);
  }
});
