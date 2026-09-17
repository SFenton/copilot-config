import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratch } from './helpers/scratch.mjs';
import { execFileSync } from 'node:child_process';
import {
  applyAcceptedDelegation,
  delegationScopeHash,
  delegationPlan,
  parseCandidate,
  selectedWorkerModel,
  validateCandidateSafety,
  validateStagedDelegation,
  verifyFrontierAcceptance,
}
  from '../skills/budget-workflow/scripts/delegation.mjs';
import {
  dockerSandboxAvailable,
  repositoryTreeHash,
  validateSandboxReadiness,
} from '../skills/budget-workflow/scripts/sandbox.mjs';
import { sha256 } from '../skills/budget-workflow/scripts/workflow.mjs';
import { pipelineContractHash }
  from '../skills/budget-workflow/scripts/team-pipeline.mjs';
import crypto from 'node:crypto';
import * as delegationApi
  from '../skills/budget-workflow/scripts/delegation.mjs';

const baseJob = {
  taskClass: 'test-generation',
  kind: 'bounded-artifact',
  instruction: 'Create tests for the supplied pure function using the adjacent test conventions.',
  risk: 'low',
  novel: false,
  evidenceComplete: true,
  sanitized: true,
  boundaries: {
    research: false,
    architecture: false,
    ambiguous: false,
    debugging: false,
    security: false,
    liveSystem: false,
    release: false,
    destructive: false,
    semanticDocumentation: false,
  },
  deterministicValidator: true,
  inputs: [{ file: 'src/value.mjs', start: 1, end: 3 }],
  outputs: ['test/value.test.mjs'],
  validator: { argv: ['node', '--test', 'test/value.test.mjs'], timeoutSeconds: 30 },
};
const adapter = {
  riskTerms: ['activation'],
  delegation: {
    allowedClasses: ['scaffold', 'test-generation', 'mechanical-transform'],
    requireCleanTargets: true,
    requireDeterministicValidator: true,
  },
};

const configurationEvents = profile => [{
  type: 'subagent.configured',
  data: {
    model: profile.model,
    reasoningEffort: profile.effort,
    contextTier: profile.context,
  },
}];

test('delegation admits bounded low-risk generated artifacts', () => {
  const result = delegationPlan(baseJob, adapter);
  assert.equal(result.eligible, true);
  assert.equal(result.automaticAcceptance, false);
  assert.equal(result.qualification, 'provisional');
  assert.equal(result.model, 'mai-code-1.1-flash');
  assert.equal(result.maxAttempts, 2);
  assert.equal(result.maxRevisions, 1);
});

test('delegation scope binds the exact worker task, evidence and source state', () => {
  const input = {
    workflowId: 'workflow',
    pipelineHash: 'a'.repeat(64),
    plan: {
      project: 'fixture',
      opportunityId: 'focused-tests',
      capability: 'fixture-tests',
      phaseId: 'generate-tests',
      validatorId: 'fixture-validator',
      sandboxProfileId: 'fixture-tests',
    },
    job: baseJob,
    sourceTreeHash: 'b'.repeat(64),
    evidenceSha256: 'c'.repeat(64),
    sandboxReadinessHash: 'f'.repeat(64),
    targetState: [{
      file: 'test/value.test.mjs',
      exists: false,
      mode: null,
      sha256: null,
    }],
  };
  const expected = delegationScopeHash(input);
  assert.notEqual(delegationScopeHash({
    ...input,
    job: { ...input.job, instruction: 'Create different tests.' },
  }), expected);
  assert.notEqual(delegationScopeHash({
    ...input,
    evidenceSha256: 'd'.repeat(64),
  }), expected);
  assert.notEqual(delegationScopeHash({
    ...input,
    sourceTreeHash: 'e'.repeat(64),
  }), expected);
  assert.notEqual(delegationScopeHash({
    ...input,
    sandboxReadinessHash: '0'.repeat(64),
  }), expected);
});

test('generated artifacts reject process, network and environment capabilities', () => {
  for (const content of [
    "import { exec } from 'node:child_process';\n",
    'await fetch("https://example.invalid");\n',
    'const token = process.env.API_TOKEN;\n',
    'import subprocess\n',
    "import fs from 'node:fs';\n",
    "eval('1 + 1');\n",
  ]) {
    assert.throws(() => validateCandidateSafety({
      files: [{ path: 'test/value.test.mjs', content }],
    }), /prohibited/);
  }
  assert.equal(validateCandidateSafety({
    files: [{ path: 'test/value.test.mjs', content: 'test("value", () => expect(1).toBe(1));\n' }],
  }), true);
});

