import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { EvidenceBroker } from '../evidence/broker.mjs';
import { createEvidencePacket } from '../evidence/research.mjs';
import { runHistoryQuery } from '../evidence/history.mjs';
import { sha256 } from '../evidence/schemas.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function initRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
}

function makeAdapterRepo(root) {
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.mkdirSync(path.join(root, 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'copilot-instructions.md'), '# test\n');
  fs.writeFileSync(path.join(root, 'api', 'example.ts'), 'export function validateKey() { return true; }\n');
  writeJson(path.join(root, '.github', 'agent-budget.json'), {
    version: 1,
    project: 'test-project',
    instructions: ['.github/copilot-instructions.md'],
    riskTerms: ['risk'],
    gates: ['gate'],
    evidencePolicy: {
      always: [],
      phases: { research: [] },
      content: {
        allowPaths: ['api'],
        denyPaths: [],
        maxFileBytes: 100000,
      },
    },
  });
  initRepo(root);
}

function fakeFetcher(url) {
  return Promise.resolve({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: `<html><head><title>${url}</title></head><body><main><p>Authoritative paragraph about validator behavior.</p></main></body></html>`,
    url,
  });
}

test('repository, external, hybrid, and history flows produce packet-first deterministic outputs', async () => {
  const repo = makeTempDir('research-repo-');
  makeAdapterRepo(repo);

  const repositorySession = makeTempDir('research-session-');
  const repositoryBroker = new EvidenceBroker({
    mode: 'repository',
    repoRoot: repo,
    repoPolicy: {
      allowPaths: ['api'],
      denyPaths: [],
      maxFileBytes: 100000,
    },
    cacheDir: makeTempDir('research-cache-'),
    stateFile: path.join(repositorySession, 'broker-state.json'),
    maxOperations: 10,
    maxReturnedCharacters: 50000,
  });
  writeJson(path.join(repositorySession, 'broker-config.json'), repositoryBroker.config);
  const repositoryOpen = await repositoryBroker.open({ path: 'api/example.ts', maxCharacters: 2000 });
  assert.equal(repositoryOpen.status, 'ok');
  const repositoryPacket = createEvidencePacket({
    workflowId: 'workflow-1',
    promptHash: sha256('prompt-1'),
    question: 'How does validateKey work?',
    mode: 'repository',
    risk: 'low',
    objective: 'cost',
    scope: ['api'],
    baseRevision: 'abc123',
  }, repo, repositorySession);
  assert.equal(repositoryPacket.packet.mode, 'repository');

  const externalSession = makeTempDir('external-session-');
  const externalBroker = new EvidenceBroker({
    mode: 'external',
    cacheDir: makeTempDir('external-cache-'),
    stateFile: path.join(externalSession, 'broker-state.json'),
    web: {
      allowedHosts: ['example.com'],
      persistTextHosts: ['example.com'],
      maxAgeSeconds: 86400,
      seeds: [{ url: 'https://example.com/docs', title: 'Docs' }],
      queries: {},
    },
    maxOperations: 10,
    maxReturnedCharacters: 50000,
  }, { fetcher: fakeFetcher });
  writeJson(path.join(externalSession, 'broker-config.json'), externalBroker.config);
  const discovered = await externalBroker.find({ scope: 'external', queryId: 'seeds' });
  const externalOpen = await externalBroker.open({ id: discovered.results[0].id, maxCharacters: 2000 });
  assert.equal(externalOpen.status, 'ok');
  const externalPacket = createEvidencePacket({
    workflowId: 'workflow-2',
    promptHash: sha256('prompt-2'),
    question: 'What does the public documentation say?',
    mode: 'external',
    risk: 'low',
    objective: 'cost',
    scope: ['docs'],
  }, null, externalSession);
  assert.equal(externalPacket.packet.mode, 'external');

  const hybridSession = makeTempDir('hybrid-session-');
  const hybridBroker = new EvidenceBroker({
    mode: 'hybrid',
    repoRoot: repo,
    repoPolicy: {
      allowPaths: ['api'],
      denyPaths: [],
      maxFileBytes: 100000,
    },
    cacheDir: makeTempDir('hybrid-cache-'),
    stateFile: path.join(hybridSession, 'broker-state.json'),
    web: {
      allowedHosts: ['example.com'],
      persistTextHosts: ['example.com'],
      maxAgeSeconds: 86400,
      seeds: [{ url: 'https://example.com/docs', title: 'Docs' }],
      queries: {},
    },
    maxOperations: 12,
    maxReturnedCharacters: 50000,
  }, { fetcher: fakeFetcher });
  writeJson(path.join(hybridSession, 'broker-config.json'), hybridBroker.config);
  const hybridRepoOpen = await hybridBroker.open({ path: 'api/example.ts', maxCharacters: 2000 });
  assert.equal(hybridRepoOpen.status, 'ok');
  await hybridBroker.contract({
    sourceIds: [hybridRepoOpen.id],
    constraints: ['Reuse validateKey'],
    gaps: ['Public validator semantics'],
  });
  const hybridSeeds = await hybridBroker.find({ scope: 'external', queryId: 'seeds' });
  const hybridExternal = await hybridBroker.open({ id: hybridSeeds.results[0].id, maxCharacters: 2000 });
  assert.equal(hybridExternal.status, 'ok');
  const hybridPacket = createEvidencePacket({
    workflowId: 'workflow-3',
    promptHash: sha256('prompt-3'),
    question: 'How should local and public validator behavior align?',
    mode: 'hybrid',
    risk: 'medium',
    objective: 'cost',
    scope: ['api', 'docs'],
    baseRevision: 'abc123',
  }, repo, hybridSession);
  assert.equal(hybridPacket.packet.mode, 'hybrid');

  const historyResult = await runHistoryQuery({
    workflowId: 'workflow-4',
    promptHash: sha256('prompt-4'),
    question: 'Did I already solve this?',
    templateId: 'recent-sessions',
    source: 'cloud',
  }, async () => [{
    session_id: 'session-1',
    repository: 'github.com/example/repo',
    branch: 'main',
    summary: 'Earlier validator investigation',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }]);
  assert.equal(historyResult.packet.mode, 'history');
});
