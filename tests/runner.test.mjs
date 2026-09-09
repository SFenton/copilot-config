import test from 'node:test';
import assert from 'node:assert/strict';
import { invocation, researchToolRequestAllowed, verifyCorpus, verifyEvidencePacket,
  terminateOwnedProcessTree, parseRunEvents } from '../skills/budget-workflow/scripts/run-leaf.mjs';
import { resolvedConfiguration } from '../skills/budget-workflow/scripts/workflow.mjs';
import { packet } from '../skills/budget-workflow/scripts/budget.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { makeScratch, scratchPath } from './helpers/scratch.mjs';

const request = { prompt: 'Summarize supplied evidence', sanitized: true, model: 'gpt-5.4-mini',
  maxCredits: 30, timeoutSeconds: 60, effort: 'medium', context: 'default' };

test('leaf exposes only denied documentation schema, no MCPs, with bounded execution', () => {
  const args = invocation(request, scratchPath('evidence'), ['hass', 'plex']);
  assert.ok(args.includes('--available-tools'));
  assert.ok(args.includes('fetch_copilot_cli_documentation'));
  assert.ok(args.includes('--deny-tool=fetch_copilot_cli_documentation'));
  assert.ok(args.includes('--deny-tool=write'));
  assert.ok(args.includes('--no-custom-instructions'));
  assert.ok(args.includes('--usage-output-file'));
  assert.ok(args.includes('--disable-builtin-mcps'));
  assert.equal(args.filter(value => value === '--disable-mcp-server').length, 2);
  assert.ok(!args.includes('--allow-all'));
});

test('research mode exposes only bounded filesystem discovery and audits requested paths', () => {
  const args = invocation({ ...request, toolMode: 'research', workspace: '/private/corpus' }, '/private/output');
  assert.equal(args[1], '/private/corpus');
  assert.ok(args.includes('--disallow-temp-dir'));
  assert.ok(args.includes('rg'));
  assert.ok(!args.includes('--allow-all-paths'));
  assert.equal(researchToolRequestAllowed({ name: 'view', arguments: { path: '/private/corpus/a.ts' } }, '/private/corpus'), true);
  assert.equal(researchToolRequestAllowed({ name: 'glob', arguments: { pattern: '*.ts' } }, '/private/corpus'), true);
  assert.equal(researchToolRequestAllowed({ name: 'view', arguments: { path: '../gold.json' } }, '/private/corpus'), false);
  assert.equal(researchToolRequestAllowed({ name: 'rg', arguments: { paths: ['/private/gold'] } }, '/private/corpus'), false);
  assert.equal(researchToolRequestAllowed({ name: 'bash', arguments: {} }, '/private/corpus'), false);
});

test('research corpus must remain hash-identical and contained', t => {
  const root = makeScratch('research-corpus-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.txt'), 'frozen');
  const sha256 = crypto.createHash('sha256').update('frozen').digest('hex');
  fs.writeFileSync(path.join(root, 'corpus.json'), JSON.stringify({ sources: [{ path: 'a.txt', sha256 }] }));
  const manifest = verifyCorpus(root);
  const evidence = packet(root, [{ file: 'a.txt', start: 1, end: 1 }]);
  assert.equal(verifyEvidencePacket(root, evidence), true);
  assert.throws(() => verifyEvidencePacket(root, { ...evidence, sources: [{ ...evidence.sources[0], text: 'invented' }] }), /differs from source/);
  const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  assert.equal(manifest.sources.length, 1);
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed');
  assert.throws(() => verifyCorpus(root), /Corpus changed/);
  fs.writeFileSync(path.join(root, 'corpus.json'), JSON.stringify({
    sources: [{ path: 'a.txt', sha256: crypto.createHash('sha256').update('changed').digest('hex') }],
  }));
  assert.throws(() => verifyCorpus(root, manifestHash), /manifest changed/);
});

