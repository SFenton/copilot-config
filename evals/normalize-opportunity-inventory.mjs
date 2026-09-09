#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import { readOpportunityPolicy } from '../skills/budget-workflow/scripts/opportunities.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ranges(value) {
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every(Number.isInteger)) return [value];
    return value.flatMap(ranges);
  }
  assert(typeof value === 'string', 'Source line ranges must be arrays or strings');
  return value.split(',').map(part => {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    assert(match, `Invalid source line range: ${part}`);
    return [Number(match[1]), Number(match[2] ?? match[1])];
  });
}

function sourceItems(item) {
  if (item.evidence) {
    return item.evidence.flatMap(source =>
      source.lineRanges.flatMap(range => ranges(range).map(([start, end]) => ({
        file: source.path, start, end,
      }))));
  }
  const values = item.anchors ?? item.artifacts;
  return values.flatMap(source => ranges(source.lines).map(([start, end]) => ({
    file: source.file ?? source.path, start, end,
  })));
}

function normalizeCase(item, opportunity, root) {
  const sources = sourceItems(item).map(source => {
    const absolute = path.resolve(source.file);
    const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
    assert(relative && !relative.startsWith('../') && !path.isAbsolute(relative),
      `${item.case_id ?? item.caseId}: source escapes repository`);
    const resolved = fs.realpathSync(absolute);
    assert(resolved === path.resolve(root, relative), `${item.case_id ?? item.caseId}: source uses symlink`);
    const totalLines = fs.readFileSync(resolved, 'utf8').split('\n').length;
    assert(Number.isInteger(source.start) && Number.isInteger(source.end) &&
      source.start >= 1 && source.end >= source.start && source.end <= totalLines,
    `${item.case_id ?? item.caseId}: invalid range ${relative}:${source.start}-${source.end}/${totalLines}`);
    return { file: relative, start: source.start, end: source.end };
  });
  const criteria = item.expectedCriteria ?? item.expected_high_signal_criteria;
  const failureCriteria = item.hiddenFailureCriteria ?? item.hidden_failure_criteria;
  assert(Array.isArray(criteria) && criteria.length >= 3, `${opportunity}: at least three criteria required`);
  assert(Array.isArray(failureCriteria) && failureCriteria.length >= 2,
    `${opportunity}: at least two failure criteria required`);
  const bytes = sources.reduce((total, source) => {
    const lines = fs.readFileSync(path.join(root, source.file), 'utf8').split('\n');
    return total + Buffer.byteLength(lines.slice(source.start - 1, source.end).join('\n'));
  }, 0);
  assert(bytes <= 40_000, `${item.case_id ?? item.caseId}: source packet exceeds 40 KB`);
  return {
    id: item.caseId ?? item.case_id,
    question: item.taskQuestion ?? item.task_question,
    sources,
    criteria,
    failureCriteria,
    validator: item.deterministicValidation ?? item.deterministic_validation,
    discriminator: item.whyThisDistinguishesCheaperChallenger ??
      item.why_it_distinguishes_cheaper_challenger,
  };
}

function sourceOpportunities(raw) {
  if (Array.isArray(raw.retained_owner_opportunities)) return raw.retained_owner_opportunities;
  if (Array.isArray(raw.opportunities)) return raw.opportunities;
  return Object.entries(raw.opportunities).map(([opportunity_id, cases]) => ({ opportunity_id, cases }));
}

export function normalizeInventory(raw, root) {
  const repository = fs.realpathSync(root);
  const policy = readOpportunityPolicy(repository, readAdapter(repository));
  const expected = policy.opportunities.filter(item => item.id !== 'focused-tests').map(item => item.id);
  const opportunities = sourceOpportunities(raw).map(item => {
    const id = (item.opportunityId ?? item.opportunity_id).replaceAll('_', '-');
    const cases = item.cases.map(value => normalizeCase(value, id, repository));
    assert(cases.length === 3, `${id}: exactly three cases required`);
    return { id, cases };
  });
  assert(new Set(opportunities.map(item => item.id)).size === opportunities.length,
    'Duplicate opportunity inventory');
  assert(JSON.stringify(opportunities.map(item => item.id).sort()) === JSON.stringify(expected.sort()),
    'Inventory opportunities do not match repository policy');
  const ids = opportunities.flatMap(item => item.cases.map(value => value.id));
  assert(ids.every(value => typeof value === 'string' && value.length > 0) &&
    new Set(ids).size === ids.length, 'Case IDs must be nonempty and unique');
  return { version: 1, project: policy.project, opportunities };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [input, root, output] = process.argv.slice(2);
    assert(input && root && output,
      'Usage: normalize-opportunity-inventory.mjs INPUT ROOT OUTPUT');
    const value = normalizeInventory(JSON.parse(fs.readFileSync(input, 'utf8')), root);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({
      project: value.project,
      opportunities: value.opportunities.length,
      cases: value.opportunities.reduce((total, item) => total + item.cases.length, 0),
    }));
  } catch (error) {
    console.error(`normalize-opportunity-inventory: ${error.message}`);
    process.exitCode = 1;
  }
}
