#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeLedger, normalizeUsage } from '../skills/budget-workflow/scripts/usage.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });

const cases = [
  {
    id: 'config-scaffold',
    family: 'scaffold',
    files: {
      'src/example-config.mjs': `export const userProfile = Object.freeze({
  id: 'profile',
  retries: 2,
  tags: Object.freeze(['stable']),
});
`,
      'spec.txt': `Create src/payment-config.mjs in the exact reference style. Export paymentProfile with id "payments", retries 4, and frozen tags ["billing", "critical"].\n`,
      'validate.mjs': `import assert from 'node:assert/strict';
import fs from 'node:fs';
const { paymentProfile } = await import('./src/payment-config.mjs?validate=' + Date.now());
assert.deepEqual(paymentProfile, { id: 'payments', retries: 4, tags: ['billing', 'critical'] });
assert.equal(Object.isFrozen(paymentProfile), true);
assert.equal(Object.isFrozen(paymentProfile.tags), true);
const source = fs.readFileSync('src/payment-config.mjs', 'utf8');
assert.match(source, /export const paymentProfile = Object\\.freeze/);
`,
    },
    job: {
      taskClass: 'scaffold',
      instruction: 'Create the requested configuration module exactly from spec.txt and the supplied reference style.',
      inputs: [
        { file: 'src/example-config.mjs', start: 1, end: 5 },
        { file: 'spec.txt', start: 1, end: 2 },
      ],
      outputs: ['src/payment-config.mjs'],
      validator: { argv: ['node', 'validate.mjs'], timeoutSeconds: 30 },
    },
  },
  {
    id: 'registry-scaffold',
    family: 'scaffold',
    files: {
      'src/example-registry.mjs': `export const exampleEntry = {
  key: 'orders',
  match: value => value.startsWith('order:'),
  normalize: value => value.slice('order:'.length).trim().toLowerCase(),
};
`,
      'spec.txt': `Create src/inventory-registry.mjs in the reference style. Export inventoryEntry. key is "inventory"; match accepts strings beginning "inventory:" only; normalize removes that prefix, trims, and uppercases.\n`,
      'validate.mjs': `import assert from 'node:assert/strict';
const { inventoryEntry } = await import('./src/inventory-registry.mjs?validate=' + Date.now());
assert.equal(inventoryEntry.key, 'inventory');
assert.equal(inventoryEntry.match('inventory: rice'), true);
assert.equal(inventoryEntry.match('Inventory: rice'), false);
assert.equal(inventoryEntry.match('order: rice'), false);
assert.equal(inventoryEntry.normalize('inventory:  brown rice '), 'BROWN RICE');
`,
    },
    job: {
      taskClass: 'scaffold',
      instruction: 'Create the registry module described by spec.txt and match the reference module conventions.',
      inputs: [
        { file: 'src/example-registry.mjs', start: 1, end: 5 },
        { file: 'spec.txt', start: 1, end: 2 },
      ],
      outputs: ['src/inventory-registry.mjs'],
      validator: { argv: ['node', 'validate.mjs'], timeoutSeconds: 30 },
    },
  },
  {
    id: 'clamp-tests',
    family: 'test-generation',
    files: {
      'src/clamp.mjs': `export function clamp(value, minimum, maximum) {
  if (minimum > maximum) throw new RangeError('minimum exceeds maximum');
  return Math.min(maximum, Math.max(minimum, value));
}
`,
      'test/wrap.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { wrap } from '../src/wrap.mjs';

test('wrap keeps values inside an inclusive range', () => {
  assert.equal(wrap(3, 1, 5), 3);
});
`,
      'src/wrap.mjs': `export const wrap = (value, minimum, maximum) =>
  value < minimum ? maximum : value > maximum ? minimum : value;
`,
      'spec.txt': `Create test/clamp.test.mjs using the adjacent node:test style. It must prove values below, inside, and above the range and prove reversed bounds throw RangeError with the existing message.\n`,
      'validate.mjs': mutationValidator('src/clamp.mjs', 'test/clamp.test.mjs', [
        `export function clamp(value, minimum, maximum) {
  if (minimum > maximum) throw new RangeError('minimum exceeds maximum');
  return Math.min(maximum, value);
}
`,
        `export function clamp(value, minimum, maximum) {
  if (minimum > maximum) throw new RangeError('minimum exceeds maximum');
  return Math.max(minimum, value);
}
`,
        `export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
`,
      ]),
    },
    job: {
      taskClass: 'test-generation',
      instruction: 'Generate the focused tests required by spec.txt, following the adjacent test conventions.',
      inputs: [
        { file: 'src/clamp.mjs', start: 1, end: 4 },
        { file: 'test/wrap.test.mjs', start: 1, end: 7 },
        { file: 'spec.txt', start: 1, end: 2 },
      ],
      outputs: ['test/clamp.test.mjs'],
      validator: { argv: ['node', 'validate.mjs'], timeoutSeconds: 45 },
    },
  },
  {
    id: 'comma-list-tests',
    family: 'test-generation',
    files: {
      'src/parse-comma-list.mjs': `export function parseCommaList(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value.split(',').map(item => item.trim()).filter(Boolean);
}
`,
      'test/parse-lines.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLines } from '../src/parse-lines.mjs';

test('parseLines trims and removes empty lines', () => {
  assert.deepEqual(parseLines(' one\\n\\n two '), ['one', 'two']);
});
`,
      'src/parse-lines.mjs': `export const parseLines = value => value.split('\\n').map(item => item.trim()).filter(Boolean);
`,
      'spec.txt': `Create test/parse-comma-list.test.mjs in the adjacent style. Prove trimming, empty-item removal, order and duplicate preservation, an empty input, and the exact TypeError for non-string input.\n`,
      'validate.mjs': mutationValidator('src/parse-comma-list.mjs', 'test/parse-comma-list.test.mjs', [
        `export function parseCommaList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}
`,
        `export function parseCommaList(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
}
`,
        `export function parseCommaList(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value.split(',').filter(Boolean);
}
`,
      ]),
    },
    job: {
      taskClass: 'test-generation',
      instruction: 'Generate complete focused tests from spec.txt and the supplied source/reference test.',
      inputs: [
        { file: 'src/parse-comma-list.mjs', start: 1, end: 4 },
        { file: 'test/parse-lines.test.mjs', start: 1, end: 7 },
        { file: 'spec.txt', start: 1, end: 2 },
      ],
      outputs: ['test/parse-comma-list.test.mjs'],
      validator: { argv: ['node', 'validate.mjs'], timeoutSeconds: 45 },
    },
  },
  {
    id: 'duration-transform',
    family: 'mechanical-transform',
    files: {
      'src/format-duration.mjs': `export function formatDuration(totalSeconds) {
  return String(totalSeconds);
}
`,
      'src/format-bytes.mjs': `export function formatBytes(bytes) {
  if (!Number.isInteger(bytes) || bytes < 0) throw new RangeError('bytes must be a non-negative integer');
  return bytes === 1 ? '1 byte' : \`\${bytes} bytes\`;
}
`,
      'spec.txt': `Replace src/format-duration.mjs. Reject non-integers or negatives with RangeError("seconds must be a non-negative integer"). Under 60 use "1 second"/"N seconds". At 60+ use whole minutes plus remaining seconds, omitting a zero part and pluralizing each unit.\n`,
      'validate.mjs': `import assert from 'node:assert/strict';
const { formatDuration } = await import('./src/format-duration.mjs?validate=' + Date.now());
for (const [input, output] of [[0,'0 seconds'],[1,'1 second'],[59,'59 seconds'],[60,'1 minute'],[61,'1 minute 1 second'],[120,'2 minutes'],[125,'2 minutes 5 seconds']]) assert.equal(formatDuration(input), output);
for (const input of [-1, 1.5, '2']) assert.throws(() => formatDuration(input), { name: 'RangeError', message: 'seconds must be a non-negative integer' });
`,
    },
    job: {
      taskClass: 'mechanical-transform',
      instruction: 'Replace the target function according to spec.txt while matching the adjacent validation and export style.',
      inputs: [
        { file: 'src/format-duration.mjs', start: 1, end: 3 },
        { file: 'src/format-bytes.mjs', start: 1, end: 4 },
        { file: 'spec.txt', start: 1, end: 2 },
      ],
      outputs: ['src/format-duration.mjs'],
      validator: { argv: ['node', 'validate.mjs'], timeoutSeconds: 30 },
    },
  },
  {
    id: 'slug-transform',
    family: 'mechanical-transform',
    files: {
      'src/to-slug.mjs': `export function toSlug(value) {
  return value;
}
`,
      'src/to-key.mjs': `export function toKey(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value.trim().toLowerCase().replaceAll(' ', '_');
}
`,
      'spec.txt': `Replace src/to-slug.mjs in the reference validation style. Reject non-strings with TypeError("value must be a string"). Trim, lowercase, turn each run of non-alphanumeric ASCII characters into one hyphen, and remove leading/trailing hyphens.\n`,
      'validate.mjs': `import assert from 'node:assert/strict';
const { toSlug } = await import('./src/to-slug.mjs?validate=' + Date.now());
for (const [input, output] of [[' Hello, World! ','hello-world'],['A---B___C','a-b-c'],['already-clean','already-clean'],['***',''],['A  B','a-b']]) assert.equal(toSlug(input), output);
assert.throws(() => toSlug(null), { name: 'TypeError', message: 'value must be a string' });
`,
    },
    job: {
      taskClass: 'mechanical-transform',
      instruction: 'Replace the target helper from spec.txt and match the supplied sibling helper conventions.',
      inputs: [
        { file: 'src/to-slug.mjs', start: 1, end: 3 },
        { file: 'src/to-key.mjs', start: 1, end: 4 },
        { file: 'spec.txt', start: 1, end: 2 },
      ],
      outputs: ['src/to-slug.mjs'],
      validator: { argv: ['node', 'validate.mjs'], timeoutSeconds: 30 },
    },
  },
];

