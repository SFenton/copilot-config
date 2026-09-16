import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inventory } from '../evals/hierarchical-inventory.mjs';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;

test('inventory keeps manifest projects free of unconditional max/long and policy-site violations', {
  skip: !manifest,
}, () => {
  const manifestData = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const result = inventory(
    JSON.parse(fs.readFileSync(
      new URL('../evals/pin-inventory.json', import.meta.url),
      'utf8',
    )),
    manifestData,
  );
  assert.equal(result.after.totals.projects, manifestData.cases.length);
  assert.ok(result.after.totals.opportunities > 0);
  assert.equal(result.after.totals.opportunities,
    result.after.projects.reduce((sum, project) => sum + project.opportunities, 0));
  assert.equal(result.after.totals.releaseMachines, result.after.machines.length);
  assert.equal(result.after.totals.enabledReleaseMachines,
    result.after.machines.filter(machine => machine.enabled).length);
  assert.equal(result.after.totals.mandatoryMaxLongSlots, 0);
  assert.equal(result.after.totals.structuredViolations, 0);
  assert.equal(result.after.totals.enforcementSiteViolations, 0);
  assert.equal(result.after.totals.unclassifiedMaxLongFiles, 0);
  assert.equal(result.after.enforcementSites.total, result.after.enforcementSites.sites.length);
});
