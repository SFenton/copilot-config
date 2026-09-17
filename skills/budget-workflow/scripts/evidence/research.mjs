#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskPlan } from './modes.mjs';
import { readAdapter } from '../budget.mjs';
import { run } from '../run-leaf.mjs';
import { validateConfig, EvidenceBroker } from './broker.mjs';
import {
  PACKET_LIMITS,
  buildFrozenEvidencePacket,
  createEvidencePacketReceipt,
  sha256,
  validateFrozenEvidencePacket,
} from './schemas.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function splitRepositoryExcerpt(entry) {
  const lines = String(entry.text ?? '').split('\n');
  const chunks = [];
  let current = [];
  let currentStart = entry.citation.start;
  let currentEnd = entry.citation.start - 1;
  let size = 0;
  for (const line of lines) {
    const parsed = /^(\d+):\s?(.*)$/.exec(line);
    const lineNumber = parsed ? Number(parsed[1]) : currentEnd + 1;
    const content = parsed ? parsed[2] : line;
    const candidate = `${lineNumber}: ${content}`;
    if (size > 0 && size + candidate.length + 1 > PACKET_LIMITS.maxExcerptCharacters) {
      chunks.push({
        sourceId: entry.sourceId,
        citation: {
          kind: 'repository',
          path: entry.citation.path,
          start: currentStart,
          end: currentEnd,
        },
        text: current.join('\n'),
        focus: entry.focus ?? null,
      });
      current = [];
      currentStart = lineNumber;
      size = 0;
    }
    current.push(candidate);
    currentEnd = lineNumber;
    size += candidate.length + 1;
  }
  if (current.length > 0) {
    chunks.push({
      sourceId: entry.sourceId,
      citation: {
        kind: 'repository',
        path: entry.citation.path,
        start: currentStart,
        end: currentEnd,
      },
      text: current.join('\n'),
      focus: entry.focus ?? null,
    });
  }
  return chunks;
}

function splitEvidenceExcerpt(entry) {
  const text = String(entry.text ?? '').trim();
  if (!text) return [];
  if (text.length <= PACKET_LIMITS.maxExcerptCharacters) return [entry];
  if (entry.citation.kind === 'repository') return splitRepositoryExcerpt(entry);
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += PACKET_LIMITS.maxExcerptCharacters) {
    const slice = text.slice(offset, offset + PACKET_LIMITS.maxExcerptCharacters).trim();
    if (!slice) continue;
    chunks.push({
      sourceId: entry.sourceId,
      citation: entry.citation,
      text: slice,
      focus: entry.focus ?? null,
    });
  }
  return chunks;
}

