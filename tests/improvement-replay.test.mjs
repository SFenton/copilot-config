import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeScratch } from './helpers/scratch.mjs';
import {
  accountCandidateValue,
  createReplayPlan,
  evaluatePromotion,
  incubateCandidate,
  promoteCandidate,
  replayCandidate,
  validateCandidateArtifact,
} from '../skills/budget-workflow/scripts/improvement-replay.mjs';
import { transitionCandidate } from '../skills/budget-workflow/scripts/improvement-candidates.mjs';
import { sha256 } from '../skills/budget-workflow/scripts/workflow.mjs';

function candidate(candidateClass = 'deterministic-tool') {
  return {
    version: 1,
    id: `candidate-fixture-${candidateClass === 'deterministic-tool' ? 'tool' : 'skill'}`,
    project: 'fixture',
    opportunityId: 'fixture',
    selectedPriority: 'fixture-operation',
    requiredValidators: ['fixture-validator'],
    destination: candidateClass === 'deterministic-tool' ? 'tools' : 'skills',
    class: candidateClass,
    state: 'eligible',
    sequenceHash: sha256(['operation-a', 'operation-b']),
    operationSignatures: ['operation-a', 'operation-b'],
    sourceWorkflowIds: ['workflow-a', 'workflow-b', 'workflow-c'],
    evidenceHash: sha256('candidate-evidence'),
    sideEffectClass: 'none',
    history: [],
  };
}

function policy(automaticPromotion = false) {
  return {
    project: 'fixture',
    destinations: {
      incubation: '.git/copilot-learning',
      tools: '.github/learned-tools',
      skills: '.github/skills',
      fixtures: 'tests/fixtures/learning',
    },
    automaticBuild: true,
    automaticPromotion,
    promotion: {
      allowedSideEffects: ['none', 'workspace'],
      requireReplay: true,
      requireProjectValidation: true,
      requireMediumReview: true,
      requirePositiveValue: true,
      requireScopeCheck: true,
      requireRollback: true,
    },
  };
}

function trajectories(sequenceHash, failureActual = 'rejected') {
  return [{
    id: 'positive-one',
    sequenceHash,
    expected: 'accepted',
    args: ['--fixture', 'accepted'],
  }, {
    id: 'negative-one',
    sequenceHash,
    expected: 'rejected',
    args: ['--fixture', failureActual],
  }, {
    id: 'rollback-one',
    sequenceHash,
    expected: 'rollback',
    args: ['--fixture', 'rollback'],
  }];
}

function receipt(kind, candidateId, fields) {
  const unsigned = { version: 1, kind, candidateId, ...fields };
  return { ...unsigned, evidenceHash: sha256(unsigned) };
}

function evidence(candidateValue, artifactHash) {
  return {
    projectValidation: receipt('candidate-project-validation', candidateValue.id, {
      passed: true,
      validatorIds: candidateValue.requiredValidators,
      resultHash: sha256('validator-result'),
      artifactHash,
    }),
    mediumReview: receipt('candidate-medium-review', candidateValue.id, {
      decision: 'accepted',
      reviewerRole: 'medium-review',
      reviewHash: sha256('review'),
      artifactHash,
    }),
    scopeTree: receipt('candidate-scope-tree', candidateValue.id, {
      scopeHash: sha256('scope'),
      treeHash: sha256('tree'),
      artifactHash,
    }),
    rollback: receipt('candidate-rollback', candidateValue.id, {
      tested: true,
      rollbackHash: sha256('rollback'),
      artifactHash,
    }),
    artifact: receipt('candidate-artifact', candidateValue.id, {
      artifactHash,
    }),
    integration: receipt('candidate-integration', candidateValue.id, {
      integrated: true,
      integrationHash: sha256('integration'),
      artifactHash,
    }),
  };
}

function gitRepository(t, prefix = 'learning-promotion-') {
  const root = makeScratch(prefix);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/agent-tools.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    tools: [],
  }, null, 2));
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

function buildDeterministicArtifact(root, incubation, candidateValue) {
  const entrypoint = path.join(incubation.directory, 'tool.mjs');
  fs.writeFileSync(entrypoint,
    '#!/usr/bin/env node\n' +
    'if (process.argv[2] === "--self-test") process.exit(0);\n' +
    'const outcome = process.argv[2] === "--cleanup" ? "accepted" : process.argv[3];\n' +
    'process.stdout.write(JSON.stringify({outcome}));\n');
  fs.chmodSync(entrypoint, 0o700);
  fs.writeFileSync(path.join(incubation.directory, 'tool.test.mjs'),
    'import assert from "node:assert/strict"; assert.equal(1, 1);\n');
  fs.writeFileSync(path.join(incubation.directory, 'contract.json'),
    JSON.stringify({ input: {}, output: { ok: 'boolean' }, sideEffect: 'none' }));
  fs.writeFileSync(path.join(incubation.directory, 'artifact-manifest.json'),
    JSON.stringify({
      version: 1,
      class: 'deterministic-tool',
      candidateId: candidateValue.id,
      entrypoint: 'tool.mjs',
      test: 'tool.test.mjs',
      contract: 'contract.json',
      files: ['tool.mjs', 'tool.test.mjs', 'contract.json'],
      integration: {
        registry: '.github/agent-tools.json',
        toolId: candidateValue.id,
      },
    }, null, 2));
  const registryFile = path.join(root, '.github/agent-tools.json');
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  registry.tools.push({
    id: candidateValue.id,
    kind: 'command',
    argv: [
      'node',
      '.github/learned-tools/candidate-fixture-tool/tool.mjs',
    ],
    cwd: '.',
    timeoutSeconds: 30,
    sideEffect: 'none',
    environment: [],
  });
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
}

