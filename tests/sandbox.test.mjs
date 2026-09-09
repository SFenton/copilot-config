import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeScratch } from './helpers/scratch.mjs';
import {
  dockerSandboxAvailable,
  repositoryTreeHash,
  validateCandidateInSandbox,
  validateSandboxReadiness,
  validateSandboxConfig,
  verifySandboxReadiness,
} from '../skills/budget-workflow/scripts/sandbox.mjs';

const image = 'node:22-bookworm-slim';
const config = {
  provider: 'docker',
  image,
  memoryMb: 256,
  pidsLimit: 64,
  allowedCollateralPaths: [],
};

function fixture(t) {
  const root = makeScratch('sandbox-fixture-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'value.mjs'), 'export const value = 1;\n');
  return root;
}

test('sandbox collateral allowlist cannot waive the whole workspace or secrets', () => {
  for (const allowedCollateralPaths of [['.'], ['.env'], ['../outside']]) {
    assert.throws(() => validateSandboxConfig({
      ...config,
      allowedCollateralPaths,
    }), /collateral paths/);
  }
  assert.throws(() => validateSandboxConfig({
    ...config,
    dependencyMounts: [{
      sourceKind: 'repository',
      source: '.',
      target: '.',
      readOnly: true,
    }],
  }), /dependency mount/);
});

test('repository integrity includes tracked source under nested data directories', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'src/data'), { recursive: true });
  const source = path.join(root, 'src/data/value.json');
  fs.writeFileSync(source, '{"value":1}\n');
  fs.writeFileSync(path.join(root, 'target-a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'target-b.txt'), 'b\n');
  fs.symlinkSync('../target-a.txt', path.join(root, 'src/source-link'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.com',
    'commit', '-qm', 'fixture',
  ], { cwd: root });
  const before = repositoryTreeHash(root);
  fs.writeFileSync(source, '{"value":2}\n');
  assert.notEqual(repositoryTreeHash(root), before);
  fs.writeFileSync(source, '{"value":1}\n');
  fs.rmSync(path.join(root, 'src/source-link'));
  fs.symlinkSync('../target-b.txt', path.join(root, 'src/source-link'));
  assert.notEqual(repositoryTreeHash(root), before);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  execFileSync('git', [
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${head},vendor/submodule`,
  ], { cwd: root });
  const withGitlink = repositoryTreeHash(root);
  execFileSync('git', [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.com',
    'commit', '--allow-empty', '-qm', 'second',
  ], { cwd: root });
  const secondHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  execFileSync('git', [
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${secondHead},vendor/submodule`,
  ], { cwd: root });
  assert.notEqual(repositoryTreeHash(root), withGitlink);
});

test('docker sandbox validates staged code with no network or host environment', {
  skip: !dockerSandboxAvailable(image),
}, t => {
  const root = fixture(t);
  const result = validateCandidateInSandbox({
    repository: root,
    repositoryStateHash: repositoryTreeHash(root),
    candidate: {
      files: [{
        path: 'test/value.test.mjs',
        content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../value.mjs';\ntest('value', () => assert.equal(value, 1));\n",
      }],
    },
    validator: {
      argv: ['node', '--test', 'test/value.test.mjs'],
      timeoutSeconds: 30,
    },
    config,
  });

  assert.equal(result.receipt.passed, true);
  assert.equal(result.receipt.network, 'none');
  assert.equal(result.receipt.collateralChanges.length, 0);
  assert.equal(result.receipt.evidenceHash.length, 64);
});

test('sandbox readiness validates image, dependencies and runtime before worker launch', {
  skip: !dockerSandboxAvailable(image),
}, t => {
  const root = fixture(t);
  const ready = validateSandboxReadiness({
    repository: root,
    config: {
      ...config,
      runtimeChecks: [{
        argv: ['node', '-e', 'process.exit(0)'],
        timeoutSeconds: 30,
      }],
    },
  });
  assert.equal(verifySandboxReadiness(ready).ready, true);
  assert.equal(ready.imageId.startsWith('sha256:'), true);
  assert.deepEqual(ready.dependencyMounts, []);

  const failed = validateSandboxReadiness({
    repository: root,
    config: {
      ...config,
      runtimeChecks: [{
        argv: ['node', '-e', 'process.exit(9)'],
        timeoutSeconds: 30,
      }],
    },
  });
  assert.equal(failed.ready, false);
  assert.throws(() => verifySandboxReadiness(failed), /readiness failed/);
});

test('docker sandbox rejects validator collateral mutations', {
  skip: !dockerSandboxAvailable(image),
}, t => {
  const root = fixture(t);
  const result = validateCandidateInSandbox({
    repository: root,
    repositoryStateHash: repositoryTreeHash(root),
    candidate: {
      files: [{ path: 'test/value.test.mjs', content: 'export {};\n' }],
    },
    validator: {
      argv: ['node', '-e', "require('node:fs').writeFileSync('collateral.txt','x')"],
      timeoutSeconds: 30,
    },
    config,
  });
  assert.equal(result.receipt.passed, false);
  assert.deepEqual(result.receipt.collateralChanges, ['collateral.txt']);
});

test('docker sandbox network namespace blocks outbound validation access', {
  skip: !dockerSandboxAvailable(image),
}, t => {
  const root = fixture(t);
  const result = validateCandidateInSandbox({
    repository: root,
    repositoryStateHash: repositoryTreeHash(root),
    candidate: {
      files: [{ path: 'test/value.test.mjs', content: 'export {};\n' }],
    },
    validator: {
      argv: [
        'node',
        '-e',
        "fetch('https://example.com').then(()=>process.exit(0)).catch(()=>process.exit(7))",
      ],
      timeoutSeconds: 30,
    },
    config,
  });
  assert.equal(result.receipt.passed, false);
  assert.equal(result.receipt.exitCode, 7);
});

test('docker sandbox excludes repository secrets and host environment', {
  skip: !dockerSandboxAvailable(image),
}, t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'API_TOKEN=secret\n');
  const result = validateCandidateInSandbox({
    repository: root,
    repositoryStateHash: repositoryTreeHash(root),
    candidate: {
      files: [{ path: 'test/value.test.mjs', content: 'export {};\n' }],
    },
    validator: {
      argv: [
        'node',
        '-e',
        "const fs=require('node:fs');if(fs.existsSync('.env')||process.env.API_TOKEN)process.exit(8)",
      ],
      timeoutSeconds: 30,
    },
    config,
  });
  assert.equal(result.receipt.passed, true);
});
