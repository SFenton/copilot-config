#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contained, readAdapter } from './budget.mjs';
import {
  createReceipt,
  resolvedConfiguration,
  requiredSideEffect,
  runRegisteredTool,
  sha256,
  toolById,
  validateAuthorization,
  validateOpportunityPolicyV2,
  validateProfile,
  validateToolRegistry,
  verifyReceiptChain,
} from './workflow.mjs';
import {
  createPipelineLegReceipt,
  pipelineContractHash,
  pipelinePhaseContracts,
  requiredPipelineSideEffect,
  validateOpportunityPolicyV3,
  verifyPipelineLegs,
} from './team-pipeline.mjs';
import {
  bindPromptWorkflow,
  bindRecentPromptWorkflow,
} from './continuous-improvement.mjs';
const STRATEGIES = new Set([
  'deterministic-owner',
  'bounded-worker',
  'specialist-owner',
  'frontier-owner',
  'explicit-live',
  'explicit-release',
]);
const EVIDENCE = new Set(['repository', 'external', 'hybrid', 'runtime']);
const BOUNDED_WORKER_MODELS = new Set([
  'mai-code-1.1-flash',
  'gemini-3.7-flash',
  'gpt-5-mini',
  'gpt-5.4-mini',
]);
const DEFAULT_ESCALATION_TRIGGERS = [
  'The deterministic evidence is incomplete or internally contradictory.',
  'The task introduces semantics outside the selected opportunity contract.',
  'A required acceptance gate still fails after one bounded revision.',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function profile(value, label) {
  return validateProfile(value, label);
}

export function readOpportunityPolicy(root, adapter = readAdapter(root)) {
  assert(adapter.opportunityPolicy, 'Repository has no opportunity policy');
  const file = contained(root, adapter.opportunityPolicy);
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (policy.version === 3) {
    assert(typeof adapter.toolRegistry === 'string',
      'Opportunity v3 requires an adapter toolRegistry');
    const registry = validateToolRegistry(
      JSON.parse(fs.readFileSync(contained(root, adapter.toolRegistry), 'utf8')),
      adapter.project,
    );
    const opportunityPacket = adapter.opportunityEvaluation
      ? JSON.parse(fs.readFileSync(contained(root, adapter.opportunityEvaluation), 'utf8'))
      : null;
    const workerPacket = adapter.workerEvaluation
      ? JSON.parse(fs.readFileSync(contained(root, adapter.workerEvaluation), 'utf8'))
      : null;
    validateOpportunityPolicyV3(policy, registry, {
      opportunityPacket,
      workerPacket,
    });
    return { ...policy, toolRegistry: registry };
  }
  if (policy.version === 2) {
    assert(typeof adapter.toolRegistry === 'string', 'Opportunity v2 requires an adapter toolRegistry');
    const registry = validateToolRegistry(
      JSON.parse(fs.readFileSync(contained(root, adapter.toolRegistry), 'utf8')),
      adapter.project,
    );
    validateOpportunityPolicyV2(policy, registry);
    return { ...policy, toolRegistry: registry };
  }
  assert(policy.version === 1 && policy.project === adapter.project, 'Opportunity policy version/project mismatch');
  assert(policy.qualification && policy.qualification.status === 'provisional' &&
    policy.qualification.caseCountPerOpportunity === 3 &&
    policy.qualification.minimumPromotionCases >= 30 &&
    policy.qualification.automaticApplication === false,
  'Version 1 opportunity policies must be explicitly provisional and disable automatic application');
  assert(Array.isArray(policy.opportunities) && policy.opportunities.length > 0, 'Opportunity list required');
  const ids = new Set();
  for (const item of policy.opportunities) {
    assert(item && typeof item === 'object' && !Array.isArray(item), 'Opportunity object required');
    assert(typeof item.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) && !ids.has(item.id),
      'Unique kebab-case opportunity id required');
    ids.add(item.id);
    assert(typeof item.label === 'string' && item.label.length > 0, `${item.id}: label required`);
    assert(Array.isArray(item.triggers) && item.triggers.length > 0 &&
      item.triggers.every(value => typeof value === 'string' && value.length > 1), `${item.id}: triggers required`);
    assert(STRATEGIES.has(item.strategy), `${item.id}: strategy unsupported`);
    assert(EVIDENCE.has(item.evidence), `${item.id}: evidence mode unsupported`);
    profile(item.primary, `${item.id}: primary`);
    if (item.escalation) profile(item.escalation, `${item.id}: escalation`);
    if (item.escalationTriggers !== undefined) {
      assert(item.escalation && Array.isArray(item.escalationTriggers) &&
        item.escalationTriggers.length > 0 &&
        item.escalationTriggers.every(value => typeof value === 'string' && value.length > 0),
      `${item.id}: escalationTriggers require an escalation profile and non-empty strings`);
    }
    assert(Array.isArray(item.skills) && item.skills.every(value => typeof value === 'string'),
      `${item.id}: skills must be strings`);
    assert(item.skills.every(skill => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)),
      `${item.id}: skills must be exact skill IDs`);
    if (item.agents !== undefined) {
      assert(Array.isArray(item.agents) && item.agents.every(value =>
        typeof value === 'string' && value.length > 0), `${item.id}: agents must be strings`);
    }
    assert(Array.isArray(item.tools) && item.tools.length > 0 &&
      item.tools.every(value => typeof value === 'string'), `${item.id}: tools required`);
    assert(Array.isArray(item.gates) && item.gates.length > 0 &&
      item.gates.every(value => typeof value === 'string'), `${item.id}: gates required`);
    assert(['none', 'explicit', 'live', 'release'].includes(item.authorization),
      `${item.id}: authorization unsupported`);
    if (item.strategy === 'bounded-worker') {
      assert(BOUNDED_WORKER_MODELS.has(item.primary.model) && item.delegationClass &&
        adapter.delegation?.allowedClasses?.includes(item.delegationClass),
      `${item.id}: bounded worker must use an allowed provisional model and an adapter-enabled class`);
    } else {
      assert(item.delegationClass === null || item.delegationClass === undefined,
        `${item.id}: owner strategies cannot declare a delegation class`);
    }
    if (item.authorization !== 'none') {
      assert(!['bounded-worker', 'deterministic-owner'].includes(item.strategy),
        `${item.id}: authorized work must retain an explicit owner`);
    }
    if (['explicit-live', 'explicit-release'].includes(item.strategy)) {
      assert(item.primary.model === 'gpt-5.6-sol' &&
        ['medium', 'high'].includes(item.primary.effort) &&
        item.primary.context === 'default',
      `${item.id}: legacy live/release coordination cannot use standing max/long residency`);
    }
  }
  return policy;
}

