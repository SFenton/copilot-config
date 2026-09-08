import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { audit, readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;
test('project adapters resolve and relocated contracts retain original detailed requirements',
  { skip: !manifest }, () => {
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const item of data.cases) {
      assert.ok(readAdapter(item.root).gates.length > 0);
      const hook = JSON.parse(fs.readFileSync(path.join(item.root, '.github/hooks/budget-reads.json'), 'utf8'));
      assert.equal(hook.version, 1);
      assert.equal(hook.hooks.preToolUse.length, 1);
      execFileSync('bash', ['-n', '-c', hook.hooks.preToolUse[0].bash]);
      const after = audit(item.root);
      assert.deepEqual(after.findings.filter(finding => finding.type === 'missing-link'), []);
      const moved = {
        ha: '.github/reference/dashboard-contract.md',
        evershelf: '.github/reference/recipe-contract.md',
      }[item.id];
      if (moved) {
        const baseline = item.instructionBaselineRef ?? 'HEAD';
        const previous = execFileSync('git', ['-C', item.root, 'show', `${baseline}:.github/copilot-instructions.md`], { encoding: 'utf8' });
        const current = fs.readFileSync(path.join(item.root, moved), 'utf8');
        assert.ok(current.endsWith(previous.slice(previous.indexOf('\n') + 1)), `${item.id} contract must remain verbatim after its heading`);
        assert.equal(after.files.find(file => file.file === moved).loading, 'task-reference');
      }
    }
  });
