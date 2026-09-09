#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { markUnknown, normalizeUsage, reserve, settle } from './usage.mjs';
import { contained, packet as buildEvidencePacket } from './budget.mjs';
import { SUPPORTED_MODELS, resolvedConfiguration } from './workflow.mjs';

const researchTools = ['view', 'rg', 'grep', 'glob'];
const brokerFunctions = ['evidence_find', 'evidence_open', 'evidence_contract'];
export const brokerToolNames = brokerFunctions.flatMap(name => [
  `budget_evidence-${name}`, `budget_evidence_${name}`, `mcp__budget_evidence__${name}`, name,
]);

export function terminateOwnedProcessTree(child, signal = 'SIGTERM') {
  if (!Number.isInteger(child.pid) || child.pid <= 1) return false;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || (process.platform === 'win32' && error.status === 128)) return false;
    throw error;
  }
}

export function parseRunEvents(text, timedOut) {
  const lines = text.split('\n').filter(Boolean);
  const events = [];
  let truncated = false;
  for (const [index, line] of lines.entries()) {
    try { events.push(JSON.parse(line)); } catch (error) {
      if (timedOut && index === lines.length - 1) truncated = true;
      else throw error;
    }
  }
  return { events, truncated };
}

export function verifyEvidencePacket(workspace, supplied) {
  if (!supplied || !Array.isArray(supplied.sources) || supplied.sources.length === 0) {
    throw new Error('Nonempty evidence packet required');
  }
  const corpus = verifyCorpus(workspace);
  if (supplied.sources.some(source => !corpus.sources.some(item => item.path === source.file))) {
    throw new Error('Packet references a file outside the frozen corpus');
  }
  const rebuilt = buildEvidencePacket(workspace, supplied.sources.map(({ file, start, end }) => ({ file, start, end })));
  if (JSON.stringify(rebuilt) !== JSON.stringify(supplied)) throw new Error('Evidence packet differs from source');
  return true;
}

export function verifyCorpus(workspace, expectedHash) {
  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'corpus.json'), 'utf8'));
  if (!Array.isArray(manifest.sources) || !manifest.sources.length) throw new Error('Frozen research corpus required');
  const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (expectedHash && expectedHash !== manifestHash) throw new Error('Corpus manifest changed');
  for (const source of manifest.sources) {
    const file = contained(workspace, source.path);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (digest !== source.sha256) throw new Error(`Corpus changed: ${source.path}`);
  }
  return manifest;
}

