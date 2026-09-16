import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { pipelineContractHash } from '../skills/budget-workflow/scripts/team-pipeline.mjs';
import { validateToolRegistry } from '../skills/budget-workflow/scripts/workflow.mjs';

export const PROJECT_MANIFEST_CONFORMANCE_VERSION = 2;
export const PROJECT_MANIFEST_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const PROJECT_MANIFEST_CHECK_TYPES = Object.freeze([
  'expected-opportunity-ids',
  'instruction-contract',
  'release-skill',
  'repository-local-phase-checks',
  'compatibility-checks',
]);

const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_REASON_LENGTH = 160;
const CONVENTIONAL_OPPORTUNITY_POLICY_PATH = '.github/agent-opportunities.json';
const CONVENTIONAL_OPPORTUNITY_EVALUATION_PATH = '.github/evals/agent-opportunity-cases.json';
const CONVENTIONAL_TOOL_REGISTRY_PATH = '.github/agent-tools.json';
const CONVENTIONAL_RELEASE_SKILL_PATH = '.github/skills/release-dashboard/SKILL.md';
const CONVENTIONAL_REFERENCE_DIRECTORY = '.github/reference';
const COMPATIBILITY_ARTIFACT_VERSION = 1;
const COMPATIBILITY_ARTIFACT_MAX_BYTES = 16 * 1024;
const COMPATIBILITY_ARTIFACT_MAX_DEPTH = 4;
const COMPATIBILITY_ARTIFACT_MAX_STRING_LENGTH = 160;
const COMPATIBILITY_ARTIFACT_MAX_VECTORS = 8;
const COMPATIBILITY_ARTIFACT_MAX_OBJECT_KEYS = 8;
const COMPATIBILITY_ARTIFACT_MAX_NODES = 128;
const COMPATIBILITY_ARTIFACTS = Object.freeze([
  {
    id: 'routed-pipeline-hash',
    path: '.github/evals/pipeline-hash-compatibility.json',
    canonicalContract: 'team-pipeline/pipeline-contract-hash@v1',
  },
]);
const COMPATIBILITY_ARTIFACTS_BY_ID = new Map(COMPATIBILITY_ARTIFACTS.map(item =>
  [item.id, item]));
const COMPATIBILITY_ARTIFACTS_BY_PATH = new Map(COMPATIBILITY_ARTIFACTS.map(item =>
  [item.path, item]));
const SUPPORTED_COMPATIBILITY_CONTRACTS = new Set(COMPATIBILITY_ARTIFACTS.map(item =>
  item.canonicalContract));

function manifestError(message) {
  return new Error(`Project manifest validation failed:\n- ${message}`);
}

function issuePath(pathEntries) {
  if (!Array.isArray(pathEntries) || pathEntries.length === 0) return 'project manifest';
  return pathEntries.reduce((result, entry) =>
    typeof entry === 'number'
      ? `${result}[${entry}]`
      : `${result}.${entry}`,
  'project manifest');
}

function uniqueKeys(items, keyFor, label, ctx) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const key = keyFor(item);
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: `${label} must not contain duplicate ${key}`,
      });
      continue;
    }
    seen.add(key);
  }
}

function nonEmptyString(label) {
  return z.string().refine(value => value.trim().length > 0, {
    message: `${label} must be a non-empty string`,
  });
}

function boundedReason(label) {
  return nonEmptyString(label).refine(value => value.length <= MAX_REASON_LENGTH, {
    message: `${label} must be at most ${MAX_REASON_LENGTH} characters`,
  });
}

function constrainedRelativePath(label) {
  return nonEmptyString(label).superRefine((value, ctx) => {
    if (path.isAbsolute(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be a relative path`,
      });
      return;
    }
    const normalized = value.replace(/\\/g, '/');
    if (normalized.split('/').includes('..')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must stay inside the repository`,
      });
    }
  });
}

