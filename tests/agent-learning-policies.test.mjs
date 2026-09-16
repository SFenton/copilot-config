import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import {
  readLearningPolicy,
} from '../skills/budget-workflow/scripts/continuous-improvement.mjs';
import {
  readOpportunityPolicy,
} from '../skills/budget-workflow/scripts/opportunities.mjs';
import {
  validateToolRegistry,
} from '../skills/budget-workflow/scripts/workflow.mjs';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;

test('project learning policies bind priorities, validators and safety',
  { skip: !manifest }, () => {
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.equal(new Set(data.cases.map(item => item.id)).size, data.cases.length);
    for (const item of data.cases) {
      const adapter = readAdapter(item.root);
      assert.equal(adapter.learningPolicy, '.github/agent-learning.json');
      const policy = readLearningPolicy(item.root, adapter);
      const opportunityPolicy = readOpportunityPolicy(item.root, adapter);
      const opportunities = new Set(opportunityPolicy.opportunities.map(value => value.id));
      const registry = validateToolRegistry(JSON.parse(fs.readFileSync(
        path.join(item.root, adapter.toolRegistry),
        'utf8',
      )), adapter.project);
      const toolIds = new Set(registry.tools.map(tool => tool.id));
      assert.ok(policy.priorities.length > 0, `${item.id}: priorities required`);
      assert.equal(new Set(policy.priorities.map(priority => priority.id)).size,
        policy.priorities.length, `${item.id}: priority ids must be unique`);
      assert.equal(policy.thresholds.maximumCandidatesPerWorkflow, 1);
      assert.equal(policy.thresholds.minimumOperationCount, 2);
      assert.equal(policy.thresholds.maximumSubgraphOperations, 6);
      assert.equal(policy.thresholds.maximumAnalysisEvents, 10000);
      assert.equal(policy.continuation.enabled, true);
      assert.equal(policy.automaticBuild, true);
      assert.equal(policy.automaticPromotion, false);
      assert.deepEqual(policy.promotion.allowedSideEffects, ['none', 'workspace']);
      assert.ok(policy.riskClasses.some(value =>
        ['production', 'release', 'destructive'].includes(value)));
      assert.ok(policy.excludedPaths.length > 0);
      for (const priority of policy.priorities) {
        assert.match(priority.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        assert.ok(opportunities.has(priority.opportunity),
          `${item.id}/${priority.id}: opportunity does not exist`);
        assert.ok(priority.validators.length > 0);
        assert.ok(['tools', 'skills', 'fixtures'].includes(priority.destination));
      }
      const targetIds = new Set(policy.priorities.map(priority => priority.id));
      for (const validator of policy.validators) {
        assert.ok(toolIds.has(validator.id),
          `${item.id}/${validator.id}: validator is not registered`);
        assert.ok(validator.targets.every(target => targetIds.has(target)),
          `${item.id}/${validator.id}: validator target is unknown`);
      }
      assert.ok([...targetIds].every(target =>
        policy.validators.some(validator => validator.targets.includes(target))),
      `${item.id}: every priority needs a validator`);
      for (const priority of policy.priorities) {
        assert.ok(priority.validators.every(validator =>
          policy.validators.some(entry =>
            entry.id === validator && entry.targets.includes(priority.id))),
        `${item.id}/${priority.id}: explicit validator mapping is invalid`);
      }
    }
  });
