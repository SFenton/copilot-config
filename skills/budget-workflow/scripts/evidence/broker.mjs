import fs from 'node:fs';
import path from 'node:path';
import { RepositoryEvidence, atomicJson, digest } from './repository.mjs';
import { WebEvidence, approvedUrl } from './web.mjs';
import { MODES } from './modes.mjs';

export function validateConfig(config) {
  if (!MODES.includes(config.mode)) throw new Error('Invalid evidence mode');
  if (config.presentation && !['lean', 'raw'].includes(config.presentation)) throw new Error('Unknown evidence presentation');
  if (!config.cacheDir || !path.isAbsolute(config.cacheDir) || !config.stateFile || !path.isAbsolute(config.stateFile)) throw new Error('Absolute cache/state locations required');
  if (config.mode === 'external' && config.repoRoot) throw new Error('External-only mode must not receive a repository root');
  if (config.mode !== 'external' && (!config.repoRoot || !path.isAbsolute(config.repoRoot))) throw new Error('Repository root required');
  if (config.repoRoot) {
    for (const target of [config.cacheDir, config.stateFile]) {
      const relative = path.relative(path.resolve(config.repoRoot), path.resolve(target));
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('Evidence cache/state must be outside the indexed repository');
      }
    }
  }
  if (config.mode !== 'repository') {
    if (!Array.isArray(config.web?.allowedHosts) || !config.web.allowedHosts.length) throw new Error('Explicit public-source hosts required');
    for (const seed of config.web.seeds ?? []) approvedUrl(seed.url, config.web.allowedHosts);
    for (const [id, query] of Object.entries(config.web.queries ?? {})) {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || !['github', 'crossref'].includes(query.provider) ||
        typeof query.text !== 'string' || query.text.length < 2 || query.text.length > 200) throw new Error('Invalid approved public query');
    }
    if ((config.web.persistTextHosts ?? []).some(host => !config.web.allowedHosts.includes(host))) throw new Error('Text-retention hosts must also be approved source hosts');
    if (!Number.isFinite(config.web.maxAgeSeconds ?? 86400) || (config.web.maxAgeSeconds ?? 86400) < 0) throw new Error('Invalid freshness policy');
  }
  if (!Number.isInteger(config.maxOperations ?? 24) || (config.maxOperations ?? 24) < 1 || (config.maxOperations ?? 24) > 80) throw new Error('Operation budget must be 1-80');
  if (!Number.isInteger(config.maxReturnedCharacters ?? 200000) ||
    (config.maxReturnedCharacters ?? 200000) < 1000 || (config.maxReturnedCharacters ?? 200000) > 1000000) throw new Error('Invalid evidence return budget');
  return config;
}

export class EvidenceBroker {
  constructor(config, dependencies = {}) {
    this.config = validateConfig(config);
    this.configHash = digest(JSON.stringify(config));
    this.repo = config.mode === 'external' ? null : new RepositoryEvidence(config.repoRoot, config.repoPolicy, config.cacheDir);
    this.web = config.mode === 'repository' ? null : new WebEvidence({ ...config.web, presentation: config.presentation }, config.cacheDir, dependencies.fetcher);
    this.state = { version: 2, configHash: this.configHash, operations: 0, returnedCharacters: 0,
      errors: [], events: [], repositoryReads: 0, webReads: 0, contract: null, sources: {}, delivered: {},
      deliveredParagraphs: {}, catalog: {}, openedEvidence: {}, orientationOperations: 0 };
    if (fs.existsSync(config.stateFile)) {
      const previous = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
      if (previous.configHash !== this.configHash) throw new Error('Evidence session config changed');
      this.state = previous;
      this.state.delivered ??= {};
      this.state.deliveredParagraphs ??= {};
      this.state.catalog ??= {};
      this.state.openedEvidence ??= {};
      this.state.orientationOperations ??= previous.events.filter(event =>
        event.scope === 'repository' || event.sourceId?.startsWith('r_')).length;
      if (this.web && previous.webStats) this.web.stats = previous.webStats;
      for (const record of Object.values(this.state.catalog)) {
        if (record.id.startsWith('r_') && this.repo) this.repo.records.set(record.id, record);
        if (!record.id.startsWith('r_') && this.web) this.web.records.set(record.id, record);
      }
    }
    this.flush();
  }

  flush() {
    this.state.webStats = this.web?.stats ?? null;
    for (const record of this.repo?.records.values() ?? []) this.state.catalog[record.id] = record;
    for (const record of this.web?.records.values() ?? []) this.state.catalog[record.id] = {
      id: record.id, kind: 'locator', url: record.url, title: record.title,
      expectedSha: record.document?.sha256 ?? record.expectedSha,
    };
    atomicJson(this.config.stateFile, this.state);
  }

