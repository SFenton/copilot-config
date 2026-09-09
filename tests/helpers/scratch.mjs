import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const gitScratch = execFileSync('git', [
  '-C', repository, 'rev-parse', '--git-path', 'copilot-budget-test-scratch',
], { encoding: 'utf8' }).trim();
const root = path.resolve(repository, gitScratch);

export function makeScratch(prefix = 'case-') {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, prefix));
}

export function scratchPath(...parts) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return path.join(root, ...parts);
}

export function removeScratch(target) {
  fs.rmSync(target, { recursive: true, force: true });
}