function replayArtifact(t, outcome = null, exitCode = 0) {
  const root = makeScratch('learning-replay-artifact-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entrypoint = path.join(root, 'tool.mjs');
  fs.writeFileSync(entrypoint,
    '#!/usr/bin/env node\n' +
    `const forced = ${JSON.stringify(outcome)};\n` +
    'const value = process.argv[2] === "--cleanup" ? "accepted" : ' +
    '(forced ?? process.argv[3]);\n' +
    'process.stdout.write(JSON.stringify({outcome:value}));\n' +
    `process.exitCode = process.argv[2] === "--cleanup" ? 0 : ${exitCode};\n`);
  fs.chmodSync(entrypoint, 0o700);
  return {
    entrypoint,
    cwd: root,
    artifactHash: sha256(fs.readFileSync(entrypoint)),
  };
}

test('replay executes the artifact and preserves success, rejection, rollback and cleanup', t => {
  const value = candidate();
  const replay = replayCandidate(value, trajectories(value.sequenceHash),
    replayArtifact(t));
  assert.equal(replay.passed, true);
  assert.equal(replay.successPreserved, true);
  assert.equal(replay.failurePreserved, true);
  assert.equal(replay.cleanupPreserved, true);
  assert.equal(createReplayPlan(value, trajectories(value.sequenceHash)).candidateId,
    value.id);
});

test('negative replay regressions and missing failure fixtures prevent promotion', t => {
  const value = candidate();
  assert.equal(replayCandidate(value,
    trajectories(value.sequenceHash), replayArtifact(t, 'accepted')).passed, false);
  assert.equal(replayCandidate(value, [{
    id: 'positive-only',
    sequenceHash: value.sequenceHash,
    expected: 'accepted',
    args: ['--fixture', 'accepted'],
  }], replayArtifact(t)).passed, false);
  assert.equal(replayCandidate(value, trajectories(value.sequenceHash),
    replayArtifact(t, null, 1)).passed, false);
});

test('all implementation, review and revision legs count toward value', () => {
  const accounting = accountCandidateValue([
    { lane: 'baseline', role: 'coordinator', kind: 'model', credits: 2, reconciled: true },
    { lane: 'baseline', role: 'reviewer', kind: 'model', credits: 1, reconciled: true },
    { lane: 'baseline', role: 'revision', kind: 'model', credits: 1, reconciled: true },
    { lane: 'candidate', role: 'tool', kind: 'deterministic', credits: 0.25, reconciled: true },
    { lane: 'candidate', role: 'reviewer', kind: 'model', credits: 0.5, reconciled: true },
  ]);
  assert.equal(accounting.baselineCredits, 4);
  assert.equal(accounting.candidateCredits, 0.75);
  assert.equal(accounting.netCredits, 3.25);
  assert.equal(accounting.positiveValue, true);
});

test('incubation resolves Git metadata in a real linked worktree', t => {
  const main = gitRepository(t, 'learning-linked-main-');
  const linked = `${main}-linked`;
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'linked', linked]);
  assert.equal(fs.statSync(path.join(linked, '.git')).isFile(), true);
  const value = candidate();
  const incubation = incubateCandidate(linked, value,
    createReplayPlan(value, []), policy());
  const expected = execFileSync('git', ['-C', linked, 'rev-parse', '--git-path',
    `copilot-learning/incubating/${value.id}`], { encoding: 'utf8' }).trim();
  assert.equal(fs.realpathSync(incubation.directory),
    fs.realpathSync(path.resolve(linked, expected)));
});

