import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import PhpParser from 'php-parser';
import { contained } from '../budget.mjs';

const require = createRequire(import.meta.url);
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const readText = file => utf8.decode(fs.readFileSync(file));
const SYNTAX_VERSION = 'wasm-0.20.8-0.1.13-php-3.7-v2';
const languageByExtension = { '.ts': 'typescript', '.tsx': 'tsx', '.js': 'typescript', '.mjs': 'typescript',
  '.py': 'python', '.php': 'php', '.cs': 'c_sharp' };
const callableTypes = new Set(['function_declaration', 'function_definition', 'method_definition',
  'method_declaration', 'constructor_declaration', 'property_declaration']);
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.py', '.php', '.cs', '.css', '.md', '.json', '.yaml', '.yml', '.sql']);
const excludedSegments = new Set(['.git', 'node_modules', 'dist', 'bin', 'obj', 'coverage',
  'test-results', 'playwright-report', 'evidence', 'artifacts', 'provider-raw', 'secrets', 'credentials']);
const languages = new Map();
let initialization;

function rgUnavailable(error) {
  return error?.code === 'ENOENT' ||
    error?.cause?.code === 'ENOENT' ||
    /spawnSync rg ENOENT/.test(error?.message ?? '');
}

function fileMatchesTerms(root, file, terms) {
  const text = readText(contained(root, file));
  if (text.includes('\0')) return false;
  const lower = text.toLowerCase();
  return terms.some(term => lower.includes(term.toLowerCase()));
}

export function eligible(file, policy) {
  const pieces = file.split('/');
  if (pieces.some(part => excludedSegments.has(part) || part.startsWith('.env'))) return false;
  if (/(?:secret|credential|token|private[-_]key)\.(?:json|ya?ml|txt)$/i.test(file)) return false;
  if (!extensions.has(path.extname(file))) return false;
  if ((policy.denyPaths ?? []).some(prefix => file === prefix || file.startsWith(`${prefix}/`))) return false;
  return policy.allowPaths.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
}

export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

