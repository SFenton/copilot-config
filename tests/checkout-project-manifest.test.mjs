import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync as runCommand } from 'node:child_process';
import { makeScratch } from './helpers/scratch.mjs';
import {
  checkoutRepositoryUrl,
  cloneCase,
  resolveManifest,
} from '../scripts/checkout-project-manifest.mjs';

function captureGit(commands) {
  return (file, args, options) => {
    commands.push({ file, args, options });
    if (file === 'git' && args[0] === 'init') {
      return runCommand(file, args, options);
    }
    return Buffer.alloc(0);
  };
}

test('public exact-SHA manifest checkouts use tokenless public fetch URLs', t => {
  const temp = makeScratch('checkout-manifest-public-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace);
  const commands = [];
  const ref = 'a'.repeat(40);
  const resolved = resolveManifest({
    cases: [{
      id: 'public-fixture',
      repository: 'octo/public-repo',
      ref,
      path: 'projects/public-fixture',
    }],
  }, workspace, undefined, captureGit(commands));
  const [item] = resolved.cases;
  assert.equal(item.root, path.join(workspace, 'projects/public-fixture'));
  assert.deepEqual(commands.map(entry => entry.args[0]), ['init', 'fetch', 'checkout']);
  assert.deepEqual(commands[1].args, [
    'fetch',
    '--quiet',
    'https://github.com/octo/public-repo.git',
    ref,
  ]);
  assert.equal(fs.readFileSync(path.join(item.root, '.git', 'config'), 'utf8').includes('github.com'), false);
});

test('authenticated manifest checkouts encode the token and never persist it to git config', t => {
  const temp = makeScratch('checkout-manifest-auth-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace);
  const commands = [];
  const token = 'token:/with unsafe?#chars';
  const ref = 'b'.repeat(40);
  const item = cloneCase(workspace, {
    id: 'private-fixture',
    repository: 'octo/private-repo',
    ref,
    path: 'projects/private-fixture',
  }, token, captureGit(commands));
  const fetchUrl = commands[1].args[2];
  assert.equal(fetchUrl, checkoutRepositoryUrl('octo/private-repo', token));
  assert.equal(fetchUrl.includes(token), false);
  assert.match(fetchUrl, /^https:\/\/x-access-token:/);
  assert.deepEqual(commands.map(entry => entry.args[0]), ['init', 'fetch', 'checkout']);
  assert.equal(fs.readFileSync(path.join(item.root, '.git', 'config'), 'utf8').includes(token), false);
});

test('exact-ref validation, workspace containment, and root normalization remain fail-closed', t => {
  const temp = makeScratch('checkout-manifest-guards-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace);
  assert.throws(() => resolveManifest({ cases: [] }, workspace), /Manifest cases array is required/);
  assert.throws(() => cloneCase(workspace, {
    id: 'short-ref',
    repository: 'octo/public-repo',
    ref: 'c'.repeat(39),
    path: 'projects/short-ref',
  }), /exact 40-character commit SHA/);
  assert.throws(() => cloneCase(workspace, {
    id: 'path-escape',
    repository: 'octo/public-repo',
    ref: 'd'.repeat(40),
    path: '../outside',
  }), /must stay inside the workspace/);

  const actual = path.join(temp, 'actual-root');
  const link = path.join(temp, 'linked-root');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, link, 'dir');
  const normalized = resolveManifest({
    cases: [{ id: 'local-root', root: link }],
  }, workspace);
  assert.equal(normalized.cases[0].root, fs.realpathSync(actual));
});

test('failed authenticated fetches fail closed without echoing the token', t => {
  const temp = makeScratch('checkout-manifest-failure-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace);
  const token = 'token:with@secret';
  assert.throws(() => cloneCase(workspace, {
    id: 'fetch-failure',
    repository: 'octo/private-repo',
    ref: 'e'.repeat(40),
    path: 'projects/fetch-failure',
  }, token, (file, args, options) => {
    if (file === 'git' && args[0] === 'init') {
      return runCommand(file, args, options);
    }
    if (file === 'git' && args[0] === 'fetch') {
      throw new Error(`Command failed: git fetch --quiet ${checkoutRepositoryUrl('octo/private-repo', token)}`);
    }
    return Buffer.alloc(0);
  }), error => {
    assert.match(error.message, /Failed to fetch exact ref/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
});