function relativePaths(label, minimum = 1) {
  return z.array(constrainedRelativePath(label)).min(minimum,
    `${label}s must include at least ${minimum} path${minimum === 1 ? '' : 's'}`).superRefine((value, ctx) => {
    uniqueKeys(value, item => item, `${label}s`, ctx);
  });
}

function kebab(label) {
  return nonEmptyString(label).refine(value => CASE_ID.test(value), {
    message: `${label} must be lower-kebab-case`,
  });
}

function notApplicableSurfaceSchema(label, {
  allowAbsentPaths = true,
  requireAbsentPaths = false,
} = {}) {
  return z.object({
    applicable: z.literal(false),
    reason: boundedReason(`${label} reason`),
    ...(requireAbsentPaths
      ? { absentPaths: relativePaths(`${label} absent path`) }
      : allowAbsentPaths
        ? { absentPaths: relativePaths(`${label} absent path`).optional() }
        : {}),
  }).strict();
}

const repositoryName = nonEmptyString('Manifest case repository').refine(value => REPOSITORY.test(value), {
  message: 'Manifest case repository must be owner/name',
});

const expectedOpportunityIdsApplicableSchema = z.object({
  applicable: z.literal(true),
  ids: z.array(kebab('Expected opportunity id')).min(1,
    'Expected opportunity ids must include at least one id'),
}).strict().superRefine((value, ctx) => {
  uniqueKeys(value.ids, item => item, 'Expected opportunity ids', ctx);
});

const instructionContractApplicableSchema = z.object({
  applicable: z.literal(true),
  path: constrainedRelativePath('Instruction contract path'),
  baselineRef: nonEmptyString('Instruction contract baselineRef').optional(),
  migrationRef: nonEmptyString('Instruction contract migrationRef').optional(),
}).strict();

const releaseSkillApplicableSchema = z.object({
  applicable: z.literal(true),
  path: constrainedRelativePath('Release skill path'),
}).strict();

const repositoryLocalPhaseEntrySchema = z.object({
  opportunity: kebab('Repository-local phase opportunity'),
  phase: kebab('Repository-local phase id'),
  variant: kebab('Repository-local phase variant').optional(),
}).strict();

const repositoryLocalPhaseApplicableSchema = z.object({
  applicable: z.literal(true),
  entries: z.array(repositoryLocalPhaseEntrySchema).min(1,
    'Repository-local phase checks must include at least one phase'),
}).strict().superRefine((value, ctx) => {
  uniqueKeys(value.entries,
    item => `${item.opportunity}:${item.variant ?? ''}:${item.phase}`,
    'Repository-local phase checks',
    ctx);
});