export function researchToolRequestAllowed(request, workspace) {
  if (!researchTools.includes(request.name)) return false;
  let args = request.arguments;
  if (typeof args === 'string') args = JSON.parse(args);
  if (!args || typeof args !== 'object') return false;
  const selected = args.paths ?? args.path ?? args.file_path ?? workspace;
  const paths = Array.isArray(selected) ? selected : [selected];
  return paths.length > 0 && paths.every(value => {
    if (typeof value !== 'string') return false;
    const absolute = path.resolve(workspace, value);
    const relative = path.relative(workspace, absolute);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

export function invocation(request, outputDirectory, mcpNames = []) {
  if (!request || typeof request.prompt !== 'string' || !request.prompt.trim() ||
    Buffer.byteLength(request.prompt) > 64000) throw new Error('Supply a nonempty reviewed prompt <=64 KB');
  if (request.sanitized !== true) throw new Error('Explicit sanitized=true attestation required; never send secrets');
  if (!(SUPPORTED_MODELS.has(request.model) || request.model === 'hydrafusion')) {
    throw new Error('Unsupported model: choose an explicit reviewed profile');
  }
  if (!Number.isFinite(request.maxCredits) || request.maxCredits < 30 || request.maxCredits > 500) {
    throw new Error('Explicit maxCredits must be 30-500 (CLI soft cap, not a hard limit)');
  }
  if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 10 || request.timeoutSeconds > 600) {
    throw new Error('timeoutSeconds must be 10-600');
  }
  if (!['low', 'medium', 'high', 'max'].includes(request.effort)) throw new Error('Explicit supported effort required');
  if (!['default', 'long_context'].includes(request.context)) throw new Error('Explicit context required');
  if (request.toolMode !== undefined && !['research', 'broker'].includes(request.toolMode)) throw new Error('Unknown tool mode');
  const research = request.toolMode === 'research';
  const broker = request.toolMode === 'broker';
  if (broker && (!request.brokerConfig || mcpNames.includes('budget_evidence'))) throw new Error('Broker configuration missing or owned MCP name conflicts');
  if (research && (typeof request.workspace !== 'string' || !path.isAbsolute(request.workspace))) {
    throw new Error('Research workspace must be explicit and absolute');
  }
  const args = [
    '-C', research ? request.workspace : outputDirectory, '--model', request.model, '--context', request.context,
    '--max-ai-credits', String(request.maxCredits), '--max-autopilot-continues', '0',
    '--available-tools', ...(broker ? brokerToolNames : research ? researchTools : ['fetch_copilot_cli_documentation']),
    '--disallow-temp-dir',
    '--deny-tool=fetch_copilot_cli_documentation',
    '--deny-tool=shell', '--deny-tool=write', '--deny-tool=url',
    '--disable-builtin-mcps', '--no-custom-instructions',
    '--no-remote-export', '--no-ask-user', '--no-auto-update', '--no-bash-env',
    '--output-format', 'json', '--usage-output-file', path.join(outputDirectory, 'usage.json'),
    '--log-dir', path.join(outputDirectory, 'logs'),
  ];
  if (request.model === 'hydrafusion') args.push('--experimental');
  if (!['hydrafusion', 'claude-haiku-4.5'].includes(request.model)) args.push('--effort', request.effort);
  for (const name of mcpNames) args.push('--disable-mcp-server', name);
  if (broker) {
    args.push('--additional-mcp-config', JSON.stringify({ mcpServers: { budget_evidence: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./evidence/server.mjs', import.meta.url)), path.join(outputDirectory, 'broker-config.json')],
      tools: ['*'],
    } } }), '--allow-tool=budget_evidence');
  }
  args.push('-p', request.prompt);
  return args;
}

function configuredMcpNames() {
  const file = path.join(process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot'), 'mcp-config.json');
  if (!fs.existsSync(file)) return [];
  return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers ?? {});
}

export async function run(request, outputDirectory) {
  const directory = path.resolve(outputDirectory);
  const args = invocation(request, directory, configuredMcpNames());
  const research = request.toolMode === 'research';
  const broker = request.toolMode === 'broker';
  const workspace = research ? fs.realpathSync(request.workspace) : directory;
  const corpusHash = research
    ? crypto.createHash('sha256').update(JSON.stringify(verifyCorpus(workspace))).digest('hex') : null;
  const packetVerified = research && request.evidencePacket !== undefined
    ? verifyEvidencePacket(workspace, request.evidencePacket) : false;
  if (request.evidencePacket !== undefined && (!packetVerified || !request.prompt.includes(JSON.stringify(request.evidencePacket)))) {
    throw new Error('Verified evidence packet must be included verbatim in the research prompt');
  }
  // Exclusive directory creation prevents overwriting prior evidence or racing another run.
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  let brokerConfig = null;
  if (broker) {
    brokerConfig = { ...request.brokerConfig, stateFile: path.join(directory, 'broker-state.json') };
    fs.writeFileSync(path.join(directory, 'broker-config.json'), JSON.stringify(brokerConfig), { flag: 'wx', mode: 0o600 });
  }
  const start = Date.now();
  const reservationId = crypto.randomUUID();
  if (request.ledger) reserve(request.ledger, reservationId, request.maxCredits);
  const manifest = {
    version: 1, model: request.model,
    effort: ['hydrafusion', 'claude-haiku-4.5'].includes(request.model) ? null : request.effort,
    context: request.context, softCreditCap: request.maxCredits,
    promptSha256: crypto.createHash('sha256').update(request.prompt).digest('hex'),
    promptBytes: Buffer.byteLength(request.prompt), startedAt: new Date(start).toISOString(),
    toolAccess: broker ? 'mode-scoped evidence MCP only; no native filesystem, history, shell, direct URL or mutation tools'
      : research ? 'frozen-corpus read/search only; no shell, network or mutations'
      : 'documentation schema only, denied; no repository/network/mutation tools',
    workspace: research ? workspace : null, corpusHash, packetVerified, sanitized: true,
    brokerConfigHash: brokerConfig ? crypto.createHash('sha256').update(JSON.stringify(brokerConfig)).digest('hex') : null,
    evidencePacketHash: packetVerified
      ? crypto.createHash('sha256').update(JSON.stringify(request.evidencePacket)).digest('hex') : null,
    reservationId: request.ledger ? reservationId : null,
  };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const output = fs.openSync(path.join(directory, 'events.jsonl'), 'wx', 0o600);
  const error = fs.openSync(path.join(directory, 'stderr.txt'), 'wx', 0o600);
  const env = { ...process.env };
  delete env.COPILOT_ALLOW_ALL;
  let child;
  try {
    // A dedicated process group permits cancelling the loader AND its CLI child.
    // It stays awaited and is never unref'd or used as a persistent daemon.
    child = spawn('copilot', args, { cwd: workspace, env, detached: process.platform !== 'win32',
      stdio: ['ignore', output, error] });
  } finally {
    fs.closeSync(output);
    fs.closeSync(error);
  }
  let timedOut = false;
  const cleanup = () => terminateOwnedProcessTree(child, 'SIGKILL');
  process.once('exit', cleanup);
  const signalHandlers = new Map([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]].map(([signal, code]) => {
    const handler = () => { cleanup(); process.exit(code); };
    process.once(signal, handler);
    return [signal, handler];
  }));
  const timer = setTimeout(() => { timedOut = true; terminateOwnedProcessTree(child); }, request.timeoutSeconds * 1000);
  const hardTimer = setTimeout(cleanup, (request.timeoutSeconds + 5) * 1000);
  const exit = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    cleanup();
    process.removeListener('exit', cleanup);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  });
  const { events, truncated } = parseRunEvents(fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8'), timedOut);
  const usagePresent = fs.existsSync(path.join(directory, 'usage.json'));
  if (request.ledger) {
    if (usagePresent) {
      try {
        const usage = normalizeUsage(JSON.parse(
          fs.readFileSync(path.join(directory, 'usage.json'), 'utf8'),
        ));
        settle(request.ledger, reservationId, usage.credits);
      } catch (error) {
        markUnknown(request.ledger, reservationId,
          `Usage telemetry could not be reconciled: ${error.message}`);
        throw error;
      }
    } else {
      markUnknown(request.ledger, reservationId,
        'Leaf completed without usage telemetry; exact billed usage requires later reconciliation.');
    }
  }
  let configured;
  try {
    configured = resolvedConfiguration(events, {
      model: request.model,
      effort: manifest.effort,
      context: request.context,
    });
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({
      ...manifest,
      ...exit,
      timedOut,
      durationMs: Date.now() - start,
      usagePresent,
      eventLogTruncated: truncated,
      resolvedConfiguration: null,
      configurationVerified: false,
      configurationError: error.message,
      warning: 'The model leg is invalid because exact resolved runtime configuration evidence is missing or mismatched.',
    }, null, 2));
    throw error;
  }
  const toolRequested = events.some(event =>
    event.type === 'tool.execution_start' || (event.data?.toolRequests?.length ?? 0) > 0);
  const toolProfiles = events.filter(event => event.type === 'session.usage_checkpoint')
    .flatMap(event => (event.data.promptCacheBreakState ?? []).flatMap(state =>
      Object.values(state.models ?? {}).map(model => ({ count: model.tool_count, tools: model.tools }))));
  const toolRequests = events.filter(event => event.type === 'assistant.message')
    .flatMap(event => event.data.toolRequests ?? []);
  const toolIsolationVerified = toolProfiles.length > 0 && toolProfiles.every(profile =>
    broker ? Array.isArray(profile.tools) && profile.count === profile.tools.length &&
      profile.tools.length >= 2 && profile.tools.every(tool => brokerToolNames.includes(tool.name)) :
      research
      ? Array.isArray(profile.tools) && profile.count === profile.tools.length &&
        profile.tools.every(tool => researchTools.includes(tool.name))
      : profile.count === 0 || (profile.count === 1 && profile.tools?.length === 1 &&
        profile.tools[0].name === 'fetch_copilot_cli_documentation'));
  const scopeVerified = broker ? toolRequests.every(tool => brokerToolNames.includes(tool.name)) :
    !research || toolRequests.every(tool => researchToolRequestAllowed(tool, workspace));
  if (research) verifyCorpus(workspace, corpusHash);
  const answer = events.filter(event => event.type === 'assistant.message')
    .map(event => ({ model: event.data.model, content: event.data.content }));
  fs.writeFileSync(path.join(directory, 'answer.json'), JSON.stringify(answer, null, 2));
  const result = {
    ...manifest, ...exit, timedOut, durationMs: Date.now() - start,
    resolvedConfiguration: configured,
    configurationVerified: true,
    usagePresent,
    eventLogTruncated: truncated, cancellationScope: 'owned-process-tree',
    toolRequested, toolIsolationVerified, scopeVerified, toolCalls: toolRequests.length,
    answerHash: crypto.createHash('sha256').update(JSON.stringify(answer)).digest('hex'),
    warning: 'No automatic retry. A failed/timed-out run may still be billed; missing usage is unknown, never zero.',
  };
  if (broker) {
    const stateFile = path.join(directory, 'broker-state.json');
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    result.brokerEvidenceVerified = Boolean(state && state.configHash === manifest.brokerConfigHash &&
      (brokerConfig.mode === 'external' ? state.webReads > 0 :
        brokerConfig.mode === 'repository' ? state.repositoryReads > 0 :
          state.repositoryReads > 0 && state.webReads > 0 && state.contract));
    result.evidenceMode = brokerConfig.mode;
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  if (exit.code !== 0 || timedOut || !result.usagePresent || (!research && !broker && toolRequested) ||
      (broker && !result.brokerEvidenceVerified) ||
      !toolIsolationVerified || !scopeVerified || (research && toolRequests.length === 0 && !packetVerified)) {
    throw new Error(`Leaf incomplete or isolation unverified; inspect ${directory}/result.json and stderr.txt`);
  }
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    console.log(JSON.stringify(await run(request, process.argv[3]), null, 2));
  } catch (error) {
    console.error(`run-leaf: ${error.message}`);
    process.exitCode = 1;
  }
}
