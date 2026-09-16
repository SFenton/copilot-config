import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './helpers/scratch.mjs';
import { install, uninstall } from '../scripts/install.mjs';

const ROUTING_HOOK_JSON = `${JSON.stringify({
  version: 1,
  hooks: {
    userPromptSubmitted: [{
      type: 'command',
      bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/routing-enforcement.mjs" prompt-start',
      timeoutSec: 5,
    }],
    sessionEnd: [{
      type: 'command',
      bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/routing-enforcement.mjs" session-end',
      timeoutSec: 5,
    }],
  },
}, null, 2)}\n`;
const CONTINUOUS_IMPROVEMENT_HOOK_JSON = `${JSON.stringify({
  version: 1,
  hooks: {
    postToolUse: [{
      type: 'command',
      bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/continuous-improvement.mjs" post-tool-use',
      timeoutSec: 5,
    }],
    postToolUseFailure: [{
      type: 'command',
      bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/continuous-improvement.mjs" post-tool-use-failure',
      timeoutSec: 5,
    }],
    subagentStop: [{
      type: 'command',
      bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/continuous-improvement.mjs" subagent-stop',
      timeoutSec: 5,
    }],
    agentStop: [{
      type: 'command',
      bash: 'node "$HOME/.copilot/skills/budget-workflow/scripts/continuous-improvement.mjs" agent-stop',
      timeoutSec: 10,
    }],
  },
}, null, 2)}\n`;

test('installer preserves unrelated configuration and restores exact previous links', t => {
  const temp = makeScratch('budget-install-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  const source = path.join(temp, 'source');
  for (const dir of ['skills/budget-workflow', 'skills/tandem-research', 'hooks', 'instructions']) {
    fs.mkdirSync(path.join(source, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(source, 'hooks/budget-reads.json'), ROUTING_HOOK_JSON);
  fs.writeFileSync(path.join(source, 'hooks/continuous-improvement.json'),
    CONTINUOUS_IMPROVEMENT_HOOK_JSON);
  const instruction = '---\napplyTo: "**"\n---\nApply budget-workflow automatically.\n';
  fs.writeFileSync(path.join(source, 'instructions/budget-workflow.instructions.md'), instruction);
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), '{"model":"unchanged"}');
  fs.symlinkSync('/previous/skills/tandem-research', path.join(home, 'skills/tandem-research'));
  assert.throws(() => install(source, home), /unrecognized/);
  assert.equal(fs.existsSync(path.join(home, 'skills/budget-workflow')), false);
  const result = install(source, home, '/previous');
  assert.equal(fs.lstatSync(path.join(home, 'hooks/budget-reads.json')).isFile(), true);
  assert.equal(fs.readFileSync(path.join(home, 'hooks/budget-reads.json'), 'utf8'), ROUTING_HOOK_JSON);
  assert.equal(fs.lstatSync(path.join(home, 'hooks/continuous-improvement.json')).isFile(), true);
  const installedInstruction = path.join(home, 'instructions/budget-workflow.instructions.md');
  assert.equal(fs.lstatSync(installedInstruction).isFile(), true);
  assert.equal(fs.readFileSync(installedInstruction, 'utf8'), instruction);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), '{"model":"unchanged"}');
  assert.equal(fs.readlinkSync(path.join(home, 'skills/tandem-research')), path.join(source, 'skills/tandem-research'));
  uninstall(result.receipt);
  assert.equal(fs.readlinkSync(path.join(home, 'skills/tandem-research')), '/previous/skills/tandem-research');
  assert.equal(fs.existsSync(path.join(home, 'hooks/budget-reads.json')), false);
  assert.equal(fs.existsSync(path.join(home, 'hooks/continuous-improvement.json')), false);
  assert.equal(fs.existsSync(installedInstruction), false);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), '{"model":"unchanged"}');
});

