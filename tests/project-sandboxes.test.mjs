import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import {
  repositoryTreeHash,
  validateCandidateInSandbox,
} from '../skills/budget-workflow/scripts/sandbox.mjs';
import {
  qualifySandboxProfile,
  readSandboxProfiles,
} from '../evals/project-sandbox-qualification.mjs';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;

function capabilityById(root, adapter) {
  const data = JSON.parse(fs.readFileSync(
    path.join(root, adapter.capabilityEvaluation),
    'utf8',
  ));
  return new Map((data.capabilities ?? []).map(item => [item.id, item]));
}

function assertPinnedMetadata(profile, capability) {
  assert.equal(capability.sandbox.imageId, profile.sandbox.expectedImageId);
  assert.equal(capability.sandbox.image, profile.sandbox.image);
  assert.equal(capability.sandbox.network, 'none');
}

function hostDependencyUnavailable(error) {
  return error instanceof Error && (
    error.message === 'Python user site-packages is unavailable' ||
    error.message.startsWith('Python system site-packages index unavailable:') ||
    error.message.startsWith('Sandbox dependency fingerprint unavailable:')
  );
}

function validateWithCurrentTag(project, profile, capability) {
  const config = { ...profile.sandbox };
  delete config.expectedImageId;
  const result = validateCandidateInSandbox({
    repository: project.root,
    repositoryStateHash: repositoryTreeHash(project.root),
    candidate: {
      files: [{
        path: profile.candidateFile,
        content: fs.readFileSync(path.join(project.root, profile.candidateFile), 'utf8'),
      }],
    },
    validator: profile.validator,
    config,
  });
  assert.equal(result.receipt.image, profile.sandbox.image);
  assert.notEqual(result.receipt.imageId, profile.sandbox.expectedImageId,
    `${project.id}/${profile.id}: fallback path requires a mutable-tag image mismatch`);
  assertPinnedMetadata(profile, capability);
  assert.equal(result.receipt.runtimeReady, true,
    `${project.id}/${profile.id}: ${result.stderr}`);
  assert.equal(result.receipt.passed, true,
    `${project.id}/${profile.id}: ${result.stderr}`);
  assert.equal(result.receipt.network, 'none');
  assert.deepEqual(result.receipt.collateralChanges, []);
  assert.ok(result.receipt.runtimeChecks.every(check =>
    check.exitCode === 0 && check.error === null));
  assert.ok(result.receipt.dependencyMounts.every(mount => mount.readOnly === true));
  assert.ok(result.receipt.dependencyMounts.every(mount =>
    mount.fingerprints.length > 0 || mount.treeHash === null));
}

test('every project dependency sandbox qualifies with real focused fixtures or current public tags', {
  skip: !manifest,
  timeout: 120000,
}, () => {
  const projects = JSON.parse(fs.readFileSync(manifest, 'utf8')).cases;
  for (const project of projects) {
    const adapter = readAdapter(project.root);
    const capabilities = capabilityById(project.root, adapter);
    const profiles = readSandboxProfiles(project.root, adapter);
    for (const profile of profiles.profiles) {
      const capability = capabilities.get(profile.id);
      assert.ok(capability, `${project.id}/${profile.id}: capability evidence missing`);
      assertPinnedMetadata(profile, capability);
      try {
        const result = qualifySandboxProfile(project.root, profile.id);
        assert.equal(result.qualified, true,
          `${project.id}/${profile.id}: ${result.stderr}`);
        assert.equal(result.network, 'none');
        assert.equal(result.collateralChanges.length, 0);
        assert.equal(result.imageId, profile.sandbox.expectedImageId);
        assert.ok(result.runtimeChecks.every(check =>
          check.exitCode === 0 && check.error === null));
        assert.ok(result.dependencyMounts.every(mount => mount.readOnly === true));
        assert.ok(result.dependencyMounts.every(mount =>
          mount.fingerprints.length > 0 || mount.treeHash === null));
      } catch (error) {
        if (!(error instanceof Error) ||
          !error.message.startsWith('Sandbox image ID mismatch for ')) {
          throw error;
        }
        try {
          validateWithCurrentTag(project, profile, capability);
        } catch (fallbackError) {
          if (!hostDependencyUnavailable(fallbackError)) {
            throw fallbackError;
          }
        }
      }
    }
  }
});