const compatibilityEntrySchema = z.object({
  id: kebab('Compatibility check id'),
  path: constrainedRelativePath('Compatibility artifact path'),
}).strict().superRefine((value, ctx) => {
  const definition = COMPATIBILITY_ARTIFACTS_BY_ID.get(value.id);
  if (!definition) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Compatibility check id must be one of ${[...COMPATIBILITY_ARTIFACTS_BY_ID.keys()].join(', ')}`,
    });
    return;
  }
  if (value.path !== definition.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['path'],
      message: `Compatibility artifact path must be ${definition.path}`,
    });
  }
});

const compatibilityChecksApplicableSchema = z.object({
  applicable: z.literal(true),
  entries: z.array(compatibilityEntrySchema).min(1,
    'Compatibility checks must include at least one entry'),
}).strict().superRefine((value, ctx) => {
  uniqueKeys(value.entries, item => item.id, 'Compatibility checks', ctx);
  uniqueKeys(value.entries, item => item.path, 'Compatibility artifact paths', ctx);
});

const conformanceSurfacesSchema = z.object({
  'expected-opportunity-ids': z.discriminatedUnion('applicable', [
    expectedOpportunityIdsApplicableSchema,
    notApplicableSurfaceSchema('Expected opportunity ids'),
  ]),
  'instruction-contract': z.discriminatedUnion('applicable', [
    instructionContractApplicableSchema,
    notApplicableSurfaceSchema('Instruction contract'),
  ]),
  'release-skill': z.discriminatedUnion('applicable', [
    releaseSkillApplicableSchema,
    notApplicableSurfaceSchema('Release skill'),
  ]),
  'repository-local-phase-checks': z.discriminatedUnion('applicable', [
    repositoryLocalPhaseApplicableSchema,
    notApplicableSurfaceSchema('Repository-local phase checks'),
  ]),
  'compatibility-checks': z.discriminatedUnion('applicable', [
    compatibilityChecksApplicableSchema,
    notApplicableSurfaceSchema('Compatibility checks', { allowAbsentPaths: false }),
  ]),
}).strict();

const caseConformanceSchema = z.object({
  version: z.literal(PROJECT_MANIFEST_CONFORMANCE_VERSION),
  surfaces: conformanceSurfacesSchema,
}).strict();

const manifestCaseSchema = z.object({
  id: kebab('Manifest case id'),
  project: nonEmptyString('Manifest case project').optional(),
  repository: repositoryName.optional(),
  ref: nonEmptyString('Manifest case ref').optional(),
  path: constrainedRelativePath('Manifest case path').optional(),
  root: nonEmptyString('Manifest case root').optional(),
  conformance: caseConformanceSchema,
}).strict().superRefine((value, ctx) => {
  const hasCheckoutField = value.repository !== undefined
    || value.ref !== undefined
    || value.path !== undefined;
  if (hasCheckoutField && (
    value.repository === undefined
    || value.ref === undefined
    || value.path === undefined
  )) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Manifest checkout cases require repository, ref, and path together',
    });
  }
  if (value.root === undefined && !hasCheckoutField) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Manifest cases require either root or repository/ref/path',
    });
  }
});

const projectManifestSchema = z.object({
  prepareCommands: z.array(nonEmptyString('Prepare command')).optional(),
  cases: z.array(manifestCaseSchema).min(1, 'Manifest cases array is required'),
}).strict();

function formatZod(error) {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }
  return error.issues
    .map(issue => `${issuePath(issue.path)}: ${issue.message}`)
    .join('\n- ');
}

function normalizedRelative(root, target) {
  return path.relative(root, target).replace(/\\/g, '/');
}

function sameStringSets(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function existingContainedPaths(root, relatives) {
  const seen = new Set();
  const files = [];
  for (const relative of relatives) {
    if (typeof relative !== 'string' || relative.length === 0) continue;
    let resolved;
    try {
      resolved = resolveContainedPath(root, relative, `${relative} surface`, {
        allowMissing: true,
      });
    } catch {
      continue;
    }
    if (!fs.statSync(resolved, { throwIfNoEntry: false })) continue;
    const normalized = normalizedRelative(fs.realpathSync(root), resolved);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
  }
  return files.sort();
}

function collectReferenceContracts(root) {
  const referenceRoot = resolveContainedPath(root,
    CONVENTIONAL_REFERENCE_DIRECTORY,
    'Instruction contract directory', {
      allowMissing: true,
    });
  const stat = fs.statSync(referenceRoot, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return [];
  const base = fs.realpathSync(root);
  const files = [];
  const queue = [referenceRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(normalizedRelative(base, fs.realpathSync(target)));
    }
  }
  return files.sort();
}

function parseRawOpportunityPolicy(root) {
  const file = resolveContainedPath(root, CONVENTIONAL_OPPORTUNITY_POLICY_PATH,
    'Opportunity policy surface', {
      expectFile: true,
    });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readContainedJson(root, relative, label) {
  const file = resolveContainedPath(root, relative, label, {
    expectFile: true,
  });
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} JSON is invalid: ${error.message}`);
    }
    throw error;
  }
}

