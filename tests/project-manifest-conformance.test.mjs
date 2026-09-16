import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeScratch } from './helpers/scratch.mjs';
import {
  PROJECT_MANIFEST_REPOSITORY_ROOT,
  compatibilityChecks,
  loadProjectManifest,
  parseProjectManifest,
  runCompatibilityCheck,
} from '../scripts/project-manifest.mjs';
import { pipelineContractHash } from '../skills/budget-workflow/scripts/team-pipeline.mjs';

const projectManifest = process.env.BUDGET_PROJECT_MANIFEST;
const repoRoot = PROJECT_MANIFEST_REPOSITORY_ROOT;
const COMPATIBILITY_ARTIFACT_PATH = '.github/evals/pipeline-hash-compatibility.json';
const COMPATIBILITY_CONTRACT = 'team-pipeline/pipeline-contract-hash@v1';

const FIXTURE_REGISTRY = {
  version: 1,
  project: 'fixture',
  tools: [
    {
      id: 'check-dashboard',
      kind: 'disabled',
      reason: 'fixture validation remains read-only',
      sideEffect: 'workspace',
      environment: [],
    },
    {
      id: 'build-release',
      kind: 'disabled',
      reason: 'fixture build remains read-only',
      sideEffect: 'workspace',
      environment: [],
    },
  ],
};

const FIXTURE_POLICY = {
  version: 3,
  project: 'fixture',
  opportunities: [
    {
      id: 'release',
      label: 'Fixture release',
      triggers: ['release'],
      evidence: 'runtime',
      enabled: false,
      evaluationStatus: 'invalidated-release-machine-contract-changed',
      casePacketStatus: 'invalidated-release-machine-contract-changed',
      skills: ['release-dashboard'],
      executionMachine: '.github/release-machine.json',
      executionEnabled: false,
      team: {
        id: 'fixture-release-team',
        topology: 'medium-owner-only',
        trustTier: 'provisional-staging',
        maxRevisions: 1,
        coordinator: {
          role: 'medium-coordinator',
          profile: {
            model: 'gpt-5.4',
            effort: 'medium',
            context: 'default',
          },
          evidenceStatus: 'provisional',
        },
        reviewer: {
          role: 'medium-review',
          profile: {
            model: 'gpt-5.4',
            effort: 'medium',
            context: 'default',
          },
          evidenceStatus: 'provisional',
        },
        workerCandidate: {
          role: 'cheap-worker',
          enabled: false,
          profile: {
            model: 'gpt-5-mini',
            effort: 'medium',
            context: 'default',
          },
          evidenceStatus: 'disabled',
          currentCases: 0,
          authority: 'staging-only',
        },
        repositoryApply: {
          authority: 'operator',
          enabled: false,
        },
      },
      conditionalProfiles: [],
      phases: [
        {
          id: 'validate-release',
          kind: 'deterministic',
          sideEffect: 'workspace',
          tool: 'check-dashboard',
        },
        {
          id: 'build-release',
          kind: 'deterministic',
          sideEffect: 'workspace',
          tool: 'build-release',
        },
        {
          id: 'coordinate',
          kind: 'medium-coordinator',
          profileRef: 'coordinator',
        },
        {
          id: 'execute-release-machine',
          kind: 'deterministic-release',
          machine: '.github/release-machine.json',
          operatorAuthorizationRequired: true,
        },
      ],
      rationale: 'Fixture release pipeline for data-only compatibility coverage.',
    },
  ],
};

function notApplicable(reason) {
  return {
    applicable: false,
    reason,
  };
}

function completeConformance(overrides = {}) {
  return {
    version: 2,
    surfaces: {
      'expected-opportunity-ids': notApplicable(
        'fixture repository has no routed opportunity inventory'),
      'instruction-contract': notApplicable(
        'fixture repository has no relocated instruction contract'),
      'release-skill': notApplicable(
        'fixture repository has no release dashboard skill'),
      'repository-local-phase-checks': notApplicable(
        'fixture repository has no deterministic none-side-effect phase probes'),
      'compatibility-checks': notApplicable(
        'fixture repository has no compatibility contract artifact'),
      ...overrides,
    },
  };
}

function fixtureCase(overrides = {}) {
  return {
    id: 'fixture',
    root: repoRoot,
    conformance: completeConformance(),
    ...overrides,
  };
}

function compatibilityEntry(overrides = {}) {
  return {
    id: 'routed-pipeline-hash',
    path: COMPATIBILITY_ARTIFACT_PATH,
    ...overrides,
  };
}

