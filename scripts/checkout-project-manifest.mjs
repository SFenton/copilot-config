#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

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
  assert(typeof item.ref === 'string' && /^[a-f0-9]{40}$/i.test(item.ref),
    'Manifest case ref must be an exact 40-character commit SHA');
  const relative = relativePath(item.path, 'Manifest case path');
  const root = path.resolve(workspace, relative);
  assert(!fs.existsSync(root), `Manifest case path already exists: ${relative}`);
  fs.mkdirSync(root, { recursive: true });
  run('git', ['init', '-q'], { cwd: root });
  try {
    run('git', ['fetch', '--quiet', checkoutRepositoryUrl(item.repository, token), item.ref], {
      cwd: root,
    });
  } catch {
    throw new Error(`Failed to fetch exact ref ${item.ref} from ${item.repository}`);
  }
  try {
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
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
  assert(Array.isArray(manifest.cases) && manifest.cases.length > 0,
    'Manifest cases array is required');
  return {
    ...manifest,
    cases: manifest.cases.map(item => cloneCase(workspace, item, token, run)),
  };
}

export function main(argv = process.argv.slice(2), options = {}) {
  const [inputFile, fallbackOutputFile] = argv;
  const outputFile = fallbackOutputFile ?? inputFile;
  assert(inputFile, 'Usage: checkout-project-manifest.mjs INPUT.json [OUTPUT.json]');
  const manifest = json(inputFile);
  const resolved = resolveManifest(
    manifest,
    options.workspace ?? process.cwd(),
    options.token ?? process.env.CROSS_REPO_READ_TOKEN,
    options.run ?? execFileSync,
  );
  fs.writeFileSync(outputFile, `${JSON.stringify(resolved, null, 2)}\n`);
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