function inspectOpportunitySurface(root) {
  const files = existingContainedPaths(root, [
    CONVENTIONAL_OPPORTUNITY_POLICY_PATH,
    CONVENTIONAL_OPPORTUNITY_EVALUATION_PATH,
  ]);
  if (files.length === 0) {
    return { applicable: false, files, ids: [] };
  }
  try {
    const policy = parseRawOpportunityPolicy(root);
    if (!Array.isArray(policy?.opportunities)) {
      throw new Error('Opportunity policy must contain an opportunities array');
    }
    return {
      applicable: true,
      files,
      ids: policy.opportunities
        .map(item => item?.id)
        .filter(item => typeof item === 'string')
        .sort(),
    };
  } catch (error) {
    return {
      applicable: true,
      files,
      ids: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function inspectRepositoryLocalPhaseSurface(root) {
  const files = existingContainedPaths(root, [
    CONVENTIONAL_OPPORTUNITY_POLICY_PATH,
    CONVENTIONAL_TOOL_REGISTRY_PATH,
  ]);
  if (files.length === 0) {
    return { applicable: false, files, phases: [] };
  }
  try {
    const policy = parseRawOpportunityPolicy(root);
    if (!Array.isArray(policy?.opportunities)) {
      throw new Error('Opportunity policy must contain an opportunities array');
    }
    const phases = policy.opportunities.flatMap(opportunity =>
      (Array.isArray(opportunity?.phases) ? opportunity.phases : [])
        .filter(phase =>
          phase.kind === 'deterministic'
          && phase.sideEffect === 'none'
          && typeof phase.tool === 'string')
        .map(phase => ({
          opportunity: opportunity.id,
          phase: phase.id,
          variant: phase.variant ?? null,
        })));
    return {
      applicable: phases.length > 0,
      files,
      phases,
    };
  } catch (error) {
    return {
      applicable: true,
      files,
      phases: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function compatibilityArtifactDefinition(entry) {
  const definition = COMPATIBILITY_ARTIFACTS_BY_ID.get(entry.id);
  if (!definition) {
    throw new Error(`Unsupported compatibility check id: ${entry.id}`);
  }
  return definition;
}

function collectCompatibilityLookingArtifacts(root) {
  const evalRoot = resolveContainedPath(root,
    '.github/evals',
    'Compatibility eval directory', {
      allowMissing: true,
    });
  const stat = fs.statSync(evalRoot, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return [];
  const base = fs.realpathSync(root);
  const matches = [];
  const queue = [evalRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json') || !/compatibility/i.test(entry.name)) {
        continue;
      }
      matches.push(normalizedRelative(base, fs.realpathSync(target)));
    }
  }
  return matches.sort();
}

function inspectCompatibilitySurface(root) {
  const declared = COMPATIBILITY_ARTIFACTS
    .filter(item => existingContainedPaths(root, [item.path]).length > 0);
  const observed = collectCompatibilityLookingArtifacts(root);
  const unexpected = observed.filter(relative => !COMPATIBILITY_ARTIFACTS_BY_PATH.has(relative));
  return {
    applicable: declared.length > 0 || observed.length > 0,
    entries: declared,
    unexpected,
  };
}

function pushIssue(issues, pathLabel, message) {
  issues.push(`${pathLabel}: ${message}`);
}

function validateCompatibilitySurfaceAgainstRoot(item, index, issues) {
  const pathLabel = `project manifest.cases[${index}].conformance.surfaces.compatibility-checks`;
  const declaration = findCaseCheck(item, 'compatibility-checks');
  const surface = inspectCompatibilitySurface(item.root);
  if (!declaration.applicable) {
    const existing = [
      ...surface.entries.map(entry => entry.path),
      ...surface.unexpected,
    ];
    if (existing.length > 0) {
      pushIssue(issues, pathLabel,
        `cannot be marked not applicable while compatibility artifacts exist: ${existing.join(', ')}`);
    }
    return;
  }
  if (surface.unexpected.length > 0) {
    pushIssue(issues, pathLabel,
      `found unexpected compatibility artifacts: ${surface.unexpected.join(', ')}`);
  }
  if (surface.entries.length === 0) {
    pushIssue(issues, pathLabel,
      'is applicable but no checked-out compatibility artifact exists');
  }
  const expectedEntries = new Map(surface.entries.map(entry =>
    [entry.id, entry.path]));
  const declaredEntries = new Map(declaration.entries.map(entry =>
    [entry.id, entry.path]));
  if (expectedEntries.size !== declaredEntries.size ||
    [...expectedEntries.entries()].some(([id, artifactPath]) =>
      declaredEntries.get(id) !== artifactPath)) {
    const detail = surface.entries.length > 0
      ? surface.entries.map(entry => `${entry.id}:${entry.path}`).join(', ')
      : 'none';
    pushIssue(issues, pathLabel,
      `must declare the checked-out compatibility artifacts exactly (${detail})`);
  }
  for (const [entryIndex, entry] of declaration.entries.entries()) {
    const entryLabel = `${pathLabel}.entries[${entryIndex}]`;
    try {
      loadCompatibilityArtifact(item.root, entry);
    } catch (error) {
      pushIssue(issues, entryLabel, error instanceof Error ? error.message : String(error));
    }
  }
}

function validateManifestCoverageAgainstRoots(manifest) {
  const issues = [];
  for (const [index, item] of manifest.cases.entries()) {
    if (typeof item.root !== 'string' || item.root.length === 0) continue;
    try {
      item.root = fs.realpathSync(item.root);
    } catch {
      pushIssue(issues, `project manifest.cases[${index}].root`,
        `Manifest case root does not exist: ${item.root}`);
      continue;
    }

    const expectedIdsDeclaration = findCaseCheck(item, 'expected-opportunity-ids');
    const opportunitySurface = inspectOpportunitySurface(item.root);
    const expectedIdsPath = `project manifest.cases[${index}].conformance.surfaces.expected-opportunity-ids`;
    if (!expectedIdsDeclaration.applicable) {
      if (opportunitySurface.applicable) {
        pushIssue(issues, expectedIdsPath,
          `cannot be marked not applicable while opportunity policy surfaces exist: ${opportunitySurface.files.join(', ')}`);
      }
    } else if (!opportunitySurface.applicable) {
      pushIssue(issues, expectedIdsPath,
        'is applicable but no opportunity policy/evaluation surface exists after checkout');
    } else if (opportunitySurface.error) {
      pushIssue(issues, expectedIdsPath,
        `could not read the checked-out opportunity policy: ${opportunitySurface.error}`);
    } else if (!sameStringSets(expectedIdsDeclaration.ids, opportunitySurface.ids)) {
      pushIssue(issues, expectedIdsPath,
        `must match the checked-out opportunity ids exactly (${opportunitySurface.ids.join(', ')})`);
    }

    const instructionDeclaration = findCaseCheck(item, 'instruction-contract');
    const instructionFiles = collectReferenceContracts(item.root);
    const instructionPath = `project manifest.cases[${index}].conformance.surfaces.instruction-contract`;
    if (!instructionDeclaration.applicable) {
      if (instructionFiles.length > 0) {
        pushIssue(issues, instructionPath,
          `cannot be marked not applicable while instruction contracts exist: ${instructionFiles.join(', ')}`);
      }
    } else {
      try {
        const instructionFile = resolveContainedPath(item.root, instructionDeclaration.path,
          `${item.id} instruction contract`, {
            expectFile: true,
          });
        if (!instructionFiles.includes(normalizedRelative(item.root, instructionFile))) {
          pushIssue(issues, instructionPath,
            `declared instruction contract is not present under ${CONVENTIONAL_REFERENCE_DIRECTORY}`);
        }
      } catch (error) {
        pushIssue(issues, `${instructionPath}.path`, error instanceof Error ? error.message : String(error));
      }
      if (instructionFiles.length === 0) {
        pushIssue(issues, instructionPath,
          'is applicable but no checked-out instruction contract exists');
      }
    }

    const releaseDeclaration = findCaseCheck(item, 'release-skill');
    const releaseSkillFiles = existingContainedPaths(item.root, [CONVENTIONAL_RELEASE_SKILL_PATH]);
    const releasePath = `project manifest.cases[${index}].conformance.surfaces.release-skill`;
    if (!releaseDeclaration.applicable) {
      if (releaseSkillFiles.length > 0) {
        pushIssue(issues, releasePath,
          `cannot be marked not applicable while release skill surfaces exist: ${releaseSkillFiles.join(', ')}`);
      }
    } else {
      try {
        resolveContainedPath(item.root, releaseDeclaration.path, `${item.id} release skill`, {
          expectFile: true,
        });
      } catch (error) {
        pushIssue(issues, `${releasePath}.path`, error instanceof Error ? error.message : String(error));
      }
      if (releaseSkillFiles.length === 0) {
        pushIssue(issues, releasePath,
          'is applicable but no checked-out release skill exists');
      }
    }

    const repositoryPhaseDeclaration = findCaseCheck(item, 'repository-local-phase-checks');
    const repositoryPhaseSurface = inspectRepositoryLocalPhaseSurface(item.root);
    const repositoryPhasePath = `project manifest.cases[${index}].conformance.surfaces.repository-local-phase-checks`;
    if (!repositoryPhaseDeclaration.applicable) {
      if (repositoryPhaseSurface.applicable) {
        const detail = repositoryPhaseSurface.error
          ? repositoryPhaseSurface.error
          : repositoryPhaseSurface.phases
            .map(phase => `${phase.opportunity}/${phase.variant ?? 'default'}/${phase.phase}`)
            .join(', ');
        pushIssue(issues, repositoryPhasePath,
          `cannot be marked not applicable while repository-local deterministic none-side-effect phases exist: ${detail}`);
      }
    } else if (!repositoryPhaseSurface.applicable) {
      pushIssue(issues, repositoryPhasePath,
        'is applicable but no checked-out deterministic none-side-effect phases exist');
    } else if (repositoryPhaseSurface.error) {
      pushIssue(issues, repositoryPhasePath,
        `could not read repository-local deterministic phases: ${repositoryPhaseSurface.error}`);
    } else {
      const available = new Set(repositoryPhaseSurface.phases.map(item =>
        `${item.opportunity}:${item.variant ?? ''}:${item.phase}`));
      for (const [entryIndex, entry] of repositoryPhaseDeclaration.entries.entries()) {
        const key = `${entry.opportunity}:${entry.variant ?? ''}:${entry.phase}`;
        if (!available.has(key)) {
          pushIssue(issues, `${repositoryPhasePath}.entries[${entryIndex}]`,
            `does not match a checked-out deterministic none-side-effect phase`);
        }
      }
    }

    validateCompatibilitySurfaceAgainstRoot(item, index, issues);
  }

  if (issues.length > 0) {
    throw manifestError(issues.join('\n- '));
  }
  return manifest;
}

export function parseProjectManifest(value) {
  try {
    return projectManifestSchema.parse(value);
  } catch (error) {
    throw manifestError(formatZod(error));
  }
}

export function loadProjectManifest(file, {
  validateRoots = true,
} = {}) {
  try {
    const manifest = parseProjectManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
    return validateRoots ? validateManifestCoverageAgainstRoots(manifest) : manifest;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw manifestError(`project manifest JSON is invalid: ${error.message}`);
    }
    throw error;
  }
}

export function findCaseCheck(item, type) {
  return item.conformance.surfaces[type] ?? null;
}

export function expectedOpportunityIds(item) {
  const declaration = findCaseCheck(item, 'expected-opportunity-ids');
  return declaration.applicable ? declaration.ids : [];
}

export function instructionContractCheck(item) {
  const declaration = findCaseCheck(item, 'instruction-contract');
  return declaration.applicable ? declaration : null;
}

export function releaseSkillCheck(item) {
  const declaration = findCaseCheck(item, 'release-skill');
  return declaration.applicable ? declaration : null;
}

export function repositoryLocalPhaseChecks(item) {
  const declaration = findCaseCheck(item, 'repository-local-phase-checks');
  return declaration.applicable ? declaration.entries : [];
}

export function compatibilityChecks(item) {
  const declaration = findCaseCheck(item, 'compatibility-checks');
  return declaration.applicable ? declaration.entries : [];
}

export function auxiliaryRefsForCase(item) {
  const instruction = instructionContractCheck(item);
  return [
    instruction?.baselineRef ?? null,
    instruction?.migrationRef ?? null,
  ].filter(value => typeof value === 'string');
}

export function resolveContainedPath(root, relative, label, {
  expectFile = false,
  allowMissing = false,
} = {}) {
  if (!root || typeof root !== 'string') {
    throw new Error(`${label} requires an absolute repository root`);
  }
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error(`${label} requires a relative path`);
  }
  const base = fs.realpathSync(root);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`${label} must stay inside ${base}`);
  }
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) {
    if (allowMissing) return resolved;
    throw new Error(`${label} does not exist: ${relative}`);
  }
  const real = fs.realpathSync(resolved);
  if (real !== base && !real.startsWith(`${base}${path.sep}`)) {
    throw new Error(`${label} must stay inside ${base}`);
  }
  if (expectFile && !stat.isFile()) {
    throw new Error(`${label} is not a file: ${relative}`);
  }
  return real;
}

