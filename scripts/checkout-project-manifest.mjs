#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  instructionContractCheck,
  loadProjectManifest,
  parseProjectManifest,
} from './project-manifest.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const AUXILIARY_REF_FIELDS = Object.freeze([
  'baselineRef',
  'migrationRef',
])

export function relativePath(value, label) {
  assert(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value),
    `${label} must be a non-empty relative path`);
  const normalized = value.replace(/\\/g, '/');
  assert(!normalized.split('/').includes('..'),
    `${label} must stay inside the workspace`);
  return value;
}

export function checkoutRepositoryUrl(repository, token) {
  assert(typeof repository === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
  'Manifest case repository must be owner/name');
  if (token === undefined || token === null || token === '') {
    return `https://github.com/${repository}.git`;
  }
  assert(typeof token === 'string', 'CROSS_REPO_READ_TOKEN must be a string when provided');
  const url = new URL(`https://github.com/${repository}.git`);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

function exactRef(value, label) {
  assert(typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value),
    `${label} must be an exact 40-character commit SHA`);
  return value;
}

function manifestRefs(item) {
  const refs = [exactRef(item.ref, 'Manifest case ref')]
  const instruction = instructionContractCheck(item)
  for (const field of AUXILIARY_REF_FIELDS) {
    const value = instruction?.[field]
    if (value === undefined) continue
    refs.push(exactRef(value, `Manifest case instruction contract ${field}`))
  }
  return [...new Set(refs)]
}

export function cloneCase(workspace, item, token, run = execFileSync) {
  if (typeof item.root === 'string' && item.root.length > 0 &&
    item.repository === undefined && item.ref === undefined && item.path === undefined) {
    return {
      ...item,
      root: fs.realpathSync(item.root),
    };
  }
  assert(typeof item.repository === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repository),
  'Manifest case repository must be owner/name');
  const refs = manifestRefs(item);
  const relative = relativePath(item.path, 'Manifest case path');
  const root = path.resolve(workspace, relative);
  assert(!fs.existsSync(root), `Manifest case path already exists: ${relative}`);
  fs.mkdirSync(root, { recursive: true });
  run('git', ['init', '-q'], { cwd: root });
  const fetchUrl = checkoutRepositoryUrl(item.repository, token);
  try {
    for (const ref of refs) {
      run('git', ['fetch', '--quiet', fetchUrl, ref], { cwd: root });
    }
  } catch {
    throw new Error(`Failed to fetch exact ref ${item.ref} from ${item.repository}`);
  }
  try {
    run('git', ['checkout', '--quiet', '--detach', item.ref], { cwd: root });
  } catch {
    throw new Error(`Failed to check out fetched ref ${item.ref} for ${item.repository}`);
  }
  return {
    ...item,
    root,
  };
}

export function resolveManifest(manifest, workspace = process.cwd(),
  token = process.env.CROSS_REPO_READ_TOKEN, run = execFileSync) {
  const validated = parseProjectManifest(manifest)
  return {
    ...validated,
    cases: validated.cases.map(item => cloneCase(workspace, item, token, run)),
  }
}

export function validateCheckoutManifest(manifest) {
  const validated = parseProjectManifest(manifest)
  for (const item of validated.cases) {
    if (item.repository === undefined) continue
    checkoutRepositoryUrl(item.repository)
    relativePath(item.path, 'Manifest case path')
    manifestRefs(item)
  }
  return validated
}

export function main(argv = process.argv.slice(2), options = {}) {
  const [firstArg, secondArg, thirdArg] = argv
  const validating = firstArg === 'validate'
  const inputFile = validating ? secondArg : firstArg
  const outputFile = validating ? thirdArg ?? null : secondArg ?? inputFile
  assert(inputFile,
    'Usage: checkout-project-manifest.mjs validate INPUT.json | INPUT.json [OUTPUT.json]')
  const manifest = loadProjectManifest(inputFile, { validateRoots: false })
  if (validating) return validateCheckoutManifest(manifest)
  const resolved = resolveManifest(
    manifest,
    options.workspace ?? process.cwd(),
    options.token ?? process.env.CROSS_REPO_READ_TOKEN,
    options.run ?? execFileSync,
  )
  fs.writeFileSync(outputFile, `${JSON.stringify(resolved, null, 2)}\n`)
}

const isMain = process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
