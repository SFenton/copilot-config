import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './helpers/scratch.mjs';
import { install, uninstall } from '../scripts/install.mjs';

const SETTINGS = {
  model: 'gpt-6-sol',
  disabledSkills: ['budget-workflow', 'ha-budget-workflow'],
  experimental: true,
  bashEnv: false,
};
const PREVIOUS_SETTINGS = {
  ...SETTINGS,
  model: 'gpt-5.6-sol',
  disabledSkills: [],
};
const BUDGET_FILES = [
  'hooks/budget-reads.json',
  'hooks/continuous-improvement.json',
  'instructions/budget-workflow.instructions.md',
];

function fixture(t) {
  const temp = makeScratch('copilot-budgetless-install-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const previous = path.join(temp, 'previous');
  const home = path.join(temp, 'home');
  for (const root of [source, previous]) {
    for (const directory of ['skills/tandem-research', 'skills/budget-workflow',
      'hooks', 'instructions']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'skills/tandem-research/SKILL.md'), 'tandem skill');
    fs.writeFileSync(path.join(root, 'instructions/budget-workflow.instructions.md'),
      'legacy budget instruction\n');
    fs.writeFileSync(path.join(root, 'hooks/budget-reads.json'),
      '{"version":1,"hooks":{"sessionEnd":[]}}\n');
    fs.writeFileSync(path.join(root, 'hooks/continuous-improvement.json'),
      '{"version":1,"hooks":{}}\n');
  }
  fs.writeFileSync(path.join(source, 'instructions/core-safety.instructions.md'),
    'Core safety remains active.\n');
  fs.writeFileSync(path.join(source, 'settings.json'),
    `${JSON.stringify(SETTINGS, null, 2)}\n`);
  fs.writeFileSync(path.join(previous, 'settings.json'),
    `${JSON.stringify(PREVIOUS_SETTINGS, null, 2)}\n`);
  return { source, previous, home };
}

