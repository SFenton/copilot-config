#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import {
  dockerSandboxAvailable,
  repositoryTreeHash,
  validateCandidateInSandbox,
  validateSandboxConfig,
} from '../skills/budget-workflow/scripts/sandbox.mjs';
import { sha256 } from '../skills/budget-workflow/scripts/workflow.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function readSandboxProfiles(root, adapter = readAdapter(root)) {
  assert(typeof adapter.sandboxProfiles === 'string', 'Adapter sandboxProfiles required');
  const file = path.join(root, adapter.sandboxProfiles);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(value.version === 1 && value.project === adapter.project,
    'Sandbox profile version/project mismatch');
  assert(Array.isArray(value.profiles) && value.profiles.length > 0,
    'Sandbox profiles required');
  const ids = new Set();
  for (const profile of value.profiles) {
    assert(typeof profile.id === 'string' && !ids.has(profile.id),
      'Unique sandbox profile id required');
    ids.add(profile.id);
    assert(profile.id === profile.capability,
      `${profile.id}: profile and capability IDs must match`);
    assert(typeof profile.candidateFile === 'string' && profile.candidateFile.length > 0 &&
      !path.isAbsolute(profile.candidateFile) &&
      !profile.candidateFile.split(/[\\/]/).includes('..'),
    `${profile.id}: safe candidateFile required`);
    assert(fs.statSync(path.join(root, profile.candidateFile), { throwIfNoEntry: false })?.isFile(),
      `${profile.id}: candidateFile unavailable`);
    validateSandboxConfig(profile.sandbox);
  }
  return value;
}

export function qualifySandboxProfile(root, profileId) {
  const repository = fs.realpathSync(root);
  const profiles = readSandboxProfiles(repository);
  const profile = profiles.profiles.find(item => item.id === profileId);
  assert(profile, `Unknown sandbox profile: ${profileId}`);
  assert(dockerSandboxAvailable(profile.sandbox.image),
    `Sandbox image must already exist locally: ${profile.sandbox.image}`);
  const candidate = {
    files: [{
      path: profile.candidateFile,
      content: fs.readFileSync(path.join(repository, profile.candidateFile), 'utf8'),
    }],
  };
  const result = validateCandidateInSandbox({
    repository,
    repositoryStateHash: repositoryTreeHash(repository),
    candidate,
    validator: profile.validator,
    config: profile.sandbox,
  });
  const qualification = {
    version: 1,
    project: profiles.project,
    capability: profile.capability,
    profileHash: sha256(profile),
    dependencyPolicyHash: sha256(profile.sandbox.dependencyMounts ?? []),
    candidateFileHash: crypto.createHash('sha256')
      .update(candidate.files[0].content).digest('hex'),
    sandboxEvidenceHash: result.receipt.evidenceHash,
    image: result.receipt.image,
    imageId: result.receipt.imageId,
    network: result.receipt.network,
    dependencyMounts: result.receipt.dependencyMounts,
    runtimeChecks: result.receipt.runtimeChecks,
    collateralChanges: result.receipt.collateralChanges,
    qualified: result.receipt.passed &&
      result.receipt.runtimeReady &&
      result.receipt.collateralChanges.length === 0,
  };
  return {
    ...qualification,
    status: qualification.qualified ? 'qualified' : 'failed',
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = qualifySandboxProfile(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
    if (!result.qualified) process.exitCode = 2;
  } catch (error) {
    console.error(`project-sandbox-qualification: ${error.message}`);
    process.exitCode = 1;
  }
}