function deterministicWorkflow(item) {
  const discovery = {
    repository: 'Open only the exact repository symbols, ranges, tests, and contracts needed by this opportunity.',
    external: 'Collect only approved public primary evidence for gaps that are absent from the repository.',
    hybrid: 'Seal the repository ownership/reuse contract first, then research only the remaining approved external gaps.',
    runtime: 'Capture the smallest authorized runtime reproduction or state snapshot without treating observation as mutation authority.',
  }[item.evidence];
  return {
    order: ['discover', 'execute-tools', 'validate-gates', 'owner-judgment', 'escalate-if-triggered'],
    discover: discovery,
    deterministicSteps: item.tools,
    acceptanceGates: item.gates,
    residualJudgment: item.rationale,
    escalationTriggers: item.escalation
      ? (item.escalationTriggers ?? DEFAULT_ESCALATION_TRIGGERS)
      : [],
    authorizationBoundary: item.authorization,
    instruction: item.escalation
      ? 'Complete deterministic discovery, tools, and gates first. Invoke the primary owner only for residual judgment; use escalation only when a named trigger is evidenced.'
      : 'Complete deterministic discovery, tools, and gates first. Invoke the primary owner only for residual judgment.',
  };
}

export function opportunityPlan(task, policy) {
  assert(task && typeof task.question === 'string' && task.question.trim(), 'Question required');
  assert(task.opportunity === undefined || typeof task.opportunity === 'string', 'Opportunity must be a string');
  assert(task.variant === undefined || typeof task.variant === 'string', 'Variant must be a string');
  let matches;
  if (task.opportunity) {
    matches = policy.opportunities.filter(item => item.id === task.opportunity);
  } else {
    const question = task.question.toLowerCase();
    matches = policy.opportunities.filter(item =>
      item.triggers.some(trigger => question.includes(trigger.toLowerCase())));
  }

  if (matches.length !== 1) {
    return {
      status: matches.length === 0 ? 'needs-opportunity' : 'ambiguous-opportunity',
      candidates: matches.map(item => item.id),
      instruction: 'Select one exact repository opportunity; do not guess or combine model pins.',
    };
  }
  const item = matches[0];
  if (policy.version === 3) {
    if (item.variants && !task.variant) {
      return {
        version: 3,
        status: 'needs-variant',
        project: policy.project,
        opportunity: item.id,
        variants: item.variants,
        instruction: 'Select one exact execution variant; release and destructive authorization cannot be combined.',
      };
    }
    if (task.variant && !item.variants?.includes(task.variant)) {
      return {
        version: 3,
        status: 'needs-variant',
        project: policy.project,
        opportunity: item.id,
        variants: item.variants ?? [],
        instruction: 'The requested execution variant is not defined for this opportunity.',
      };
    }
    const selectedPhases = item.phases.filter(phase =>
      !phase.variant || phase.variant === task.variant);
    const receiptPhases = pipelinePhaseContracts(
      item,
      policy.toolRegistry,
      task.variant ?? null,
    );
    const phases = [
      {
        id: 'route-opportunity',
        kind: 'deterministic',
        builtin: 'deterministic-router',
        sideEffect: 'none',
        modelCalls: 0,
      },
      {
        id: 'collect-evidence',
        kind: 'deterministic',
        builtin: 'bounded-evidence-collector',
        sideEffect: 'none',
        modelCalls: 0,
      },
      ...selectedPhases,
    ];
    const plan = {
      version: 3,
      status: item.enabled ? 'ready' : 'disabled',
      project: policy.project,
      opportunity: item.id,
      pipelineId: `${policy.project}-${item.id}`,
      pipelineHash: pipelineContractHash(
        policy.project,
        item,
        policy.toolRegistry,
        task.variant ?? null,
      ),
      label: item.label,
      evidence: item.evidence,
      enabled: item.enabled,
      evaluationStatus: item.evaluationStatus,
      casePacketStatus: item.casePacketStatus,
      team: item.team,
      conditionalProfiles: item.conditionalProfiles,
      variant: task.variant ?? null,
      phases,
      receiptPhases,
      skills: item.skills ?? [],
      rationale: item.rationale,
      requiredSideEffect: requiredPipelineSideEffect(
        { ...item, phases: selectedPhases },
        policy.toolRegistry,
      ),
      qualification: policy.qualification,
      warning: item.enabled
        ? 'Routing and deterministic evidence require zero model calls. Model roles have semantic authority only; repository apply and every external side effect require separate operator authorization.'
        : 'This opportunity is disabled because project policy or case evidence is invalidated. Do not launch replacement models or fabricate evidence.',
    };
    return { ...plan, planHash: sha256(plan) };
  }
  if (policy.version === 2) {
    if (item.variants && !task.variant) {
      return {
        version: 2,
        status: 'needs-variant',
        project: policy.project,
        opportunity: item.id,
        variants: item.variants,
        instruction: 'Select one exact execution variant; authorization and rollback cannot be combined across variants.',
      };
    }
    if (task.variant && !item.variants?.includes(task.variant)) {
      return {
        version: 2,
        status: 'needs-variant',
        project: policy.project,
        opportunity: item.id,
        variants: item.variants ?? [],
        instruction: 'The requested execution variant is not defined for this opportunity.',
      };
    }
    const phases = item.phases.filter(phase => !phase.variant || phase.variant === task.variant);
    const selected = { ...item, phases };
    const sideEffect = requiredSideEffect(selected, policy.toolRegistry);
    const plan = {
      version: 2,
      status: 'ready',
      project: policy.project,
      opportunity: item.id,
      label: item.label,
      evidence: item.evidence,
      semanticOwner: item.semanticOwner,
      escalation: item.escalation ?? null,
      escalationTriggers: item.escalation
        ? (item.escalationTriggers ?? DEFAULT_ESCALATION_TRIGGERS)
        : [],
      variant: task.variant ?? null,
      phases,
      skills: item.skills ?? [],
      agents: item.agents ?? [],
      rationale: item.rationale,
      acceptanceGates: phases.flatMap(phase => phase.validators ?? []),
      executionMachine: item.executionMachine ?? null,
      executionEnabled: item.executionEnabled ?? null,
      requiredSideEffect: sideEffect,
      qualification: policy.qualification,
      warning: 'Authorization is derived from registered phase side effects. Opportunity selection cannot lower a tool authorization requirement.',
    };
    return { ...plan, planHash: sha256(plan) };
  }
  return {
    version: 1,
    status: 'ready',
    project: policy.project,
    opportunity: item.id,
    label: item.label,
    strategy: item.strategy,
    evidence: item.evidence,
    primary: item.primary,
    escalation: item.escalation ?? null,
    skills: item.skills,
    agents: item.agents ?? [],
    tools: item.tools,
    gates: item.gates,
    authorization: item.authorization,
    delegationClass: item.delegationClass ?? null,
    maxRevisions: item.maxRevisions ?? 1,
    qualification: policy.qualification,
    rationale: item.rationale,
    workflow: deterministicWorkflow(item),
    warning: 'Version 1 planning is advisory and provisional. Its string tools and gates are not executable, it does not grant permissions, and it cannot authorize automatic application or waive repository gates.',
  };
}