test('personal instruction collisions and operator edits are never overwritten', t => {
  const temp = makeScratch('budget-instruction-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const home = path.join(temp, 'home');
  for (const dir of ['skills/budget-workflow', 'skills/tandem-research', 'hooks', 'instructions']) {
    fs.mkdirSync(path.join(source, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(source, 'hooks/budget-reads.json'), ROUTING_HOOK_JSON);
  fs.writeFileSync(path.join(source, 'hooks/continuous-improvement.json'),
    CONTINUOUS_IMPROVEMENT_HOOK_JSON);
  fs.writeFileSync(path.join(source, 'instructions/budget-workflow.instructions.md'), 'managed rule');
  fs.mkdirSync(path.join(home, 'instructions'), { recursive: true });
  const destination = path.join(home, 'instructions/budget-workflow.instructions.md');
  fs.writeFileSync(destination, 'operator rule');
  assert.throws(() => install(source, home), /unrecognized file/);
  assert.equal(fs.existsSync(path.join(home, 'skills/budget-workflow')), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'operator rule');
  fs.unlinkSync(destination);
  const result = install(source, home);
  fs.writeFileSync(destination, 'operator edit');
  assert.throws(() => uninstall(result.receipt), /changed destination/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'operator edit');
  assert.equal(fs.existsSync(path.join(home, 'skills/budget-workflow')), true);
});

test('installer upgrades an unchanged regular file from a named previous checkout', t => {
  const temp = makeScratch('budget-upgrade-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const previous = path.join(temp, 'previous');
  const source = path.join(temp, 'source');
  const home = path.join(temp, 'home');
  for (const root of [previous, source]) {
    for (const dir of ['skills/budget-workflow', 'skills/tandem-research', 'hooks', 'instructions']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'hooks/budget-reads.json'), ROUTING_HOOK_JSON);
    fs.writeFileSync(path.join(root, 'hooks/continuous-improvement.json'),
      root === previous ? '{"version":"old"}' : CONTINUOUS_IMPROVEMENT_HOOK_JSON);
  }
  fs.writeFileSync(path.join(previous, 'instructions/budget-workflow.instructions.md'), 'old managed rule');
  fs.writeFileSync(path.join(source, 'instructions/budget-workflow.instructions.md'), 'new managed rule');
  fs.mkdirSync(path.join(home, 'instructions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'), 'old managed rule');
  fs.writeFileSync(path.join(home, 'hooks/budget-reads.json'), ROUTING_HOOK_JSON);
  fs.writeFileSync(path.join(home, 'hooks/continuous-improvement.json'), '{"version":"old"}');
  fs.symlinkSync(path.join(previous, 'skills/budget-workflow'), path.join(home, 'skills/budget-workflow'));
  fs.symlinkSync(path.join(previous, 'skills/tandem-research'), path.join(home, 'skills/tandem-research'));
  const result = install(source, home, previous);
  assert.equal(fs.readFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'), 'utf8'), 'new managed rule');
  assert.equal(fs.readFileSync(path.join(home, 'hooks/continuous-improvement.json'), 'utf8'),
    CONTINUOUS_IMPROVEMENT_HOOK_JSON);
  uninstall(result.receipt);
  assert.equal(fs.readFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'), 'utf8'), 'old managed rule');
  assert.equal(fs.readlinkSync(path.join(home, 'skills/budget-workflow')), path.join(previous, 'skills/budget-workflow'));
  assert.equal(fs.readFileSync(path.join(home, 'hooks/continuous-improvement.json'), 'utf8'), '{"version":"old"}');
});

test('canonical and installed routing hook sources stay semantically aligned with prompt/session lifecycle hooks', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const installHook = JSON.parse(fs.readFileSync(path.join(root, 'hooks/budget-reads.json'), 'utf8'));
  const canonicalHook = JSON.parse(fs.readFileSync(path.join(root, '.github/hooks/budget-reads.json'), 'utf8'));
  assert.deepEqual(canonicalHook, installHook);
  assert.deepEqual(Object.keys(installHook.hooks).sort(),
    ['sessionEnd', 'userPromptSubmitted']);
  assert.equal(installHook.hooks.userPromptSubmitted.length, 1);
  assert.equal(installHook.hooks.sessionEnd.length, 1);
});

test('installed observability hooks avoid duplicate lifecycle registration', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hook = JSON.parse(fs.readFileSync(path.join(root, 'hooks/continuous-improvement.json'), 'utf8'));
  assert.deepEqual(Object.keys(hook.hooks).sort(), [
    'agentStop',
    'postToolUse',
    'postToolUseFailure',
    'subagentStop',
  ]);
});

test('markdown-first instruction surfaces and fallback guidance stay documented', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const instruction = fs.readFileSync(
    path.join(root, 'instructions/budget-workflow.instructions.md'),
    'utf8',
  );
  for (const location of [
    '~/.copilot/copilot-instructions.md',
    '~/.copilot/instructions/**/*.instructions.md',
    '.github/copilot-instructions.md',
    '.github/instructions/**/*.instructions.md',
    'AGENTS.md',
  ]) {
    assert.match(readme, new RegExp(location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const command of ['/instructions', '/env', '/subagents', '/usage', '/limits', '/autopilot --max-ai-credits']) {
    assert.match(readme, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(readme, /soft[\s*]+per-session AI credit target/i);
  assert.match(instruction, /must never prevent[\s\S]*starting or resuming a session/i);
  assert.match(instruction, /current owner may proceed directly/i);
  assert.match(instruction, /Do not add or preserve persistent Claude/i);
});
