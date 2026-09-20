import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './helpers/scratch.mjs';
import { install, uninstall } from '../scripts/install.mjs';

const ROUTING_HOOK_JSON = `${JSON.stringify({
  version: 1,
  hooks: {
    sessionEnd: [{
      type: 'command',
      bash: 'node "${COPILOT_HOME:-$HOME/.copilot}/skills/budget-workflow/scripts/routing-enforcement.mjs" session-end',
      powershell: "$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }; node (Join-Path $copilotHome 'skills/budget-workflow/scripts/routing-enforcement.mjs') session-end",
      timeoutSec: 5,
    }],
  },
}, null, 2)}\n`;
const CONTINUOUS_IMPROVEMENT_HOOK_JSON = `${JSON.stringify({
  version: 1,
  hooks: {},
}, null, 2)}\n`;
const SETTINGS = {
  model: 'gpt-5.6-sol',
  disabledSkills: [],
  experimental: true,
  bashEnv: false,
};
const SETTINGS_JSON = `${JSON.stringify(SETTINGS, null, 2)}\n`;

function assertCrossPlatformHookCommands(hook) {
  for (const commands of Object.values(hook.hooks)) {
    for (const command of commands) {
      assert.equal(typeof command.bash, 'string');
      assert.match(command.bash, /COPILOT_HOME/);
      assert.equal(typeof command.powershell, 'string');
      assert.match(command.powershell, /\$env:COPILOT_HOME/);
    }
  }
}

function runNativeHook(command, payload, home, cwd) {
  const windows = process.platform === 'win32';
  return spawnSync(windows ? 'pwsh' : 'bash',
    windows
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : ['-c', command], {
      cwd,
      env: { ...process.env, COPILOT_HOME: home },
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
}

test('installer preserves unrelated configuration and restores exact previous links', t => {
  const temp = makeScratch('budget-install-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  const source = path.join(temp, 'source');
  const previousRoot = path.join(temp, 'previous');
  const previousTandem = path.join(previousRoot, 'skills', 'tandem-research');
  for (const dir of ['skills/budget-workflow', 'skills/tandem-research', 'hooks', 'instructions']) {
    fs.mkdirSync(path.join(source, dir), { recursive: true });
  }
  fs.mkdirSync(previousTandem, { recursive: true });
  fs.writeFileSync(path.join(source, 'hooks/budget-reads.json'), ROUTING_HOOK_JSON);
  fs.writeFileSync(path.join(source, 'hooks/continuous-improvement.json'),
    CONTINUOUS_IMPROVEMENT_HOOK_JSON);
  fs.writeFileSync(path.join(source, 'settings.json'), SETTINGS_JSON);
  const instruction = '---\napplyTo: "**"\n---\nApply budget-workflow automatically.\n';
  fs.writeFileSync(path.join(source, 'instructions/budget-workflow.instructions.md'), instruction);
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), '{"model":"unchanged"}');
  const previousSettings = `${JSON.stringify({ ...SETTINGS, theme: 'dark' })}\n`;
  fs.writeFileSync(path.join(home, 'settings.json'), previousSettings);
  fs.symlinkSync(previousTandem, path.join(home, 'skills/tandem-research'));
  assert.throws(() => install(source, home), /unrecognized/);
  assert.equal(fs.existsSync(path.join(home, 'skills/budget-workflow')), false);
  const result = install(source, home, previousRoot);
  assert.equal(fs.lstatSync(path.join(home, 'hooks/budget-reads.json')).isFile(), true);
  assert.equal(fs.readFileSync(path.join(home, 'hooks/budget-reads.json'), 'utf8'), ROUTING_HOOK_JSON);
  assert.equal(fs.lstatSync(path.join(home, 'hooks/continuous-improvement.json')).isFile(), true);
  const installedInstruction = path.join(home, 'instructions/budget-workflow.instructions.md');
  assert.equal(fs.lstatSync(installedInstruction).isFile(), true);
  assert.equal(fs.readFileSync(installedInstruction, 'utf8'), instruction);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), '{"model":"unchanged"}');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')), {
    ...SETTINGS,
    theme: 'dark',
  });
  assert.equal(fs.readlinkSync(path.join(home, 'skills/tandem-research')), path.join(source, 'skills/tandem-research'));
  uninstall(result.receipt);
  assert.equal(fs.realpathSync(path.join(home, 'skills/tandem-research')),
    fs.realpathSync(previousTandem));
  assert.equal(fs.existsSync(path.join(home, 'hooks/budget-reads.json')), false);
  assert.equal(fs.existsSync(path.join(home, 'hooks/continuous-improvement.json')), false);
  assert.equal(fs.existsSync(installedInstruction), false);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), '{"model":"unchanged"}');
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), previousSettings);
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
  fs.writeFileSync(path.join(source, 'settings.json'), SETTINGS_JSON);
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

