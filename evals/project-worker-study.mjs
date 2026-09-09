#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packet, readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import { run } from '../skills/budget-workflow/scripts/run-leaf.mjs';
import { initializeLedger, normalizeUsage } from '../skills/budget-workflow/scripts/usage.mjs';

const DEFAULT_MODELS = ['mai-code-1.1-flash', 'gemini-3.7-flash'];
const SUPPORTED_MODELS = [...DEFAULT_MODELS, 'gpt-5-mini', 'gpt-5.4-mini'];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function readWorkerCases(root) {
  const repository = fs.realpathSync(root);
  const adapter = readAdapter(repository);
  assert(typeof adapter.workerEvaluation === 'string', 'Adapter workerEvaluation required');
  const value = read(path.join(repository, adapter.workerEvaluation));
  assert(value.version === 1 && value.project === adapter.project &&
    value.opportunity === 'focused-tests', 'Worker evaluation version/project mismatch');
  assert(Array.isArray(value.cases) && value.cases.length === 3,
    'Exactly three project worker cases required');
  for (const item of value.cases) {
    assert(typeof item.id === 'string' && typeof item.instruction === 'string',
      'Worker case id/instruction required');
    assert(typeof item.target === 'string' && fs.existsSync(path.join(repository, item.target)),
      `${item.id}: existing target required`);
    assert(Array.isArray(item.requiredPatterns) && item.requiredPatterns.length >= 2,
      `${item.id}: required patterns missing`);
    assert(Array.isArray(item.validator) && item.validator.length >= 2,
      `${item.id}: validator command missing`);
    packet(repository, item.sources, 40_000);
  }
  return { repository, adapter, value };
}