export async function sourceUnits(text, extension) {
  if (extension === '.php') {
    let ast;
    try { ast = new PhpParser({ parser: { suppressErrors: false }, ast: { withPositions: true } }).parseCode(text); }
    catch (error) {
      if (error instanceof SyntaxError) return { parsed: false, units: [], reason: 'PHP syntax not recognized; use explicit source' };
      throw error;
    }
    const units = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (['function', 'method', 'constantstatement'].includes(node.kind) && node.loc) {
        units.push({ name: node.name?.name ?? node.name ?? node.constants?.[0]?.name?.name ?? node.kind,
          kind: node.kind, start: node.loc.start.line, end: node.loc.end.line });
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(ast);
    return { parsed: true, units: units.sort((a, b) => a.start - b.start || a.end - b.end) };
  }
  const language = languageByExtension[extension];
  if (!language) return { parsed: false, units: [], reason: 'No syntax parser for this file type; use complete file/explicit lines' };
  initialization ??= Parser.init();
  await initialization;
  if (!languages.has(language)) {
    languages.set(language, await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${language}.wasm`)));
  }
  const parser = new Parser();
  parser.setLanguage(languages.get(language));
  const tree = parser.parse(text);
  try {
    if (tree.rootNode.hasError()) return { parsed: false, units: [], reason: 'Syntax not fully recognized; do not trust inferred boundaries' };
    const units = [];
    const walk = node => {
      let selected = null;
      if (callableTypes.has(node.type)) selected = node;
      if (node.type === 'assignment' && node.parent?.type === 'expression_statement' &&
        node.parent.parent?.type === 'module') selected = node.parent;
      if (['lexical_declaration', 'type_alias_declaration', 'interface_declaration', 'enum_declaration'].includes(node.type) &&
        ['program', 'export_statement'].includes(node.parent?.type)) selected = node;
      if (['field_declaration', 'public_field_definition'].includes(node.type)) selected = node;
      if (node.type === 'arrow_function' && node.parent?.type === 'variable_declarator') {
        selected = node.parent.parent;
      }
      if (selected) {
        if (['export_statement', 'decorated_definition'].includes(selected.parent?.type)) selected = selected.parent;
        const named = node.childForFieldName('name') ?? node.childForFieldName('left') ??
          node.namedChildren[0]?.childForFieldName('name') ?? node.parent?.childForFieldName('name');
        units.push({ name: named?.text ?? node.type, kind: node.type,
          start: selected.startPosition.row + 1, end: selected.endPosition.row + 1 });
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(tree.rootNode);
    const distinct = [...new Map(units.map(unit => [`${unit.start}:${unit.end}:${unit.name}`, unit])).values()]
      .sort((a, b) => a.start - b.start || a.end - b.end);
    return { parsed: true, units: distinct };
  } finally { tree.delete(); parser.delete(); }
}

export class RepositoryEvidence {
  constructor(root, policy, cacheDir, options = {}) {
    this.root = fs.realpathSync(root);
    if (!policy || !Array.isArray(policy.allowPaths) || !policy.allowPaths.length) throw new Error('Explicit repository content allowPaths required');
    if (policy.allowPaths.some(p => typeof p !== 'string' || path.isAbsolute(p) || p.split('/').includes('..'))) throw new Error('Invalid repository allowPaths');
    this.policy = policy;
    this.cacheDir = cacheDir;
    this.rgExec = options.rgExec ?? execFileSync;
    this.records = new Map();
    this.opened = new Set();
  }

  files() {
    const paths = execFileSync('git', ['-C', this.root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 10000000 }).split('\0').filter(Boolean);
    const allowed = [...new Set(paths)].filter(file => eligible(file, this.policy));
    if (allowed.length > 20000) throw new Error('Repository inventory exceeds configured discovery capacity; narrow allowPaths');
    return allowed;
  }

  async register(file, parse = true) {
    if (!eligible(file, this.policy)) throw new Error('File is outside repository content policy');
    const target = contained(this.root, file);
    if (!fs.statSync(target).isFile() || fs.statSync(target).size > (this.policy.maxFileBytes ?? 1000000)) throw new Error('Source file exceeds content limit');
    const text = readText(target);
    if (text.includes('\0')) throw new Error('Binary source rejected');
    const hash = digest(text);
    const id = `r_${digest(`${this.root}\0${file}\0${hash}\0${SYNTAX_VERSION}`).slice(0, 16)}`;
    const cache = path.join(this.cacheDir, 'syntax', `${digest(`${SYNTAX_VERSION}\0${file}\0${hash}`)}.json`);
    let structure;
    if (!parse) structure = { parsed: false, units: [] };
    else if (fs.existsSync(cache)) structure = JSON.parse(fs.readFileSync(cache, 'utf8'));
    else {
      structure = await sourceUnits(text, path.extname(file));
      atomicJson(cache, structure);
    }
    const record = { id, path: file, sha256: hash, bytes: Buffer.byteLength(text),
      lineCount: text.split('\n').length, extractorVersion: SYNTAX_VERSION, ...structure };
    this.records.set(id, record);
    return record;
  }

  async discover(query, limit = 6, raw = false) {
    if (typeof query !== 'string' || !query.trim() || query.length > 160) throw new Error('Bounded repository query required');
    const terms = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])].filter(t => t.length > 1).slice(0, 8);
    if (!terms.length) throw new Error('Repository query has no searchable terms');
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Discovery limit must be 1-8');
    const inventory = this.files();
    let skippedLarge = 0;
    const files = inventory.filter(file => {
      const target = contained(this.root, file);
      const info = fs.statSync(target);
      if (!info.isFile()) throw new Error('Inventory entry is not a regular file');
      if (info.size > (this.policy.maxFileBytes ?? 1000000)) { skippedLarge++; return false; }
      return true;
    });
    const scored = new Map();
    for (const file of files) {
      const score = terms.filter(term => file.toLowerCase().includes(term.toLowerCase())).length * 4;
      if (score) scored.set(file, { score, matches: [] });
    }
    let searchBackend = 'rg';
    for (let start = 0; start < files.length; start += 250) {
      const selected = files.slice(start, start + 250);
      if (!selected.length) continue;
      const args = ['--files-with-matches', '-0', '-i', '-F'];
      for (const term of terms) args.push('-e', term);
      args.push('--', ...selected);
      let matches;
      try {
        matches = this.rgExec('rg', args, {
          cwd: this.root,
          encoding: 'utf8',
          maxBuffer: 8000000,
          timeout: 15000,
        }).split('\0').filter(Boolean);
      }
      catch (error) {
        if (error.status === 1) matches = [];
        else if (rgUnavailable(error)) {
          searchBackend = 'javascript-fixed-string-fallback';
          matches = selected.filter(file => fileMatchesTerms(this.root, file, terms));
        } else throw error;
      }
      for (const file of matches) {
        const old = scored.get(file) ?? { score: 0, matches: [] };
        old.score += 1;
        scored.set(file, old);
      }
    }
    const candidates = [...scored.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).slice(0, 200);
    for (const [file, info] of candidates) {
      const text = readText(contained(this.root, file));
      if (text.includes('\0')) continue;
      const matchedTerms = new Set();
      text.split('\n').forEach((line, index) => {
        const matching = terms.filter(term => line.toLowerCase().includes(term.toLowerCase()));
        matching.forEach(term => matchedTerms.add(term));
        if (matching.length && info.matches.length < 3) info.matches.push({ line: index + 1, text: line.trim().slice(0, 220) });
        if (!raw && matching.some(term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\(|=|\\{|:)`, 'i').test(line)) &&
          /^\s*(?:export |async |def |function |class |public |private |internal |static |const |let |var |type |interface |[A-Z_][A-Z0-9_]*\s*=)/.test(line)) {
          info.score += 20;
          if (!info.matches.some(match => match.line === index + 1)) info.matches.unshift({ line: index + 1, text: line.trim().slice(0, 220) });
          info.matches = info.matches.slice(0, 5);
        }
      });
      info.score += matchedTerms.size * 2;
    }
    const ranked = candidates.sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).slice(0, limit);
    const results = [];
    for (const [file, info] of ranked) {
      const record = await this.register(file, !raw);
      const relevant = record.bytes <= 8000 && record.lineCount <= 200 ? [] : record.units.filter(unit => info.matches.some(m => m.line >= unit.start && m.line <= unit.end))
        .sort((a, b) => (a.end - a.start) - (b.end - b.start)).slice(0, 5);
      results.push({ id: record.id, path: file, sha256: record.sha256.slice(0, 12), bytes: record.bytes,
        matches: info.matches, preferWholeFile: record.bytes <= 8000 && record.lineCount <= 200,
        units: relevant.map(unit => ({ id: `${record.id}/u${record.units.indexOf(unit)}`, ...unit })) });
    }
    return { scope: 'repository', searchedFiles: files.length, skippedLarge,
      matchingFiles: scored.size, rankedFiles: candidates.length, contentPolicy: this.policy.allowPaths,
      results, absenceIsNotProof: true, searchBackend,
      warnings: searchBackend === 'rg'
        ? []
        : ['rg-unavailable-fixed-string-fallback'] };
  }

  read(id, options = {}) {
    const [sourceId, unitId] = id.split('/');
    const record = this.records.get(sourceId);
    if (!record) throw new Error('Unknown repository source ID; discover first');
    if (record.extractorVersion !== SYNTAX_VERSION) throw new Error('Source index version changed; rediscover its declaration');
    const text = readText(contained(this.root, record.path));
    if (digest(text) !== record.sha256) throw new Error('Source changed; rediscover before using cached references');
    const lines = text.split('\n');
    let start = 1;
    let end = lines.length;
    let completeUnit = true;
    if (unitId) {
      if (!/^u\d+$/.test(unitId) || !record.units[Number(unitId.slice(1))]) throw new Error('Unknown source unit');
      ({ start, end } = record.units[Number(unitId.slice(1))]);
    } else if (options.start !== undefined || options.end !== undefined) {
      ({ start, end } = options);
      completeUnit = false;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) throw new Error('Invalid source line range');
    let content = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
    const maximum = options.maxCharacters ?? (options.raw ? 32000 : 12000);
    if (!Number.isInteger(maximum) || maximum < 500 || maximum > 64000) throw new Error('Invalid source character budget');
    if (content.length > maximum) {
      if (options.raw) {
        const selected = [];
        let characters = 0;
        for (let i = start - 1; i < end; i++) {
          const line = `${i + 1}: ${lines[i]}`;
          if (characters + line.length + 1 > maximum) break;
          selected.push(line);
          characters += line.length + 1;
        }
        if (selected.length) {
          this.opened.add(sourceId);
          return { status: 'ok', id, path: record.path, sha256: record.sha256,
            start, end: start + selected.length - 1, completeUnit: false, truncated: true,
            totalLines: lines.length, content: selected.join('\n'), warning: 'Raw view truncated explicitly; use ranges to inspect remaining source.' };
        }
      }
      return { status: 'needs-expansion', id, path: record.path, requiredCharacters: content.length,
        reason: 'No source was silently truncated; open a complete unit or explicitly bounded lines',
        units: record.units.slice(0, 30).map((unit, i) => ({ id: `${sourceId}/u${i}`, ...unit })) };
    }
    this.opened.add(sourceId);
    return { status: 'ok', id, path: record.path, sha256: record.sha256, start, end, completeUnit,
      content, caveat: 'A complete syntax unit is not proof of complete semantic context; inspect callers/fields when needed' };
  }
}