test('installer upgrades equivalent managed files across line-ending conversion', t => {
  const temp = makeScratch('budget-line-endings-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const home = path.join(temp, 'home');
  for (const dir of ['skills/budget-workflow', 'skills/tandem-research', 'hooks', 'instructions']) {
    fs.mkdirSync(path.join(source, dir), { recursive: true });
  }
  const instruction = '---\napplyTo: "**"\n---\nApply budget-workflow automatically.\n';
  fs.writeFileSync(path.join(source, 'hooks/budget-reads.json'), ROUTING_HOOK_JSON);
  fs.writeFileSync(path.join(source, 'hooks/continuous-improvement.json'),
    CONTINUOUS_IMPROVEMENT_HOOK_JSON);
  fs.writeFileSync(path.join(source, 'settings.json'), SETTINGS_JSON);
  fs.writeFileSync(path.join(source, 'instructions/budget-workflow.instructions.md'),
    instruction);
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'instructions'), { recursive: true });
  for (const skill of ['budget-workflow', 'tandem-research']) {
    fs.symlinkSync(path.join(source, 'skills', skill),
      path.join(home, 'skills', skill));
  }
  const crlf = value => value.replace(/\n/g, '\r\n');
  fs.writeFileSync(path.join(home, 'hooks/budget-reads.json'),
    crlf(ROUTING_HOOK_JSON));
  fs.writeFileSync(path.join(home, 'hooks/continuous-improvement.json'),
    crlf(CONTINUOUS_IMPROVEMENT_HOOK_JSON));
  fs.writeFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'),
    crlf(instruction));

  const result = install(source, home);
  assert.equal(fs.readFileSync(path.join(home, 'hooks/budget-reads.json'), 'utf8'),
    ROUTING_HOOK_JSON);
  assert.equal(fs.readFileSync(
    path.join(home, 'instructions/budget-workflow.instructions.md'),
    'utf8',
  ), instruction);
  uninstall(result.receipt);
  assert.equal(fs.readFileSync(path.join(home, 'hooks/budget-reads.json'), 'utf8'),
    crlf(ROUTING_HOOK_JSON));
  assert.equal(fs.readFileSync(
    path.join(home, 'instructions/budget-workflow.instructions.md'),
    'utf8',
  ), crlf(instruction));
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
    fs.writeFileSync(path.join(root, 'settings.json'), `${JSON.stringify({
      ...SETTINGS,
      model: root === previous ? 'gpt-5.3-codex' : SETTINGS.model,
    }, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(previous, 'instructions/budget-workflow.instructions.md'), 'old managed rule');
  fs.writeFileSync(path.join(source, 'instructions/budget-workflow.instructions.md'), 'new managed rule');
  fs.mkdirSync(path.join(home, 'instructions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'), 'old managed rule');
  fs.writeFileSync(path.join(home, 'hooks/budget-reads.json'), ROUTING_HOOK_JSON);
  fs.writeFileSync(path.join(home, 'hooks/continuous-improvement.json'), '{"version":"old"}');
  const previousSettings = `${JSON.stringify({
    ...SETTINGS,
    model: 'gpt-5.3-codex',
    theme: 'dark',
  })}\n`;
  fs.writeFileSync(path.join(home, 'settings.json'), previousSettings);
  fs.symlinkSync(path.join(previous, 'skills/budget-workflow'), path.join(home, 'skills/budget-workflow'));
  fs.symlinkSync(path.join(previous, 'skills/tandem-research'), path.join(home, 'skills/tandem-research'));
  const result = install(source, home, previous);
  assert.equal(fs.readFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'), 'utf8'), 'new managed rule');
  assert.equal(fs.readFileSync(path.join(home, 'hooks/continuous-improvement.json'), 'utf8'),
    CONTINUOUS_IMPROVEMENT_HOOK_JSON);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')), {
    ...SETTINGS,
    theme: 'dark',
  });
  uninstall(result.receipt);
  assert.equal(fs.readFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'), 'utf8'), 'old managed rule');
  assert.equal(fs.readlinkSync(path.join(home, 'skills/budget-workflow')), path.join(previous, 'skills/budget-workflow'));
  assert.equal(fs.readFileSync(path.join(home, 'hooks/continuous-improvement.json'), 'utf8'), '{"version":"old"}');
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), previousSettings);
});

test('installer refuses conflicting edits to managed settings', t => {
  const temp = makeScratch('budget-settings-conflict-');
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
  fs.writeFileSync(path.join(source, 'settings.json'), SETTINGS_JSON);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    ...SETTINGS,
    model: 'operator-selected-model',
    theme: 'dark',
  }));

  assert.throws(() => install(source, home), /unrecognized setting "model"/);
  assert.equal(fs.existsSync(path.join(home, 'skills/budget-workflow')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).theme, 'dark');
});

test('canonical and installed routing hook sources keep only passive session-end observation', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const installHook = JSON.parse(fs.readFileSync(path.join(root, 'hooks/budget-reads.json'), 'utf8'));
  const canonicalHook = JSON.parse(fs.readFileSync(path.join(root, '.github/hooks/budget-reads.json'), 'utf8'));
  assert.deepEqual(canonicalHook, installHook);
  assert.deepEqual(Object.keys(installHook.hooks).sort(), ['sessionEnd']);
  assert.equal(installHook.hooks.sessionEnd.length, 1);
  assertCrossPlatformHookCommands(installHook);
});

test('installed continuous-improvement hook is inert by default', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hook = JSON.parse(fs.readFileSync(path.join(root, 'hooks/continuous-improvement.json'), 'utf8'));
  assert.deepEqual(hook.hooks, {});
  assertCrossPlatformHookCommands(hook);
});

test('installed hooks execute through the native platform shell', t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = makeScratch('budget-hook-shell-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = install(root, home);
  assert.match(SETTINGS.model, /^gpt-5\.6-(?:sol|terra|luna)$/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')),
    SETTINGS,
  );
  const routing = JSON.parse(fs.readFileSync(
    path.join(home, 'hooks/budget-reads.json'),
    'utf8',
  ));
  const commandKey = process.platform === 'win32' ? 'powershell' : 'bash';
  const sessionId = '64646464-6464-4646-8646-646464646464';
  const ended = runNativeHook(
    routing.hooks.sessionEnd[0][commandKey],
    { sessionId, cwd: root, reason: 'completed' },
    home,
    root,
  );
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(typeof JSON.parse(ended.stdout), 'object');
  uninstall(result.receipt);
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
  assert.match(instruction, /Do not use\s+Claude models/i);
  assert.match(instruction, /current main model as the semantic owner/i);
  assert.match(instruction, /bounded session-history search/i);
  assert.match(instruction, /No prompt-start routing/i);
  assert.doesNotMatch(instruction, /opportunities\.mjs plan/);
  assert.doesNotMatch(instruction, /frontier models never perform/);
});
