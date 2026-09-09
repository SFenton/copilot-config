import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratch } from './helpers/scratch.mjs';
import {
  challengerFor,
  prepare as prepareOpportunityStudy,
  readEvaluation,
} from '../evals/opportunity-pin-study.mjs';
import {
  parseAppend,
  prepare as prepareWorkerStudy,
  readWorkerCases,
  validateAppend,
} from '../evals/project-worker-study.mjs';

test('challenger ladder lowers cost or context without crossing live authorization', () => {
  assert.deepEqual(challengerFor({
    strategy: 'bounded-worker',
    primary: { model: 'mai-code-1.1-flash', effort: 'medium', context: 'default' },
  }), { model: 'gemini-3.7-flash', effort: 'medium', context: 'default' });
  assert.deepEqual(challengerFor({
    strategy: 'frontier-owner',
    primary: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
  }), { model: 'claude-sonnet-5', effort: 'medium', context: 'default' });
  assert.deepEqual(challengerFor({
    strategy: 'explicit-release',
    primary: { model: 'gpt-5.6-sol', effort: 'max', context: 'long_context' },
  }), { model: 'gpt-5.6-sol', effort: 'high', context: 'default' });
});

test('project worker outputs require strict bounded test append JSON', () => {
  assert.equal(parseAppend(`{"append":"test('x', () => expect(1).toBe(1))"}`,
    ['test(', 'expect(']).includes('expect('), true);
  assert.equal(parseAppend(`{"append":"assert value == 'copilot_socket'"}`, ['assert']).includes('copilot_socket'),
    true);
  assert.throws(() => parseAppend('```json\\n{\"append\":\"test()\"}\\n```', ['test(']));
  assert.throws(() => parseAppend(`{"append":"fetch('https://example.com')"}`, ['fetch(']));
  assert.throws(() => parseAppend(`{"append":"import socket\\nsocket.create_connection(('host', 80))"}`,
    ['socket.']));
});

test('project worker validation borrows sibling dependencies and restores exact target bytes', () => {
  const parent = makeScratch('worker-study-');
  const sibling = path.join(parent, 'fixture');
  const repository = `${sibling}-delegation-123`;
  fs.mkdirSync(path.join(sibling, 'node_modules'), { recursive: true });
  fs.mkdirSync(repository);
  fs.writeFileSync(path.join(repository, 'target.test.js'), 'const original = true;\n');
  execFileSync('git', ['init', '-q', repository]);
  execFileSync('git', ['-C', repository, 'add', 'target.test.js']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-qm', 'fixture']);

  const result = validateAppend(repository, {
    id: 'fixture',
    target: 'target.test.js',
    validator: [process.execPath, '-e',
      "const fs=require('fs');if(!fs.readFileSync('target.test.js','utf8').includes('added'))process.exit(1)"],
  }, 'const added = true;');

  assert.equal(result.passed, true);
  assert.equal(result.provenance.sourceMutated, false);
  assert.notEqual(result.provenance.stagedTargetHash,
    result.provenance.sourceTargetHash);
  assert.equal(fs.readFileSync(path.join(repository, 'target.test.js'), 'utf8'), 'const original = true;\n');
  assert.equal(fs.existsSync(path.join(repository, 'node_modules')), false);
  fs.rmSync(parent, { recursive: true });
});

const manifest = process.env.BUDGET_PROJECT_MANIFEST;
test('every retained-owner opportunity has three frozen repository cases',
  { skip: !manifest }, () => {
    const projects = JSON.parse(fs.readFileSync(manifest, 'utf8')).cases;
    for (const project of projects) {
      const value = readEvaluation(project.root);
      const retained = value.policy.opportunities.filter(item => item.id !== 'focused-tests');
      assert.deepEqual(value.evaluation.opportunities.map(item => item.id).sort(),
        retained.map(item => item.id).sort());
      assert.equal(value.evaluation.opportunities.every(item => item.cases.length === 3), true);
      if (value.adapter.workerEvaluation) {
        assert.equal(readWorkerCases(project.root).value.cases.length, 3);
      }
    }
  });

test('current project worker studies cannot launch before budget selection', {
  skip: !manifest,
}, t => {
  const parent = makeScratch('disabled-worker-studies-');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const projects = JSON.parse(fs.readFileSync(manifest, 'utf8')).cases;
  for (const project of projects) {
    const output = path.join(parent, project.id);
    assert.throws(() => prepareWorkerStudy(project.root, output),
      /invalidated|model calls are disabled/);
    assert.equal(fs.existsSync(output), false);
  }
});

test('invalidated opportunity inventories cannot launch model studies', {
  skip: !manifest,
}, t => {
  const parent = makeScratch('disabled-opportunity-studies-');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const projects = JSON.parse(fs.readFileSync(manifest, 'utf8')).cases;
  for (const project of projects) {
    assert.throws(() => prepareOpportunityStudy(
      project.root,
      path.join(parent, project.id),
    ), /invalidated/);
  }
});