export function executeOpportunityPhase(root, policy, task, phaseId, authorization, options = {}) {
  const plan = opportunityPlan(task, policy);
  if (plan.version === 3) {
    assert(plan.status === 'ready' ||
      plan.status === 'disabled' && options.allowDisabledDeterministic === true,
    'Executable opportunity requires an enabled plan or explicit disabled-policy deterministic validation');
    const phase = plan.phases.find(item => item.id === phaseId);
    assert(phase?.kind === 'deterministic',
      `Opportunity phase is not a registered deterministic phase: ${phaseId}`);
    const actualRevision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const diagnostic = plan.status === 'disabled' &&
      options.allowDisabledDeterministic === true;
    const currentRevision = diagnostic
      ? options.currentRevision ?? actualRevision
      : options.currentRevision;
    const scopeHash = diagnostic
      ? options.scopeHash ?? sha256({
          project: plan.project,
          opportunity: plan.opportunity,
          phase: phase.id,
          diagnostic: true,
        })
      : options.scopeHash;
    const workflowId = diagnostic
      ? options.workflowId ?? `diagnostic-${plan.pipelineId}`
      : options.workflowId;
    assert(typeof workflowId === 'string' && workflowId.length > 0 &&
      typeof currentRevision === 'string' && currentRevision === actualRevision &&
      typeof scopeHash === 'string' && /^[a-f0-9]{64}$/.test(scopeHash),
    'Version 3 execution requires exact workflow, revision and scope binding');
    const receipts = options.receipts ?? [];
    let verifiedPipeline = null;
    if (!diagnostic) {
      verifiedPipeline = verifyPipelineLegs(receipts, {
        workflowId,
        pipelineHash: plan.pipelineHash,
        pipelineId: plan.pipelineId,
        teamId: plan.team.id,
        project: plan.project,
        opportunityId: plan.opportunity,
        repository: fs.realpathSync(root),
        baseRevision: currentRevision,
        scopeHash,
        expectedPhases: plan.receiptPhases,
      });
      assert(!verifiedPipeline.terminal &&
        verifiedPipeline.nextPhaseId === phase.id &&
        verifiedPipeline.nextPhaseKind === 'deterministic',
      'Deterministic phase is not the next declared pipeline action');
    }
    const tool = toolById(policy.toolRegistry, phase.tool);
    const execution = runRegisteredTool(root, tool, {
      execute: options.execute,
      allowedSideEffects: options.allowedSideEffects,
      operatorAuthorization: options.operatorAuthorization,
      project: plan.project,
      opportunityId: plan.opportunity,
      variant: plan.variant,
      now: options.now,
      currentRevision: options.currentRevision,
      scopeHash: options.scopeHash,
      fakeAdapter: options.fakeAdapter,
      fakeState: options.fakeState,
      fakeScenario: options.fakeScenario,
    });
    return {
      plan,
      phase,
      execution,
      receipt: createPipelineLegReceipt({
        workflowId,
        pipelineHash: plan.pipelineHash,
        pipelineId: plan.pipelineId,
        teamId: plan.team.id,
        project: plan.project,
        opportunityId: plan.opportunity,
        repository: fs.realpathSync(root),
        baseRevision: currentRevision,
        scopeHash,
        phaseId: phase.id,
        phaseKind: 'deterministic',
        role: 'deterministic-tool',
        trustTier: plan.team.trustTier,
        attempt: verifiedPipeline?.activeAttempt ?? 1,
        profile: null,
        authority: 'deterministic-local',
        configurationEvidence: null,
        usage: { state: 'deterministic', modelCalls: 0, credits: 0 },
        state: execution.status === 'accepted' ? 'executed' : 'failed',
        outcome: execution.status,
        durationMs: Math.max(0,
          Date.parse(execution.completedAt) - Date.parse(execution.startedAt)),
        toolEvidence: {
          toolId: execution.toolId,
          toolHash: sha256(tool),
          sideEffect: tool.sideEffect,
          argvHash: execution.argvHash,
          exitCode: execution.exitCode,
          stdoutHash: sha256(execution.stdout ?? ''),
          stderrHash: sha256(execution.stderr ?? ''),
          beforeStateHash: options.beforeStateHash,
          afterStateHash: options.afterStateHash,
        },
        previousReceiptHash: receipts.at(-1)?.receiptHash ?? null,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
      }),
    };
  }
  assert(plan.version === 2 && plan.status === 'ready',
    'Executable opportunity phase requires a ready version 2 plan');
  const phase = plan.phases.find(item => item.id === phaseId);
  assert(phase && phase.executor === 'deterministic',
    `Opportunity phase is not deterministic: ${phaseId}`);
  const phaseIndex = plan.phases.findIndex(item => item.id === phaseId);
  const tool = toolById(policy.toolRegistry, phase.tool);
  assert(typeof options.currentRevision === 'string' &&
    typeof options.scopeHash === 'string' &&
    typeof options.resolvedConfigurationEvidenceHash === 'string',
  'Opportunity execution requires current revision, scope and resolved configuration evidence');
  const resolved = resolvedConfiguration(
    options.resolvedConfigurationEvents,
    plan.semanticOwner,
  );
  assert(resolved.evidenceHash === options.resolvedConfigurationEvidenceHash,
    'Opportunity resolved configuration evidence mismatch');
  const actualRevision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert(actualRevision === options.currentRevision,
    'Opportunity authorization revision does not match the repository');
  const authorized = validateAuthorization(authorization, {
    project: plan.project,
    opportunityId: plan.opportunity,
    variant: plan.variant,
    repository: root,
    requiredSideEffect: phase.sideEffect,
    toolIds: [tool.id],
    now: options.now,
    expectedOwner: plan.semanticOwner,
    expectedBaseRevision: options.currentRevision,
    expectedScopeHash: options.scopeHash,
    expectedResolvedConfigurationEvidenceHash: options.resolvedConfigurationEvidenceHash,
  });
  const receipts = options.receipts ?? [];
  const priorPhases = plan.phases.slice(0, phaseIndex);
  assert(receipts.length === priorPhases.length,
    'Every preceding opportunity phase requires exactly one receipt');
  if (receipts.length > 0) {
    verifyReceiptChain(receipts, {
      workflowId: authorization.workflowId,
      opportunityId: plan.opportunity,
      variant: plan.variant,
      planHash: plan.planHash,
      authorizationHash: authorized.hash,
      stepIds: plan.phases.map(item => item.id),
      steps: plan.phases,
      registry: policy.toolRegistry,
    });
    assert(receipts.every(receipt => receipt.status === 'accepted'),
      'Every preceding opportunity phase must be accepted');
  }
  const execution = runRegisteredTool(root, tool, {
    execute: options.execute,
    allowedSideEffects: options.allowedSideEffects,
    authorization,
    project: plan.project,
    opportunityId: plan.opportunity,
    variant: plan.variant,
    now: options.now,
    expectedOwner: plan.semanticOwner,
    currentRevision: options.currentRevision,
    scopeHash: options.scopeHash,
    resolvedConfigurationEvidenceHash: options.resolvedConfigurationEvidenceHash,
    resolvedConfigurationEvents: options.resolvedConfigurationEvents,
  });
  return {
    plan,
    phase,
    execution,
    receipt: createReceipt({
      workflowId: authorization.workflowId,
      opportunityId: plan.opportunity,
      variant: plan.variant,
      stepId: phase.id,
      executor: 'deterministic',
      planHash: plan.planHash,
      authorizationHash: authorized.hash,
      previousReceiptHash: receipts.at(-1)?.receiptHash ?? null,
      toolId: tool.id,
      toolHash: sha256(tool),
      argvHash: execution.argvHash,
      status: execution.status,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      beforeStateHash: options.beforeStateHash,
      afterStateHash: options.afterStateHash,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
    }),
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, root, taskFile] = process.argv.slice(2);
    const policy = readOpportunityPolicy(root);
    if (command === 'validate') console.log(JSON.stringify(policy, null, 2));
    else if (command === 'plan') {
      const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
      const plan = opportunityPlan(task, policy);
      const sessionId = task.sessionId ?? process.env.COPILOT_SESSION_ID;
      if (sessionId && plan.opportunity &&
        plan.status === 'ready' && plan.enabled !== false) {
        bindPromptWorkflow(root, sessionId, plan.opportunity, plan);
      } else if (!sessionId && plan.opportunity &&
        plan.status === 'ready' && plan.enabled !== false) {
        bindRecentPromptWorkflow(root, task.question, plan.opportunity, plan);
      }
      console.log(JSON.stringify(plan, null, 2));
    } else throw new Error('Usage: opportunities.mjs validate ROOT | plan ROOT TASK.json');
  } catch (error) {
    console.error(`opportunities: ${error.message}`);
    process.exitCode = 1;
  }
}
