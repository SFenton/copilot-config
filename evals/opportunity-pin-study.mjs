#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packet, readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import { readOpportunityPolicy } from '../skills/budget-workflow/scripts/opportunities.mjs';
import { requiredSideEffect } from '../skills/budget-workflow/scripts/workflow.mjs';
import { run } from '../skills/budget-workflow/scripts/run-leaf.mjs';
import { initializeLedger, normalizeUsage } from '../skills/budget-workflow/scripts/usage.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function challengerFor(opportunity) {
  const bounded = opportunity.strategy === 'bounded-worker' ||
    opportunity.phases?.some(phase => phase.executor === 'bounded-model');
  const primary = opportunity.semanticOwner ?? opportunity.primary;
  if (bounded) {
    return { model: 'gemini-3.7-flash', effort: 'medium', context: 'default' };
  }
  if (primary.model === 'gpt-5.6-sol' && primary.effort === 'max') {
    return { model: 'gpt-5.6-sol', effort: 'high', context: 'default' };
  }
  if (primary.model === 'gpt-5.6-sol' && primary.effort === 'high') {
    return { model: 'claude-sonnet-5', effort: 'medium', context: 'default' };
  }
  return { model: 'gpt-5.4-mini', effort: 'high', context: 'default' };
}

export function readEvaluation(root) {
  const repository = fs.realpathSync(root);
  const adapter = readAdapter(repository);
  assert(typeof adapter.opportunityEvaluation === 'string', 'Adapter opportunityEvaluation required');
  const evaluation = read(path.join(repository, adapter.opportunityEvaluation));
  const policy = readOpportunityPolicy(repository, adapter);
  assert(evaluation.version === 1 && evaluation.project === policy.project,
    'Evaluation version/project mismatch');
  const policyById = new Map(policy.opportunities.map(item => [item.id, item]));
  for (const item of evaluation.opportunities) {
    assert(policyById.has(item.id), `Unknown evaluation opportunity: ${item.id}`);
    assert(Array.isArray(item.cases) && item.cases.length === 3,
      `${item.id}: exactly three cases required`);
    for (const value of item.cases) {
      assert(typeof value.id === 'string' && typeof value.question === 'string',
        `${item.id}: case id/question required`);
      assert(Array.isArray(value.sources) && value.sources.length > 0,
        `${value.id}: sources required`);
      assert(Array.isArray(value.criteria) && value.criteria.length >= 3,
        `${value.id}: criteria required`);
      assert(Array.isArray(value.failureCriteria) && value.failureCriteria.length >= 2,
        `${value.id}: failure criteria required`);
      packet(repository, value.sources, 40_000);
    }
  }
  return { repository, adapter, evaluation, policy, policyById };
}

export function prepare(root, output) {
  const { repository, evaluation, policy, policyById } = readEvaluation(root);
  assert(!evaluation.qualificationStatus?.startsWith('invalidated'),
    `Opportunity study is invalidated: ${evaluation.qualificationStatus}`);
  const invalid = evaluation.opportunities.filter(item =>
    item.qualificationStatus?.startsWith('invalidated'));
  assert(invalid.length === 0,
    `Opportunity study contains invalidated scopes: ${invalid.map(item => item.id).join(', ')}`);
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  const publicCases = [];
  const hiddenCases = [];
  for (const item of evaluation.opportunities) {
    const opportunity = policyById.get(item.id);
    for (const value of item.cases) {
      publicCases.push({
        id: value.id,
        opportunity: item.id,
        question: value.question,
        evidence: packet(repository, value.sources, 40_000),
        baseline: opportunity.semanticOwner ?? opportunity.primary,
        challenger: challengerFor(opportunity),
        strategy: opportunity.strategy ?? (opportunity.phases.some(phase =>
          phase.executor === 'bounded-model') ? 'bounded-worker' : 'frontier-owner'),
        authorization: policy.version === 2
          ? requiredSideEffect(opportunity, policy.toolRegistry)
          : opportunity.authorization,
        gates: opportunity.gates ?? opportunity.phases.flatMap(phase => phase.validators ?? []),
      });
      hiddenCases.push({
        id: value.id,
        criteria: value.criteria,
        failureCriteria: value.failureCriteria,
        validator: value.validator,
        discriminator: value.discriminator,
      });
    }

  }
  const seal = {
    version: 1,
    project: evaluation.project,
    sourceRoot: repository,
    createdAt: new Date().toISOString(),
    cases: publicCases,
    limitation: 'Frozen read-only reasoning cases; live/release/destructive scenarios grant no authorization and perform no side effects.',
  };
  write(path.join(output, 'seal.json'), seal);
  fs.writeFileSync(path.join(output, 'seal.sha256'), digest(JSON.stringify(seal)), { flag: 'wx' });
  write(path.join(output, 'hidden.json'), { version: 1, cases: hiddenCases });
  initializeLedger(path.join(output, 'ledger.json'), 1500, 0);
  return { project: evaluation.project, cases: publicCases.length, seal: digest(JSON.stringify(seal)) };
}

