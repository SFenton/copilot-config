import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const FORBIDDEN_REPOSITORY_PATTERNS = [
  /\bha-react\b/i,
  /\bha-sfenton-react-dash\b/i,
  /\bevershelf\b/i,
  /\bha-evershelf\b/i,
  /\bfestival-score-tracker\b/i,
  /\bFestivalScoreTracker\b/,
];
const FORBIDDEN_HOME_PATTERNS = [
  /\/home\/sfenton\b/,
  /\$HOME\/repos\/copilot-config\b/,
];
const ALLOWED_GENERIC_PATH_PATTERNS = [
  /session-state\b/,
  /os\.tmpdir\(/,
];
const RUNTIME_SURFACES = [
  '.github/workflows/budget-contracts.yml',
  'README.md',
  'instructions/budget-workflow.instructions.md',
  'scripts/checkout-project-manifest.mjs',
  'skills/budget-workflow/SKILL.md',
  'skills/budget-workflow/scripts/budget.mjs',
  'skills/budget-workflow/scripts/continuous-improvement.mjs',
  'skills/budget-workflow/scripts/effective-contract.mjs',
  'skills/budget-workflow/scripts/model-catalog.mjs',
  'skills/budget-workflow/scripts/opportunities.mjs',
  'skills/budget-workflow/scripts/release-machine.mjs',
  'skills/budget-workflow/scripts/routing-enforcement.mjs',
  'skills/budget-workflow/scripts/run-leaf.mjs',
  'skills/budget-workflow/scripts/workflow.mjs',
];
const ALLOWED_FIXTURES = [
  'skills/budget-workflow/scripts/tests/routing-enforcement.test.mjs',
  'skills/budget-workflow/scripts/tests/intent-acceptance.test.mjs',
];

function text(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('runtime and installed global surfaces reject application repository names and home paths', () => {
  for (const file of RUNTIME_SURFACES) {
    const source = text(file);
    for (const pattern of FORBIDDEN_REPOSITORY_PATTERNS) {
      assert.equal(pattern.test(source), false, `${file} must not contain ${pattern}`);
    }
    for (const pattern of FORBIDDEN_HOME_PATTERNS) {
      assert.equal(pattern.test(source), false, `${file} must not contain ${pattern}`);
    }
  }
});

test('explicit integration data and fixtures may retain repository names and generic path-shape evidence', () => {
  const combined = ALLOWED_FIXTURES.map(file => text(file)).join('\n');
  assert.equal(FORBIDDEN_REPOSITORY_PATTERNS.some(pattern => pattern.test(combined)), true);
  assert.equal(FORBIDDEN_HOME_PATTERNS.some(pattern => pattern.test(combined)), false);
  assert.equal(ALLOWED_GENERIC_PATH_PATTERNS.some(pattern => pattern.test(combined)), true);
});

test('budget contracts workflow requires manifest-backed integration on normal CI without repository coupling', () => {
  const source = text('.github/workflows/budget-contracts.yml');
  assert.match(source, /\n\s*pull_request:\n/);
  assert.match(source, /\n\s*push:\n/);
  assert.match(source, /\n\s*workflow_call:\n/);
  assert.doesNotMatch(source, /if:\s*github\.event_name == 'workflow_dispatch'/);
  assert.match(source, /BUDGET_PROJECT_MANIFEST_JSON/);
  assert.match(source, /CROSS_REPO_READ_TOKEN/);
  assert.match(source,
    /Manifest-backed exact-ref integration manifest is required on pull_request, push, workflow_dispatch, and workflow_call runs\./);
});