function mutationValidator(sourcePath, testPath, mutants) {
  return `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const sourcePath = ${JSON.stringify(sourcePath)};
const testPath = ${JSON.stringify(testPath)};
const original = fs.readFileSync(sourcePath, 'utf8');
const run = () => spawnSync(process.execPath, ['--test', testPath], { encoding: 'utf8' });
try {
  const baseline = run();
  if (baseline.status !== 0) throw new Error('generated tests fail correct implementation\\n' + baseline.stderr + baseline.stdout);
  const mutants = ${JSON.stringify(mutants)};
  for (const [index, mutant] of mutants.entries()) {
    fs.writeFileSync(sourcePath, mutant);
    const result = run();
    if (result.status === 0) throw new Error('generated tests did not kill mutant ' + (index + 1));
  }
} finally {
  fs.writeFileSync(sourcePath, original);
}
`;
}

function createRepository(root, item) {
  fs.mkdirSync(root, { recursive: true });
  for (const [file, content] of Object.entries(item.files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/agent-budget.json'), JSON.stringify({
    version: 1,
    project: `delegation-${item.id}`,
    instructions: ['AGENTS.md'],
    riskTerms: ['publication', 'authentication'],
    gates: ['Run the supplied deterministic validator'],
    delegation: {
      allowedClasses: ['scaffold', 'test-generation', 'mechanical-transform'],
      requireCleanTargets: true,
      requireDeterministicValidator: true,
    },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Frozen delegation evaluation fixture. Follow the supplied specification.\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Evaluation', '-c', 'user.email=evaluation@example.com',
    'commit', '-qm', 'frozen fixture'], { cwd: root });
}