export function deriveConcise(source, output, maximumWords) {
  const seal = read(path.join(source, 'seal.json'));
  assert(digest(JSON.stringify(seal)) === fs.readFileSync(path.join(source, 'seal.sha256'), 'utf8'),
    'Source study seal changed');
  const words = Number.parseInt(maximumWords, 10);
  assert(Number.isInteger(words) && words >= 80 && words <= 500, 'Concise word limit must be 80-500');
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  const derived = { ...seal, createdAt: new Date().toISOString(), challengerMaxWords: words };
  write(path.join(output, 'seal.json'), derived);
  fs.writeFileSync(path.join(output, 'seal.sha256'), digest(JSON.stringify(derived)), { flag: 'wx' });
  fs.copyFileSync(path.join(source, 'hidden.json'), path.join(output, 'hidden.json'), fs.constants.COPYFILE_EXCL);
  initializeLedger(path.join(output, 'ledger.json'), 300, 0);
  return { project: derived.project, cases: derived.cases.length, challengerMaxWords: words };
}

function answerContent(directory) {
  const values = read(path.join(directory, 'answer.json'));
  const content = values.at(-1)?.content;
  assert(typeof content === 'string' && content.trim(), 'Missing solver answer');
  return content;
}

function selectedCases(output, caseId) {
  const seal = read(path.join(output, 'seal.json'));
  assert(digest(JSON.stringify(seal)) === fs.readFileSync(path.join(output, 'seal.sha256'), 'utf8'),
    'Study seal changed');
  const cases = seal.cases.filter(item => !caseId || item.id === caseId);
  assert(cases.length > 0, 'Unknown case');
  return cases;
}

export async function solve(output, arm, caseId = null) {
  assert(['baseline', 'challenger'].includes(arm), 'Arm must be baseline or challenger');
  const seal = read(path.join(output, 'seal.json'));
  assert(digest(JSON.stringify(seal)) === fs.readFileSync(path.join(output, 'seal.sha256'), 'utf8'),
    'Study seal changed');
  for (const value of selectedCases(output, caseId)) {
    const profile = value[arm];
    const directory = path.join(output, 'runs', value.id, arm);
    if (fs.existsSync(directory)) continue;
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    const concise = arm === 'challenger' && Number.isInteger(seal.challengerMaxWords)
      ? ` Limit the complete answer to at most ${seal.challengerMaxWords} words.`
      : '';
    const prompt = `Answer the frozen repository question from the exact evidence only.
Do not use tools, infer missing source, propose live actions, or treat the scenario as authorization.
Return concise analysis with exact evidence references and explicitly preserve applicable gates.${concise}
Question: ${value.question}
Strategy: ${value.strategy}
Authorization: ${value.authorization}
Retained gates: ${JSON.stringify(value.gates)}
Evidence: ${JSON.stringify(value.evidence)}`;
    try {
      await run({
        prompt,
        model: profile.model,
        effort: profile.effort,
        context: profile.context,
        sanitized: true,
        maxCredits: 30,
        timeoutSeconds: 300,
        ledger: path.join(output, 'ledger.json'),
      }, directory);
      if (arm === 'challenger' && Number.isInteger(seal.challengerMaxWords)) {
        const count = answerContent(directory).trim().split(/\s+/).filter(Boolean).length;
        assert(count <= seal.challengerMaxWords,
          `Challenger exceeded ${seal.challengerMaxWords}-word limit`);
      }
      write(path.join(directory, 'study-answer.json'), {
        content: answerContent(directory),
        usage: normalizeUsage(read(path.join(directory, 'usage.json'))),
      });
    } catch (error) {
      fs.mkdirSync(directory, { recursive: true });
      write(path.join(directory, 'study-error.json'), { error: error.message });
    }
    console.log(JSON.stringify({ case: value.id, arm, model: profile.model }));
  }
}

