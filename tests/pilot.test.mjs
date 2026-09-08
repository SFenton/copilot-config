import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeAnswer } from '../skills/budget-workflow/scripts/pilot.mjs';

test('known-answer checks reject hallucinations, missing citations and invented source locations', () => {
  const expected = { cap: 100, strict: true };
  const sources = [{ file: 'x.py', start: 1, end: 5 }];
  const answer = { ...expected, citations: [{ file: 'x.py', line: 3 }] };
  assert.equal(gradeAnswer(JSON.stringify(answer), expected, sources).passed, true);
  for (const bad of [
    { ...answer, cap: 101 }, { ...answer, strict: 'true' }, { ...expected },
    { ...answer, citations: [{ file: 'y.py', line: 3 }] },
    { ...answer, citations: [{ file: 'x.py', line: 300 }] },
  ]) assert.equal(gradeAnswer(JSON.stringify(bad), expected, sources).passed, false);
  assert.equal(gradeAnswer('not json', expected, sources).passed, false);
});