test('frontier acceptance is hash-bound, configuration-evidenced and expires', () => {
  const root = makeScratch('frontier-acceptance-');
  const receipt = {
    version: 2,
    staged: true,
    applied: false,
    project: 'fixture',
    repository: root,
    baseRevision: 'base-revision',
    sourceTreeHash: 'e'.repeat(64),
    scopeHash: 'f'.repeat(64),
    candidateSha256: 'a'.repeat(64),
    evidenceSha256: 'b'.repeat(64),
    plan: {
      project: 'fixture',
      opportunityId: 'focused-tests',
      capability: 'fixture-tests',
      validatorId: 'fixture-validator',
      sandboxProfileId: 'fixture-tests',
      semanticOwner: { model: 'gpt-5.6-sol', effort: 'max', context: 'long_context' },
    },
  };
  const validationEvidence = {
    version: 1,
    candidateSha256: receipt.candidateSha256,
    evidenceSha256: receipt.evidenceSha256,
    sourceTreeHash: receipt.sourceTreeHash,
    validatorId: receipt.plan.validatorId,
    sandboxProfileId: receipt.plan.sandboxProfileId,
  };
  const validation = {
    ...validationEvidence,
    evidenceHash: sha256(validationEvidence),
  };
  const acceptance = {
    version: 1,
    kind: 'frontier-acceptance',
    approvedBy: 'frontier-owner',
    decision: 'accept-exact-staged-candidate',
    project: receipt.plan.project,
    opportunityId: receipt.plan.opportunityId,
    capability: receipt.plan.capability,
    repository: receipt.repository,
    baseRevision: receipt.baseRevision,
    scopeHash: receipt.scopeHash,
    validatorId: receipt.plan.validatorId,
    sandboxProfileId: receipt.plan.sandboxProfileId,
    candidateSha256: receipt.candidateSha256,
    evidenceSha256: receipt.evidenceSha256,
    validationEvidenceHash: validation.evidenceHash,
    resolvedConfigurationEvidenceHash: sha256(configurationEvents(
      receipt.plan.semanticOwner,
    )[0]),
    owner: { model: 'gpt-5.6-sol', effort: 'max', context: 'long_context' },
    approvedAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-09T00:00:00.000Z',
  };
  assert.equal(verifyFrontierAcceptance(
    receipt,
    acceptance,
    validation,
    Date.parse('2026-09-08T12:00:00.000Z'),
    {
      currentRevision: receipt.baseRevision,
      scopeHash: receipt.scopeHash,
      resolvedConfigurationEvidenceHash: acceptance.resolvedConfigurationEvidenceHash,
      resolvedConfigurationEvents: configurationEvents(receipt.plan.semanticOwner),
    },
  ).accepted, true);
  assert.throws(() => verifyFrontierAcceptance(receipt, {
    ...acceptance,
    candidateSha256: 'd'.repeat(64),
  }, validation, Date.parse('2026-09-08T12:00:00.000Z'), {
    currentRevision: receipt.baseRevision,
    scopeHash: receipt.scopeHash,
    resolvedConfigurationEvidenceHash: acceptance.resolvedConfigurationEvidenceHash,
    resolvedConfigurationEvents: configurationEvents(receipt.plan.semanticOwner),
  }), /candidate hash/);
  assert.throws(() => verifyFrontierAcceptance(receipt, {
    ...acceptance,
    unexpectedAuthority: true,
  }, validation, Date.parse('2026-09-08T12:00:00.000Z'), {
    currentRevision: receipt.baseRevision,
    scopeHash: receipt.scopeHash,
    resolvedConfigurationEvidenceHash: acceptance.resolvedConfigurationEvidenceHash,
    resolvedConfigurationEvents: configurationEvents(receipt.plan.semanticOwner),
  }), /unsupported fields/);
  assert.throws(() => verifyFrontierAcceptance(
    receipt,
    acceptance,
    validation,
    Date.parse('2026-09-08T12:00:00.000Z'),
    {
      currentRevision: receipt.baseRevision,
      scopeHash: receipt.scopeHash,
      resolvedConfigurationEvidenceHash: acceptance.resolvedConfigurationEvidenceHash,
      resolvedConfigurationEvents: configurationEvents({
        ...receipt.plan.semanticOwner,
        effort: 'high',
      }),
    },
  ), /effort mismatch/);
  assert.throws(() => verifyFrontierAcceptance(
    receipt,
    acceptance,
    validation,
    Date.parse('2026-09-10T00:00:00.000Z'),
    {
      currentRevision: receipt.baseRevision,
      scopeHash: receipt.scopeHash,
      resolvedConfigurationEvidenceHash: acceptance.resolvedConfigurationEvidenceHash,
      resolvedConfigurationEvents: configurationEvents(receipt.plan.semanticOwner),
    },
  ), /not currently valid/);
  fs.rmSync(root, { recursive: true, force: true });
});

