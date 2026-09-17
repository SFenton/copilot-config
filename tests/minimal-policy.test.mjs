import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function text(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('default instruction keeps semantic ownership and targeted continuity', () => {
  const instruction = text('instructions/budget-workflow.instructions.md');

  assert.match(instruction, /current main model as the semantic owner/i);
  assert.match(instruction, /Preserve the operator's exact wording/i);
  assert.match(instruction, /bounded session-history search/i);
  assert.match(instruction, /Delegate only bounded mechanical evidence work/i);
  assert.match(instruction, /Do not use\s+Claude models/i);

  assert.doesNotMatch(instruction, /opportunities\.mjs plan/i);
  assert.doesNotMatch(instruction, /frontier models never perform/i);
  assert.match(instruction, /Do not require[\s\S]*fixed coordinator/i);
  assert.doesNotMatch(instruction, /userPromptSubmitted/i);
});

test('budget skill makes planners and packets optional', () => {
  const skill = text('skills/budget-workflow/SKILL.md');

  assert.match(skill, /current main model responsible/i);
  assert.match(skill, /run a narrow\s+session-history search/i);
  assert.match(skill, /Use non-Claude delegates/i);
  assert.match(skill, /never prerequisites/i);
  assert.doesNotMatch(skill, /run[\s\S]{0,80}opportunities\.mjs plan/i);
  assert.doesNotMatch(skill, /frontier models never perform/i);
});

test('tandem preserves raw intent before matched evidence reasoning', () => {
  const skill = text('skills/tandem-research/SKILL.md');

  assert.match(skill, /operator's exact prompt is canonical/i);
  assert.match(skill, /unchanged to both\s+researchers/i);
  assert.match(skill, /search relevant\s+session history/i);
  assert.match(skill, /Do not use Claude models/i);
  assert.doesNotMatch(skill, /Normalize one shared question/i);
  assert.doesNotMatch(skill, /returns to `budget-workflow`/i);
});

test('installed hook defaults cannot steer prompts or request continuations', () => {
  const routing = JSON.parse(text('hooks/budget-reads.json'));
  const observer = JSON.parse(text('hooks/continuous-improvement.json'));

  assert.deepEqual(Object.keys(routing.hooks), ['sessionEnd']);
  assert.equal(routing.hooks.sessionEnd.length, 1);
  assert.deepEqual(observer.hooks, {});
});