  async operation(name, data, action, commit) {
    if (this.state.operations >= (this.config.maxOperations ?? 24)) {
      this.state.exhausted = true;
      this.flush();
      throw new Error('Evidence operation budget exhausted; finalize with remaining gaps instead of retrying');
    }
    this.state.operations++;
    const started = Date.now();
    try {
      let result = await action();
      if (this.config.presentation !== 'raw' && Buffer.byteLength(JSON.stringify(result)) > 15000) {
        result = { status: 'needs-smaller-result', id: result.id,
          instruction: 'Result exceeds the safe CLI transport envelope and was not delivered or marked read. Narrow query/limit, use a syntax unit, or request fewer characters (e.g. 4000).',
          sourceCount: result.results?.length };
      }
      result.budget = { remainingOperations: (this.config.maxOperations ?? 24) - this.state.operations };
      if (this.config.mode === 'hybrid' && !this.state.webReads && this.config.presentation !== 'raw') {
        result.budget.orientationRemaining = Math.max(0, this.orientationLimit() - this.state.orientationOperations);
        result.budget.next = this.state.contract ? 'Open authoritative external gap evidence before further local investigation.' :
          'Open decisive local evidence, then record its contract; do not audit the whole repository.';
      }
      const size = JSON.stringify(result).length;
      if (this.state.returnedCharacters + size > (this.config.maxReturnedCharacters ?? 200000)) {
        throw new Error('Evidence return budget exhausted; no oversized result is delivered');
      }
      this.state.returnedCharacters += size;
      if (commit) commit(result);
      this.state.events.push({ operation: name, scope: data.scope, sourceId: data.id, queryId: data.queryId,
        query: data.scope === 'repository' ? data.query : undefined, characters: size, elapsedMs: Date.now() - started });
      this.flush();
      return result;
    } catch (error) {
      this.state.errors.push({ operation: name, message: error.message, elapsedMs: Date.now() - started });
      this.flush();
      throw error;
    }
  }

  find(data) {
    data = normalizeOptionals(data);
    return this.operation('find', data, async () => {
      if (data.scope === 'repository') {
        if (!this.repo) throw new Error('Repository access is unavailable in external-only mode');
        this.orient();
        return this.repo.discover(data.query, data.limit ?? 6, this.config.presentation === 'raw');
      }
      if (data.scope !== 'external' || !this.web) throw new Error('External access is unavailable in this mode');
      if (data.query !== undefined) throw new Error('Raw web query text is forbidden; choose a pre-approved queryId');
      if (this.config.mode === 'hybrid' && !this.state.contract) throw new Error('Hybrid mode requires a source-backed repository contract before external discovery');
      this.verifyContract();
      return this.web.discover(data.queryId ?? 'seeds', data.limit ?? 5);
    });
  }