const sandboxImage = 'node:22-bookworm-slim';
const sandbox = {
  provider: 'docker',
  image: sandboxImage,
  memoryMb: 256,
  pidsLimit: 64,
  allowedCollateralPaths: [],
};

function reviewedApplyFixture(t) {
  const root = makeScratch('delegation-reviewed-');
  const output = makeScratch('delegation-stage-');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'value.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'test/value.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../value.mjs';\ntest('value', () => assert.equal(value, 2));\n");
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  const validator = {
    argv: ['node', '--test', 'test/value.test.mjs'],
    timeoutSeconds: 30,
  };
  const imageId = execFileSync(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}', sandboxImage],
    { encoding: 'utf8' },
  ).trim();
  const profile = {
    id: 'fixture-tests',
    capability: 'fixture-tests',
    candidateFile: 'value.mjs',
    validator,
    sandbox: { ...sandbox, expectedImageId: imageId },
  };
  fs.writeFileSync(path.join(root, 'AGENTS.md'),
    'Test fixture: use only the registered deterministic validator.\n');
  fs.writeFileSync(path.join(root, '.github/agent-budget.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    opportunityPolicy: '.github/agent-opportunities.json',
    toolRegistry: '.github/agent-tools.json',
    capabilityEvaluation: '.github/evals/capability-qualification.json',
    sandboxProfiles: '.github/sandbox-profiles.json',
    instructions: ['AGENTS.md'],
    riskTerms: [],
    gates: ['Use the registered sandbox and validator'],
    delegation: {
      allowedClasses: ['mechanical-transform'],
      requireCleanTargets: true,
      requireDeterministicValidator: true,
    },
  }, null, 2));
  fs.writeFileSync(path.join(root, '.github/agent-tools.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    tools: [{
      id: 'fixture-validator',
      kind: 'command',
      ...validator,
      cwd: '.',
      sideEffect: 'none',
      environment: [],
    }],
  }, null, 2));
  fs.writeFileSync(path.join(root, '.github/agent-opportunities.json'), JSON.stringify({
    version: 3,
    project: 'fixture',
    qualification: {
      status: 'qualified',
      automaticApplication: false,
      minimumUnattendedCases: 30,
    },
    triggerCatalog: [{
      id: 'approved-novel-public-research',
      category: 'research',
      description: 'Approved public gap.',
    }, {
      id: 'binding-novel-spec-required',
      category: 'specification',
      description: 'Binding novel specification required.',
    }],
    opportunities: [{
      id: 'focused-tests',
      label: 'Focused tests',
      triggers: ['focused tests'],
      evidence: 'repository',
      enabled: true,
      evaluationStatus: 'reviewed',
      casePacketStatus: 'reviewed',
      team: {
        id: 'fixture-focused-tests-team',
        topology: 'medium-owner-cheap-worker-medium-review',
        trustTier: 'reviewed-application',
        maxRevisions: 1,
        coordinator: {
          role: 'medium-coordinator',
          profile: {
            model: 'gpt-5.6-luna',
            effort: 'medium',
            context: 'default',
          },
          evidenceStatus: 'qualified',
        },
        reviewer: {
          role: 'medium-review',
          profile: {
            model: 'gpt-5.6-luna',
            effort: 'medium',
            context: 'default',
          },
          evidenceStatus: 'qualified',
        },
        workerCandidate: {
          role: 'cheap-worker',
          enabled: true,
          profile: {
            model: 'gpt-5-mini',
            effort: 'medium',
            context: 'default',
          },
          evidenceStatus: 'provisional',
          currentCases: 3,
          capability: 'fixture-tests',
          sandboxProfile: 'fixture-tests',
          delegationClass: 'mechanical-transform',
          validators: ['fixture-validator'],
          authority: 'staging-only',
        },
        repositoryApply: {
          authority: 'operator',
          enabled: false,
        },
      },
      conditionalProfiles: [{
        id: 'external-research',
        kind: 'research-frontier',
        profile: {
          model: 'gpt-5.6-sol',
          effort: 'high',
          context: 'default',
        },
        triggerIds: ['approved-novel-public-research'],
        requiresTriggerReceipt: true,
      }, {
        id: 'binding-spec',
        kind: 'spec-planner',
        profile: {
          model: 'gpt-5.6-luna',
          effort: 'medium',
          context: 'default',
        },
        triggerIds: ['binding-novel-spec-required'],
        requiresTriggerReceipt: true,
      }],
      phases: [{
        id: 'research-if-triggered',
        kind: 'research-frontier',
        profileRef: 'conditional:external-research',
        condition: {
          triggerIds: ['approved-novel-public-research'],
          requiresTriggerReceipt: true,
        },
      }, {
        id: 'spec-if-triggered',
        kind: 'spec-planner',
        profileRef: 'conditional:binding-spec',
        condition: {
          triggerIds: ['binding-novel-spec-required'],
          requiresTriggerReceipt: true,
        },
      }, {
        id: 'coordinate',
        kind: 'medium-coordinator',
        profileRef: 'coordinator',
      }, {
        id: 'generate-tests',
        kind: 'cheap-worker',
        profileRef: 'worker-candidate',
        enabled: true,
      }, {
        id: 'validate-tests',
        kind: 'deterministic',
        sideEffect: 'none',
        tool: 'fixture-validator',
      }, {
        id: 'review-tests',
        kind: 'medium-review',
        profileRef: 'reviewer',
      }],
      rationale: 'Fixture reviewed-application pipeline.',
    }],
  }, null, 2));
  fs.writeFileSync(path.join(root, '.github/sandbox-profiles.json'), JSON.stringify({
    version: 1,
    project: 'fixture',
    profiles: [profile],
  }, null, 2));
  fs.mkdirSync(path.join(root, '.github/evals'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/evals/capability-qualification.json'),
    JSON.stringify({
      version: 1,
      project: 'fixture',
      capabilities: [{
        id: 'fixture-tests',
        status: 'reviewed',
        trustTier: 'reviewed-application',
        automaticApplication: false,
        reviewedApplication: true,
        sandbox: {
          status: 'qualified',
          network: 'none',
          profileHash: sha256(profile),
          imageId,
          dependencyPolicyHash: sha256([]),
        },
      }],
    }, null, 2));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-qm', 'fixture'], { cwd: root });
  fs.mkdirSync(path.join(output, 'staged'));
  const files = [{ path: 'value.mjs', content: 'export const value = 2;\n' }];
  fs.writeFileSync(path.join(output, 'staged/value.mjs'), files[0].content);
  const candidateSha256 = crypto.createHash('sha256')
    .update(JSON.stringify(files)).digest('hex');
  const job = {
    outputs: ['value.mjs'],
  };
  const policyData = JSON.parse(fs.readFileSync(
    path.join(root, '.github/agent-opportunities.json'),
    'utf8',
  ));
  const registryData = JSON.parse(fs.readFileSync(
    path.join(root, '.github/agent-tools.json'),
    'utf8',
  ));
  const pipelineHash = pipelineContractHash(
    'fixture',
    policyData.opportunities[0],
    registryData,
  );
  const sandboxReadiness = validateSandboxReadiness({
    repository: root,
    config: profile.sandbox,
  });
  const stagingReceipt = {
    version: 2,
    staged: true,
    applied: false,
    workflowId: 'reviewed-application-workflow',
    pipelineHash,
    verifiedPipelineReceiptHash: 'b'.repeat(64),
    jobHash: sha256(job),
    sandboxReadiness,
    sandboxReadinessHash: sandboxReadiness.evidenceHash,
    candidateSha256,
    evidenceSha256: 'a'.repeat(64),
    project: 'fixture',
    repository: root,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    sourceTreeHash: null,
    scopeHash: 'c'.repeat(64),
    targetState: [{
      file: 'value.mjs',
      exists: true,
      mode: fs.statSync(path.join(root, 'value.mjs')).mode,
      sha256: crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(root, 'value.mjs'))).digest('hex'),
    }],
    plan: {
      version: 3,
      project: 'fixture',
      opportunityId: 'focused-tests',
      phaseId: 'generate-tests',
      capability: 'fixture-tests',
      validatorId: 'fixture-validator',
      sandboxProfileId: 'fixture-tests',
      sandboxProfileHash: sha256(profile),
      sandboxImageId: imageId,
      sandboxDependencyPolicyHash: sha256([]),
      capabilityQualificationHash: null,
      coordinator: { model: 'gpt-5.6-luna', effort: 'medium', context: 'default' },
      reviewer: { model: 'gpt-5.6-luna', effort: 'medium', context: 'default' },
      trustTier: 'reviewed-application',
      pipelineHash,
    },
  };
  stagingReceipt.plan.capabilityQualificationHash = sha256(
    JSON.parse(fs.readFileSync(
      path.join(root, '.github/evals/capability-qualification.json'),
      'utf8',
    )).capabilities[0],
  );
  stagingReceipt.sourceTreeHash = repositoryTreeHash(root);
  const acceptance = {
    version: 1,
    kind: 'medium-review-acceptance',
    approvedBy: 'medium-reviewer',
    decision: 'accept-exact-staged-candidate',
    workflowId: stagingReceipt.workflowId,
    pipelineHash: stagingReceipt.pipelineHash,
    verifiedPipelineReceiptHash:
      stagingReceipt.verifiedPipelineReceiptHash,
    jobHash: stagingReceipt.jobHash,
    sandboxReadinessHash: stagingReceipt.sandboxReadinessHash,
    project: 'fixture',
    opportunityId: 'focused-tests',
    capability: 'fixture-tests',
    repository: root,
    baseRevision: stagingReceipt.baseRevision,
    scopeHash: stagingReceipt.scopeHash,
    candidateSha256,
    evidenceSha256: stagingReceipt.evidenceSha256,
    validationEvidenceHash: null,
    configurationEvidenceHash: sha256(configurationEvents(
      stagingReceipt.plan.reviewer,
    )[0]),
    reviewer: stagingReceipt.plan.reviewer,
    approvedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const applyAuthorization = {
    version: 1,
    kind: 'repository-apply-authorization',
    authorizedBy: 'operator',
    workflowId: stagingReceipt.workflowId,
    pipelineHash: stagingReceipt.pipelineHash,
    verifiedPipelineReceiptHash:
      stagingReceipt.verifiedPipelineReceiptHash,
    jobHash: stagingReceipt.jobHash,
    sandboxReadinessHash: stagingReceipt.sandboxReadinessHash,
    project: 'fixture',
    opportunityId: 'focused-tests',
    capability: 'fixture-tests',
    repository: root,
    baseRevision: stagingReceipt.baseRevision,
    scopeHash: stagingReceipt.scopeHash,
    candidateSha256,
    validationEvidenceHash: null,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  return {
    root,
    output,
    stagingReceipt,
    job,
    acceptance,
    applyAuthorization,
    resolvedConfigurationEvents:
      configurationEvents(stagingReceipt.plan.reviewer),
  };
}

test('reviewed apply validates in isolation, checks unchanged state and revalidates after apply', {
  skip: !dockerSandboxAvailable(sandboxImage),
}, t => {
  const fixture = reviewedApplyFixture(t);
  const validationReceipt = validateStagedDelegation(
    fixture.stagingReceipt,
    fixture.job,
    fixture.root,
    fixture.output,
  );
  fixture.acceptance.validationEvidenceHash = validationReceipt.evidenceHash;
  fixture.applyAuthorization.validationEvidenceHash = validationReceipt.evidenceHash;
  assert.equal(validationReceipt.passed, true);
  const result = applyAcceptedDelegation({
    ...fixture,
    validationReceipt,
    outputDirectory: fixture.output,
    enableApply: true,
    currentRevision: fixture.stagingReceipt.baseRevision,
    scopeHash: fixture.stagingReceipt.scopeHash,
    configurationEvidenceHash:
      fixture.acceptance.configurationEvidenceHash,
  });
  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'value.mjs'), 'utf8'),
    'export const value = 2;\n');
});

