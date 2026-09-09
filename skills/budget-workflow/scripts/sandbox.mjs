import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const digest = value => crypto.createHash('sha256')
  .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  .digest('hex');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function repositoryScratch(repository, prefix) {
  let owner = repository;
  let result = spawnSync('git', [
    '-C', repository, 'rev-parse', '--git-path', 'copilot-budget-scratch',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    owner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    result = spawnSync('git', [
      '-C', owner, 'rev-parse', '--git-path', 'copilot-budget-scratch',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  assert(result.status === 0, 'Repository-owned scratch path is unavailable');
  const root = path.resolve(owner, result.stdout.trim());
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, prefix));
}

function repositoryDependencySource(repository, mount) {
  const resolve = (base, candidate) => {
    const info = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const resolved = fs.realpathSync(candidate);
    const relative = path.relative(fs.realpathSync(base), resolved);
    assert(relative && relative !== '.' &&
      !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `Sandbox dependency source escapes its repository: ${mount.source}`);
    return resolved;
  };
  const direct = resolve(repository, path.join(repository, mount.source));
  if (direct) return direct;
  if (mount.siblingFallback === true) {
    const sibling = repository.replace(/-delegation-\d+$/, '');
    const fallback = path.join(sibling, mount.source);
    if (sibling !== repository) {
      const resolved = resolve(sibling, fallback);
      if (resolved) return resolved;
    }
  }
  throw new Error(`Sandbox dependency source unavailable: ${mount.source}`);
}

function pythonUserSite() {
  const result = spawnSync('python', ['-m', 'site', '--user-site'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(result.status === 0, 'Unable to resolve Python user site-packages');
  const directory = result.stdout.trim();
  assert(fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory(),
    'Python user site-packages is unavailable');
  return fs.realpathSync(directory);
}

function pythonSystemSite(index) {
  const result = spawnSync('python', ['-c',
    'import json,site;print(json.dumps(site.getsitepackages()))'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(result.status === 0, 'Unable to resolve Python system site-packages');
  const directories = JSON.parse(result.stdout);
  const directory = directories[index];
  assert(typeof directory === 'string' &&
    fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory(),
  `Python system site-packages index unavailable: ${index}`);
  return fs.realpathSync(directory);
}

function dependencyTreeHash(root) {
  const entries = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      if (['.cache', '.vite-temp'].includes(name)) continue;
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) {
        entries.push({ path: relative, symlink: fs.readlinkSync(absolute) });
      } else if (info.isDirectory()) {
        walk(absolute);
      } else if (info.isFile()) {
        entries.push({
          path: relative,
          mode: info.mode & 0o777,
          size: info.size,
          sha256: digest(fs.readFileSync(absolute)),
        });
      }
    }
  }
  walk(root);
  return digest(entries);
}

function dependencyMounts(repository, config) {
  return (config.dependencyMounts ?? []).map(mount => {
    const source = mount.sourceKind === 'repository'
      ? repositoryDependencySource(repository, mount)
      : mount.sourceKind === 'python-user-site'
        ? pythonUserSite()
        : pythonSystemSite(mount.systemIndex);
    const target = path.isAbsolute(mount.target)
      ? mount.target
      : `/workspace/${mount.target.replace(/^\.\/+/, '')}`;
    let evidence = null;
    if (mount.evidenceFile) {
      const evidenceFile = path.join(repository, mount.evidenceFile);
      assert(fs.statSync(evidenceFile, { throwIfNoEntry: false })?.isFile(),
        `Sandbox dependency evidence file unavailable: ${mount.evidenceFile}`);
      evidence = {
        file: mount.evidenceFile,
        sha256: digest(fs.readFileSync(evidenceFile)),
      };
    }
    return {
      source,
      sourcePathHash: digest(source),
      target,
      evidence,
      fingerprints: (mount.fingerprintFiles ?? []).map(file => {
        const targetFile = path.join(source, file);
        assert(fs.statSync(targetFile, { throwIfNoEntry: false })?.isFile(),
          `Sandbox dependency fingerprint unavailable: ${file}`);
        return { file, sha256: digest(fs.readFileSync(targetFile)) };
      }),
      treeHash: mount.fingerprintMode === 'tree'
        ? dependencyTreeHash(source)
        : null,
    };
  });
}

function dockerArgs(workspace, config, mounts, command) {
  const args = [
    'run', '--rm', '--pull', 'never',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`,
    '--pids-limit', String(config.pidsLimit),
    '--memory', `${config.memoryMb}m`,
    '--cpus', '1',
    '--tmpfs', `/workspace/.runtime-scratch:rw,nosuid,nodev,noexec,size=64m,uid=${process.getuid?.() ?? 65534},gid=${process.getgid?.() ?? 65534},mode=1777`,
    '--env', 'TMPDIR=/workspace/.runtime-scratch',
    '--env', 'TMP=/workspace/.runtime-scratch',
    '--env', 'TEMP=/workspace/.runtime-scratch',
    '--volume', `${workspace}:/workspace:rw`,
    '--workdir', '/workspace',
  ];
  for (const mount of mounts) args.push('--volume', `${mount.source}:${mount.target}:ro`);
  for (const target of config.tmpfsMounts ?? []) {
    args.push('--tmpfs',
      `${target}:rw,nosuid,nodev,noexec,size=64m,uid=${process.getuid?.() ?? 65534},gid=${process.getgid?.() ?? 65534},mode=1777`);
  }
  for (const [name, value] of Object.entries(config.containerEnvironment ?? {})) {
    args.push('--env', `${name}=${value}`);
  }
  args.push(config.image, ...command);
  return args;
}

function runDocker(workspace, config, mounts, command, timeoutSeconds) {
  return spawnSync('docker', dockerArgs(workspace, config, mounts, command), {
    encoding: 'utf8',
    timeout: timeoutSeconds * 1000,
    maxBuffer: 2_000_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function excluded(relative) {
  const parts = relative.split(path.sep);
  return parts.some(part =>
    part === '.git' ||
    part === 'node_modules' ||
    part === 'dist' ||
    part === 'coverage' ||
    part === '__pycache__' ||
    part === '.pytest_cache' ||
    part === '.cache' ||
    part === '.outbox' ||
    /^\.env(?:\.|$)/.test(part) ||
    /^(credentials|secrets?)$/i.test(part) ||
    /\.(?:pem|key|p12|pfx)$/i.test(part)) ||
    ['logs', 'storage', 'data'].includes(parts[0]);
}

function copyRepository(repository, destination, includePaths = null) {
  const copy = (source, target) => fs.cpSync(source, target, {
    recursive: true,
    filter(value) {
      const relative = path.relative(repository, value);
      if (fs.lstatSync(value).isSymbolicLink()) return false;
      return !relative || !excluded(relative);
    },
  });
  if (!includePaths?.length) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(repository)) {
      if (excluded(name)) continue;
      copy(path.join(repository, name), path.join(destination, name));
    }
    return;
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of includePaths) {
    const source = path.join(repository, relative);
    assert(fs.existsSync(source), `Sandbox include path unavailable: ${relative}`);
    copy(source, path.join(destination, relative));
  }
}

function treeManifest(root) {
  const entries = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
      const info = fs.lstatSync(absolute);
      assert(!info.isSymbolicLink(), `Sandbox source contains a symbolic link: ${relative}`);
      if (info.isDirectory()) walk(absolute);
      else if (info.isFile()) entries.push({
        path: relative,
        mode: info.mode & 0o777,
        sha256: digest(fs.readFileSync(absolute)),
      });
    }
  }
  walk(root);
  return entries;
}

function repositoryIntegrityManifest(root) {
  const repository = fs.realpathSync(root);
  const listed = spawnSync('git', [
    '-C',
    repository,
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8_000_000,
  });
  let paths;
  let indexEntries = new Map();
  if (listed.status === 0) {
    paths = listed.stdout.split('\0').filter(Boolean).sort();
    const staged = spawnSync('git', [
      '-C',
      repository,
      'ls-files',
      '--stage',
      '-z',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8_000_000,
    });
    assert(staged.status === 0,
      'Repository index metadata is unavailable');
    indexEntries = new Map(staged.stdout.split('\0').filter(Boolean)
      .map(entry => {
        const tab = entry.indexOf('\t');
        const [mode, objectId, stage] = entry.slice(0, tab).split(' ');
        const file = entry.slice(tab + 1);
        assert(stage === '0',
          `Unmerged repository entry is not eligible: ${file}`);
        return [file, { indexMode: mode, indexObjectId: objectId }];
      }));
  } else {
    paths = [];
    const walk = directory => {
      for (const name of fs.readdirSync(directory).sort()) {
        if (name === '.git' || name === 'node_modules') continue;
        const absolute = path.join(directory, name);
        const relative = path.relative(repository, absolute)
          .replaceAll(path.sep, '/');
        const info = fs.lstatSync(absolute);
        if (info.isDirectory()) walk(absolute);
        else paths.push(relative);
      }
    };
    walk(repository);
  }
  return paths.map(relative => {
    const index = indexEntries.get(relative) ?? null;
    const absolute = path.join(repository, relative);
    if (index?.indexMode === '160000') {
      const topLevel = spawnSync('git', [
        '-C',
        absolute,
        'rev-parse',
        '--show-toplevel',
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const available = topLevel.status === 0 &&
        fs.realpathSync(topLevel.stdout.trim()) === fs.realpathSync(absolute);
      const checkedOut = available
        ? spawnSync('git', ['-C', absolute, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : null;
      return {
        path: relative,
        type: 'gitlink',
        ...index,
        checkedOutObjectId: available && checkedOut.status === 0
          ? checkedOut.stdout.trim()
          : null,
        workingTreeHash: available && checkedOut.status === 0
          ? digest(repositoryIntegrityManifest(absolute))
          : null,
      };
    }
    const info = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!info) return { path: relative, type: 'missing', ...index };
    if (info.isSymbolicLink()) {
      return {
        path: relative,
        type: 'symlink',
        mode: info.mode & 0o777,
        target: fs.readlinkSync(absolute),
        ...index,
      };
    }
    if (info.isFile()) {
      return {
        path: relative,
        type: 'file',
        mode: info.mode & 0o777,
        sha256: digest(fs.readFileSync(absolute)),
        ...index,
      };
    }
    return {
      path: relative,
      type: info.isDirectory() ? 'directory' : 'other',
      mode: info.mode & 0o777,
      ...index,
    };
  });
}

export function repositoryTreeHash(root) {
  return digest(repositoryIntegrityManifest(root));
}

export function repositoryTreeHashWithCandidate(root, candidate) {
  const repository = fs.realpathSync(root);
  const entries = new Map(repositoryIntegrityManifest(repository)
    .map(entry => [entry.path, entry]));
  for (const file of candidate.files) {
    const target = path.join(repository, file.path);
    const relative = path.relative(repository, target)
      .replaceAll(path.sep, '/');
    assert(relative && !relative.startsWith('../') &&
      !path.isAbsolute(relative),
    `Staged file escapes repository hash: ${file.path}`);
    const current = fs.lstatSync(target, { throwIfNoEntry: false });
    entries.set(relative, {
      path: relative,
      type: 'file',
      mode: current?.isFile() ? current.mode & 0o777 : 0o644,
      sha256: digest(file.content),
      ...(entries.get(relative)?.indexMode
        ? {
            indexMode: entries.get(relative).indexMode,
            indexObjectId: entries.get(relative).indexObjectId,
          }
        : {}),
    });
  }
  return digest([...entries.values()].sort((left, right) =>
    left.path.localeCompare(right.path)));
}

export function verifySandboxReceipt(receipt) {
  assert(receipt && receipt.version === 1 && receipt.provider === 'docker',
    'Docker sandbox receipt required');
  const { evidenceHash, ...evidence } = receipt;
  assert(evidenceHash === digest(evidence), 'Sandbox evidence hash mismatch');
  assert(receipt.network === 'none' && receipt.readOnlyRoot === true &&
    receipt.capabilities === 'dropped' && receipt.noNewPrivileges === true,
  'Sandbox isolation evidence is incomplete');
  assert(typeof receipt.repositoryStateHash === 'string' &&
    /^[a-f0-9]{64}$/.test(receipt.repositoryStateHash),
  'Sandbox repository state hash is required');
  return receipt;
}

function manifestMap(entries) {
  return new Map(entries.map(entry => [entry.path, entry]));
}

function changedPaths(before, after) {
  const left = manifestMap(before);
  const right = manifestMap(after);
  return [...new Set([...left.keys(), ...right.keys()])].filter(file =>
    JSON.stringify(left.get(file) ?? null) !== JSON.stringify(right.get(file) ?? null)).sort();
}

function stageFiles(root, files) {
  for (const file of files) {
    const target = path.join(root, file.path);
    const relative = path.relative(root, target);
    assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      `Staged file escapes sandbox: ${file.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
}

export function validateSandboxConfig(config) {
  assert(config && config.provider === 'docker', 'Docker sandbox configuration required');
  assert(typeof config.image === 'string' && config.image.length > 0,
    'Sandbox image required');
  if (config.expectedImageId !== undefined) {
    assert(/^sha256:[a-f0-9]{64}$/.test(config.expectedImageId),
      'Sandbox expectedImageId must be a sha256 image ID');
  }
  assert(Number.isInteger(config.memoryMb) && config.memoryMb >= 64 &&
    config.memoryMb <= 4096, 'Sandbox memory must be 64-4096 MB');
  assert(Number.isInteger(config.pidsLimit) && config.pidsLimit >= 16 &&
    config.pidsLimit <= 512, 'Sandbox pidsLimit must be 16-512');
  assert(Array.isArray(config.allowedCollateralPaths ?? []) &&
    (config.allowedCollateralPaths ?? []).every(value =>
      typeof value === 'string' && value.length > 0 && value !== '.' &&
      !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') &&
      !/(^|\/)(?:\.git|\.env|credentials|secrets?)(?:\/|$)/i.test(value)),
  'Sandbox collateral paths must be safe repository-relative paths');
  assert(Array.isArray(config.dependencyMounts ?? []), 'Sandbox dependency mounts must be an array');
  for (const mount of config.dependencyMounts ?? []) {
    assert(['repository', 'python-user-site', 'python-system-site'].includes(mount.sourceKind),
      'Sandbox dependency mount sourceKind unsupported');
    if (mount.sourceKind === 'repository') {
      assert(typeof mount.source === 'string' && mount.source.length > 0 &&
        mount.source !== '.' &&
        /(^|\/)node_modules$/.test(mount.source.replaceAll('\\', '/')) &&
        !path.isAbsolute(mount.source) && !mount.source.split(/[\\/]/).includes('..'),
      'Repository dependency mount requires a safe relative source');
      assert(mount.siblingFallback === undefined || mount.siblingFallback === true,
        'Repository dependency siblingFallback must be true when present');
    }
    if (mount.sourceKind === 'python-system-site') {
      assert(Number.isInteger(mount.systemIndex) && mount.systemIndex >= 0,
        'Python system site mount requires systemIndex');
    }
    assert(typeof mount.target === 'string' && mount.target.length > 0,
      'Sandbox dependency mount target required');
    const relativeTarget = !path.isAbsolute(mount.target);
    assert(relativeTarget && mount.target !== '.' &&
      /(^|\/)node_modules$/.test(mount.target.replaceAll('\\', '/')) &&
      !mount.target.split(/[\\/]/).includes('..') ||
      /^\/opt\/python-(?:user|system-\d+)$/.test(mount.target),
    'Sandbox dependency mount target is not allowed');
    assert(mount.readOnly === true, 'Sandbox dependency mounts must be read-only');
    if (mount.evidenceFile !== undefined) {
      assert(typeof mount.evidenceFile === 'string' && mount.evidenceFile.length > 0 &&
        !path.isAbsolute(mount.evidenceFile) &&
        !mount.evidenceFile.split(/[\\/]/).includes('..'),
      'Sandbox dependency evidenceFile must be repository-relative');
    }
    assert(Array.isArray(mount.fingerprintFiles ?? []) &&
      (mount.fingerprintFiles ?? []).every(value =>
        typeof value === 'string' && value.length > 0 &&
        !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..')),
    'Sandbox dependency fingerprint files must be safe relative paths');
    assert(mount.fingerprintMode === undefined ||
      ['files', 'tree'].includes(mount.fingerprintMode),
    'Sandbox dependency fingerprintMode unsupported');
  }
  assert(Array.isArray(config.runtimeChecks ?? []) &&
    (config.runtimeChecks ?? []).every(check =>
      Array.isArray(check.argv) && check.argv.length > 0 &&
      check.argv.every(value => typeof value === 'string' && value.length > 0)),
  'Sandbox runtime checks require argv arrays');
  assert(Array.isArray(config.writablePaths ?? []) &&
    (config.writablePaths ?? []).every(value =>
      typeof value === 'string' && value.length > 0 && value !== '.' &&
      !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') &&
      !/(^|\/)(?:\.git|\.env|credentials|secrets?)(?:\/|$)/i.test(value)),
  'Sandbox writable paths must be explicit safe repository-relative directories');
  assert(Array.isArray(config.includePaths ?? []) &&
    (config.includePaths ?? []).every(value =>
      typeof value === 'string' && value.length > 0 && value !== '.' &&
      !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') &&
      !excluded(value)),
  'Sandbox include paths must be explicit safe repository-relative paths');
  assert(config.containerEnvironment === undefined ||
    config.containerEnvironment && typeof config.containerEnvironment === 'object' &&
    !Array.isArray(config.containerEnvironment) &&
    Object.entries(config.containerEnvironment).every(([name, value]) =>
      /^[A-Z][A-Z0-9_]*$/.test(name) && typeof value === 'string' &&
      !/(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)/.test(name)),
  'Sandbox container environment must contain fixed non-secret values');
  assert(Array.isArray(config.tmpfsMounts ?? []) &&
    (config.tmpfsMounts ?? []).every(value =>
      typeof value === 'string' &&
      /^\/workspace\/(?:[^/]+\/)*node_modules\/\.vite-temp$/.test(value)),
  'Sandbox tmpfs mounts are limited to dependency cache paths');
  return config;
}

export function dockerSandboxAvailable(image) {
  const result = spawnSync('docker', ['image', 'inspect', image], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function dockerImageId(image) {
  const result = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(result.status === 0, `Sandbox image is unavailable locally: ${image}`);
  return result.stdout.trim();
}

export function validateSandboxReadiness({ repository, config }) {
  validateSandboxConfig(config);
  const source = fs.realpathSync(repository);
  const temporary = repositoryScratch(source, 'budget-sandbox-readiness-');
  fs.chmodSync(temporary, 0o755);
  const workspace = path.join(temporary, 'workspace');
  try {
    copyRepository(source, workspace, config.includePaths);
    fs.chmodSync(workspace, 0o755);
    for (const relative of config.writablePaths ?? []) {
      const directory = path.join(workspace, relative);
      fs.mkdirSync(directory, { recursive: true });
      fs.chmodSync(directory, 0o777);
    }
    const imageId = dockerImageId(config.image);
    if (config.expectedImageId) {
      assert(imageId === config.expectedImageId,
        `Sandbox image ID mismatch for ${config.image}`);
    }
    const mounts = dependencyMounts(source, config);
    const runtimeChecks = (config.runtimeChecks ?? []).map(check => {
      const result = runDocker(
        workspace,
        config,
        mounts,
        check.argv,
        check.timeoutSeconds ?? 30,
      );
      return {
        argvHash: digest(check.argv),
        exitCode: result.status,
        error: result.error?.message ?? null,
        stdoutHash: digest(result.stdout ?? ''),
        stderrHash: digest(result.stderr ?? ''),
      };
    });
    const receipt = {
      version: 1,
      kind: 'sandbox-readiness',
      provider: 'docker',
      image: config.image,
      imageId,
      configHash: digest(config),
      dependencyMounts: mounts.map(({
        sourcePathHash,
        target,
        evidence,
        fingerprints,
        treeHash,
      }) => ({
        sourcePathHash,
        target,
        evidence,
        fingerprints,
        treeHash,
        readOnly: true,
      })),
      runtimeChecks,
      ready: runtimeChecks.every(check =>
        check.exitCode === 0 && check.error === null),
    };
    return { ...receipt, evidenceHash: digest(receipt) };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifySandboxReadiness(receipt) {
  assert(receipt?.version === 1 &&
    receipt.kind === 'sandbox-readiness' &&
    receipt.provider === 'docker',
  'Sandbox readiness receipt required');
  const { evidenceHash, ...evidence } = receipt;
  assert(evidenceHash === digest(evidence),
    'Sandbox readiness evidence hash mismatch');
  assert(receipt.ready === true,
    'Sandbox runtime or dependency readiness failed');
  return receipt;
}

export function validateCandidateInSandbox({
  repository,
  candidate,
  validator,
  config,
  repositoryStateHash,
}) {
  validateSandboxConfig(config);
  assert(candidate && Array.isArray(candidate.files) && candidate.files.length > 0,
    'Sandbox candidate files required');
  assert(validator && Array.isArray(validator.argv) && validator.argv.length > 0 &&
    validator.argv.every(value => typeof value === 'string' && value.length > 0),
  'Sandbox validator argv required');
  assert(Number.isInteger(validator.timeoutSeconds) && validator.timeoutSeconds >= 1 &&
    validator.timeoutSeconds <= 1800, 'Sandbox validator timeout must be 1-1800 seconds');
  const source = fs.realpathSync(repository);
  assert(typeof repositoryStateHash === 'string' &&
    /^[a-f0-9]{64}$/.test(repositoryStateHash),
  'Full repository state hash required');
  const temporary = repositoryScratch(source, 'budget-sandbox-');
  fs.chmodSync(temporary, 0o755);
  const workspace = path.join(temporary, 'workspace');
  try {
    copyRepository(source, workspace, config.includePaths);
    fs.chmodSync(workspace, 0o755);
    for (const relative of config.writablePaths ?? []) {
      const directory = path.join(workspace, relative);
      fs.mkdirSync(directory, { recursive: true });
      fs.chmodSync(directory, 0o777);
    }
    const beforeCandidate = treeManifest(workspace);
    stageFiles(workspace, candidate.files);
    const expected = treeManifest(workspace);
    const imageId = dockerImageId(config.image);
    if (config.expectedImageId) {
      assert(imageId === config.expectedImageId,
        `Sandbox image ID mismatch for ${config.image}`);
    }
    const mounts = dependencyMounts(source, config);
    const runtimeChecks = (config.runtimeChecks ?? []).map(check => {
      const result = runDocker(
        workspace,
        config,
        mounts,
        check.argv,
        check.timeoutSeconds ?? 30,
      );
      return {
        argvHash: digest(check.argv),
        exitCode: result.status,
        error: result.error?.message ?? null,
        stdoutHash: digest(result.stdout ?? ''),
        stderrHash: digest(result.stderr ?? ''),
      };
    });
    const runtimeReady = runtimeChecks.every(check =>
      check.exitCode === 0 && check.error === null);
    const execution = runtimeReady
      ? runDocker(workspace, config, mounts, validator.argv, validator.timeoutSeconds)
      : { status: null, signal: null, error: new Error('Sandbox runtime check failed'), stdout: '', stderr: '' };
    const after = treeManifest(workspace);
    const allowed = config.allowedCollateralPaths ?? [];
    const collateralChanges = changedPaths(expected, after).filter(file =>
      !allowed.some(prefix => file === prefix || file.startsWith(`${prefix.replace(/\/+$/, '')}/`)));
    const passed = runtimeReady && execution.status === 0 &&
      !execution.error && collateralChanges.length === 0;
    const receipt = {
      version: 1,
      provider: 'docker',
      image: config.image,
      imageId,
      network: 'none',
      readOnlyRoot: true,
      capabilities: 'dropped',
      noNewPrivileges: true,
      user: `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`,
      dependencyMounts: mounts.map(({ sourcePathHash, target, evidence, fingerprints, treeHash }) => ({
        sourcePathHash,
        target,
        evidence,
        fingerprints,
        treeHash,
        readOnly: true,
      })),
      runtimeChecks,
      runtimeReady,
      writablePaths: config.writablePaths ?? [],
      candidateSha256: digest(candidate.files),
      repositoryStateHash,
      sourceTreeHash: digest(beforeCandidate),
      expectedTreeHash: digest(expected),
      resultingTreeHash: digest(after),
      validatorArgvHash: digest(validator.argv),
      exitCode: execution.status,
      signal: execution.signal,
      error: execution.error?.message ?? null,
      stdoutHash: digest(execution.stdout ?? ''),
      stderrHash: digest(execution.stderr ?? ''),
      collateralChanges,
      passed,
    };
    return {
      receipt: { ...receipt, evidenceHash: digest(receipt) },
      stdout: (execution.stdout ?? '').slice(-4000),
      stderr: (execution.stderr ?? '').slice(-4000),
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
