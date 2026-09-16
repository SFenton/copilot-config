#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;
if (!manifest) {
  console.error('BUDGET_PROJECT_MANIFEST is required for cross-project contract tests');
  process.exit(2);
}
if (!fs.statSync(manifest, { throwIfNoEntry: false })?.isFile()) {
  console.error(`Cross-project manifest is not a file: ${manifest}`);
  process.exit(2);
}

const tests = [
  'tests/opportunities.test.mjs',
  'tests/opportunity-pin-study.test.mjs',
  'tests/project-contracts.test.mjs',
  'tests/registered-worktree-policies.test.mjs',
  'tests/agent-learning-policies.test.mjs',
  'tests/project-sandboxes.test.mjs',
  'tests/project-tools.test.mjs',
  'tests/release-machine.test.mjs',
  'tests/team-pipeline-evaluation.test.mjs',
  'tests/hierarchical-inventory.test.mjs',
];
const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