test('reviewed apply rejects repository changes after isolated validation', {
  skip: !dockerSandboxAvailable(sandboxImage),
}, t => {
  const fixture = reviewedApplyFixture(t);
  const validationReceipt = validateStagedDelegation(
    fixture.stagingReceipt,
    fixture.job,
    fixture.root,
    fixture.output,
  );
  fixture.acceptance.validationEvidenceHash = validationReceipt.evidenceHash;
  fixture.applyAuthorization.validationEvidenceHash = validationReceipt.evidenceHash;
  fs.writeFileSync(path.join(fixture.root, 'unrelated.txt'), 'changed\n');
  assert.throws(() => applyAcceptedDelegation({
    ...fixture,
    validationReceipt,
    outputDirectory: fixture.output,
    enableApply: true,
    currentRevision: fixture.stagingReceipt.baseRevision,
    scopeHash: fixture.stagingReceipt.scopeHash,
    configurationEvidenceHash:
      fixture.acceptance.configurationEvidenceHash,
  }), /Repository changed/);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'value.mjs'), 'utf8'),
    'export const value = 1;\n');
});

test('reviewed apply restores exact bytes when applied state differs from accepted evidence', {
  skip: !dockerSandboxAvailable(sandboxImage),
}, t => {
  const fixture = reviewedApplyFixture(t);
  const validationReceipt = validateStagedDelegation(
    fixture.stagingReceipt,
    fixture.job,
    fixture.root,
    fixture.output,
  );
  validationReceipt.expectedTreeHash = '0'.repeat(64);
  delete validationReceipt.evidenceHash;
  validationReceipt.evidenceHash = sha256(validationReceipt);
  fixture.acceptance.validationEvidenceHash = validationReceipt.evidenceHash;
  fixture.applyAuthorization.validationEvidenceHash = validationReceipt.evidenceHash;
  assert.throws(() => applyAcceptedDelegation({
    ...fixture,
    validationReceipt,
    outputDirectory: fixture.output,
    enableApply: true,
    currentRevision: fixture.stagingReceipt.baseRevision,
    scopeHash: fixture.stagingReceipt.scopeHash,
    configurationEvidenceHash:
      fixture.acceptance.configurationEvidenceHash,
  }), /undeclared collateral changes/);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'value.mjs'), 'utf8'),
    'export const value = 1;\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], {
    cwd: fixture.root,
    encoding: 'utf8',
  }), '');
});

