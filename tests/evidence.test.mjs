import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { taskPlan, delegationDecision } from '../skills/budget-workflow/scripts/evidence/modes.mjs';
import { RepositoryEvidence, sourceUnits } from '../skills/budget-workflow/scripts/evidence/repository.mjs';
import { approvedUrl, publicAddress, extractDocument, WebEvidence } from '../skills/budget-workflow/scripts/evidence/web.mjs';
import { EvidenceBroker, validateConfig } from '../skills/budget-workflow/scripts/evidence/broker.mjs';
import { evidenceSchemas } from '../skills/budget-workflow/scripts/evidence/schemas.mjs';
import { observedWebEvidence } from '../evals/mode-study.mjs';
import { webSourceId } from '../skills/budget-workflow/scripts/evidence/web.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  fs.writeFileSync(path.join(repo, 'src/guard.ts'), `// café
export function guarded(value: number) {
  if (value < 0) return false;

  return value > 2;
}
export const double = (value: number) => value * 2;
`);
  fs.writeFileSync(path.join(repo, '.env.development'), 'NOT_A_REAL_TOKEN=fixture');
  const cache = path.join(root, 'cache');
  return { root, repo, cache, policy: { allowPaths: ['src'], denyPaths: [] } };
}

const adapter = {
  evidencePolicy: { always: ['Keep source truth'], phases: { research: ['No live claims'], release: ['Release approval'] } },
};

test('evidence location and research risk are separate; irrelevant phase gates stay out', () => {
  const base = { question: 'Investigate the behavior', phase: 'research', risk: 'low', objective: 'cost' };
  const external = taskPlan({ ...base, mode: 'auto', externalRequired: true, repositoryRelevant: false });
  assert.equal(external.mode, 'external');
  assert.equal(external.model, 'gpt-5.6-sol');
  assert.equal(external.effort, 'high');
  assert.equal(external.context, 'default');
  assert.deepEqual(external.rules, []);
  const hybrid = taskPlan({ ...base, mode: 'auto', externalRequired: true, repositoryRelevant: true }, adapter);
  assert.equal(hybrid.contractRequired, true);
  assert.deepEqual(hybrid.rules, ['Keep source truth', 'No live claims']);
  assert.ok(!hybrid.rules.includes('Release approval'));
  const repo = taskPlan({ ...base, mode: 'repository', risk: 'high' }, adapter);
  assert.equal(repo.model, 'gpt-6-astra');
  assert.equal(repo.effort, 'high');
  assert.equal(repo.automaticWorker, false);
  assert.equal(taskPlan({ ...base, mode: 'auto' }).status, 'needs-scope-probe');
  assert.equal(taskPlan({ ...base, mode: 'external', novel: true }).effort, 'high');
  assert.equal(taskPlan({ ...base, mode: 'repository', question: 'Investigate lock behavior' },
    { ...adapter, riskTerms: ['lock'] }).model, 'gpt-6-astra');
});

test('delegation requires qualified all-leg savings, not just a cheap worker rate', () => {
  assert.equal(delegationDecision({ qualityEligible: false }).delegate, false);
  assert.equal(delegationDecision({ qualityEligible: true, direct: 10 }).delegate, false);
  assert.equal(delegationDecision({ qualityEligible: true, direct: 10, preparation: 1, worker: 1,
    handoff: 1, owner: 4, review: 1, retry: 2 }).delegate, false);
  assert.equal(delegationDecision({ qualityEligible: true, direct: 10, preparation: 0, worker: 1,
    handoff: 0, owner: 4, review: 1, retry: 0 }).delegate, true);
});

test('syntax units preserve early guards, exports, decorators and Unicode', async () => {
  const ts = await sourceUnits('// café\nexport function f(x:number) {\n if(x<0)return false;\n return true;\n}\n', '.ts');
  assert.equal(ts.parsed, true);
  assert.equal(ts.units[0].start, 2);
  assert.equal(ts.units[0].end, 5);
  const py = await sourceUnits('@property\ndef thing(self):\n    return 1\n', '.py');
  assert.equal(py.units[0].start, 1);
  const cs = await sourceUnits('public class X { public int[] F() => [1, 2]; }', '.cs');
  assert.equal(cs.parsed, true);
  const php = await sourceUnits('<?php function f(mixed $x): ?int { return null; }', '.php');
  assert.equal(php.parsed, true);
  assert.equal((await sourceUnits('export function broken(', '.ts')).parsed, false);
  const assignment = await sourceUnits('SCHEMA = {\n "key": 1,\n}\n\ndef f():\n return SCHEMA\n', '.py');
  assert.ok(assignment.units.some(unit => unit.name === 'SCHEMA' && unit.start === 1 && unit.end === 3));
  const heredoc = await sourceUnits('<?php\nfunction query() {\n $sql = <<<SQL\nSELECT 1\nSQL;\n return $sql;\n}\n', '.php');
  assert.equal(heredoc.parsed, true);
  assert.equal(heredoc.units[0].name, 'query');
});

test('declarations outrank call sites for a named symbol', async t => {
  const { repo, cache, policy } = fixture(t);
  fs.writeFileSync(path.join(repo, 'src/a-caller.py'), 'def caller():\n return target_symbol()\n');
  fs.writeFileSync(path.join(repo, 'src/z-owner.py'), 'def target_symbol():\n return 1\n');
  const found = await new RepositoryEvidence(repo, policy, cache).discover('target_symbol');
  assert.equal(found.results[0].path, 'src/z-owner.py');
});

test('repository discovery sees the allowed full tree, returns complete units, and detects dirty changes', async t => {
  const { repo, cache, policy } = fixture(t);
  const source = new RepositoryEvidence(repo, policy, cache);
  const found = await source.discover('guarded');
  assert.equal(found.searchedFiles, 1);
  assert.equal(found.results[0].path, 'src/guard.ts');
  const id = found.results[0].units[0]?.id ?? found.results[0].id;
  const unit = source.read(id);
  assert.equal(unit.completeUnit, true);
  assert.match(unit.content, /if \(value < 0\) return false/);
  assert.match(unit.content, /return value > 2/);
  fs.appendFileSync(path.join(repo, 'src/guard.ts'), '\n// changed');
  assert.throws(() => source.read(id), /Source changed/);
  const changed = await source.discover('guarded');
  assert.notEqual(changed.results[0].id, found.results[0].id);
});

test('symlink escapes are rejected before repository content search', async t => {
  const { root, repo, cache, policy } = fixture(t);
  const outside = path.join(root, 'outside.ts');
  fs.writeFileSync(outside, 'secret fixture');
  fs.symlinkSync(outside, path.join(repo, 'src/escape.ts'));
  await assert.rejects(new RepositoryEvidence(repo, policy, cache).discover('secret'), /escapes repository/);
});

test('public URL and IP policy reject local, credential and private-network paths', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(publicAddress(ip), false, ip);
  }
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(approvedUrl('https://example.org/a#b', ['example.org']).href, 'https://example.org/a');
  for (const url of ['http://example.org/', 'https://user:pass@example.org/', 'https://127.0.0.1/',
    'https://example.org/?api_key=fixture', 'https://example.org:444/', 'https://evil.org/']) {
    assert.throws(() => approvedUrl(url, ['example.org', '127.0.0.1']));
  }
});

test('HTML extraction is inert and preserves useful content and source links', () => {
  const result = extractDocument('<html><head><title>Docs</title></head><body><nav>Noise</nav><main><h1>Isolation</h1><p>One writer at a time.</p><script>evil()</script><a href="/wal">WAL details</a></main></body></html>', 'https://example.org/');
  assert.ok(result.paragraphs.includes('One writer at a time.'));
  assert.ok(!result.paragraphs.join(' ').includes('evil'));
  assert.ok(!result.paragraphs.join(' ').includes('Noise'));
  assert.equal(result.links[0].url, 'https://example.org/wal');
});

test('web cache tracks freshness, revalidates 304, and never silently returns stale content after error', async t => {
  const { cache } = fixture(t);
  let calls = 0;
  let response = { status: 200, url: 'https://example.org/', headers: { 'content-type': 'text/html', etag: '"v1"' },
    body: '<main><h1>Test</h1><p>Verified fact.</p></main>' };
  const fetcher = async () => { calls++; return response; };
  const config = { allowedHosts: ['example.org'], persistTextHosts: ['example.org'], maxAgeSeconds: 3600,
    seeds: [{ url: 'https://example.org/' }], queries: {} };
  const web = new WebEvidence(config, cache, fetcher);
  const id = (await web.discover('seeds')).results[0].id;
  const first = await web.read(id);
  assert.equal(first.status, 'ok');
  assert.equal(calls, 1);
  assert.equal((await web.read(id)).cacheHit, true);
  assert.equal(calls, 1);
  response = { status: 304, headers: {}, body: '', url: 'https://example.org/' };
  assert.equal((await web.read(id, { refresh: true })).sha256, first.sha256);
  response = { status: 503, headers: {}, body: '', url: 'https://example.org/' };
  await assert.rejects(web.read(id, { refresh: true }), /not silently substituted/);
});

test('hybrid requires opened repo evidence; private query text cannot leave through web discovery', async t => {
  const { root, repo, cache, policy } = fixture(t);
  let externalCalls = 0;
  const broker = new EvidenceBroker({ mode: 'hybrid', repoRoot: repo, repoPolicy: policy, cacheDir: cache,
    stateFile: path.join(root, 'state.json'), web: { allowedHosts: ['example.org'], seeds: [{ url: 'https://example.org/' }], queries: {} } },
  { fetcher: async () => { externalCalls++; throw new Error('not requested'); } });
  await assert.rejects(broker.find({ scope: 'external', queryId: 'seeds' }), /requires.*contract/);
  const found = await broker.find({ scope: 'repository', query: 'guarded' });
  const id = found.results[0].units[0]?.id ?? found.results[0].id;
  await broker.open({ id });
  await broker.contract({ sourceIds: [id], constraints: ['Guarded local function'], gaps: ['Need public contract'] });
  assert.equal((await broker.find({ scope: 'external', queryId: 'seeds' })).results.length, 1);
  await assert.rejects(broker.find({ scope: 'external', query: 'PRIVATE SOURCE', queryId: 'seeds' }), /Raw web query/);
  assert.equal(externalCalls, 0);
  assert.equal((await broker.open({ id })).status, 'already-supplied');
});

test('external-only mode cannot receive a repo and operation budgets persist', async t => {
  const { root, repo, cache } = fixture(t);
  const config = { mode: 'external', cacheDir: cache, stateFile: path.join(root, 'state.json'),
    maxOperations: 1, web: { allowedHosts: ['example.org'], seeds: [], queries: {} } };
  assert.throws(() => validateConfig({ ...config, repoRoot: repo }), /must not receive/);
  const broker = new EvidenceBroker(config);
  await broker.find({ scope: 'external', queryId: 'seeds' });
  await assert.rejects(broker.find({ scope: 'external', queryId: 'seeds' }), /budget exhausted/);
  const restarted = new EvidenceBroker(config);
  assert.equal(restarted.state.exhausted, true);
  await assert.rejects(restarted.find({ scope: 'external', queryId: 'seeds' }), /budget exhausted/);
});

test('mode schemas omit irrelevant fields rather than inviting empty arguments', () => {
  assert.equal(evidenceSchemas('external').find.query, undefined);
  assert.equal(evidenceSchemas('external').open.path, undefined);
  assert.equal(evidenceSchemas('external').open.start, undefined);
  assert.equal(evidenceSchemas('repository').find.queryId, undefined);
  assert.ok(evidenceSchemas('hybrid').open.path);
});

test('hybrid orientation reserves web headroom and restores handles across owner CLI calls', async t => {
  const { root, repo, cache, policy } = fixture(t);
  const config = { mode: 'hybrid', repoRoot: repo, repoPolicy: policy, cacheDir: cache,
    stateFile: path.join(root, 'state.json'), maxOperations: 24,
    web: { allowedHosts: ['example.org'], seeds: [{ url: 'https://example.org/' }], queries: {} } };
  const dependencies = { fetcher: async () => ({ status: 200, url: 'https://example.org/',
    headers: { 'content-type': 'text/html' }, body: '<main><p>Public contract.</p></main>' }) };
  const broker = new EvidenceBroker(config, dependencies);
  const source = await broker.open({ id: ' ', path: 'src/guard.ts', symbol: 'guarded' });
  assert.equal(source.status, 'ok');
  assert.match(source.content, /value < 0/);
  for (let n = 1; n < 8; n++) await broker.find({ scope: 'repository', query: 'guarded' });
  const restored = new EvidenceBroker(config, dependencies);
  await assert.rejects(restored.open({ id: source.id }), /orientation allowance/);
  await restored.contract({ sourceIds: [source.id], constraints: ['Guard exists'], gaps: ['Public semantics'] });
  await assert.rejects(restored.find({ scope: 'external', query: 'private text' }), /Raw web query/);
  const urls = await restored.find({ scope: 'external', query: ' ', queryId: 'seeds' });
  const document = await restored.open({ id: urls.results[0].id, path: '', symbol: '' });
  assert.equal(document.status, 'ok');
  assert.equal(restored.state.webReads, 1);
  assert.equal((await restored.open({ id: source.id, reopen: true })).status, 'ok');
});

test('grading binds retained web excerpts to source versions instead of refetching mutable pages', () => {
  const sha256 = 'a'.repeat(64);
  const url = 'https://example.org/';
  const id = webSourceId(url, sha256);
  const paragraph = { id: `${id}:p1`, text: 'The observed fact.' };
  const sources = { [id]: { kind: 'external', url, sha256, paragraphIds: [paragraph.id] } };
  const event = result => ({ type: 'tool.execution_complete', data: { success: true,
    result: { content: JSON.stringify(result) } } });
  const result = { status: 'ok', id, url, sha256, paragraphs: [paragraph] };
  assert.equal(observedWebEvidence([event(result)], sources).get(id).paragraphs.get(paragraph.id), paragraph.text);
  assert.throws(() => observedWebEvidence([event({ ...result, sha256: 'b'.repeat(64) })], sources), /binding mismatch/);
  assert.throws(() => observedWebEvidence([event({ ...result, paragraphs: [{ ...paragraph, id: 'wrong' }] })], sources), /Unregistered/);
  const truncated = event(result);
  truncated.data.result.detailedContent = truncated.data.result.content;
  truncated.data.result.content = 'Output too large; preview only';
  assert.equal(observedWebEvidence([truncated], sources).get(id).transportTruncated, true);
});

test('lean web output bounds serialized bytes including paragraph IDs', async t => {
  const { cache } = fixture(t);
  const web = new WebEvidence({ allowedHosts: ['example.org'], seeds: [], queries: {} }, cache,
    async () => ({ status: 200, url: 'https://example.org/', headers: { 'content-type': 'text/html' },
      body: `<main>${Array.from({ length: 500 }, (_, i) => `<p>Paragraph ${i}</p>`).join('')}</main>` }));
  const result = await web.read(web.locator('https://example.org/', 'Example').id);
  assert.equal(result.status, 'ok');
  assert.equal(result.selectionOnly, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 14000);
});
