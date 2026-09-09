import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratch } from './helpers/scratch.mjs';
import { install, uninstall } from '../scripts/install.mjs';

test('installer preserves unrelated configuration and restores exact previous links', t => {
  const temp = makeScratch('budget-install-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  const source = path.join(temp, 'source');
  for (const dir of ['skills/budget-workflow', 'skills/tandem-research', 'hooks', 'instructions']) {
    fs.mkdirSync(path.join(source, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(source, 'hooks/budget-reads.json'), '{}');
  fs.writeFileSync(path.join(source, 'hooks/continuous-improvement.json'), '{}');
  const instruction = '---\napplyTo: "**"\n---\nApply budget-workflow automatically.\n';
  fs.writeFileSync(path.join(source, 'instructions/budget-workflow.instructions.md'), instruction);
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), '{"model":"unchanged"}');
  fs.symlinkSync('/previous/skills/tandem-research', path.join(home, 'skills/tandem-research'));
  assert.throws(() => install(source, home), /unrecognized/);
  assert.equal(fs.existsSync(path.join(home, 'skills/budget-workflow')), false);
  const result = install(source, home, '/previous');
  assert.equal(fs.lstatSync(path.join(home, 'hooks/budget-reads.json')).isFile(), true);
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
  fs.writeFileSync(path.join(source, 'hooks/budget-reads.json'), '{}');
  fs.writeFileSync(path.join(source, 'hooks/continuous-improvement.json'), '{}');
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
    fs.writeFileSync(path.join(root, 'hooks/budget-reads.json'), '{}');
    fs.writeFileSync(path.join(root, 'hooks/continuous-improvement.json'),
      root === previous ? '{"version":"old"}' : '{"version":"new"}');
  }
  fs.writeFileSync(path.join(previous, 'instructions/budget-workflow.instructions.md'), 'old managed rule');
  fs.writeFileSync(path.join(source, 'instructions/budget-workflow.instructions.md'), 'new managed rule');
  fs.mkdirSync(path.join(home, 'instructions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'), 'old managed rule');
  fs.writeFileSync(path.join(home, 'hooks/budget-reads.json'), '{}');
  fs.writeFileSync(path.join(home, 'hooks/continuous-improvement.json'), '{"version":"old"}');
  fs.symlinkSync(path.join(previous, 'skills/budget-workflow'), path.join(home, 'skills/budget-workflow'));
  fs.symlinkSync(path.join(previous, 'skills/tandem-research'), path.join(home, 'skills/tandem-research'));
  const result = install(source, home, previous);
  assert.equal(fs.readFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'), 'utf8'), 'new managed rule');
  assert.equal(fs.readFileSync(path.join(home, 'hooks/continuous-improvement.json'), 'utf8'), '{"version":"new"}');
  uninstall(result.receipt);
  assert.equal(fs.readFileSync(path.join(home, 'instructions/budget-workflow.instructions.md'), 'utf8'), 'old managed rule');
  assert.equal(fs.readlinkSync(path.join(home, 'skills/budget-workflow')), path.join(previous, 'skills/budget-workflow'));
  assert.equal(fs.readFileSync(path.join(home, 'hooks/continuous-improvement.json'), 'utf8'), '{"version":"old"}');
});