test('reviewed apply rejects validation from a different dependency environment', {
  skip: !dockerSandboxAvailable(sandboxImage),
}, t => {
  const fixture = reviewedApplyFixture(t);
  const validationReceipt = validateStagedDelegation(
    fixture.stagingReceipt,
    fixture.job,
    fixture.root,
    fixture.output,
  );
  const { evidenceHash: sandboxHash, ...sandboxEvidence } =
    validationReceipt.sandbox;
  void sandboxHash;
  validationReceipt.sandbox = {
    ...sandboxEvidence,
    dependencyMounts: [{
      sourcePathHash: '1'.repeat(64),
      target: '/workspace/node_modules',
      evidence: 'tree-hash',
      fingerprints: [],
      treeHash: '2'.repeat(64),
      readOnly: true,
    }],
  };
  validationReceipt.sandbox.evidenceHash = crypto.createHash('sha256')
    .update(JSON.stringify(validationReceipt.sandbox)).digest('hex');
  delete validationReceipt.evidenceHash;
  validationReceipt.evidenceHash = sha256(validationReceipt);
  fixture.acceptance.validationEvidenceHash = validationReceipt.evidenceHash;
  fixture.applyAuthorization.validationEvidenceHash = validationReceipt.evidenceHash;
  assert.throws(() => applyAcceptedDelegation({
    ...fixture,
    validationReceipt,
    outputDirectory: fixture.output,
    enableApply: true,
    currentRevision: fixture.stagingReceipt.baseRevision,
    scopeHash: fixture.stagingReceipt.scopeHash,
    configurationEvidenceHash:
      fixture.acceptance.configurationEvidenceHash,
  }), /Pre-apply validation differs from worker readiness/);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'value.mjs'), 'utf8'),
    'export const value = 1;\n');
});