  open(data) {
    data = normalizeOptionals(data);
    const deliveryKey = digest(JSON.stringify({ id: data.id, path: data.path, symbol: data.symbol, focus: data.focus, start: data.start, end: data.end }));
    return this.operation('open', data, async () => {
      if ((typeof data.id === 'string') === (typeof data.path === 'string')) throw new Error('Provide exactly one source ID or repository-relative path');
      if (data.path && !this.repo) throw new Error('Repository paths are unavailable in external-only mode');
      if (data.path || data.id?.startsWith('r_')) this.orient();
      if (data.path) {
        const record = await this.repo.register(data.path, this.config.presentation !== 'raw');
        data = { ...data, id: record.id };
        if (data.symbol) {
          const selected = record.units.findIndex(unit => unit.name === data.symbol);
          if (selected < 0) return { status: 'choose-source-unit', id: record.id, path: record.path,
            units: record.units.slice(0, 25).map((unit, index) => ({ id: `${record.id}/u${index}`, ...unit })) };
          data.id = `${record.id}/u${selected}`;
        }
      }
      let result;
      if (data.id.startsWith('r_')) {
        if (!this.repo) throw new Error('Repository access is unavailable');
        result = this.repo.read(data.id, { ...data, raw: this.config.presentation === 'raw' });
      } else {
        if (!this.web) throw new Error('External access is unavailable');
        if (this.config.mode === 'hybrid' && !this.state.contract) throw new Error('Record repository contract first');
        this.verifyContract();
        result = await this.web.read(data.id, data);
      }

      if (this.config.presentation !== 'raw' && !data.reopen && !data.refresh && result.status === 'ok' &&
        this.state.delivered[deliveryKey] === result.sha256) return {
        status: 'already-supplied', id: result.id, sha256: result.sha256,
        instruction: 'Use the evidence already returned; reopen=true explicitly requests it again.',
      };
      if (this.config.presentation !== 'raw' && !data.reopen && !data.refresh && result.paragraphs) {
        const prior = result.paragraphs.filter(p => this.state.deliveredParagraphs[p.id]).map(p => p.id);
        result = { ...result, paragraphs: result.paragraphs.filter(p => !this.state.deliveredParagraphs[p.id]),
          previouslySuppliedParagraphs: prior };
        if (!result.paragraphs.length && prior.length) result.status = 'already-supplied';
      }
      return result;
    }, result => {
      if (result.status !== 'ok') return;
      this.state.delivered[deliveryKey] = result.sha256;
      if (result.path) {
        this.state.repositoryReads++;
        this.state.sources[result.id] = { kind: 'repository', path: result.path, sha256: result.sha256,
          start: result.start, end: result.end, completeUnit: result.completeUnit };
        this.state.openedEvidence[result.id] = [{
          sourceId: result.id,
          citation: {
            kind: 'repository',
            path: result.path,
            start: result.start,
            end: result.end,
          },
          text: result.content,
          focus: data.symbol ?? null,
        }];
      } else {
        this.state.webReads++;
        for (const paragraph of result.paragraphs) this.state.deliveredParagraphs[paragraph.id] = true;
        const prior = this.state.sources[result.id]?.paragraphIds ?? [];
        this.state.sources[result.id] = { kind: 'external', url: result.url, title: result.title,
          sha256: result.sha256, verifiedAt: result.verifiedAt,
          paragraphIds: [...new Set([...prior, ...result.paragraphs.map(p => p.id)])] };
        this.state.openedEvidence[result.id] = result.paragraphs.map(paragraph => ({
          sourceId: result.id,
          citation: {
            kind: 'external',
            paragraphIds: [paragraph.id],
          },
          text: paragraph.text,
          focus: data.focus ?? null,
        }));
      }
    });
  }

  verifyContract() {
    if (this.config.mode !== 'hybrid' || !this.state.contract) return;
    for (const id of this.state.contract.sourceIds) {
      const record = this.state.sources[id];
      this.repo.read(id, { start: record.start, end: record.end, maxCharacters: 64000 });
    }
  }

  orientationLimit() {
    return Math.min(8, Math.max(1, Math.floor((this.config.maxOperations ?? 24) / 3)));
  }

  orient() {
    if (this.config.mode !== 'hybrid' || this.config.presentation === 'raw' || this.state.webReads) return;
    if (this.state.orientationOperations >= this.orientationLimit()) {
      throw new Error('Hybrid orientation allowance reached. Record a contract from opened sources, then open external gap evidence before returning to repository research. If no defensible contract exists, finalize as incomplete.');
    }
    this.state.orientationOperations++;
  }

  contract(data) {
    return this.operation('contract', data, async () => {
      if (this.config.mode !== 'hybrid' || !this.repo) throw new Error('Contract transition is hybrid-only');
      if (!Array.isArray(data.sourceIds) || !data.sourceIds.length ||
        data.sourceIds.some(id => !this.state.sources[id] || this.state.sources[id].kind !== 'repository')) {
        throw new Error('Contract requires repository evidence actually opened in this session');
      }

      for (const id of data.sourceIds) {
        const record = this.state.sources[id];
        const current = this.repo.records.get(id.split('/')[0]);
        if (!current || current.sha256 !== record.sha256) throw new Error('Contract source is stale');
        this.repo.read(id, { start: record.start, end: record.end, maxCharacters: 64000 });
      }
      if (!Array.isArray(data.constraints) || data.constraints.length > 8 ||
        data.constraints.some(text => typeof text !== 'string' || text.length > 300)) throw new Error('Bounded contract constraints required');
      if (!Array.isArray(data.gaps) || !data.gaps.length || data.gaps.length > 6 ||
        data.gaps.some(text => typeof text !== 'string' || text.length > 240)) throw new Error('Explicit bounded external gaps required');
      return { status: 'contract-recorded', publicQueryIds: [...Object.keys(this.config.web.queries ?? {}), 'seeds'],
        warning: 'Constraints stay local. Only pre-approved public query text is sent externally. Recommendations still need local applicability review.' };
    }, () => {
      this.state.contract = { sourceIds: data.sourceIds, constraints: data.constraints,
        gaps: data.gaps, at: new Date().toISOString() };
    });
  }
}

export function normalizeOptionals(data) {
  return Object.fromEntries(Object.entries(data).filter(([key, value]) =>
    !(['query', 'queryId', 'id', 'path', 'symbol', 'focus'].includes(key) &&
      typeof value === 'string' && value.trim() === '')));
}