function brokerPacketInput(task, repoRoot, sessionDirectory) {
  const session = path.resolve(sessionDirectory);
  const config = JSON.parse(fs.readFileSync(path.join(session, 'broker-config.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(session, 'broker-state.json'), 'utf8'));
  const plan = taskPlan(task, task.mode === 'external' ? null : repoRoot ? readAdapter(repoRoot) : null);
  assert(plan.mode !== 'history', 'Use history.mjs for history packets');
  const catalog = Object.entries(state.sources ?? {})
    .map(([id, source]) => {
      if (source.kind === 'repository') {
        return {
          id,
          kind: 'repository',
          path: source.path,
          start: source.start,
          end: source.end,
          sha256: source.sha256,
          openedAt: state.contract?.at ?? task.createdAt ?? new Date().toISOString(),
          completeUnit: source.completeUnit === true,
        };
      }
      return {
        id,
        kind: 'external',
        url: source.url,
        title: source.title,
        sha256: source.sha256,
        verifiedAt: source.verifiedAt,
        paragraphIds: source.paragraphIds,
      };
    });
  const excerpts = Object.values(state.openedEvidence ?? {})
    .flatMap(entries => entries.flatMap(splitEvidenceExcerpt))
    .map((entry, index) => ({
      id: `rx_${String(index + 1).padStart(2, '0')}`,
      sourceId: entry.sourceId,
      citation: entry.citation,
      text: entry.text,
      textHash: sha256(entry.text),
      focus: entry.focus ?? null,
    }));
  return {
    plan,
    config,
    state,
    packetInput: {
      workflowId: exactString(task.workflowId, 'workflowId'),
      promptHash: exactString(task.promptHash, 'promptHash'),
      question: task.question,
      mode: plan.mode,
      scope: task.scope ?? [plan.mode],
      repository: plan.mode === 'external'
        ? null
        : {
          root: path.resolve(repoRoot),
          baseRevision: exactString(task.baseRevision, 'baseRevision'),
          policyHash: sha256(config.repoPolicy ?? {}),
        },
      sourceCatalog: catalog,
      excerpts,
      createdAt: task.createdAt ?? new Date().toISOString(),
      expiresAt: task.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      parentPacketHash: task.parentPacketHash ?? null,
      deltaFromPacketHash: task.deltaFromPacketHash ?? null,
    },
  };
}

function exactString(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} required`);
  return value;
}

export function researchRequest(task, repoRoot, cacheDir) {
  const history = task.mode === 'history' || task.historyRequested === true;
  const external = task.mode === 'external' ||
    (task.mode === 'auto' && task.externalRequired === true && task.repositoryRelevant === false);
  const adapter = history || external ? null : repoRoot ? readAdapter(repoRoot) : null;
  const plan = taskPlan(task, adapter);
  if (plan.status !== 'ready') throw new Error(plan.instruction);
  if (plan.phase !== 'research') throw new Error('This runner is research-only; implementation/validation/release remain project-owned workflows');
  if (plan.mode === 'history') {
    return {
      plan,
      request: null,
      instruction: 'Use history.mjs plan/run/packet for deterministic history extraction, then optionally run a packet-only gpt-5.6-luna low/default or medium/default reason-only leaf.',
    };
  }
  if (!external && !adapter?.evidencePolicy) throw new Error('Project needs an evidencePolicy; do not flatten old release gates into research');
  const config = {
    mode: plan.mode,
    cacheDir: path.resolve(cacheDir),
    ...(external ? {} : { repoRoot: path.resolve(repoRoot), repoPolicy: adapter.evidencePolicy.content }),
    ...(plan.mode === 'repository' ? {} : { web: task.web }),
    maxOperations: task.maxOperations ?? 24,
    maxReturnedCharacters: task.maxReturnedCharacters ?? 160000,
    stateFile: path.join(path.resolve(cacheDir), 'validation-only.json'),
  };
  validateConfig(config);
  return {
    plan,
    request: {
      config,
      instruction: 'Collect evidence deterministically with init/evidence, then freeze a packet before any model reasoning.',
    },
  };
}

export function sourceReferences(packet) {
  const verified = validateFrozenEvidencePacket(packet);
  return verified.sourceCatalog.map(source => source.kind === 'repository'
    ? `- \`${source.id}\`: ${source.path}:${source.start}-${source.end} (SHA-256 ${source.sha256})`
    : source.kind === 'external'
      ? `- \`${source.id}\`: ${source.url} (verified ${source.verifiedAt}; SHA-256 ${source.sha256})`
      : `- \`${source.id}\`: ${source.sessionRef} via ${source.templateId} (query ${source.queryHash.slice(0, 12)})`).join('\n');
}

export function createEvidencePacket(task, repoRoot, sessionDirectory) {
  const { plan, packetInput } = brokerPacketInput(task, repoRoot, sessionDirectory);
  const packet = buildFrozenEvidencePacket(packetInput, {
    overflowStrategy: 'trim',
  });
  return {
    plan,
    packet,
    receipt: createEvidencePacketReceipt(packet),
  };
}

function reasonOnlyPrompt(task, plan, packet) {
  return [
    'Reason only from the frozen evidence packet below.',
    'Do not use tools. Do not ask for tools. Do not assume unstated evidence.',
    'Return strict JSON only.',
    'Allowed shapes:',
    '- {"version":2,"kind":"findings","packetHash":"...","findings":[{"id":"...","summary":"...","confidence":"low|medium|high","citations":[{"sourceId":"...","quote":"optional"}]}],"remainingUncertainty":["..."]}',
    '- {"version":2,"kind":"blocked","packetHash":"...","blockedReason":"...","findings":[],"remainingUncertainty":["..."]}',
    '- {"version":2,"kind":"evidence-gap-request","packetHash":"...","loop":1|2,"expectedDecisionImpact":"...","requests":[{"mode":"repository|external|hybrid|history","query":"optional","path":"optional","focus":"optional","template":"optional","maxBytes":16384}]}',
    `Question: ${task.question}`,
    `Mode: ${plan.mode}`,
    `Packet hash: ${packet.packetHash}`,
    `Packet: ${JSON.stringify(packet)}`,
  ].join('\n');
}

function packetForRun(task, repoRoot) {
  if (task.packet) return validateFrozenEvidencePacket(task.packet);
  if (task.packetFile) return validateFrozenEvidencePacket(
    JSON.parse(fs.readFileSync(task.packetFile, 'utf8')),
  );
  if (task.evidenceSession) {
    return createEvidencePacket(task, repoRoot, task.evidenceSession).packet;
  }
  throw new Error('Provide packet, packetFile, or evidenceSession before launching the packet-only reason-only leg');
}

export function reasonOnlyLeafRequest(task, repoRoot) {
  const external = task.mode === 'external' ||
    (task.mode === 'auto' && task.externalRequired === true && task.repositoryRelevant === false);
  const adapter = task.mode === 'history' || external ? null : repoRoot ? readAdapter(repoRoot) : null;
  const plan = taskPlan(task, adapter);
  assert(plan.status === 'ready', plan.instruction ?? 'Research plan is not ready');
  const packet = packetForRun(task, repoRoot);
  const prompt = reasonOnlyPrompt(task, plan, packet);
  return {
    plan,
    packet,
    request: {
      prompt,
      model: task.profile?.model ?? plan.model,
      effort: task.profile?.effort ?? plan.effort,
      context: task.profile?.context ?? plan.context,
      toolMode: plan.toolMode,
      evidencePacket: packet,
      expectedResultKind: task.expectedResultKind ?? null,
      sanitized: task.sanitized === true,
      maxCredits: task.maxCredits ?? 60,
      timeoutSeconds: task.timeoutSeconds ?? 240,
      ledger: task.ledger,
    },
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, taskFile, repoRoot, outputDirectory, cacheDir] = process.argv.slice(2);
    const task = command === 'evidence' ? null : JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    const root = repoRoot === '-' ? null : repoRoot;
    if (command === 'evidence') {
      const session = taskFile;
      const operation = repoRoot;
      const data = JSON.parse(outputDirectory);
      const broker = new EvidenceBroker(JSON.parse(fs.readFileSync(path.join(session, 'broker-config.json'), 'utf8')));
      if (!['find', 'open', 'contract'].includes(operation)) throw new Error('Unknown evidence operation');
      console.log(JSON.stringify(await broker[operation](data), null, 2));
    } else if (command === 'plan') {
      const external = task.mode === 'external' || (task.mode === 'auto' && task.externalRequired && !task.repositoryRelevant);
      const adapter = task.mode === 'history' || external ? null : root ? readAdapter(root) : null;
      console.log(JSON.stringify(taskPlan(task, adapter), null, 2));
    } else if (command === 'init') {
      const { plan, request, instruction } = researchRequest(task, root, cacheDir);
      assert(plan.mode !== 'history', instruction);
      fs.mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
      const config = { ...request.config, stateFile: path.join(path.resolve(outputDirectory), 'broker-state.json') };
      fs.writeFileSync(path.join(outputDirectory, 'broker-config.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({
        plan,
        session: path.resolve(outputDirectory),
        instruction,
      }, null, 2));
    } else if (command === 'packet') {
      const built = createEvidencePacket(task, root, outputDirectory);
      console.log(JSON.stringify(built, null, 2));
    } else if (command === 'validate-packet') {
      console.log(JSON.stringify(validateFrozenEvidencePacket(
        JSON.parse(fs.readFileSync(taskFile, 'utf8')),
      ), null, 2));
    } else if (command === 'run') {
      const { plan, packet, request } = reasonOnlyLeafRequest(task, root);
      const result = await run(request, outputDirectory);
      const answers = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'answer.json'), 'utf8'));
      fs.writeFileSync(path.join(outputDirectory, 'report.md'),
        `${answers.at(-1)?.content ?? ''}\n\n## Source references\n\n${sourceReferences(packet)}\n`, { flag: 'wx' });
      console.log(JSON.stringify({ plan, packetHash: packet.packetHash, result, report: path.join(outputDirectory, 'report.md') }, null, 2));
    } else throw new Error('Usage: research.mjs plan TASK ROOT|- | init TASK ROOT|- NEW_OUTPUT CACHE | evidence SESSION find|open|contract JSON | packet TASK ROOT|- SESSION | validate-packet PACKET.json | run TASK ROOT|- NEW_OUTPUT CACHE');
  } catch (error) {
    console.error(`research: ${error.message}`);
    process.exitCode = 1;
  }
}