function solverResult(output, id, arm) {
  const directory = path.join(output, 'runs', id, arm);
  const answer = path.join(directory, 'study-answer.json');
  if (!fs.existsSync(answer)) {
    const usage = path.join(directory, 'usage.json');
    return {
      complete: false,
      content: '',
      usage: fs.existsSync(usage) ? normalizeUsage(read(usage)) : null,
      error: fs.existsSync(path.join(directory, 'study-error.json'))
        ? read(path.join(directory, 'study-error.json')).error : 'missing run',
    };
  }
  return { complete: true, ...read(answer), error: null };
}

function parseJudge(content, criterionCount) {
  let value;
  try { value = JSON.parse(content); } catch { throw new Error('Judge output is not strict JSON'); }
  assert(value && Object.keys(value).sort().join(',') === 'failures,rationale,scores,winner',
    'Judge output keys invalid');
  assert(['A', 'B', 'tie'].includes(value.winner), 'Judge winner invalid');
  for (const arm of ['A', 'B']) {
    assert(Array.isArray(value.scores[arm]) && value.scores[arm].length === criterionCount &&
      value.scores[arm].every(score => Number.isInteger(score) && score >= 0 && score <= 2),
    'Judge scores invalid');
    assert(Array.isArray(value.failures[arm]) &&
      value.failures[arm].every(index => Number.isInteger(index) && index >= 0),
    'Judge failures invalid');
  }
  assert(typeof value.rationale === 'string', 'Judge rationale required');
  return value;
}

export async function judge(output, caseId = null) {
  const hidden = new Map(read(path.join(output, 'hidden.json')).cases.map(item => [item.id, item]));
  for (const value of selectedCases(output, caseId)) {
    const directory = path.join(output, 'runs', value.id, 'judge');
    if (fs.existsSync(directory)) continue;
    const baseline = solverResult(output, value.id, 'baseline');
    const challenger = solverResult(output, value.id, 'challenger');
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    if (!baseline.complete || !challenger.complete) {
      fs.mkdirSync(directory, { recursive: false });
      write(path.join(directory, 'study-error.json'), {
        error: 'Cannot judge incomplete solver arms',
        baseline: baseline.error,
        challenger: challenger.error,
      });
      continue;
    }
    const rubric = hidden.get(value.id);
    const challengerFirst = Number.parseInt(digest(value.id).slice(0, 2), 16) % 2 === 0;
    const labels = challengerFirst
      ? { A: challenger, B: baseline, challenger: 'A', baseline: 'B' }
      : { A: baseline, B: challenger, challenger: 'B', baseline: 'A' };
    const prompt = `Grade two anonymous answers to a frozen repository question.
Score each required criterion 0=missing/wrong, 1=partial, 2=complete and correct.
List zero-based forbidden-failure indexes that each answer commits. Prefer tie when materially equivalent.
Return ONLY JSON: {"scores":{"A":[0],"B":[0]},"failures":{"A":[],"B":[]},"winner":"A|B|tie","rationale":"brief"}.
Question: ${value.question}
Evidence: ${JSON.stringify(value.evidence)}
Required criteria: ${JSON.stringify(rubric.criteria)}
Forbidden failures: ${JSON.stringify(rubric.failureCriteria)}
Answer A: ${labels.A.content}
Answer B: ${labels.B.content}`;
    try {
      await run({
        prompt,
        model: 'gpt-5.6-sol',
        effort: 'high',
        context: 'default',
        sanitized: true,
        maxCredits: 30,
        timeoutSeconds: 300,
        ledger: path.join(output, 'ledger.json'),
      }, directory);
      const result = parseJudge(answerContent(directory), rubric.criteria.length);
      write(path.join(directory, 'study-judgment.json'), {
        ...result,
        labels: { challenger: labels.challenger, baseline: labels.baseline },
        usage: normalizeUsage(read(path.join(directory, 'usage.json'))),
      });
    } catch (error) {
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
      write(path.join(directory, 'study-error.json'), { error: error.message });
    }
    console.log(JSON.stringify({ case: value.id, judged: true }));
  }
}

