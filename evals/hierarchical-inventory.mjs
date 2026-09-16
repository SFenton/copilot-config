#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import { readOpportunityPolicy } from '../skills/budget-workflow/scripts/opportunities.mjs';
import { readReleaseMachine } from '../skills/budget-workflow/scripts/release-machine.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function maxLong(profile) {
  return profile?.model === 'gpt-5.6-sol' &&
    profile?.effort === 'max' &&
    profile?.context === 'long_context';
}

function categoryCounts(sites) {
  return Object.fromEntries([...new Set(sites.map(site => site.category))]
    .sort()
    .map(category => [
      category,
      sites.filter(site => site.category === category).length,
    ]));
}

function allRepositoryFiles(root) {
  return execFileSync('git', [
    '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ], { encoding: 'utf8', maxBuffer: 8_000_000 })
    .split('\0')
    .filter(Boolean);
}

function containsSolMaxLong(text) {
  return /gpt-5\.6-sol[\s\S]{0,240}(?:"(?:effort|reasoning(?:Effort)?)"\s*:\s*"max"|reasoning(?: effort)?\s*[:` ]+\s*`?max|long_context|long-context)/i
    .test(text) ||
    /(?:"(?:effort|reasoning(?:Effort)?)"\s*:\s*"max"|reasoning(?: effort)?\s*[:` ]+\s*`?max|long_context|long-context)[\s\S]{0,240}gpt-5\.6-sol/i
    .test(text) ||
    /\bSol\b[\s/`-]*max[\s/`-]*(?:long_context|long-context|long\b)/i.test(text);
}

function broadClassification(project, relative, canonical) {
  if (['.github/agent-opportunities.json', '.github/release-machine.json',
    '.github/destructive-maintenance-machine.json'].includes(relative)) {
    return 'structured-slot';
  }
  if (canonical.has(`${project}:${relative}`)) return 'canonical-current-site';
  if (project === 'ha' &&
    relative.startsWith('.github/skills/house-style-copy/evals/')) {
    return 'historical-house-style-evidence';
  }
  if (project === 'shared' && relative.startsWith('evals/')) {
    return 'historical-or-disabled-study';
  }
  if (project === 'shared' && relative.startsWith('tests/')) {
    return 'legacy-compatibility-test';
  }
  if (project === 'fst' &&
    relative === 'docs/database/SnapshotReuseRunbook.md') {
    return 'historical-runtime-record';
  }
  if (project === 'ha' &&
    relative.startsWith('.github/skills/simulated-user-panel/evals/')) {
    return 'panel-evaluation-profile';
  }
  return 'unclassified';
}

export function inventory(config, manifest) {
  assert(config?.version === 1 && Array.isArray(config.currentCanonicalSites),
    'Pin inventory config required');
  const roots = Object.fromEntries(manifest.cases.map(item => [item.id, item.root]));
  roots.shared = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const projects = [];
  const structuredPins = [];
  const machines = [];
  for (const item of manifest.cases) {
    const adapter = readAdapter(item.root);
    const policy = readOpportunityPolicy(item.root, adapter);
    assert(policy.version === 3, `${item.id}: version 3 policy required`);
    const phaseCounts = {};
    let commandPhases = 0;
    let disabledBackedPhases = 0;
    for (const opportunity of policy.opportunities) {
      for (const phase of opportunity.phases) {
        phaseCounts[phase.kind] = (phaseCounts[phase.kind] ?? 0) + 1;
        if (phase.kind === 'deterministic') {
          const tool = policy.toolRegistry.tools.find(entry => entry.id === phase.tool);
          if (tool.kind === 'command') commandPhases += 1;
          if (tool.kind === 'disabled') disabledBackedPhases += 1;
        }
      }
      for (const [slot, profile] of [
        ['coordinator', opportunity.team.coordinator.profile],
        ['reviewer', opportunity.team.reviewer.profile],
        ['worker', opportunity.team.workerCandidate.profile],
      ]) {
        if (maxLong(profile)) {
          structuredPins.push({
            project: policy.project,
            opportunity: opportunity.id,
            slot,
            conditional: false,
            violation: 'max/long cannot be a mandatory team role',
          });
        }
      }
      for (const conditional of opportunity.conditionalProfiles) {
        if (!maxLong(conditional.profile)) continue;
        const valid = conditional.kind === 'risk-triggered-frontier-review' &&
          conditional.requiresTriggerReceipt === true &&
          conditional.triggerIds.length > 0;
        structuredPins.push({
          project: policy.project,
          opportunity: opportunity.id,
          slot: conditional.id,
          conditional: true,
          triggerIds: conditional.triggerIds,
          violation: valid ? null : 'conditional max/long profile lacks a concrete trigger receipt',
        });
      }
    }
    const registryCounts = {
      command: policy.toolRegistry.tools.filter(tool => tool.kind === 'command').length,
      disabled: policy.toolRegistry.tools.filter(tool => tool.kind === 'disabled').length,
      fakeDriver: policy.toolRegistry.tools.filter(tool => tool.kind === 'fake-driver').length,
    };
    const projectMachines = [];
    if (adapter.releaseMachine) {
      projectMachines.push(readReleaseMachine(item.root, adapter));
    }
    if (adapter.destructiveMaintenanceMachine) {
      projectMachines.push(readReleaseMachine(item.root, {
        ...adapter,
        releaseMachine: adapter.destructiveMaintenanceMachine,
      }));
    }
    for (const machine of projectMachines) {
      if (maxLong(machine.exception.profile)) {
        const valid = machine.exception.requiresTriggerReceipt === true &&
          machine.exception.triggerIds.length > 0;
        structuredPins.push({
          project: machine.project,
          machine: machine.variant ?? machine.opportunity,
          slot: 'machine-exception',
          conditional: true,
          triggerIds: machine.exception.triggerIds,
          violation: valid ? null : 'machine exception max/long lacks a trigger receipt',
        });
      }
      machines.push({
        project: machine.project,
        variant: machine.variant ?? null,
        version: machine.version,
        enabled: machine.enabled,
        reviewer: machine.reviewer.profile,
        exceptionTriggers: machine.exception.triggerIds,
      });
    }
    projects.push({
      id: item.id,
      project: policy.project,
      opportunities: policy.opportunities.length,
      enabledOpportunities: policy.opportunities.filter(value => value.enabled).length,
      invalidatedOpportunities: policy.opportunities.filter(value =>
        !value.enabled).map(value => value.id),
      phaseCounts,
      deterministicCommandPhases: commandPhases,
      disabledBackedPhases,
      registeredTools: registryCounts,
      enabledWorkers: policy.opportunities.filter(value =>
        value.team.workerCandidate.enabled).map(value => value.id),
    });
  }

  const sites = config.currentCanonicalSites.map(site => {
    const root = roots[site.project];
    assert(root, `Unknown site project: ${site.project}`);
    const file = path.join(root, site.path);
    assert(fs.statSync(file, { throwIfNoEntry: false })?.isFile(),
      `Canonical site missing: ${site.project}:${site.path}`);
    const text = fs.readFileSync(file, 'utf8');
    const hasMaxPin = /(?:\bmax\b|long_context|long-context)/i.test(text) &&
      (site.category === 'test-coupling' ||
        /(?:gpt-5\.6-sol|\bSol\b)/i.test(text));
    assert(hasMaxPin, `Canonical site no longer contains a max/long pin: ${site.path}`);
    let triggerBound = /trigger|copy-safety-conflict|criticalProfile|explicit(?:-only|ly asks)/i
      .test(text);
    if (site.historical) {
      const routing = JSON.parse(fs.readFileSync(path.join(
        roots.ha,
        '.github/skills/house-style-copy/evals/runtime-routing.json',
      ), 'utf8'));
      triggerBound = routing.conditionalAdjudicator?.candidateId ===
        JSON.parse(text).candidateId &&
        routing.conditionalAdjudicator?.requiresTriggerReceipt === true &&
        routing.conditionalAdjudicator?.triggerIds?.length > 0;
    }
    return {
      ...site,
      triggerBound,
      violation: triggerBound ? null : 'canonical max/long site lacks a concrete trigger binding',
    };
  });
  const canonical = new Set(config.currentCanonicalSites.map(site =>
    `${site.project}:${site.path}`));
  const allMaxLongFiles = [];
  for (const [project, root] of Object.entries(roots)) {
    for (const relative of allRepositoryFiles(root)) {
      if (!/\.(?:json|md|mjs|js|ts|tsx|cs)$/.test(relative)) continue;
      const file = path.join(root, relative);
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!containsSolMaxLong(text)) continue;
      allMaxLongFiles.push({
        project,
        path: relative,
        classification: broadClassification(project, relative, canonical),
      });
    }
  }
  const unclassifiedMaxLongFiles = allMaxLongFiles.filter(item =>
    item.classification === 'unclassified');

  const totals = {
    projects: projects.length,
    opportunities: projects.reduce((sum, project) => sum + project.opportunities, 0),
    deterministicCommandPhases: projects.reduce((sum, project) =>
      sum + project.deterministicCommandPhases, 0),
    disabledBackedPhases: projects.reduce((sum, project) =>
      sum + project.disabledBackedPhases, 0),
    registeredCommandTools: projects.reduce((sum, project) =>
      sum + project.registeredTools.command, 0),
    registeredDisabledTools: projects.reduce((sum, project) =>
      sum + project.registeredTools.disabled, 0),
    releaseMachines: machines.length,
    enabledReleaseMachines: machines.filter(machine => machine.enabled).length,
    structuredMaxLongSlots: structuredPins.length,
    mandatoryMaxLongSlots: structuredPins.filter(pin => !pin.conditional).length,
    conditionalMaxLongSlots: structuredPins.filter(pin => pin.conditional).length,
    structuredViolations: structuredPins.filter(pin => pin.violation).length,
    enforcementSites: sites.length,
    enforcementSiteViolations: sites.filter(site => site.violation).length,
    allMaxLongFiles: allMaxLongFiles.length,
    unclassifiedMaxLongFiles: unclassifiedMaxLongFiles.length,
  };
  assert(totals.opportunities === 44,
    `Expected 44 opportunities, found ${totals.opportunities}`);
  assert(totals.releaseMachines === 5,
    `Expected five release/maintenance machines, found ${totals.releaseMachines}`);
  return {
    version: 1,
    method: 'Resolved structured profiles plus explicit canonical file-level enforcement/authoring sites. Structured slots and sites are never summed.',
    baseline: config.baseline,
    after: {
      totals,
      projects,
      machines,
      structuredPins,
      enforcementSites: {
        total: sites.length,
        categories: categoryCounts(sites),
        sites,
      },
      allMaxLongFiles,
      unclassifiedMaxLongFiles,
    },
  };
}

if (process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const config = JSON.parse(fs.readFileSync(
      process.argv[2] ?? new URL('./pin-inventory.json', import.meta.url),
      'utf8',
    ));
    const manifest = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    console.log(JSON.stringify(inventory(config, manifest), null, 2));
  } catch (error) {
    console.error(`hierarchical-inventory: ${error.message}`);
    process.exitCode = 1;
  }
}
