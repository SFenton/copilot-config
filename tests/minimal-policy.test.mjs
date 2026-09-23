import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function text(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('default instruction retains safety without routing research', () => {
  const instruction = text('instructions/core-safety.instructions.md');

  assert.match(instruction, /current main model owns task meaning/i);
  assert.match(instruction, /Do not use Claude models except Claude Opus 5\.5/i);
  assert.match(instruction, /Claude Opus 5\.5 `max\/default`/);
  assert.match(instruction, /auto-merge only when the author is exactly\s+`SFenton`/i);
  assert.match(instruction, /including bots[\s\S]*manual merge/i);
  assert.doesNotMatch(instruction, /must search session history|packet-first|read files before/i);
});

test('archived budget skill still makes planners and packets optional', () => {
  const skill = text('skills/budget-workflow/SKILL.md');

  assert.match(skill, /current main model responsible/i);
  assert.match(skill, /run a narrow\s+session-history search/i);
  assert.match(skill, /Use non-Claude delegates/i);
  assert.match(skill, /never prerequisites/i);
  assert.doesNotMatch(skill, /run[\s\S]{0,80}opportunities\.mjs plan/i);
  assert.doesNotMatch(skill, /frontier models never perform/i);
});

test('tandem dispatches first and permits authorized implementation', () => {
  const skill = text('skills/tandem-research/SKILL.md');

  assert.match(skill, /Launch GPT-6 Sol `max\/default` and Opus 5\.5 `max\/default`/i);
  assert.match(skill, /\| Independent second researcher \| `claude-opus-5\.5` \| `max` \| `default` \|/);
  assert.doesNotMatch(skill, /Opus 5\.5 `high\/default`/);
  assert.match(skill, /exact unmodified operator request/i);
  assert.match(skill, /end the parent\s+turn and wait/i);
  assert.match(skill, /No parent `view`, search, web, GitHub, history, shell/i);
  assert.match(skill, /current GPT-6 Sol main owner when authorized/i);
  assert.doesNotMatch(skill, /diagnostic copy is strictly read-only/i);
  assert.doesNotMatch(skill, /Use budget-workflow\s+for ordinary work/i);
});

test('archived hook files cannot steer prompts or request continuations', () => {
  const routing = JSON.parse(text('hooks/budget-reads.json'));
  const observer = JSON.parse(text('hooks/continuous-improvement.json'));

  assert.deepEqual(Object.keys(routing.hooks), ['sessionEnd']);
  assert.equal(routing.hooks.sessionEnd.length, 1);
  assert.deepEqual(observer.hooks, {});
});