function validateCompatibilityArtifactBounds(value, label) {
  let nodes = 0;
  const visit = (current, depth) => {
    if (depth > COMPATIBILITY_ARTIFACT_MAX_DEPTH) {
      throw new Error(`${label} exceeds the maximum depth of ${COMPATIBILITY_ARTIFACT_MAX_DEPTH}`);
    }
    nodes += 1;
    if (nodes > COMPATIBILITY_ARTIFACT_MAX_NODES) {
      throw new Error(`${label} exceeds the maximum node count of ${COMPATIBILITY_ARTIFACT_MAX_NODES}`);
    }
    if (typeof current === 'string') {
      if (current.length > COMPATIBILITY_ARTIFACT_MAX_STRING_LENGTH) {
        throw new Error(`${label} strings must be at most ${COMPATIBILITY_ARTIFACT_MAX_STRING_LENGTH} characters`);
      }
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > COMPATIBILITY_ARTIFACT_MAX_VECTORS) {
        throw new Error(`${label} arrays must contain at most ${COMPATIBILITY_ARTIFACT_MAX_VECTORS} items`);
      }
      current.forEach(item => visit(item, depth + 1));
      return;
    }
    if (!current || typeof current !== 'object') return;
    const entries = Object.entries(current);
    if (entries.length > COMPATIBILITY_ARTIFACT_MAX_OBJECT_KEYS) {
      throw new Error(`${label} objects must contain at most ${COMPATIBILITY_ARTIFACT_MAX_OBJECT_KEYS} keys`);
    }
    for (const [key, child] of entries) {
      if (key.length > COMPATIBILITY_ARTIFACT_MAX_STRING_LENGTH) {
        throw new Error(`${label} keys must be at most ${COMPATIBILITY_ARTIFACT_MAX_STRING_LENGTH} characters`);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

const compatibilityArtifactVectorSchema = z.object({
  id: kebab('Compatibility vector id'),
  opportunityId: kebab('Compatibility vector opportunity id'),
  expectedHash: z.string().refine(value => HEX_SHA256.test(value), {
    message: 'Compatibility expected hash must be a 64-character hex hash',
  }),
}).strict();

const compatibilityArtifactSchema = z.object({
  version: z.literal(COMPATIBILITY_ARTIFACT_VERSION),
  canonicalContract: nonEmptyString('Compatibility canonical contract').refine(value =>
    SUPPORTED_COMPATIBILITY_CONTRACTS.has(value), {
      message: `Compatibility canonical contract must be one of ${[...SUPPORTED_COMPATIBILITY_CONTRACTS].join(', ')}`,
    }),
  project: kebab('Compatibility project'),
  vectors: z.array(compatibilityArtifactVectorSchema)
    .min(1, 'Compatibility vectors must include at least one vector')
    .max(COMPATIBILITY_ARTIFACT_MAX_VECTORS,
      `Compatibility vectors must include at most ${COMPATIBILITY_ARTIFACT_MAX_VECTORS} vectors`),
}).strict().superRefine((value, ctx) => {
  uniqueKeys(value.vectors, item => item.id, 'Compatibility vectors', ctx);
  uniqueKeys(value.vectors, item => item.opportunityId, 'Compatibility vector opportunities', ctx);
});

function loadCompatibilityArtifact(root, entry) {
  const definition = compatibilityArtifactDefinition(entry);
  const file = resolveContainedPath(root, entry.path, `${entry.id} compatibility artifact`, {
    expectFile: true,
  });
  const raw = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > COMPATIBILITY_ARTIFACT_MAX_BYTES) {
    throw new Error(`${entry.id} compatibility artifact must be at most ${COMPATIBILITY_ARTIFACT_MAX_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${entry.id} compatibility artifact JSON is invalid: ${error.message}`);
  }
  validateCompatibilityArtifactBounds(parsed, `${entry.id} compatibility artifact`);
  let artifact;
  try {
    artifact = compatibilityArtifactSchema.parse(parsed);
  } catch (error) {
    throw new Error(formatZod(error));
  }
  if (artifact.canonicalContract !== definition.canonicalContract) {
    throw new Error(`${entry.id} compatibility artifact must declare canonicalContract ${definition.canonicalContract}`);
  }
  return {
    artifact,
    definition,
    file,
  };
}

function computeCompatibilityHash(root, artifact, vector) {
  if (artifact.canonicalContract !== 'team-pipeline/pipeline-contract-hash@v1') {
    throw new Error(`Unsupported compatibility contract: ${artifact.canonicalContract}`);
  }
  const policy = parseRawOpportunityPolicy(root);
  if (policy?.project !== artifact.project) {
    throw new Error(`Compatibility project ${artifact.project} does not match checked-out opportunity policy ${policy?.project ?? 'unknown'}`);
  }
  const registry = validateToolRegistry(
    readContainedJson(root, CONVENTIONAL_TOOL_REGISTRY_PATH, 'Compatibility tool registry'),
    artifact.project,
  );
  const opportunity = policy.opportunities?.find(item => item?.id === vector.opportunityId);
  if (!opportunity) {
    throw new Error(`Compatibility opportunity does not exist: ${vector.opportunityId}`);
  }
  return pipelineContractHash(artifact.project, opportunity, registry, null);
}

export function runCompatibilityCheck(item, entry, options = {}) {
  const label = `${item.id}/${entry.id}`;
  const { artifact, file } = loadCompatibilityArtifact(item.root, entry);
  const vectors = artifact.vectors.map(vector => {
    const canonicalHash = computeCompatibilityHash(item.root, artifact, vector);
    if (canonicalHash !== vector.expectedHash) {
      throw new Error(
        `${label}/${vector.id} expected hash ${vector.expectedHash} did not match canonical pipeline hash ${canonicalHash}`,
      );
    }
    return {
      id: vector.id,
      opportunityId: vector.opportunityId,
      expectedHash: vector.expectedHash,
      canonicalHash,
    };
  });
  return {
    artifact: normalizedRelative(fs.realpathSync(item.root), file),
    canonicalContract: artifact.canonicalContract,
    vectors,
  };
}