export function parseAppend(content, requiredPatterns) {
  let value;
  try { value = JSON.parse(content); } catch { throw new Error('Worker output is not strict JSON'); }
  assert(value && Object.keys(value).length === 1 && typeof value.append === 'string',
    'Worker output must contain only append');
  assert(value.append.length > 0 && Buffer.byteLength(value.append) <= 16_000,
    'Worker append must be 1-16000 bytes');
  for (const pattern of requiredPatterns) {
    assert(value.append.includes(pattern), `Worker append missing required pattern: ${pattern}`);
  }
  assert(!/(?:from\s+(?:subprocess|socket|urllib|requests)\s+import|import\s+(?:subprocess|socket|urllib|requests)\b|require\(\s*['"](?:child_process|http|https|net|tls)['"]\s*\)|child_process|os\.system|process\.env|fetch\(|requests\.|urllib\.|socket\.|https?:\/\/)/i
    .test(value.append), 'Worker test contains prohibited process, secret, or network access');
  return value.append;
}

export function prepare(root, output, requestedModels = null) {
  const { repository, value } = readWorkerCases(root);
  assert(!value.qualificationStatus?.startsWith('invalidated'),
    `Worker study is invalidated: ${value.qualificationStatus}`);
  assert(value.modelStudyEnabled === true,
    'Project worker model calls are disabled until the benchmark budget planner selects this exact capability');
  const models = requestedModels ? requestedModels.split(',').filter(Boolean) : DEFAULT_MODELS;
  assert(models.length > 0 && models.every(model => SUPPORTED_MODELS.includes(model)),
    'Unsupported project worker candidate');
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  const seal = {
    version: 1,
    project: value.project,
    repository,
    models,
    cases: value.cases.map(item => ({
      ...item,
      evidence: packet(repository, item.sources, 40_000),
    })),
  };
  write(path.join(output, 'seal.json'), seal);
  fs.writeFileSync(path.join(output, 'seal.sha256'), digest(JSON.stringify(seal)), { flag: 'wx' });
  initializeLedger(path.join(output, 'ledger.json'), 300, 0);
  return { project: value.project, cases: value.cases.length, models };
}

function sealed(output) {
  const seal = read(path.join(output, 'seal.json'));
  assert(digest(JSON.stringify(seal)) === fs.readFileSync(path.join(output, 'seal.sha256'), 'utf8'),
    'Worker study seal changed');
  return seal;
}

function answerContent(directory) {
  const content = read(path.join(directory, 'answer.json')).at(-1)?.content;
  assert(typeof content === 'string', 'Missing worker answer');
  return content;
}

export function validateAppend(repository, item, append) {
  const target = path.join(repository, item.target);
  const gitScratch = execFileSync('git', [
    '-C', repository, 'rev-parse', '--git-path', 'copilot-budget-scratch',
  ], { encoding: 'utf8' }).trim();
  const scratchRoot = path.resolve(repository, gitScratch);
  fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(
    scratchRoot,
    `worker-study-${digest(`${repository}\0${item.target}`).slice(0, 12)}-`,
  ));
  const sandbox = path.join(scratch, 'repository');
  const original = fs.readFileSync(target);
  const originalHash = digest(original);
  try {
    const dirty = execFileSync('git', ['-C', repository, '--literal-pathspecs', 'status',
      '--porcelain=v1', '--', item.target], { encoding: 'utf8' }).trim();
    assert(!dirty, `${item.id}: target must be clean`);
    assert(fs.lstatSync(target).isFile(), `${item.id}: target must be a regular file`);
    fs.mkdirSync(sandbox);
    for (const name of fs.readdirSync(repository)) {
      if (['.git', 'node_modules', 'artifacts'].includes(name)) continue;
      fs.cpSync(path.join(repository, name), path.join(sandbox, name), {
        recursive: true,
        dereference: false,
      });
    }
    const dependencyPath = path.join(sandbox, 'node_modules');
    if (!fs.existsSync(dependencyPath)) {
      const localDependencies = path.join(repository, 'node_modules');
      const sibling = repository.replace(/-delegation-\d+$/, '');
      const siblingDependencies = path.join(sibling, 'node_modules');
      const dependencySource =
        fs.statSync(localDependencies, { throwIfNoEntry: false })?.isDirectory()
          ? localDependencies
          : sibling !== repository &&
            fs.statSync(siblingDependencies, { throwIfNoEntry: false })?.isDirectory()
            ? siblingDependencies
            : null;
      if (dependencySource) fs.symlinkSync(dependencySource, dependencyPath);
    }
    const sandboxTarget = path.join(sandbox, item.target);
    assert(fs.lstatSync(sandboxTarget).isFile(), `${item.id}: staged target must be a regular file`);
    fs.appendFileSync(sandboxTarget, `\n${append}\n`);
    const stdout = execFileSync(item.validator[0], item.validator.slice(1), {
      cwd: sandbox,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 2_000_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      passed: true,
      stdout: stdout.slice(-4000),
      provenance: {
        sourceTargetHash: originalHash,
        stagedTargetHash: digest(fs.readFileSync(sandboxTarget)),
        sourceMutated: false,
      },
    };
  } catch (error) {
    return {
      passed: false,
      stdout: String(error.stdout ?? '').slice(-4000),
      stderr: String(error.stderr ?? error.message).slice(-4000),
      provenance: {
        sourceTargetHash: originalHash,
        sourceMutated: digest(fs.readFileSync(target)) !== originalHash,
      },
    };
  } finally {
    assert(fs.lstatSync(target).isFile() &&
      digest(fs.readFileSync(target)) === originalHash,
    `${item.id}: source target changed during staged validation`);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function solve(output, model, caseId = null) {
  const seal = sealed(output);
  assert(seal.models.includes(model), 'Unsupported project worker candidate');
  const cases = seal.cases.filter(item => !caseId || item.id === caseId);
  assert(cases.length > 0, 'Unknown worker case');
  for (const item of cases) {
    const directory = path.join(output, 'runs', item.id, model);
    if (fs.existsSync(directory)) continue;
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    const prompt = `Generate only additional tests for the supplied pure behavior.
Do not edit implementation, research, use tools, access network/process/environment, or broaden scope.
Return ONLY strict JSON: {"append":"test declarations to append to the existing target file"}.
Do not return Markdown fences, imports unless required, or prose outside JSON.
Target test file: ${item.target}
Instruction: ${item.instruction}
Evidence: ${JSON.stringify(item.evidence)}`;
    let receipt;
    try {
      const result = await run({
        prompt,
        model,
        effort: 'medium',
        context: 'default',
        sanitized: true,
        maxCredits: 30,
        timeoutSeconds: 240,
        ledger: path.join(output, 'ledger.json'),
      }, directory);
      const append = parseAppend(answerContent(directory), item.requiredPatterns);
      const validation = validateAppend(seal.repository, item, append);
      receipt = {
        passed: validation.passed,
        appendSha256: digest(append),
        appendBytes: Buffer.byteLength(append),
        validation,
        usage: normalizeUsage(read(path.join(directory, 'usage.json'))),
        durationMs: result.durationMs,
      };
    } catch (error) {
      fs.mkdirSync(directory, { recursive: true });
      const usageFile = path.join(directory, 'usage.json');
      receipt = {
        passed: false,
        error: error.message,
        usage: fs.existsSync(usageFile) ? normalizeUsage(read(usageFile)) : null,
      };
    }

    fs.mkdirSync(directory, { recursive: true });
    write(path.join(directory, 'worker-study-result.json'), receipt);
    console.log(JSON.stringify({ case: item.id, model, passed: receipt.passed }));
  }
}

export function revalidate(output, model, caseId) {
  const seal = sealed(output);
  assert(seal.models.includes(model), 'Unsupported project worker candidate');
  const item = seal.cases.find(value => value.id === caseId);
  assert(item, 'Unknown worker case');
  const directory = path.join(output, 'runs', item.id, model);
  const append = parseAppend(answerContent(directory), item.requiredPatterns);
  const receipt = {
    passed: false,
    appendSha256: digest(append),
    appendBytes: Buffer.byteLength(append),
    validation: validateAppend(seal.repository, item, append),
    usage: normalizeUsage(read(path.join(directory, 'usage.json'))),
    revalidated: true,
  };
  receipt.passed = receipt.validation.passed;
  write(path.join(directory, 'worker-study-result-revalidated.json'), receipt);
  return receipt;
}

export function report(output) {
  const seal = sealed(output);
  const rows = seal.cases.flatMap(item => seal.models.map(model => {
    const directory = path.join(output, 'runs', item.id, model);
    const revalidated = path.join(directory, 'worker-study-result-revalidated.json');
    const file = fs.existsSync(revalidated)
      ? revalidated : path.join(directory, 'worker-study-result.json');
    return { case: item.id, model, ...(fs.existsSync(file)
      ? read(file) : { passed: false, error: 'missing run', usage: null }) };
  }));
  const models = Object.fromEntries(seal.models.map(model => {
    const selected = rows.filter(item => item.model === model);
    const known = selected.every(item => item.usage);
    return [model, {
      cases: selected.length,
      passes: selected.filter(item => item.passed).length,
      credits: known ? selected.reduce((sum, item) => sum + item.usage.credits, 0) : null,
      tokens: known ? selected.reduce((sum, item) => sum + item.usage.totalTokens, 0) : null,
      provisional: selected.length === 3 && selected.every(item => item.passed),
      qualified: false,
      minimumPromotionCases: 30,
      automaticApplication: false,
    }];
  }));
  return { version: 1, project: seal.project, rows, models };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, first, second, third] = process.argv.slice(2);
    if (command === 'prepare') console.log(JSON.stringify(prepare(first, second, third), null, 2));
    else if (command === 'solve') await solve(first, second, third);
    else if (command === 'revalidate') console.log(JSON.stringify(revalidate(first, second, third), null, 2));
    else if (command === 'report') console.log(JSON.stringify(report(first), null, 2));
    else throw new Error('Usage: project-worker-study.mjs prepare ROOT OUTPUT | solve OUTPUT MODEL [CASE] | revalidate OUTPUT MODEL CASE | report OUTPUT');
  } catch (error) {
    console.error(`project-worker-study: ${error.message}`);
    process.exitCode = 1;
  }
}