export function report(output) {
  const cases = selectedCases(output, null).map(value => {
    const baseline = solverResult(output, value.id, 'baseline');
    const challenger = solverResult(output, value.id, 'challenger');
    const judgmentFile = path.join(output, 'runs', value.id, 'judge', 'study-judgment.json');
    const judgment = fs.existsSync(judgmentFile) ? read(judgmentFile) : null;
    const challengerLabel = judgment?.labels.challenger;
    const baselineScore = judgment
      ? judgment.scores[judgment.labels.baseline].reduce((a, b) => a + b, 0) : null;
    const challengerScore = judgment
      ? judgment.scores[challengerLabel].reduce((a, b) => a + b, 0) : null;
    const challengerFailures = judgment ? judgment.failures[challengerLabel].length : null;
    return {
      id: value.id,
      opportunity: value.opportunity,
      baselineProfile: value.baseline,
      challengerProfile: value.challenger,
      baselineComplete: baseline.complete,
      challengerComplete: challenger.complete,
      baselineScore,
      challengerScore,
      challengerFailures,
      challengerComparable: judgment
        ? challengerFailures === 0 && challengerScore >= baselineScore && judgment.winner !== judgment.labels.baseline
        : false,
      baselineUsage: baseline.usage,
      challengerUsage: challenger.usage,
      judgment,
    };
  });
  const opportunities = Object.fromEntries([...new Set(cases.map(item => item.opportunity))].map(id => {
    const selected = cases.filter(item => item.opportunity === id);
    return [id, {
      cases: selected.length,
      comparableCases: selected.filter(item => item.challengerComparable).length,
      challengerProvisional: selected.length === 3 &&
        selected.every(item => item.challengerComparable),
      challengerQualified: false,
      minimumPromotionCases: 30,
    }];
  }));
  return { version: 1, cases, opportunities };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, first, second, third] = process.argv.slice(2);
    if (command === 'prepare') console.log(JSON.stringify(prepare(first, second), null, 2));
    else if (command === 'derive-concise') console.log(JSON.stringify(deriveConcise(first, second, third), null, 2));
    else if (command === 'solve') await solve(first, second, third);
    else if (command === 'judge') await judge(first, second);
    else if (command === 'report') console.log(JSON.stringify(report(first), null, 2));
    else throw new Error('Usage: opportunity-pin-study.mjs prepare ROOT OUTPUT | derive-concise SOURCE OUTPUT MAX_WORDS | solve OUTPUT baseline|challenger [CASE] | judge OUTPUT [CASE] | report OUTPUT');
  } catch (error) {
    console.error(`opportunity-pin-study: ${error.message}`);
    process.exitCode = 1;
  }
}