export function prepare(output, workerModel = 'gpt-5.4-mini', workerEffort = 'medium') {
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(output, 'fixtures'));
  fs.mkdirSync(path.join(output, 'runs'));
  const seal = {
    version: 1,
    historicalOnly: true,
    runnable: false,
    createdAt: new Date().toISOString(),
    cases: cases.map(({ id, family, job, files }) => ({
      id, family, job, sourceHash: digest(JSON.stringify(files)),
    })),
    arms: {
      frontier: { model: 'gpt-5.6-sol', effort: 'high', context: 'default' },
      worker: { model: workerModel, effort: workerEffort, context: 'default' },
    },
    accounting: 'Delegated total includes the worker and a frontier fallback whenever deterministic validation rejects the worker. Router and validators are deterministic.',
    limitation: 'Synthetic frozen tasks measure bounded artifact generation, not research, debugging, architecture, live-system changes, or broad production equivalence.',
  };
  for (const item of cases) createRepository(path.join(output, 'fixtures', item.id), item);
  write(path.join(output, 'seal.json'), seal);
  fs.writeFileSync(path.join(output, 'seal.sha256'), digest(JSON.stringify(seal)));
  initializeLedger(path.join(output, 'ledger.json'), 500, 0);
  return { cases: cases.length, seal: digest(JSON.stringify(seal)) };
}

export async function solve() {
  throw new Error(
    'The legacy six-case delegation study is historical and non-runnable. Use a capability-matched v2 study only after the benchmark budget planner selects it.',
  );
}

