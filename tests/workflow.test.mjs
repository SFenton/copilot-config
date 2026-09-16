import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratch } from './helpers/scratch.mjs';
import {
  createReceipt,
  requiredSideEffect,
  resolvedConfiguration,
  runRegisteredTool,
  sha256,
  validateAuthorization,
  validateOpportunityPolicyV2,
  validateToolRegistry,
  verifyReceiptChain,
} from '../skills/budget-workflow/scripts/workflow.mjs';

const profile = { model: 'gpt-5.6-sol', effort: 'high', context: 'default' };
const registry = {
  version: 1,
  project: 'sample',
  tools: [
    {
      id: 'inspect-value',
      kind: 'command',
      argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
      cwd: '.',
      timeoutSeconds: 10,
      sideEffect: 'none',
      environment: [],
    },
    {
      id: 'publish-value',
      kind: 'command',
      argv: [process.execPath, '-e', 'process.stdout.write("publish")'],
      cwd: '.',
      timeoutSeconds: 10,
      sideEffect: 'production',
      environment: [],
    },
    {
      id: 'disabled-release',
      kind: 'disabled',
      reason: 'External release driver is not implemented',
      sideEffect: 'production',
      environment: [],
    },
  ],
};

test('phase-level policy represents deterministic, bounded-model and frontier work', () => {
  validateToolRegistry(registry);
  const policy = validateOpportunityPolicyV2({
    version: 2,
    project: 'sample',
    qualification: {
      status: 'provisional',
      automaticApplication: false,
      minimumPromotionCases: 30,
    },
    opportunities: [{
      id: 'mixed-work',
      label: 'Mixed work',
      triggers: ['mixed work'],
      semanticOwner: profile,
      phases: [
        { id: 'inspect', executor: 'deterministic', tool: 'inspect-value', sideEffect: 'none' },
        {
          id: 'generate',
          executor: 'bounded-model',
          sideEffect: 'none',
          capability: 'sample-tests',
          sandboxProfile: 'sample-tests',
          profile: { model: 'gpt-5-mini', effort: 'medium', context: 'default' },
        },
        { id: 'review', executor: 'frontier', sideEffect: 'production' },
        { id: 'publish', executor: 'deterministic', tool: 'publish-value', sideEffect: 'production' },
      ],
    }],
  }, registry);
  assert.equal(requiredSideEffect(policy.opportunities[0], registry), 'production');
  assert.throws(() => validateOpportunityPolicyV2({
    ...policy,
    opportunities: [{
      ...policy.opportunities[0],
      phases: [
        { id: 'review', executor: 'frontier', sideEffect: 'none' },
        {
          id: 'bad',
          executor: 'deterministic',
          tool: 'inspect-value',
          sideEffect: 'none',
          profile,
        },
      ],
    }],
  }, registry), /cannot use a model/);
});