test('promotion requires executable artifact, registry integration and bound evidence', t => {
  const root = gitRepository(t);
  const initial = candidate();
  const incubation = incubateCandidate(root, initial,
    createReplayPlan(initial, trajectories(initial.sequenceHash)), policy(true));
  buildDeterministicArtifact(root, incubation, initial);
  const artifact = validateCandidateArtifact(initial, incubation.directory);
  const replay = replayCandidate(initial, trajectories(initial.sequenceHash), {
    entrypoint: path.join(incubation.directory, 'tool.mjs'),
    cwd: incubation.directory,
    artifactHash: artifact.artifactHash,
  });
  const replaying = transitionCandidate(incubation.candidate, 'replaying',
    replay.replayHash);
  const provisional = transitionCandidate(replaying, 'provisional',
    replay.replayHash);
  const accounting = accountCandidateValue([
    { lane: 'baseline', role: 'coordinator', kind: 'model', credits: 2, reconciled: true },
    { lane: 'baseline', role: 'reviewer', kind: 'model', credits: 1, reconciled: true },
    { lane: 'candidate', role: 'tool', kind: 'deterministic', credits: 0.25, reconciled: true },
  ], provisional.id, artifact.artifactHash);
  const boundEvidence = evidence(provisional, artifact.artifactHash);
  const evaluation = evaluatePromotion(provisional, replay, accounting,
    boundEvidence, policy(true));
  assert.equal(evaluation.allowed, true, evaluation.reasons.join(', '));
  const promoted = promoteCandidate(root, provisional, incubation.directory, {
    evaluation,
    replay,
    accounting,
    evidence: boundEvidence,
  }, policy(true));
  assert.equal(promoted.candidate.state, 'promoted');
  assert.equal(fs.statSync(path.join(promoted.target, 'tool.mjs')).isFile(), true);

  const booleans = evaluatePromotion(provisional, replay, accounting, {
    projectValidation: true,
    mediumReview: true,
    scopeTree: true,
    rollback: true,
    artifact: true,
    integration: true,
  }, policy(true));
  assert.equal(booleans.allowed, false);
  assert.ok(booleans.reasons.length >= 6);
  assert.equal(evaluatePromotion(provisional, replay, accounting,
    boundEvidence, policy(false)).allowed, false);
  assert.throws(() => promoteCandidate(root, provisional, incubation.directory, {
    evaluation: { ...evaluation, evidenceHash: sha256('forged') },
    replay,
    accounting,
    evidence: boundEvidence,
  }, policy(true)), /promotion gates/);
});

test('placeholder skills and symlink destinations are rejected', t => {
  const root = gitRepository(t, 'learning-safety-');
  const value = candidate('reusable-skill');
  const incubation = incubateCandidate(root, value,
    createReplayPlan(value, []), policy(true));
  fs.writeFileSync(path.join(incubation.directory, 'SKILL.md'),
    '---\nname: placeholder\n---\n\nIncubated reusable workflow.\n');
  fs.writeFileSync(path.join(incubation.directory, 'contract.json'), '{}');
  fs.writeFileSync(path.join(incubation.directory, 'artifact-manifest.json'),
    JSON.stringify({
      version: 1,
      class: 'reusable-skill',
      candidateId: value.id,
      skill: 'SKILL.md',
      contract: 'contract.json',
      files: ['SKILL.md', 'contract.json'],
      integration: { discoveryRoot: '.github/skills' },
    }));
  assert.throws(() => validateCandidateArtifact(value, incubation.directory),
    /section missing|placeholder/);

  const outside = makeScratch('learning-outside-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, '.github/learned-tools'));
  const deterministic = candidate();
  const deterministicIncubation = incubateCandidate(root, deterministic,
    createReplayPlan(deterministic, []), policy(true));
  buildDeterministicArtifact(root, deterministicIncubation, deterministic);
  const privateFile = path.join(outside, 'private.txt');
  fs.writeFileSync(privateFile, 'private');
  const sourceLink = path.join(deterministicIncubation.directory, 'extra-private');
  fs.symlinkSync(privateFile, sourceLink);
  assert.throws(() => validateCandidateArtifact(deterministic,
    deterministicIncubation.directory), /symlink|non-regular/);
  fs.unlinkSync(sourceLink);
  const artifact = validateCandidateArtifact(deterministic,
    deterministicIncubation.directory);
  const replay = replayCandidate(deterministic,
    trajectories(deterministic.sequenceHash), {
      entrypoint: path.join(deterministicIncubation.directory, 'tool.mjs'),
      cwd: deterministicIncubation.directory,
      artifactHash: artifact.artifactHash,
    });
  const replaying = transitionCandidate(deterministicIncubation.candidate,
    'replaying', replay.replayHash);
  const provisional = transitionCandidate(replaying, 'provisional',
    replay.replayHash);
  const accounting = accountCandidateValue([
    { lane: 'baseline', role: 'model', kind: 'model', credits: 2, reconciled: true },
    { lane: 'candidate', role: 'tool', kind: 'deterministic', credits: 0, reconciled: true },
  ], provisional.id, artifact.artifactHash);
  const evaluation = evaluatePromotion(provisional, replay, accounting,
    evidence(provisional, artifact.artifactHash), policy(true));
  assert.equal(evaluation.allowed, true);
  assert.throws(() => promoteCandidate(root, provisional,
    deterministicIncubation.directory, {
      evaluation,
      replay,
      accounting,
      evidence: evidence(provisional, artifact.artifactHash),
    }, policy(true)), /symlink/);
});

test('committed fixtures contain all required synthetic trajectory classes', () => {
  const data = JSON.parse(fs.readFileSync(new URL(
    './fixtures/continuous-improvement/trajectories.json',
    import.meta.url,
  ), 'utf8'));
  assert.deepEqual(new Set(data.fixtures.map(item => item.candidateClass)),
    new Set([
      'deterministic-tool',
      'reusable-skill',
      'routing-policy',
      'no-op',
    ]));
});