export function armResult(output, id, arm) {
  const directory = path.join(output, 'runs', id, arm, 'output');
  const receiptFile = path.join(directory, 'delegation-result.json');
  if (!fs.existsSync(receiptFile)) {
    const worker = path.join(directory, 'worker');
    const usageFile = path.join(worker, 'usage.json');
    const resultFile = path.join(worker, 'result.json');
    const usage = fs.existsSync(usageFile) ? normalizeUsage(read(usageFile)) : null;
    const retained = fs.existsSync(resultFile) ? read(resultFile) : null;
    return {
      passed: false,
      credits: usage?.credits ?? null,
      tokens: usage?.totalTokens ?? null,
      durationMs: retained?.durationMs ?? null,
      usageKnown: Boolean(usage),
      error: read(path.join(directory, 'study-error.json')).error,
    };
  }
  const receipt = read(receiptFile);
  return {
    passed: receipt.applied === true && receipt.validation?.passed === true,
    credits: receipt.usage.credits,
    tokens: receipt.usage.totalTokens,
    durationMs: receipt.workerResult.durationMs,
    error: receipt.validation?.passed === false ? receipt.validation.stderr : null,
    usageKnown: true,
  };
}

export function report(output) {
  const rows = cases.map(item => {
    const frontier = armResult(output, item.id, 'frontier');
    const worker = armResult(output, item.id, 'worker');
    const accountingComplete = worker.usageKnown && frontier.usageKnown;
    const delegatedCredits = accountingComplete ? worker.credits + (worker.passed ? 0 : frontier.credits) : null;
    const delegatedTokens = accountingComplete ? worker.tokens + (worker.passed ? 0 : frontier.tokens) : null;
    const delegatedDurationMs = accountingComplete ? worker.durationMs + (worker.passed ? 0 : frontier.durationMs) : null;
    return {
      id: item.id,
      family: item.family,
      frontier,
      worker,
      fallbackRequired: !worker.passed,
      delegatedCredits,
      delegatedTokens,
      delegatedDurationMs,
      accountingComplete,
      creditSavings: accountingComplete && frontier.credits > 0 ? 1 - delegatedCredits / frontier.credits : null,
      tokenSavings: accountingComplete && frontier.tokens > 0 ? 1 - delegatedTokens / frontier.tokens : null,
      durationSavings: accountingComplete && frontier.durationMs > 0 ? 1 - delegatedDurationMs / frontier.durationMs : null,
    };
  });
  const sum = (selector, selected = rows) => selected.reduce((total, row) => total + selector(row), 0);
  const accountingComplete = rows.every(row => row.accountingComplete);
  const aggregate = {
    cases: rows.length,
    workerPasses: rows.filter(row => row.worker.passed).length,
    frontierPasses: rows.filter(row => row.frontier.passed).length,
    frontierCredits: sum(row => row.frontier.credits),
    delegatedCredits: accountingComplete ? sum(row => row.delegatedCredits) : null,
    frontierTokens: sum(row => row.frontier.tokens),
    delegatedTokens: accountingComplete ? sum(row => row.delegatedTokens) : null,
    frontierDurationMs: sum(row => row.frontier.durationMs),
    delegatedDurationMs: accountingComplete ? sum(row => row.delegatedDurationMs) : null,
  };
  aggregate.accountingComplete = accountingComplete;
  aggregate.creditSavings = aggregate.accountingComplete ? 1 - aggregate.delegatedCredits / aggregate.frontierCredits : null;
  aggregate.tokenSavings = aggregate.accountingComplete ? 1 - aggregate.delegatedTokens / aggregate.frontierTokens : null;
  aggregate.durationSavings = aggregate.accountingComplete ? 1 - aggregate.delegatedDurationMs / aggregate.frontierDurationMs : null;
  const families = Object.fromEntries([...new Set(rows.map(row => row.family))].map(family => {
    const selected = rows.filter(row => row.family === family);
    const complete = selected.every(row => row.accountingComplete);
    const frontierCredits = sum(row => row.frontier.credits, selected);
    const delegatedCredits = complete ? sum(row => row.delegatedCredits, selected) : null;
    return [family, {
      cases: selected.length,
      workerPasses: selected.filter(row => row.worker.passed).length,
      frontierPasses: selected.filter(row => row.frontier.passed).length,
      frontierCredits,
      delegatedCredits,
      accountingComplete: complete,
      creditSavings: complete ? 1 - delegatedCredits / frontierCredits : null,
    }];
  }));
  return {
    version: 1,
    rows,
    families,
    aggregate,
    decisionRule: 'Qualify only families with all worker cases passing, no frontier-only pass, and positive all-leg credit savings. Retain one attempt and deterministic fallback.',
    limitations: [
      'Six synthetic held-out tasks across three bounded artifact families; not population-level equivalence.',
      'Outer interactive-owner classification/context cost is not included; deterministic router and validators use no model calls.',
      'No research, debugging, architecture, security, release, live-system mutation, semantic documentation, or ambiguous edits were tested.',
      'A passing validator proves only its encoded contract; project tests and owner responsibility remain mandatory.',
    ],
  };
}