test('reviewed apply remains disabled for provisional or unqualified capabilities', {
  skip: !dockerSandboxAvailable(sandboxImage),
}, t => {
  const fixture = reviewedApplyFixture(t);
  const validationReceipt = validateStagedDelegation(
    fixture.stagingReceipt,
    fixture.job,
    fixture.root,
    fixture.output,
  );
  fixture.acceptance.validationEvidenceHash = validationReceipt.evidenceHash;
  fixture.applyAuthorization.validationEvidenceHash = validationReceipt.evidenceHash;
  const qualificationFile =
    path.join(fixture.root, '.github/evals/capability-qualification.json');
  const qualification = JSON.parse(fs.readFileSync(qualificationFile, 'utf8'));
  qualification.capabilities[0].status = 'provisional';
  qualification.capabilities[0].trustTier = 'provisional-staging';
  qualification.capabilities[0].reviewedApplication = false;
  fs.writeFileSync(qualificationFile, JSON.stringify(qualification, null, 2));
  fixture.stagingReceipt.plan.capabilityQualificationHash =
    sha256(qualification.capabilities[0]);
  assert.throws(() => applyAcceptedDelegation({
    ...fixture,
    validationReceipt,
    outputDirectory: fixture.output,
    enableApply: true,
    currentRevision: fixture.stagingReceipt.baseRevision,
    scopeHash: fixture.stagingReceipt.scopeHash,
    configurationEvidenceHash:
      fixture.acceptance.configurationEvidenceHash,
  }), /reviewed-application capability/);
});