test('HydraFusion preview does not receive unsupported effort', () => {
  const args = invocation({ ...request, model: 'hydrafusion' }, scratchPath('evidence'));
  assert.ok(args.includes('--experimental'));
  assert.ok(!args.includes('--effort'));
});

test('leaf rejects silent budget, model, payload and timeout substitutions', () => {
  for (const change of [
    { maxCredits: undefined }, { maxCredits: 1 }, { maxCredits: Infinity }, { model: 'auto' },
    { timeoutSeconds: 0 }, { sanitized: false }, { context: 'unknown' }, { prompt: 'x'.repeat(65000) },
  ]) assert.throws(() => invocation({ ...request, ...change }, scratchPath('evidence')));
});

test('provisional worker candidates are explicit supported model pins', () => {
  for (const model of ['gpt-5-mini', 'gpt-5.4-mini', 'gemini-3.8-flash', 'mai-code-1.1-flash']) {
    const args = invocation({ ...request, model }, scratchPath('evidence'));
    assert.ok(args.includes(model));
  }
});

test('expanded worker candidates preserve explicit model pins and HydraFusion experimental mode', () => {
  for (const model of [
    'mai-code-1-flash-picker',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'claude-haiku-4.5',
  ]) {
    const args = invocation({ ...request, model }, scratchPath('output'));
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', model]);
    assert.equal(args.includes('--experimental'), false);
    assert.equal(args.includes('--effort'), model !== 'claude-haiku-4.5');
  }
  const hydra = invocation({ ...request, model: 'hydrafusion' }, scratchPath('output'));
  assert.equal(hydra.includes('--experimental'), true);
  assert.equal(hydra.includes('--effort'), false);
});

test('timed-out logs tolerate only a flagged incomplete final event', () => {
  const result = parseRunEvents('{"type":"ok"}\n{"type":', true);
  assert.equal(result.events.length, 1);
  assert.equal(result.truncated, true);
  assert.throws(() => parseRunEvents('{"type":', false));
  assert.throws(() => parseRunEvents('bad\n{"type":"ok"}', true));
});

test('leaf runtime configuration requires exact resolved event fields', () => {
  const event = {
    type: 'subagent.configured',
    data: {
      model: request.model,
      reasoningEffort: request.effort,
      contextTier: request.context,
    },
  };
  assert.equal(resolvedConfiguration([event], {
    model: request.model,
    effort: request.effort,
    context: request.context,
  }).model, request.model);
  assert.throws(() => resolvedConfiguration([], request), /Exactly one/);
});

test('CLI entry points execute through installed-style symlink paths', t => {
  const root = makeScratch('budget-cli-link-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['budget.mjs', 'opportunities.mjs']) {
    const source = path.resolve('skills/budget-workflow/scripts', name);
    const link = path.join(root, name);
    fs.symlinkSync(source, link);
    const result = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`^${name.replace('.mjs', '')}:`));
  }
});

test('owned process-group termination also stops the CLI-like grandchild',
  { skip: process.platform !== 'linux', timeout: 5000 }, async t => {
    const dir = makeScratch('budget-process-tree-');
    const info = path.join(dir, 'pids.json');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.argv[1], JSON.stringify({ grandchild: grand.pid }));
      setInterval(() => {}, 1000);
    `, info], { detached: true, stdio: 'ignore' });
    t.after(() => {
      terminateOwnedProcessTree(child, 'SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const closed = new Promise(resolve => child.once('close', resolve));
    for (let i = 0; i < 100 && !fs.existsSync(info); i++) await delay(10);
    assert.ok(fs.existsSync(info), 'child should publish its descendant PID');
    const { grandchild } = JSON.parse(fs.readFileSync(info, 'utf8'));
    terminateOwnedProcessTree(child, 'SIGKILL');
    await closed;
    await delay(30);
    const stat = `/proc/${grandchild}/stat`;
    const state = fs.existsSync(stat) ? fs.readFileSync(stat, 'utf8').split(') ')[1][0] : null;
    assert.ok(state === null || state === 'Z', 'grandchild must be gone or exited, not still running');
  });
