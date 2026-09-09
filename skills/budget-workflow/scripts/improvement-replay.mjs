import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from './workflow.mjs';
import { transitionCandidate } from './improvement-candidates.mjs';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function within(root, relative) {
  assert(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative),
    'Learning destination must be repository-relative');
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, relative);
  const relation = path.relative(realRoot, target);
  assert(relation !== '..' && !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation), 'Learning destination escapes repository');
  let cursor = realRoot;
  for (const part of relation.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) break;
    assert(!stat.isSymbolicLink(), 'Learning destination contains a symlink');
    assert(path.relative(realRoot, fs.realpathSync(cursor)) !== '..' &&
      !path.relative(realRoot, fs.realpathSync(cursor)).startsWith(`..${path.sep}`),
    'Learning destination resolves outside repository');
  }
  return target;
}

function gitIncubationRoot(root) {
  const value = execFileSync('git', ['-C', root, 'rev-parse', '--git-path',
    'copilot-learning'], { encoding: 'utf8' }).trim();
  return path.resolve(root, value);
}

function safeCandidateId(candidateId) {
  assert(ID_PATTERN.test(candidateId), 'Candidate ID must be safe kebab-case');
  return candidateId;
}

export function createReplayPlan(candidate, trajectories) {
  const positives = trajectories.filter(item => item.expected === 'accepted');
  const negatives = trajectories.filter(item =>
    ['rejected', 'failed', 'rollback'].includes(item.expected));
  return {
    version: 1,
    candidateId: candidate.id,
    sequenceHash: candidate.sequenceHash,
    sourceWorkflowIds: candidate.sourceWorkflowIds ?? [],
    positiveFixtureIds: positives.map(item => item.id).sort(),
    negativeFixtureIds: negatives.map(item => item.id).sort(),
    fixtureHashes: trajectories.map(item => ({
      id: item.id,
      hash: sha256(item),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    planHash: sha256({
      candidateId: candidate.id,
      sequenceHash: candidate.sequenceHash,
      sourceWorkflowIds: candidate.sourceWorkflowIds ?? [],
      positives: positives.map(item => item.id).sort(),
      negatives: negatives.map(item => item.id).sort(),
      fixtures: trajectories.map(item => ({
        id: item.id,
        hash: sha256(item),
      })).sort((left, right) => left.id.localeCompare(right.id)),
    }),
  };
}

function replayStep(entrypoint, cwd, args) {
  const result = spawnSync(entrypoint, args, {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status === null) {
    return {
      outcome: 'failed',
      exitCode: null,
      outputHash: sha256(result.stderr ?? ''),
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return {
    outcome: typeof parsed?.outcome === 'string' ? parsed.outcome : 'failed',
    exitCode: result.status,
    outputHash: sha256(result.stdout ?? ''),
  };
}

export function replayCandidate(candidate, trajectories, artifact = null) {
  const plan = createReplayPlan(candidate, trajectories);
  const relevant = trajectories.filter(item =>
    item.sequenceHash === candidate.sequenceHash);
  const entrypoint = artifact?.entrypoint;
  const artifactHash = artifact?.artifactHash ?? null;
  const executable = typeof entrypoint === 'string' &&
    fs.statSync(entrypoint, { throwIfNoEntry: false })?.isFile() &&
    (fs.statSync(entrypoint).mode & 0o111) !== 0 &&
    HASH_PATTERN.test(artifactHash ?? '');
  const outcomes = executable
    ? relevant.map(item => {
      const execution = replayStep(entrypoint, artifact.cwd ?? path.dirname(entrypoint),
        item.args ?? []);
      const cleanup = replayStep(entrypoint, artifact.cwd ?? path.dirname(entrypoint),
        item.cleanupArgs ?? ['--cleanup', item.id]);
      return {
        id: item.id,
        expected: item.expected,
        actual: execution.outcome,
        cleanup: cleanup.outcome,
        exitCode: execution.exitCode,
        expectedExitCode: item.expectedExitCode ??
          (item.expected === 'failed' ? 1 : 0),
        exitMatched: execution.exitCode === (item.expectedExitCode ??
          (item.expected === 'failed' ? 1 : 0)),
        outputHash: execution.outputHash,
        cleanupExitCode: cleanup.exitCode,
        cleanupExitMatched: cleanup.exitCode ===
          (item.expectedCleanupExitCode ?? 0),
        cleanupOutputHash: cleanup.outputHash,
        fixtureHash: sha256(item),
      };
    })
    : [];
  const positive = outcomes.filter(item => item.expected === 'accepted');
  const negative = outcomes.filter(item =>
    ['rejected', 'failed', 'rollback'].includes(item.expected));
  const successPreserved = positive.length > 0 &&
    positive.every(item => item.actual === 'accepted' && item.exitMatched);
  const failurePreserved = negative.length > 0 &&
    negative.every(item => item.actual === item.expected && item.exitMatched);
  const cleanupPreserved = outcomes.length === relevant.length &&
    outcomes.every(item =>
      item.cleanup === 'accepted' && item.cleanupExitMatched);
  const unsigned = {
    version: 1,
    kind: 'candidate-replay',
    candidateId: candidate.id,
    artifactHash,
    executable,
    plan,
    successPreserved,
    failurePreserved,
    cleanupPreserved,
    passed: successPreserved && failurePreserved && cleanupPreserved,
    outcomesHash: sha256(outcomes.sort((left, right) =>
      left.id.localeCompare(right.id))),
  };
  return { ...unsigned, replayHash: sha256(unsigned) };
}

export function accountCandidateValue(legs, candidateId = null, artifactHash = null) {
  assert(Array.isArray(legs) && legs.length > 0, 'Candidate accounting requires all legs');
  const normalized = legs.map(leg => {
    assert(['baseline', 'candidate'].includes(leg.lane), 'Unknown accounting lane');
    assert(typeof leg.credits === 'number' && Number.isFinite(leg.credits) &&
      leg.credits >= 0, 'Leg credits must be nonnegative');
    return {
      lane: leg.lane,
      role: leg.role,
      kind: leg.kind,
      credits: leg.credits,
      reconciled: leg.reconciled === true,
    };
  });
  const baselineCredits = normalized.filter(leg => leg.lane === 'baseline')
    .reduce((sum, leg) => sum + leg.credits, 0);
  const candidateCredits = normalized.filter(leg => leg.lane === 'candidate')
    .reduce((sum, leg) => sum + leg.credits, 0);
  const unsigned = {
    version: 1,
    kind: 'candidate-accounting',
    candidateId,
    artifactHash,
    legs: normalized,
    baselineCredits,
    candidateCredits,
    netCredits: baselineCredits - candidateCredits,
    allLegsReconciled: normalized.every(leg => leg.reconciled),
    positiveValue: normalized.every(leg => leg.reconciled) &&
      baselineCredits > candidateCredits,
  };
  return { ...unsigned, accountingHash: sha256(unsigned) };
}

export function incubateCandidate(root, candidate, replayPlan, policy) {
  safeCandidateId(candidate.id);
  const configured = policy.destinations.incubation;
  const base = configured === '.git/copilot-learning'
    ? gitIncubationRoot(root)
    : within(root, configured);
  const directory = path.join(base, 'incubating', candidate.id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const contract = {
    version: 1,
    id: candidate.id,
    class: candidate.class,
    project: candidate.project,
    opportunityId: candidate.opportunityId,
    selectedPriority: candidate.selectedPriority,
    priorityOptions: candidate.priorityOptions ?? [],
    requiredValidators: candidate.requiredValidators,
    operationSignatures: candidate.operationSignatures,
    sideEffectClass: candidate.sideEffectClass,
    executionAuthority: candidate.executionAuthority,
    requiredGates: candidate.requiredGates ?? [],
    automaticDeterministicPromotionEligible:
      candidate.automaticDeterministicPromotionEligible === true,
    evidenceHash: candidate.evidenceHash,
  };
  fs.writeFileSync(path.join(directory, 'candidate.json'),
    `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'replay-plan.json'),
    `${JSON.stringify(replayPlan, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'BUILD.md'),
    `# ${candidate.id}\n\nImplement the ${candidate.class} contract in candidate.json. ` +
    `Do not promote until artifact, integration, replay, validator, medium-review, ` +
    `scope/tree, rollback, and accounting receipts are recorded.\n`,
  { mode: 0o600 });
  const evidenceHash = sha256({ contract, replayPlan });
  return {
    candidate: transitionCandidate(candidate, 'incubating', evidenceHash),
    directory,
    evidenceHash,
  };
}

function readManifest(directory) {
  const file = path.join(directory, 'artifact-manifest.json');
  assert(fs.lstatSync(file, { throwIfNoEntry: false })?.isFile(),
    'Class-specific artifact manifest missing');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateDeterministicArtifact(candidate, directory, manifest) {
  assert(manifest.version === 1 && manifest.class === 'deterministic-tool' &&
    manifest.candidateId === candidate.id, 'Deterministic artifact manifest mismatch');
  for (const key of ['entrypoint', 'test', 'contract']) {
    assert(typeof manifest[key] === 'string' && manifest[key].length > 0,
      `Deterministic artifact ${key} missing`);
    assert(fs.statSync(within(directory, manifest[key]), { throwIfNoEntry: false })?.isFile(),
      `Deterministic artifact ${key} file missing`);
  }
  assert(Array.isArray(manifest.files) &&
    [manifest.entrypoint, manifest.test, manifest.contract]
      .every(file => manifest.files.includes(file)),
  'Deterministic artifact promotion allowlist is incomplete');
  const entrypoint = within(directory, manifest.entrypoint);
  assert((fs.statSync(entrypoint).mode & 0o111) !== 0,
    'Deterministic artifact entrypoint is not executable');
  const selfTest = spawnSync(entrypoint, ['--self-test'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert(selfTest.status === 0, 'Deterministic artifact self-test failed');
  assert(manifest.integration?.toolId === candidate.id &&
    typeof manifest.integration.registry === 'string',
  'Deterministic artifact registry integration missing');
}

function validateSkillArtifact(candidate, directory, manifest) {
  assert(manifest.version === 1 && manifest.class === 'reusable-skill' &&
    manifest.candidateId === candidate.id, 'Skill artifact manifest mismatch');
  const skill = within(directory, manifest.skill ?? 'SKILL.md');
  const contract = within(directory, manifest.contract ?? 'contract.json');
  assert(fs.statSync(skill, { throwIfNoEntry: false })?.isFile() &&
    fs.statSync(contract, { throwIfNoEntry: false })?.isFile(),
  'Skill artifact files missing');
  const text = fs.readFileSync(skill, 'utf8');
  for (const heading of ['## Inputs', '## Workflow', '## Validation', '## Escalation']) {
    assert(text.includes(heading), `Skill artifact ${heading} section missing`);
  }
  assert(text.length >= 300 && !/Incubated reusable workflow\./.test(text),
    'Skill artifact is a placeholder');
  assert(manifest.integration?.discoveryRoot === '.github/skills',
    'Skill discovery integration missing');
  assert(Array.isArray(manifest.files) &&
    [manifest.skill ?? 'SKILL.md', manifest.contract ?? 'contract.json']
      .every(file => manifest.files.includes(file)),
  'Skill artifact promotion allowlist is incomplete');
}

export function validateCandidateArtifact(candidate, directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const stat = fs.lstatSync(path.join(directory, entry.name));
    assert(stat.isFile() && !stat.isSymbolicLink(),
      'Incubation contains a symlink or non-regular file');
  }
  const manifest = readManifest(directory);
  if (candidate.class === 'deterministic-tool') {
    validateDeterministicArtifact(candidate, directory, manifest);
  } else if (candidate.class === 'reusable-skill') {
    validateSkillArtifact(candidate, directory, manifest);
  } else {
    throw new Error('Candidate class is not promotable');
  }
  const promotedNames = [...new Set([
    'artifact-manifest.json',
    ...manifest.files,
  ])].sort();
  const files = promotedNames.map(name => ({
    name,
    hash: sha256(fs.readFileSync(within(directory, name))),
  }));
  return { manifest, artifactHash: sha256(files), files };
}

function verifyReceipt(receipt, kind, candidateId) {
  assert(receipt?.kind === kind && receipt.candidateId === candidateId,
    `${kind} receipt mismatch`);
  const hashKey = {
    'candidate-project-validation': 'evidenceHash',
    'candidate-medium-review': 'evidenceHash',
    'candidate-scope-tree': 'evidenceHash',
    'candidate-rollback': 'evidenceHash',
    'candidate-artifact': 'evidenceHash',
    'candidate-integration': 'evidenceHash',
  }[kind];
  const { [hashKey]: receiptHash, ...unsigned } = receipt;
  assert(HASH_PATTERN.test(receiptHash ?? '') && receiptHash === sha256(unsigned),
    `${kind} receipt hash mismatch`);
  return receipt;
}

export function evaluatePromotion(candidate, replay, accounting, evidence, policy) {
  const reasons = [];
  let expectedArtifactHash = null;
  if (!['deterministic-tool', 'reusable-skill'].includes(candidate.class)) {
    reasons.push('candidate class is not promotable');
  }
  if (candidate.class === 'reusable-skill' &&
    candidate.executionAuthority !== 'none') {
    reasons.push('reusable skill must retain zero execution authority');
  }
  if (candidate.class === 'reusable-skill' &&
    candidate.automaticDeterministicPromotionEligible === true) {
    reasons.push('reusable skill cannot enter deterministic automatic promotion');
  }
  if (!policy.promotion.allowedSideEffects.includes(candidate.sideEffectClass)) {
    reasons.push('side effect is outside automatic promotion policy');
  }
  if (replay?.kind !== 'candidate-replay' ||
    replay.candidateId !== candidate.id ||
    replay.replayHash !== sha256(Object.fromEntries(Object.entries(replay)
      .filter(([key]) => key !== 'replayHash'))) ||
    replay.executable !== true ||
    replay.passed !== true) reasons.push('replay gate failed');
  if (accounting?.kind !== 'candidate-accounting' ||
    accounting.candidateId !== candidate.id ||
    accounting.accountingHash !== sha256(Object.fromEntries(Object.entries(accounting)
      .filter(([key]) => key !== 'accountingHash'))) ||
    accounting.positiveValue !== true ||
    accounting.allLegsReconciled !== true) {
    reasons.push('positive reconciled all-leg accounting missing');
  }
  try {
    const artifact = verifyReceipt(evidence.artifact, 'candidate-artifact',
      candidate.id);
    if (!HASH_PATTERN.test(artifact.artifactHash)) reasons.push('artifact hash missing');
    else expectedArtifactHash = artifact.artifactHash;
  } catch {
    reasons.push('artifact receipt invalid');
  }
  if (expectedArtifactHash && replay?.artifactHash !== expectedArtifactHash) {
    reasons.push('replay is not bound to the candidate artifact');
  }
  if (expectedArtifactHash && accounting?.artifactHash !== expectedArtifactHash) {
    reasons.push('accounting is not bound to the candidate artifact');
  }
  try {
    const validation = verifyReceipt(evidence.projectValidation,
      'candidate-project-validation', candidate.id);
    if (validation.passed !== true ||
      !candidate.requiredValidators.every(id => validation.validatorIds.includes(id))) {
      reasons.push('project validation missing required validators');
    }
    if (expectedArtifactHash && validation.artifactHash !== expectedArtifactHash) {
      reasons.push('project validation is not bound to the candidate artifact');
    }
  } catch {
    reasons.push('project validation receipt invalid');
  }
  try {
    const review = verifyReceipt(evidence.mediumReview, 'candidate-medium-review',
      candidate.id);
    if (review.decision !== 'accepted') reasons.push('medium review rejected');
    if (expectedArtifactHash && review.artifactHash !== expectedArtifactHash) {
      reasons.push('medium review is not bound to the candidate artifact');
    }
  } catch {
    reasons.push('medium review receipt invalid');
  }
  try {
    const scope = verifyReceipt(evidence.scopeTree, 'candidate-scope-tree', candidate.id);
    if (!HASH_PATTERN.test(scope.scopeHash) || !HASH_PATTERN.test(scope.treeHash)) {
      reasons.push('scope/tree hashes missing');
    }
    if (expectedArtifactHash && scope.artifactHash !== expectedArtifactHash) {
      reasons.push('scope/tree evidence is not bound to the candidate artifact');
    }
  } catch {
    reasons.push('scope/tree receipt invalid');
  }
  try {
    const rollback = verifyReceipt(evidence.rollback, 'candidate-rollback',
      candidate.id);
    if (rollback.tested !== true) reasons.push('rollback not tested');
    if (expectedArtifactHash && rollback.artifactHash !== expectedArtifactHash) {
      reasons.push('rollback is not bound to the candidate artifact');
    }
  } catch {
    reasons.push('rollback receipt invalid');
  }
  try {
    const integration = verifyReceipt(evidence.integration, 'candidate-integration',
      candidate.id);
    if (integration.integrated !== true) reasons.push('integration not proven');
    if (expectedArtifactHash && integration.artifactHash !== expectedArtifactHash) {
      reasons.push('integration is not bound to the candidate artifact');
    }
  } catch {
    reasons.push('integration receipt invalid');
  }
  if (policy.automaticPromotion !== true) reasons.push('automatic promotion disabled');
  return {
    allowed: reasons.length === 0,
    reasons,
    artifactHash: expectedArtifactHash,
    evidenceHash: sha256({
      candidateId: candidate.id,
      replayHash: replay?.replayHash ?? null,
      accountingHash: accounting?.accountingHash ?? null,
      evidence,
      automaticPromotion: policy.automaticPromotion,
    }),
  };
}

function verifyRegistryIntegration(root, candidate, manifest, target) {
  if (candidate.class === 'reusable-skill') {
    assert(path.dirname(target) === within(root, manifest.integration.discoveryRoot),
      'Promoted skill is outside its discovery root');
    return;
  }
  const registryFile = within(root, manifest.integration.registry);
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const entry = registry.tools?.find(tool => tool.id === candidate.id);
  assert(entry, 'Project tool registry does not reference promoted tool');
  const targetRelative = path.relative(root, target).split(path.sep).join('/');
  assert(JSON.stringify(entry).includes(targetRelative),
    'Project tool registry entry does not reference promoted artifact');
}

export function promoteCandidate(root, candidate, incubationDirectory, bundle, policy) {
  assert(policy.automaticPromotion === true,
    'Automatic promotion is disabled by project policy');
  assert(bundle && typeof bundle === 'object',
    'Promotion evidence bundle required');
  const evaluation = evaluatePromotion(candidate, bundle.replay,
    bundle.accounting, bundle.evidence, policy);
  assert(evaluation.allowed === true &&
    bundle.evaluation?.allowed === true &&
    bundle.evaluation.evidenceHash === evaluation.evidenceHash,
  'Candidate promotion gates are not satisfied');
  safeCandidateId(candidate.id);
  const artifact = validateCandidateArtifact(candidate, incubationDirectory);
  assert(evaluation.artifactHash === artifact.artifactHash,
    'Promotion artifact differs from evaluated evidence');
  const destinationKey = candidate.class === 'deterministic-tool' ? 'tools' : 'skills';
  assert(candidate.destination === destinationKey,
    'Candidate destination does not match its class');
  const base = within(root, policy.destinations[destinationKey]);
  const target = path.join(base, candidate.id);
  assert(!fs.existsSync(target), 'Promotion destination already exists');
  verifyRegistryIntegration(root, candidate, artifact.manifest, target);
  fs.mkdirSync(target, { recursive: true });
  for (const file of artifact.files) {
    fs.copyFileSync(path.join(incubationDirectory, file.name),
      path.join(target, file.name), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(target, file.name),
      fs.statSync(path.join(incubationDirectory, file.name)).mode);
  }
  fs.writeFileSync(path.join(target, 'promotion.json'),
    `${JSON.stringify({
      version: 1,
      candidateId: candidate.id,
      evaluationHash: evaluation.evidenceHash,
      artifactHash: artifact.artifactHash,
      rollback: { removePath: path.relative(root, target) },
      contentHash: sha256(artifact.files),
    }, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 });
  return {
    candidate: transitionCandidate(candidate, 'promoted', evaluation.evidenceHash),
    target,
    manifestHash: sha256(canonicalJson(fs.readdirSync(target).sort())),
  };
}

function main() {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === 'replay') {
    assert(first && second && third,
      'Usage: improvement-replay.mjs replay CANDIDATE.json TRAJECTORIES.json ARTIFACT_DIR');
    const candidate = JSON.parse(fs.readFileSync(first, 'utf8'));
    const trajectories = JSON.parse(fs.readFileSync(second, 'utf8'));
    const artifact = validateCandidateArtifact(candidate, third);
    const entrypoint = artifact.manifest.entrypoint ??
      artifact.manifest.replayEntrypoint;
    assert(entrypoint, 'Candidate artifact has no deterministic replay entrypoint');
    console.log(JSON.stringify(replayCandidate(candidate,
      trajectories.trajectories ?? trajectories.fixtures ?? trajectories, {
        entrypoint: within(third, entrypoint),
        cwd: third,
        artifactHash: artifact.artifactHash,
      }), null, 2));
    return;
  }
  if (command === 'account') {
    assert(first && second && third,
      'Usage: improvement-replay.mjs account LEGS.json CANDIDATE_ID ARTIFACT_HASH');
    assert(ID_PATTERN.test(second) && HASH_PATTERN.test(third),
      'Accounting candidate ID or artifact hash invalid');
    console.log(JSON.stringify(accountCandidateValue(
      JSON.parse(fs.readFileSync(first, 'utf8')), second, third,
    ), null, 2));
    return;
  }
  throw new Error(
    'Usage: improvement-replay.mjs replay CANDIDATE.json TRAJECTORIES.json ARTIFACT_DIR | ' +
    'account LEGS.json CANDIDATE_ID ARTIFACT_HASH',
  );
}

if (process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`improvement-replay: ${error.message}`);
    process.exitCode = 1;
  }
}