test('authorization side effects are monotonic and bound to exact tools', () => {
  const root = makeScratch('workflow-auth-');
  const base = {
    version: 1,
    kind: 'frontier-authorization',
    workflowId: 'workflow-1',
    opportunityId: 'mixed-work',
    project: 'sample',
    repository: root,
    baseRevision: 'abc123',
    scopeHash: 'a'.repeat(64),
    nonce: 'nonce-1',
    issuedAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-09T00:00:00.000Z',
    resolvedConfigurationEvidenceHash: 'b'.repeat(64),
    allowedSideEffect: 'workspace',
    toolIds: ['inspect-value'],
    owner: profile,
  };
  assert.equal(validateAuthorization(base, {
    project: 'sample',
    opportunityId: 'mixed-work',
    repository: root,
    requiredSideEffect: 'none',
    toolIds: ['inspect-value'],
    now: Date.parse('2026-09-08T12:00:00.000Z'),
  }).hash.length, 64);
  assert.throws(() => validateAuthorization(base, {
    project: 'sample',
    opportunityId: 'mixed-work',
    repository: root,
    requiredSideEffect: 'production',
    toolIds: ['publish-value'],
    now: Date.parse('2026-09-08T12:00:00.000Z'),
  }), /too weak|omits/);
  assert.throws(() => validateAuthorization(base, {
    project: 'sample',
    opportunityId: 'mixed-work',
    repository: root,
    requiredSideEffect: 'none',
    toolIds: ['inspect-value'],
    expectedOwner: { model: 'gpt-5-mini', effort: 'medium', context: 'default' },
    now: Date.parse('2026-09-08T12:00:00.000Z'),
  }), /owner mismatch/);
  assert.throws(() => validateAuthorization({
    ...base,
    inferredApproval: true,
  }, {
    project: 'sample',
    opportunityId: 'mixed-work',
    repository: root,
    requiredSideEffect: 'none',
    toolIds: ['inspect-value'],
    now: Date.parse('2026-09-08T12:00:00.000Z'),
  }), /unsupported fields/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('registered command execution uses explicit side-effect admission', () => {
  const root = makeScratch('workflow-tool-');
  const result = runRegisteredTool(root, registry.tools[0], {
    execute: true,
    allowedSideEffects: ['none'],
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.stdout, 'ok');
  const legacy = runRegisteredTool(root, registry.tools[0], {
    execute: true,
    allowedSideEffects: ['none'],
    trustedEnvironment: {
      RELEASE_AUTHORIZED_SCOPE_HASH: 'a'.repeat(64),
    },
  });
  assert.equal(legacy.status, 'accepted');
  assert.equal(legacy.stdout, 'ok');
  assert.throws(() => runRegisteredTool(root, registry.tools[1], {
    execute: true,
    allowedSideEffects: ['none'],
  }), /not enabled/);
  assert.throws(() => runRegisteredTool(root, registry.tools[1], {
    execute: true,
    allowedSideEffects: ['production'],
  }), /operator authorization/);
  assert.throws(() => runRegisteredTool(root, registry.tools[2], {
    execute: true,
    allowedSideEffects: ['production'],
  }), /disabled/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('release authorization environment only comes from trusted runner input', () => {
  const root = makeScratch('workflow-trusted-env-');
  const tool = {
    id: 'release-context',
    kind: 'command',
    argv: [
      process.execPath,
      '-e',
      'process.stdout.write(process.env.RELEASE_AUTHORIZED_SCOPE_HASH ?? "missing")',
    ],
    cwd: '.',
    timeoutSeconds: 10,
    sideEffect: 'none',
    environment: ['RELEASE_AUTHORIZED_SCOPE_HASH'],
  };
  const homeTool = {
    ...tool,
    id: 'release-home',
    argv: [
      process.execPath,
      '-e',
      'process.stdout.write(process.env.HOME ?? "missing")',
    ],
    environment: ['HOME'],
  };
  const previous = process.env.RELEASE_AUTHORIZED_SCOPE_HASH;
  process.env.RELEASE_AUTHORIZED_SCOPE_HASH = 'ambient-forgery';
  try {
    assert.equal(runRegisteredTool(root, tool, {
      execute: true,
      allowedSideEffects: ['none'],
    }).stdout, 'missing');
    assert.equal(runRegisteredTool(root, tool, {
      execute: true,
      allowedSideEffects: ['none'],
      trustedEnvironment: {
        RELEASE_AUTHORIZED_SCOPE_HASH: 'a'.repeat(64),
      },
    }).stdout, 'a'.repeat(64));
    assert.equal(runRegisteredTool(root, homeTool, {
      execute: true,
      allowedSideEffects: ['none'],
    }).stdout, process.env.HOME);
  } finally {
    if (previous === undefined) delete process.env.RELEASE_AUTHORIZED_SCOPE_HASH;
    else process.env.RELEASE_AUTHORIZED_SCOPE_HASH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt chains reject forged, duplicated and out-of-order evidence', () => {
  const common = {
    workflowId: 'workflow-1',
    opportunityId: 'mixed-work',
    executor: 'deterministic',
    planHash: 'c'.repeat(64),
    authorizationHash: 'd'.repeat(64),
    status: 'accepted',
    beforeStateHash: 'e'.repeat(64),
    afterStateHash: 'f'.repeat(64),
    startedAt: '2026-09-08T00:00:00.000Z',
    completedAt: '2026-09-08T00:00:01.000Z',
  };
  const first = createReceipt({ ...common, stepId: 'inspect' });
  const second = createReceipt({
    ...common,
    stepId: 'review',
    executor: 'frontier',
    previousReceiptHash: first.receiptHash,
  });
  const context = {
    workflowId: common.workflowId,
    opportunityId: common.opportunityId,
    planHash: common.planHash,
    authorizationHash: common.authorizationHash,
    stepIds: ['inspect', 'review'],
  };
  assert.equal(verifyReceiptChain([first, second], context).valid, true);
  assert.throws(() => verifyReceiptChain([{ ...first, evidenceHash: '0'.repeat(64) }], context),
    /evidence hash/);
  assert.throws(() => verifyReceiptChain([second, first], context), /chain|order/);
  assert.throws(() => verifyReceiptChain([first, first], context), /duplicate|chain|order/);
});

test('resolved model configuration requires exact event evidence', () => {
  const expected = { model: 'gpt-5.6-sol', effort: 'max', context: 'long_context' };
  const event = {
    type: 'subagent.configured',
    data: {
      model: expected.model,
      reasoningEffort: expected.effort,
      contextTier: expected.context,
    },
  };
  const result = resolvedConfiguration([event], expected);
  assert.equal(result.evidenceHash, sha256(event));
  assert.throws(() => resolvedConfiguration([], expected),
    /subagent\.configured or model\.call_start/);
  assert.throws(() => resolvedConfiguration([{
    ...event,
    data: { ...event.data, reasoningEffort: 'high' },
  }], expected), /effort mismatch/);
});

test('resolved model configuration accepts the current CLI telemetry shape only when it is exact and complete', () => {
  const expected = { model: 'gpt-5.4', effort: 'medium', context: 'default' };
  const events = [
    {
      type: 'model.call_start',
      data: {
        model: expected.model,
        reasoningEffort: expected.effort,
        contextTier: expected.context,
      },
    },
    {
      type: 'session.tools_updated',
      data: {
        tools: [{ name: 'fetch_copilot_cli_documentation' }],
      },
    },
    {
      type: 'session.usage_checkpoint',
      data: {
        promptCacheBreakState: [{
          models: {
            [expected.model]: {
              tool_count: 0,
              tools: [],
            },
          },
        }],
      },
    },
  ];
  const resolved = resolvedConfiguration(events, expected);
  assert.equal(resolved.model, expected.model);
  assert.equal(resolved.effort, expected.effort);
  assert.equal(resolved.context, expected.context);
  assert.equal(resolved.source,
    'model.call_start+session.tools_updated+session.usage_checkpoint');
  assert.throws(() => resolvedConfiguration([
    ...events,
    {
      type: 'model.call_start',
      data: {
        model: expected.model,
        reasoningEffort: 'high',
        contextTier: expected.context,
      },
    },
  ], expected), /ambiguous|mismatch/);
  assert.throws(() => resolvedConfiguration(events.filter(event =>
    event.type !== 'session.tools_updated'), expected), /session\.tools_updated/);
  assert.throws(() => resolvedConfiguration(events.filter(event =>
    event.type !== 'session.usage_checkpoint'), expected), /session\.usage_checkpoint/);
  assert.throws(() => resolvedConfiguration([
    {
      type: 'subagent.configured',
      data: {
        model: expected.model,
        reasoningEffort: 'high',
        contextTier: expected.context,
      },
    },
    ...events,
  ], expected), /conflicts|mismatch/);
  assert.throws(() => resolvedConfiguration([
    events[0],
    {
      type: 'session.tools_updated',
      data: {
        tools: [{ name: 'fetch_copilot_cli_documentation' }],
      },
    },
    {
      type: 'session.tools_updated',
      data: {
        tools: [{ name: 'view' }],
      },
    },
    events[2],
  ], expected), /telemetry is ambiguous/);
  assert.throws(() => resolvedConfiguration([
    events[0],
    events[1],
    {
      type: 'session.usage_checkpoint',
      data: {
        promptCacheBreakState: [{
          models: {
            other: {
              tool_count: 0,
              tools: [],
            },
          },
        }],
      },
    },
  ], expected), /conflicts with the resolved model/);
});
