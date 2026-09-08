#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { estimate } from '../skills/budget-workflow/scripts/budget.mjs';

// Explicit planning scenarios, not fitted measurements or provider guarantees.
const rates = {
  sol: { input: 4, cached: 0.4, cacheWrite: 5, output: 20 },
  opus: { input: 5, cached: 0.5, cacheWrite: 6.25, output: 25 },
  astra: { input: 10, cached: 1, cacheWrite: 12.5, output: 50 },
  sonnet: { input: 2, cached: 0.2, cacheWrite: 2.5, output: 10 },
  mini: { input: 0.75, cached: 0.075, cacheWrite: 0, output: 4.5 },
};
function leg(name, model, count, input, cached, output) {
  return { name, model, count, input, cached, cacheWrite: 0, output, rates: rates[model] };
}
const scenarios = [
  { project: 'ha-react', researchCalls: 3, implementationCalls: 8, novelCalls: 1, workerCalls: 2 },
  { project: 'evershelf', researchCalls: 6, implementationCalls: 12, novelCalls: 5, workerCalls: 2 },
  { project: 'ha-evershelf', researchCalls: 2, implementationCalls: 5, novelCalls: 1, workerCalls: 1 },
  { project: 'festival-score-tracker', researchCalls: 5, implementationCalls: 10, novelCalls: 3, workerCalls: 2 },
].map(item => {
  const baseline = [
    leg('independent research A', 'sol', item.researchCalls, 18000, 40000, 2500),
    leg('independent research B', 'opus', item.researchCalls, 18000, 40000, 2500),
    leg('cross-critique A', 'sol', 1, 6000, 80000, 1500),
    leg('cross-critique B', 'opus', 1, 6000, 80000, 1500),
    leg('adjudication', 'sol', 1, 5000, 90000, 1500),
    leg('implementation', 'sol', item.implementationCalls, 8000, 100000, 1200),
    leg('test iteration and release evidence', 'sol', 3, 6000, 100000, 800),
  ];
  const candidate = [
    leg('coordinator planning and handoff', 'sonnet', 2, 5000, 15000, 500),
    leg('bounded evidence worker', 'mini', item.workerCalls, 5500, 0, 600),
    leg('frontier investigation', 'astra', item.novelCalls, 10000, 25000, 1500),
    leg('targeted independent critique', 'opus', 1, 7000, 0, 1200),
    leg('single-owner implementation', 'sonnet', item.implementationCalls, 5000, 25000, 1000),
    leg('one repair allowance', 'sonnet', 1, 5000, 25000, 800),
    leg('same test and release evidence', 'sonnet', 3, 4000, 25000, 600),
  ];
  const scenario = {
    project: item.project, rateUnit: 'USD per million tokens',
    assumptions: '2026-09-06 published default-tier prices, no new cache writes, same acceptance gates; all counts are hypothetical. Baseline Sol/Opus tandem; candidate Sonnet fallback coordinator plus selective Astra and Opus. No HydraFusion percentage is assumed. Release legs execute only if separately authorized.',
    baseline, candidate,
  };
  const stress = { ...scenario, candidate: [...candidate,
    leg('extra frontier escalation stress case', 'astra', 3, 20000, 50000, 3000)] };
  const currentBaseline = baseline.map(phase => phase.model === 'sol'
    ? { ...phase, model: 'astra', rates: rates.astra } : phase);
  return { scenario, estimate: estimate(scenario), escalationStress: estimate(stress),
    currentAstraBaseline: estimate({ ...scenario, baseline: currentBaseline }) };
});

if (!process.argv[2]) throw new Error('Pass an existing output directory');
for (const item of scenarios) {
  fs.writeFileSync(path.join(process.argv[2], `scenario-${item.scenario.project}.json`),
    JSON.stringify(item, null, 2), { flag: 'wx' });
}
console.log(JSON.stringify(scenarios.map(item => ({
  project: item.scenario.project, baseline: item.estimate.baseline, candidate: item.estimate.candidate,
  tokenSavings: item.estimate.tokenSavings, costSavings: item.estimate.costSavings,
  stressedTokenSavings: item.escalationStress.tokenSavings, stressedCostSavings: item.escalationStress.costSavings,
  currentAstraBaselineCost: item.currentAstraBaseline.baseline.cost,
  currentAstraCostSavings: item.currentAstraBaseline.costSavings,
})), null, 2));