test('delegation rejects research, risk, incomplete evidence and semantic docs', () => {
  for (const change of [
    { risk: 'medium' },
    { novel: true },
    { evidenceComplete: false },
    { deterministicValidator: false },
    { instruction: 'Debug a production activation race condition.' },
  ]) {
    assert.equal(delegationPlan({ ...baseJob, ...change }, adapter).eligible, false);
  }
  assert.throws(() => delegationPlan({ ...baseJob, taskClass: 'documentation-sync' }, adapter));
  assert.throws(() => delegationPlan({ ...baseJob, taskClass: 'research' }, adapter));
});

test('candidate parser requires exact paths and bounded JSON file content', () => {
  assert.deepEqual(parseCandidate(JSON.stringify({
    files: [{ path: 'test/value.test.mjs', content: 'ok' }],
  }), baseJob.outputs), {
    files: [{ path: 'test/value.test.mjs', content: 'ok' }],
    bytes: 2,
  });
  assert.deepEqual(parseCandidate(JSON.stringify({
    files: [
      { path: 'second.test.mjs', content: 'second' },
      { path: 'first.test.mjs', content: 'first' },
    ],
  }), ['first.test.mjs', 'second.test.mjs']).files, [
    { path: 'first.test.mjs', content: 'first' },
    { path: 'second.test.mjs', content: 'second' },
  ]);
  for (const value of [
    'not-json',
    JSON.stringify({ files: [] }),
    JSON.stringify({ files: [{ path: 'other', content: 'x' }] }),
    JSON.stringify({ files: [
      { path: 'test/value.test.mjs', content: 'x' },
      { path: 'test/value.test.mjs', content: 'x' },
    ] }),
    JSON.stringify({ files: [{ path: 'test/value.test.mjs', content: 'x' }], notes: [] }),
    JSON.stringify({ files: [{ path: 'test/value.test.mjs', content: 'x', note: 'extra' }] }),
    JSON.stringify({ files: [{ path: 'test/value.test.mjs', content: 'x\0y' }] }),
  ]) assert.throws(() => parseCandidate(value, baseJob.outputs));
});

test('delegation requires sanitization and adapter content boundaries', () => {
  assert.throws(() => delegationPlan({ ...baseJob, sanitized: false }, adapter));
  const boundedAdapter = {
    ...adapter,
    evidencePolicy: { content: { allowPaths: ['src', 'test'], denyPaths: ['src/private'] } },
  };
  assert.equal(delegationPlan({ ...baseJob, inputs: [
    { file: 'src/private/value.mjs', start: 1, end: 3 },
  ] }, boundedAdapter).eligible, false);
});

test('delegation structurally rejects prohibited work despite optimistic risk labels', () => {
  for (const key of Object.keys(baseJob.boundaries)) {
    assert.throws(() => delegationPlan({
      ...baseJob,
      boundaries: { ...baseJob.boundaries, [key]: true },
    }, adapter));
  }
  assert.throws(() => delegationPlan({ ...baseJob, kind: 'research' }, adapter));
  for (const instruction of [
    'Research the best test implementation.',
    'Make an ambiguous best-effort artifact.',
    'Perform destructive cleanup in this test.',
    'Change the live entity behavior test.',
  ]) assert.equal(delegationPlan({ ...baseJob, instruction }, adapter).eligible, false);
});

