export const MODES = ['repository', 'external', 'hybrid'];
export const PHASES = ['research', 'implementation', 'validation', 'release'];

export function taskPlan(task, adapter = null) {
  if (!task || typeof task.question !== 'string' || !task.question.trim()) throw new Error('Question required');
  if (!PHASES.includes(task.phase ?? 'research')) throw new Error('Unknown task phase');
  if (!['low', 'medium', 'high', 'unknown'].includes(task.risk)) throw new Error('Explicit risk required');
  if (!['cost', 'speed'].includes(task.objective ?? 'cost')) throw new Error('Unknown objective');
  let mode = task.mode;
  if (mode === 'auto') {
    if (typeof task.repositoryRelevant !== 'boolean' || typeof task.externalRequired !== 'boolean') {
      return { status: 'needs-scope-probe', instruction: 'Resolve repository relevance and external evidence need with a bounded probe; do not infer absence from one search.', model: null };
    }
    mode = task.externalRequired ? (task.repositoryRelevant ? 'hybrid' : 'external') : 'repository';
  }
  if (!MODES.includes(mode)) throw new Error('Unknown evidence mode');
  if (mode !== 'external' && !adapter) throw new Error('Repository/hybrid mode requires a project adapter');
  const phase = task.phase ?? 'research';
  if (task.novel !== undefined && typeof task.novel !== 'boolean') throw new Error('Novel must be boolean');
  const riskTerms = ['production', 'migration', 'credentials', 'security', 'data loss',
    'race condition', 'deadlock', 'activation', 'rollback', ...(mode === 'external' ? [] : adapter?.riskTerms ?? [])];
  const riskHits = riskTerms.filter(term => task.question.toLowerCase().includes(term.toLowerCase()));
  const high = task.risk === 'high' || task.risk === 'unknown' || task.novel === true || riskHits.length > 0;
  const speed = task.objective === 'speed';
  const model = high ? 'gpt-6-astra' : speed ? 'gpt-6-astra' : 'gpt-5.6-sol';
  const effort = high ? 'high' : speed ? 'low' : 'high';
  const policy = adapter?.evidencePolicy;
  const rules = mode === 'external' ? [] : [...(policy?.always ?? []), ...(policy?.phases?.[phase] ?? [])];
  return {
    version: 1, status: 'ready', mode, phase, model, effort, context: 'default', riskHits,
    directOwner: true, automaticWorker: false, tandem: false,
    rules, contractRequired: mode === 'hybrid',
    runtimeEvidenceRequired: task.runtimeEvidenceRequired === true,
    runtimeAuthorized: false, mutationAuthorized: false,
    gaps: task.runtimeEvidenceRequired ? ['Source research cannot establish current runtime behavior; use separately authorized project evidence.'] : [],
    authority: 'Model choices are working defaults, not universal quality guarantees. User-pinned specialist contracts take precedence.',
  };
}

export function delegationDecision(costs) {
  if (!costs || costs.qualityEligible !== true) return { delegate: false, reason: 'No quality-qualified delegation path' };
  const fields = ['direct', 'preparation', 'worker', 'handoff', 'owner', 'review', 'retry'];
  if (fields.some(key => typeof costs[key] !== 'number' || !Number.isFinite(costs[key]) || costs[key] < 0)) {
    return { delegate: false, reason: 'Cost evidence incomplete; use direct execution' };
  }
  const assisted = fields.filter(key => key !== 'direct').reduce((sum, key) => sum + costs[key], 0);
  return { delegate: assisted <= costs.direct * 0.8 && costs.direct > 0,
    direct: costs.direct, assisted, reason: 'Require at least 20% estimated margin after all legs; estimates are not observed savings' };
}
