import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inventory } from '../evals/hierarchical-inventory.mjs';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;

test('inventory finds 44 pipelines, five disabled machines, and no untriggered max residency', {
  skip: !manifest,
}, () => {
  const result = inventory(
    JSON.parse(fs.readFileSync(
      new URL('../evals/pin-inventory.json', import.meta.url),
      'utf8',
    )),
    JSON.parse(fs.readFileSync(manifest, 'utf8')),
  );
  assert.equal(result.baseline.structuredSlots.total, 37);
  assert.equal(result.baseline.enforcementSites.total, 18);
  assert.equal(result.after.totals.opportunities, 44);
  assert.equal(result.after.totals.releaseMachines, 5);
  assert.equal(result.after.totals.enabledReleaseMachines, 0);
  assert.equal(result.after.totals.mandatoryMaxLongSlots, 0);
  assert.equal(result.after.totals.structuredViolations, 0);
  assert.equal(result.after.totals.enforcementSiteViolations, 0);
  assert.equal(result.after.totals.unclassifiedMaxLongFiles, 0);
});