export function compare(baselineOutput, candidateOutput) {
  const rows = cases.map(item => {
    const frontier = armResult(baselineOutput, item.id, 'frontier');
    const worker = armResult(candidateOutput, item.id, 'worker');
    const accountingComplete = worker.usageKnown && frontier.usageKnown;
    const delegatedCredits = accountingComplete ? worker.credits + (worker.passed ? 0 : frontier.credits) : null;
    const delegatedTokens = accountingComplete ? worker.tokens + (worker.passed ? 0 : frontier.tokens) : null;
    const delegatedDurationMs = accountingComplete ? worker.durationMs + (worker.passed ? 0 : frontier.durationMs) : null;
    return {
      id: item.id, family: item.family, frontier, worker,
      fallbackRequired: !worker.passed, accountingComplete,
      delegatedCredits, delegatedTokens, delegatedDurationMs,
      creditSavings: accountingComplete ? 1 - delegatedCredits / frontier.credits : null,
      tokenSavings: accountingComplete ? 1 - delegatedTokens / frontier.tokens : null,
      durationSavings: accountingComplete ? 1 - delegatedDurationMs / frontier.durationMs : null,
    };
  });
  const sum = selector => rows.reduce((total, row) => total + selector(row), 0);
  const accountingComplete = rows.every(row => row.accountingComplete);
  const aggregate = {
    cases: rows.length,
    workerPasses: rows.filter(row => row.worker.passed).length,
    frontierPasses: rows.filter(row => row.frontier.passed).length,
    frontierCredits: sum(row => row.frontier.credits),
    delegatedCredits: accountingComplete ? sum(row => row.delegatedCredits) : null,
    frontierTokens: sum(row => row.frontier.tokens),
    delegatedTokens: accountingComplete ? sum(row => row.delegatedTokens) : null,
    frontierDurationMs: sum(row => row.frontier.durationMs),
    delegatedDurationMs: accountingComplete ? sum(row => row.delegatedDurationMs) : null,
  };
  aggregate.accountingComplete = accountingComplete;
  aggregate.creditSavings = aggregate.accountingComplete ? 1 - aggregate.delegatedCredits / aggregate.frontierCredits : null;
  aggregate.tokenSavings = aggregate.accountingComplete ? 1 - aggregate.delegatedTokens / aggregate.frontierTokens : null;
  aggregate.durationSavings = aggregate.accountingComplete ? 1 - aggregate.delegatedDurationMs / aggregate.frontierDurationMs : null;
  return {
    version: 1,
    baselineModel: read(path.join(baselineOutput, 'seal.json')).arms.frontier,
    workerModel: read(path.join(candidateOutput, 'seal.json')).arms.worker,
    rows,
    aggregate,
    decisionRule: 'All six candidates must pass deterministic validation and isolation; failed candidates include frontier fallback cost.',
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, output, id, option] = process.argv.slice(2);
    if (command === 'prepare') console.log(JSON.stringify(prepare(output, id ?? 'gpt-5.4-mini', process.argv[5] ?? 'medium'), null, 2));
    else if (command === 'solve') await solve(output, id, option);
    else if (command === 'report') console.log(JSON.stringify(report(output), null, 2));
    else if (command === 'compare') console.log(JSON.stringify(compare(output, id), null, 2));
    else throw new Error('Usage: delegation-study.mjs prepare OUTPUT [MODEL EFFORT] | solve OUTPUT [CASE [ARM]] | report OUTPUT | compare BASELINE CANDIDATE');
  } catch (error) {
    console.error(`delegation-study: ${error.message}`);
    process.exitCode = 1;
  }
}
