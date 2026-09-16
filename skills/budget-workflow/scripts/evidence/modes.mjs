import { RESEARCH_MODES, REASON_ONLY_TOOL_MODE } from './schemas.mjs';

export const MODES = [...RESEARCH_MODES];
export const PHASES = ['research', 'implementation', 'validation', 'release'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function historyProfile(task) {
  const crossSession = task.crossSessionSynthesis === true ||
    (Array.isArray(task.resolvedSessions) && task.resolvedSessions.length > 1);
  return crossSession
    ? { model: 'gpt-5.4', effort: 'medium', context: 'default' }
    : { model: 'gpt-5.4-mini', effort: 'low', context: 'default' };
}

export function taskPlan(task, adapter = null) {
  if (!task || typeof task.question !== 'string' || !task.question.trim()) throw new Error('Question required');
  if (!PHASES.includes(task.phase ?? 'research')) throw new Error('Unknown task phase');
  if (!['low', 'medium', 'high', 'unknown'].includes(task.risk)) throw new Error('Explicit risk required');
  if (!['cost', 'speed'].includes(task.objective ?? 'cost')) throw new Error('Unknown objective');
  let mode = task.mode;
  if (mode === 'auto') {
    if (task.historyRequested === true) mode = 'history';
    else if (typeof task.repositoryRelevant !== 'boolean' || typeof task.externalRequired !== 'boolean') {
      return {
        status: 'needs-scope-probe',
        instruction: 'Resolve repository relevance, external evidence need, and whether history is materially relevant with a bounded deterministic probe; do not infer absence from one search.',
        model: null,
      };
    } else {
      mode = task.externalRequired
        ? (task.repositoryRelevant ? 'hybrid' : 'external')
        : 'repository';
    }
  }
  if (!MODES.includes(mode)) throw new Error('Unknown evidence mode');
  if (mode !== 'external' && mode !== 'history' && !adapter) throw new Error('Repository/hybrid mode requires a project adapter');
  const phase = task.phase ?? 'research';
  if (task.novel !== undefined && typeof task.novel !== 'boolean') throw new Error('Novel must be boolean');
  const riskTerms = ['production', 'migration', 'credentials', 'security', 'data loss',
    'race condition', 'deadlock', 'activation', 'rollback', ...(mode === 'external' || mode === 'history' ? [] : adapter?.riskTerms ?? [])];
  const riskHits = riskTerms.filter(term => task.question.toLowerCase().includes(term.toLowerCase()));
  const policy = adapter?.evidencePolicy;
  const rules = mode === 'external' || mode === 'history'
    ? []
    : [...(policy?.always ?? []), ...(policy?.phases?.[phase] ?? [])];
  const metaAudit = task.metaAudit === true;
  const historyRequested = mode === 'history';
  const profile = historyRequested
    ? historyProfile(task)
    : metaAudit
      ? { model: 'gpt-5.4', effort: 'medium', context: 'default' }
      : { model: 'gpt-5.6-sol', effort: 'high', context: 'default' };
  const role = historyRequested
    ? profile.model === 'gpt-5.4-mini'
      ? 'history-curation'
      : 'history-synthesis'
    : metaAudit
      ? 'meta-audit'
      : 'frontier-research';
  if (mode !== 'external' && mode !== 'history') {
    assert(policy, 'Project needs an evidencePolicy; do not flatten old release gates into research');
  }
  return {
    version: 2,
    status: 'ready',
    mode,
    phase,
    role,
    model: profile.model,
    effort: profile.effort,
    context: profile.context,
    toolMode: REASON_ONLY_TOOL_MODE,
    riskHits,
    directOwner: true,
    automaticWorker: false,
    tandem: false,
    packetRequired: true,
    packetWorkflowVersion: 2,
    deterministicEvidence: true,
    historyRequested,
    metaAudit,
    rules,
    contractRequired: mode === 'hybrid',
    runtimeEvidenceRequired: task.runtimeEvidenceRequired === true,
    runtimeAuthorized: false,
    mutationAuthorized: false,
    reasoningOnly: true,
    historyPlanner: mode === 'history' ? 'scripts/evidence/history.mjs' : null,
    gaps: task.runtimeEvidenceRequired
      ? ['Source and history research cannot establish current runtime behavior; use separately authorized project evidence.']
      : [],
    authority: historyRequested
      ? 'History packets are deterministically prepared first. Any optional model leg is packet-only gpt-5.4-mini low/default for small extracts or gpt-5.4 medium/default for cross-session synthesis.'
      : metaAudit
        ? 'Meta-audits stay native: one gpt-5.4 medium/default owner plus deterministic evidence. No tandem or frontier tools are implied.'
        : 'Frontier models perform reasoning only. Deterministic evidence collection freezes the packet before the reason-only leg and never grants repository, external, live, release, or implementation authority.',
  };
}

export function delegationDecision(costs) {
  if (!costs || costs.qualityEligible !== true) return { delegate: false, reason: 'No quality-qualified delegation path' };
  const fields = ['direct', 'preparation', 'worker', 'handoff', 'owner', 'review', 'retry'];
  if (fields.some(key => typeof costs[key] !== 'number' || !Number.isFinite(costs[key]) || costs[key] < 0)) {
    return { delegate: false, reason: 'Cost evidence incomplete; use direct execution' };
  }
  const assisted = fields.filter(key => key !== 'direct').reduce((sum, key) => sum + costs[key], 0);
  return {
    delegate: assisted <= costs.direct * 0.8 && costs.direct > 0,
    direct: costs.direct,
    assisted,
    reason: 'Require at least 20% estimated margin after all legs; estimates are not observed savings',
  };
}
