import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import {
  qualifySandboxProfile,
  readSandboxProfiles,
} from '../evals/project-sandbox-qualification.mjs';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;

test('every project dependency sandbox qualifies with real focused fixtures', {
  skip: !manifest,
  timeout: 120000,
}, () => {
  const projects = JSON.parse(fs.readFileSync(manifest, 'utf8')).cases;
  for (const project of projects) {
    const adapter = readAdapter(project.root);
    const profiles = readSandboxProfiles(project.root, adapter);
    for (const profile of profiles.profiles) {
      const result = qualifySandboxProfile(project.root, profile.id);
      assert.equal(result.qualified, true,
        `${project.id}/${profile.id}: ${result.stderr}`);
      assert.equal(result.network, 'none');
      assert.equal(result.collateralChanges.length, 0);
      assert.ok(result.runtimeChecks.every(check =>
        check.exitCode === 0 && check.error === null));
      assert.ok(result.dependencyMounts.every(mount => mount.readOnly === true));
      assert.ok(result.dependencyMounts.every(mount =>
        mount.fingerprints.length > 0));
    }
  }
});