test('repository opportunity policy must explicitly permit the delegation class', () => {
  const policyAdapter = { ...adapter, opportunityPolicy: '.github/agent-opportunities.json' };
  const policy = {
    opportunities: [
      {
        id: 'focused-tests',
        strategy: 'bounded-worker',
        delegationClass: 'test-generation',
        primary: { model: 'mai-code-1.1-flash' },
      },
      {
        id: 'debugging',
        strategy: 'frontier-owner',
        primary: { model: 'gpt-5.6-sol' },
      },
    ],
  };
  assert.throws(() => delegationPlan(baseJob, policyAdapter, policy), /opportunityId/);
  assert.equal(delegationPlan({
    ...baseJob,
    opportunityId: 'focused-tests',
  }, policyAdapter, policy).eligible, true);
  assert.equal(delegationPlan({
    ...baseJob,
    opportunityId: 'debugging',
  }, policyAdapter, policy).eligible, false);
  assert.equal(delegationPlan({
    ...baseJob,
    opportunityId: 'focused-tests',
    taskClass: 'scaffold',
  }, policyAdapter, policy).eligible, false);
});

test('staging delegation cannot override the provisional opportunity model', () => {
  const plan = { model: 'mai-code-1.1-flash' };
  assert.equal(selectedWorkerModel(plan), 'mai-code-1.1-flash');
  assert.throws(() => selectedWorkerModel(plan, { model: 'gemini-3.7-flash' }));
  assert.equal(selectedWorkerModel(plan, {
    model: 'gemini-3.7-flash',
    calibration: true,
  }), 'gemini-3.7-flash');
});

test('repository opportunity policy selects its provisionally evaluated worker model', () => {
  const policyAdapter = { ...adapter, opportunityPolicy: '.github/agent-opportunities.json' };
  const result = delegationPlan({ ...baseJob, opportunityId: 'focused-tests' }, policyAdapter, {
    opportunities: [{
      id: 'focused-tests',
      strategy: 'bounded-worker',
      delegationClass: 'test-generation',
      primary: { model: 'gemini-3.7-flash', effort: 'medium', context: 'default' },
    }],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.model, 'gemini-3.7-flash');
});

test('version 2 bounded-model phases drive staging eligibility', () => {
  const policyAdapter = { ...adapter, opportunityPolicy: '.github/agent-opportunities.json' };
  const { validator, ...v2Job } = baseJob;
  const capability = {
    version: 1,
    project: 'fixture',
    capabilities: [{
      id: 'fixture-tests',
      status: 'provisional',
      currentCases: 3,
      automaticApplication: false,
      sandbox: { status: 'qualified', network: 'none' },
    }],
  };
  const result = delegationPlan({
    ...v2Job,
    opportunityId: 'focused-tests',
    validatorId: 'fixture-validator',
  }, { ...policyAdapter, project: 'fixture' }, {
    version: 2,
    project: 'fixture',
    qualification: {
      status: 'provisional',
      automaticApplication: false,
      minimumPromotionCases: 30,
    },
    opportunities: [{
      id: 'focused-tests',
      phases: [{
        id: 'generate-tests',
        executor: 'bounded-model',
        capability: 'fixture-tests',
        delegationClass: 'test-generation',
        sandboxProfile: 'fixture-sandbox',
        profile: { model: 'gpt-5-mini', effort: 'medium', context: 'default' },
        validators: ['fixture-validator'],
      }],
    }],
  }, capability);
  assert.equal(result.eligible, true);
  assert.equal(result.model, 'gpt-5-mini');
  assert.equal(result.automaticAcceptance, false);
  assert.equal(result.qualificationCases, 3);
  const invalidated = structuredClone(capability);
  invalidated.capabilities[0].currentCases = 0;
  assert.equal(delegationPlan({
    ...v2Job,
    opportunityId: 'focused-tests',
    validatorId: 'fixture-validator',
  }, { ...policyAdapter, project: 'fixture' }, {
    version: 2,
    project: 'fixture',
    qualification: {
      status: 'provisional',
      automaticApplication: false,
      minimumPromotionCases: 30,
    },
    opportunities: [{
      id: 'focused-tests',
      phases: [{
        id: 'generate-tests',
        executor: 'bounded-model',
        delegationClass: 'test-generation',
        sandboxProfile: 'fixture-sandbox',
        profile: { model: 'gpt-5-mini', effort: 'medium', context: 'default' },
        validators: ['fixture-validator'],
      }],
    }],
  }, invalidated).eligible, false);
});

test('fixture demonstrates validator and git target assumptions', t => {
  const root = makeScratch('delegation-fixture-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/value.mjs'), 'export const value = () => 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-qm', 'fixture'], { cwd: root });
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
});

test('delegation exports no direct repository materialization bypass', () => {
  assert.equal('materializeCandidate' in delegationApi, false);
});