function compatibilityArtifact(overrides = {}) {
  return {
    version: 1,
    canonicalContract: COMPATIBILITY_CONTRACT,
    project: FIXTURE_POLICY.project,
    vectors: [
      {
        id: 'release',
        opportunityId: 'release',
        expectedHash: pipelineContractHash(
          FIXTURE_POLICY.project,
          FIXTURE_POLICY.opportunities[0],
          FIXTURE_REGISTRY,
          null,
        ),
      },
    ],
    ...overrides,
  };
}

function writeJson(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (typeof value === 'string') {
    fs.writeFileSync(target, value);
    return target;
  }
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

function writeCompatibilityRoot(t, artifact = compatibilityArtifact(), extras = []) {
  const scratch = makeScratch('manifest-compatibility-');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'root');
  writeJson(root, '.github/agent-opportunities.json', FIXTURE_POLICY);
  writeJson(root, '.github/agent-tools.json', FIXTURE_REGISTRY);
  writeJson(root, COMPATIBILITY_ARTIFACT_PATH, artifact);
  for (const item of extras) {
    writeJson(root, item.path, item.value);
  }
  return root;
}

function writeManifest(t, cases) {
  const scratch = makeScratch('manifest-compatibility-manifest-');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const manifest = path.join(scratch, 'manifest.json');
  fs.writeFileSync(manifest, `${JSON.stringify({ cases }, null, 2)}\n`);
  return manifest;
}

test('project manifest schema accepts explicit N/A declarations for every surface', () => {
  const manifest = parseProjectManifest({
    cases: [fixtureCase()],
  });
  assert.equal(manifest.cases[0].conformance.version, 2);
  assert.equal(manifest.cases[0].conformance.surfaces['compatibility-checks'].applicable, false);
});