function seedPrevious({ previous, home }, extras = {}) {
  for (const directory of ['skills', 'hooks', 'instructions']) {
    fs.mkdirSync(path.join(home, directory), { recursive: true });
  }
  for (const skill of ['tandem-research', 'budget-workflow']) {
    fs.symlinkSync(path.join(previous, 'skills', skill),
      path.join(home, 'skills', skill));
  }
  for (const file of BUDGET_FILES) {
    fs.copyFileSync(path.join(previous, file), path.join(home, file));
  }
  const oldSettings = `${JSON.stringify({
    ...PREVIOUS_SETTINGS, ...extras,
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(home, 'settings.json'), oldSettings);
  return oldSettings;
}

test('fresh install loads only tandem and core safety while preserving unrelated settings', t => {
  const { source, home } = fixture(t);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), '{"unrelated":true}');
  fs.writeFileSync(path.join(home, 'settings.json'), '{"theme":"dark"}');
  const result = install(source, home);
  assert.deepEqual(result.links, [path.join(home, 'skills/tandem-research')]);
  assert.deepEqual(result.retired, []);
  assert.equal(fs.realpathSync(path.join(home, 'skills/tandem-research')),
    fs.realpathSync(path.join(source, 'skills/tandem-research')));
  assert.equal(fs.readFileSync(path.join(home, 'instructions/core-safety.instructions.md'), 'utf8'),
    'Core safety remains active.\n');
  assert.equal(fs.existsSync(path.join(home, 'skills/budget-workflow')), false);
  for (const file of BUDGET_FILES) assert.equal(fs.existsSync(path.join(home, file)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')),
    { theme: 'dark', ...SETTINGS });
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'),
    '{"unrelated":true}');
  uninstall(result.receipt);
  assert.equal(fs.existsSync(path.join(home, 'skills/tandem-research')), false);
  assert.equal(fs.existsSync(path.join(home, 'instructions/core-safety.instructions.md')), false);
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'),
    '{"theme":"dark"}');
});

test('upgrade retires only recognized budget surfaces and rollback restores them', t => {
  const env = fixture(t);
  const oldSettings = seedPrevious(env, { theme: 'dark' });
  const result = install(env.source, env.home, env.previous);
  assert.equal(result.retired.length, 4);
  for (const file of ['skills/budget-workflow', ...BUDGET_FILES]) {
    assert.equal(fs.existsSync(path.join(env.home, file)), false);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.home, 'settings.json'), 'utf8')),
    { ...SETTINGS, theme: 'dark' });
  assert.equal(fs.readlinkSync(path.join(env.home, 'skills/tandem-research')),
    path.join(env.source, 'skills/tandem-research'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.receipt).mode & 0o077, 0);
  }

  uninstall(result.receipt);
  for (const file of BUDGET_FILES) {
    assert.equal(fs.readFileSync(path.join(env.home, file), 'utf8'),
      fs.readFileSync(path.join(env.previous, file), 'utf8'));
  }
  assert.equal(fs.readlinkSync(path.join(env.home, 'skills/budget-workflow')),
    path.join(env.previous, 'skills/budget-workflow'));
  assert.equal(fs.readlinkSync(path.join(env.home, 'skills/tandem-research')),
    path.join(env.previous, 'skills/tandem-research'));
  assert.equal(fs.existsSync(path.join(env.home, 'instructions/core-safety.instructions.md')),
    false);
  assert.equal(fs.readFileSync(path.join(env.home, 'settings.json'), 'utf8'),
    oldSettings);
});

test('repeated budgetless installs remain idempotent and independently reversible', t => {
  const env = fixture(t);
  const originalSettings = seedPrevious(env);
  const first = install(env.source, env.home, env.previous);
  const second = install(env.source, env.home);
  assert.deepEqual(second.retired, []);
  uninstall(second.receipt);
  assert.equal(fs.existsSync(path.join(env.home, 'skills/budget-workflow')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.home, 'settings.json'), 'utf8')),
    SETTINGS);
  uninstall(first.receipt);
  assert.equal(fs.existsSync(path.join(env.home, 'skills/budget-workflow')), true);
  assert.equal(fs.readFileSync(path.join(env.home, 'settings.json'), 'utf8'),
    originalSettings);
});

test('budget retirement accepts recognized CRLF but preserves it on rollback', t => {
  const env = fixture(t);
  seedPrevious(env);
  const destination = path.join(env.home, 'instructions/budget-workflow.instructions.md');
  const crlf = fs.readFileSync(destination, 'utf8').replace(/\n/g, '\r\n');
  fs.writeFileSync(destination, crlf);
  const result = install(env.source, env.home, env.previous);
  assert.equal(fs.existsSync(destination), false);
  uninstall(result.receipt);
  assert.equal(fs.readFileSync(destination, 'utf8'), crlf);
});

test('unknown budget file and symlink refuse installation before changing any target', t => {
  const env = fixture(t);
  seedPrevious(env);
  const budgetFile = path.join(env.home, 'instructions/budget-workflow.instructions.md');
  fs.writeFileSync(budgetFile, 'operator instruction');
  assert.throws(() => install(env.source, env.home, env.previous),
    /Refusing to retire unrecognized file/);
  assert.equal(fs.readFileSync(budgetFile, 'utf8'), 'operator instruction');
  assert.equal(fs.existsSync(path.join(env.home, 'instructions/core-safety.instructions.md')), false);
  fs.copyFileSync(path.join(env.previous, 'instructions/budget-workflow.instructions.md'),
    budgetFile);
  fs.unlinkSync(path.join(env.home, 'skills/budget-workflow'));
  fs.mkdirSync(path.join(env.home, 'other'));
  fs.symlinkSync(path.join(env.home, 'other'),
    path.join(env.home, 'skills/budget-workflow'));
  assert.throws(() => install(env.source, env.home, env.previous),
    /Refusing to retire unrecognized link/);
});

test('operator edits to core instruction and managed settings fail closed', t => {
  const env = fixture(t);
  fs.mkdirSync(path.join(env.home, 'instructions'), { recursive: true });
  const core = path.join(env.home, 'instructions/core-safety.instructions.md');
  fs.writeFileSync(core, 'operator-owned instruction');
  assert.throws(() => install(env.source, env.home),
    /Refusing to replace unrecognized file/);
  assert.equal(fs.readFileSync(core, 'utf8'), 'operator-owned instruction');
  fs.unlinkSync(core);
  fs.writeFileSync(path.join(env.home, 'settings.json'),
    JSON.stringify({ ...SETTINGS, model: 'operator-selected', theme: 'dark' }));
  assert.throws(() => install(env.source, env.home), /unrecognized setting "model"/);
  assert.equal(fs.existsSync(path.join(env.home, 'skills/tandem-research')), false);
});

test('rollback refuses recreated retired files instead of destroying user changes', t => {
  const env = fixture(t);
  seedPrevious(env);
  const result = install(env.source, env.home, env.previous);
  const destination = path.join(env.home, 'hooks/budget-reads.json');
  fs.writeFileSync(destination, 'new operator hook');
  assert.throws(() => uninstall(result.receipt), /Refusing rollback of changed destination/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new operator hook');
  assert.equal(fs.existsSync(path.join(env.home, 'instructions/core-safety.instructions.md')),
    true);
});

test('archived hooks remain passive source fixtures but are never installed', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const archived = JSON.parse(fs.readFileSync(path.join(root, 'hooks/budget-reads.json'), 'utf8'));
  const canonical = JSON.parse(fs.readFileSync(
    path.join(root, '.github/hooks/budget-reads.json'), 'utf8'));
  const observer = JSON.parse(fs.readFileSync(
    path.join(root, 'hooks/continuous-improvement.json'), 'utf8'));
  assert.deepEqual(archived, canonical);
  assert.deepEqual(Object.keys(archived.hooks), ['sessionEnd']);
  assert.deepEqual(observer.hooks, {});
});

test('documentation describes a budgetless global profile and rollback', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const instruction = fs.readFileSync(
    path.join(root, 'instructions/core-safety.instructions.md'), 'utf8');
  assert.match(readme, /installer links only tandem-research/i);
  assert.match(readme, /copilot-install-TIMESTAMP-UUID\.json/);
  assert.match(readme, /interactive default is `gpt-6-sol`/);
  assert.match(instruction, /Do not use Claude models except Claude Opus 5\.5/);
  assert.match(instruction, /auto-merge only when the author is exactly/i);
});
