import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateTeamPipelines } from '../evals/team-pipeline-evaluation.mjs';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;

test('zero-model harness evaluates all 44 complete team pipelines', {
  skip: !manifest,
}, () => {
  const config = JSON.parse(fs.readFileSync(
    new URL('../evals/team-pipeline-study.json', import.meta.url),
    'utf8',
  ));
  const result = evaluateTeamPipelines(
    config,
    JSON.parse(fs.readFileSync(manifest, 'utf8')),
  );
  assert.equal(result.pipelineCount, 44);
  assert.equal(result.runStudy, false);
  assert.equal(result.totals.modelCalls, 0);
  assert.equal(result.expectedProductionSavings, null);
  assert.ok(Math.abs(result.sealedV2.totalCredits.value - 1590.70354) < 1e-9);
  assert.ok(Math.abs(result.sealedV2.judgeShare.value - 0.376087) < 0.000001);
  assert.ok(Math.abs(result.sealedV2.costIncreaseOverBaseline.value - 0.6137) < 0.0001);
  for (const topology of result.topologies) {
    assert.equal(topology.modelCallsLaunched.value, 0);
    assert.equal(topology.expectedProductionSavings.value, null);
    assert.ok(topology.legs.some(leg => leg.class === 'failure'));
    assert.ok(topology.legs.some(leg => leg.class === 'fallback'));
    assert.ok(topology.legs.some(leg => leg.class === 'escalation'));
    assert.ok(topology.legs.some(leg => leg.class === 'release'));
  }
});