test('each case must declare every conformance surface explicitly', () => {
  for (const type of [
    'expected-opportunity-ids',
    'instruction-contract',
    'release-skill',
    'repository-local-phase-checks',
    'compatibility-checks',
  ]) {
    const manifest = fixtureCase();
    delete manifest.conformance.surfaces[type];
    assert.throws(() => parseProjectManifest({
      cases: [manifest],
    }), new RegExp(type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('one case cannot satisfy another case coverage declaration', () => {
  const first = fixtureCase();
  const second = fixtureCase({
    id: 'second',
  });
  delete second.conformance.surfaces['release-skill'];
  assert.throws(() => parseProjectManifest({
    cases: [first, second],
  }), /cases\[1\].*release-skill/i);
});

test('project manifest schema rejects compatibility path escape, false N/A absentPaths, and smuggled fields', () => {
  assert.throws(() => parseProjectManifest({
    cases: [fixtureCase({
      conformance: completeConformance({
        'compatibility-checks': {
          applicable: true,
          entries: [{
            ...compatibilityEntry(),
            command: 'node -e "process.exit(0)"',
          }],
        },
      }),
    })],
  }), /command/i);
  assert.throws(() => parseProjectManifest({
    cases: [fixtureCase({
      conformance: completeConformance({
        'compatibility-checks': {
          applicable: true,
          entries: [{
            ...compatibilityEntry(),
            path: '../outside.json',
          }],
        },
      }),
    })],
  }), /must stay inside the repository/i);
  assert.throws(() => parseProjectManifest({
    cases: [fixtureCase({
      conformance: completeConformance({
        'compatibility-checks': {
          applicable: false,
          reason: 'fixture repository has no compatibility contract artifact',
          absentPaths: [COMPATIBILITY_ARTIFACT_PATH],
        },
      }),
    })],
  }), /absentPaths|Compatibility checks reason/i);
});

test('project contract runner fails closed before project tests on missing coverage metadata', (t) => {
  const scratch = makeScratch('manifest-runner-fail-closed-');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'root');
  fs.mkdirSync(root, { recursive: true });
  const manifest = path.join(scratch, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    cases: [{
      id: 'fixture',
      root,
      conformance: {
        version: 2,
        surfaces: {
          'expected-opportunity-ids': notApplicable(
            'fixture repository has no routed opportunity inventory'),
          'instruction-contract': notApplicable(
            'fixture repository has no relocated instruction contract'),
          'release-skill': notApplicable(
            'fixture repository has no release dashboard skill'),
          'repository-local-phase-checks': notApplicable(
            'fixture repository has no deterministic none-side-effect phase probes'),
        },
      },
    }],
  }, null, 2));
  const script = path.join(repoRoot, 'scripts', 'run-project-contract-tests.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BUDGET_PROJECT_MANIFEST: manifest,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Project manifest validation failed/);
});

test('false N/A declarations fail when a conventional compatibility artifact exists after checkout', (t) => {
  const root = writeCompatibilityRoot(t);
  const manifest = writeManifest(t, [fixtureCase({
    root,
    conformance: completeConformance(),
  })]);
  assert.throws(() => loadProjectManifest(manifest),
    /compatibility-checks.*not applicable/i);
});

test('compatibility artifact validation rejects malformed, oversized, and deeply nested JSON', (t) => {
  const malformedRoot = writeCompatibilityRoot(t, '{"version": 1,');
  assert.throws(() => runCompatibilityCheck(
    { id: 'fixture', root: malformedRoot },
    compatibilityEntry(),
  ), /JSON is invalid/i);

  const oversizedRoot = writeCompatibilityRoot(t, {
    version: 1,
    canonicalContract: COMPATIBILITY_CONTRACT,
    project: 'fixture',
    vectors: Array.from({ length: 8 }, (_, index) => ({
      id: `vector-${index}`,
      opportunityId: 'release',
      expectedHash: 'a'.repeat(64),
    })),
    padding: 'x'.repeat(16 * 1024),
  });
  assert.throws(() => runCompatibilityCheck(
    { id: 'fixture', root: oversizedRoot },
    compatibilityEntry(),
  ), /at most 16384 bytes/i);

  const deepRoot = writeCompatibilityRoot(t, {
    version: 1,
    canonicalContract: COMPATIBILITY_CONTRACT,
    project: 'fixture',
    vectors: [{
      id: 'release',
      opportunityId: 'release',
      expectedHash: compatibilityArtifact().vectors[0].expectedHash,
    }],
    nesting: {
      a: {
        b: {
          c: {
            d: 'too-deep',
          },
        },
      },
    },
  });
  assert.throws(() => runCompatibilityCheck(
    { id: 'fixture', root: deepRoot },
    compatibilityEntry(),
  ), /maximum depth/i);
});

test('compatibility artifact validation rejects smuggled command, module, url, and unknown fields', (t) => {
  for (const [field, value] of [
    ['command', 'node scripts/run.js'],
    ['modulePath', '.github/skills/house-style-copy/scripts/lib.mjs'],
    ['url', 'https://example.com/compatibility.json'],
    ['code', 'export const payload = 1;'],
  ]) {
    const root = writeCompatibilityRoot(t, {
      ...compatibilityArtifact(),
      [field]: value,
    });
    assert.throws(() => runCompatibilityCheck(
      { id: 'fixture', root },
      compatibilityEntry(),
    ), new RegExp(field, 'i'));
  }
});

test('compatibility artifact ambiguity fails closed on extra compatibility-looking files', (t) => {
  const root = writeCompatibilityRoot(t, compatibilityArtifact(), [{
    path: '.github/evals/second-compatibility.json',
    value: { note: 'unexpected' },
  }]);
  const manifest = writeManifest(t, [fixtureCase({
    root,
    conformance: completeConformance({
      'compatibility-checks': {
        applicable: true,
        entries: [compatibilityEntry()],
      },
    }),
  })]);
  assert.throws(() => loadProjectManifest(manifest),
    /unexpected compatibility artifacts/i);
});

test('compatibility artifact hash mismatches fail closed', (t) => {
  const root = writeCompatibilityRoot(t, {
    ...compatibilityArtifact(),
    vectors: [{
      ...compatibilityArtifact().vectors[0],
      expectedHash: '0'.repeat(64),
    }],
  });
  assert.throws(() => runCompatibilityCheck(
    { id: 'fixture', root },
    compatibilityEntry(),
  ), /did not match canonical pipeline hash/i);
});

test('compatibility artifact valid parity succeeds with inert manifest data', (t) => {
  const root = writeCompatibilityRoot(t);
  const result = runCompatibilityCheck(
    { id: 'fixture', root },
    compatibilityEntry(),
  );
  assert.equal(result.artifact, COMPATIBILITY_ARTIFACT_PATH);
  assert.equal(result.canonicalContract, COMPATIBILITY_CONTRACT);
  assert.deepEqual(result.vectors.map(item => item.id), ['release']);
  assert.equal(result.vectors[0].canonicalHash, result.vectors[0].expectedHash);
});

test('manifest compatibility checks keep checked-in React hashes aligned with the canonical pipeline hash', {
  skip: !projectManifest,
}, () => {
  const manifest = loadProjectManifest(projectManifest);
  const entries = manifest.cases.flatMap(item =>
    compatibilityChecks(item).map(entry => ({
      caseId: item.id,
      root: item.root,
      entry,
    })));
  assert.ok(entries.length > 0,
    'Manifest must declare at least one compatibility-checks entry');
  for (const item of entries) {
    const result = runCompatibilityCheck({
      id: item.caseId,
      root: item.root,
    }, item.entry);
    assert.ok(result.vectors.length > 0,
      `${item.caseId}/${item.entry.id} must include at least one compatibility vector`);
    for (const vector of result.vectors) {
      assert.equal(vector.canonicalHash, vector.expectedHash,
        `${item.caseId}/${item.entry.id}/${vector.id} compatibility result drifted from the canonical implementation`);
    }
  }
});
