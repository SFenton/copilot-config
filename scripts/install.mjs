#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

function sameManagedText(left, right) {
  return typeof left === 'string' &&
    typeof right === 'string' &&
    left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n');
}

function parseSettings(content, source) {
  let settings;
  try {
    settings = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}: ${error.message}`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`Expected a JSON object in ${source}`);
  }
  return settings;
}

function mergeSettings(desiredContent, currentContent, previousContent, destination) {
  const desired = parseSettings(desiredContent, 'settings.json');
  const current = currentContent === null
    ? {}
    : parseSettings(currentContent, destination);
  const previous = previousContent === null
    ? {}
    : parseSettings(previousContent, 'previous settings.json');
  const merged = { ...current };
  const ownedKeys = new Set([...Object.keys(previous), ...Object.keys(desired)]);

  for (const key of ownedKeys) {
    const hasCurrent = Object.hasOwn(current, key);
    const hasDesired = Object.hasOwn(desired, key);
    const hasPrevious = Object.hasOwn(previous, key);
    const recognized = !hasCurrent ||
      (hasDesired && isDeepStrictEqual(current[key], desired[key])) ||
      (hasPrevious && isDeepStrictEqual(current[key], previous[key]));
    if (!recognized) {
      throw new Error(`Refusing to replace unrecognized setting "${key}" in ${destination}`);
    }
    if (hasDesired) merged[key] = desired[key];
    else delete merged[key];
  }

  return `${JSON.stringify(merged, null, 2)}\n`;
}

export function install(root, home, previousRoot = null) {
  const base = fs.realpathSync(root);
  const targets = [
    ['skills/tandem-research', 'skills/tandem-research', 'link'],
    ['instructions/core-safety.instructions.md', 'instructions/core-safety.instructions.md', 'file'],
    ['settings.json', 'settings.json', 'settings'],
  ];
  const retiredTargets = [
    ['skills/budget-workflow', 'link'],
    ['hooks/budget-reads.json', 'file'],
    ['hooks/continuous-improvement.json', 'file'],
    ['instructions/budget-workflow.instructions.md', 'file'],
  ];
  const installedPlan = targets.map(([source, target, kind]) => {
    const destination = path.join(home, target);
    const desired = path.join(base, source);
    if (!fs.existsSync(desired)) throw new Error(`Missing source ${source}`);
    const desiredContent = kind === 'link' ? null : fs.readFileSync(desired, 'utf8');
    const knownPrevious = previousRoot ? path.join(path.resolve(previousRoot), source) : null;
    const previousSourceContent = knownPrevious && fs.existsSync(knownPrevious) && kind !== 'link'
      ? fs.readFileSync(knownPrevious, 'utf8') : null;
    let installedContent = desiredContent;
    let previous = null;
    let previousContent = null;
    if (fs.existsSync(destination) || fs.lstatSync(path.dirname(destination), { throwIfNoEntry: false })) {
      const info = fs.lstatSync(destination, { throwIfNoEntry: false });
      if (info) {
        if (info.isSymbolicLink()) {
          if (kind !== 'link') {
            throw new Error(`Refusing to replace unrecognized existing link: ${destination}`);
          }
          previous = fs.readlinkSync(destination);
          const resolved = path.resolve(path.dirname(destination), previous);
          if (resolved !== desired && (!previousRoot || resolved !== path.join(path.resolve(previousRoot), source))) {
            throw new Error(`Refusing unrecognized existing link: ${destination}`);
          }
        } else if (kind !== 'link' && info.isFile()) {
          const currentContent = fs.readFileSync(destination, 'utf8');
          if (kind === 'settings') {
            previousContent = currentContent;
            installedContent = mergeSettings(
              desiredContent,
              currentContent,
              previousSourceContent,
              destination,
            );
          } else if (sameManagedText(currentContent, installedContent) ||
            sameManagedText(currentContent, previousSourceContent)) {
            previousContent = currentContent;
          } else {
            throw new Error(`Refusing to replace unrecognized file/directory: ${destination}`);
          }
        } else {
          throw new Error(`Refusing to replace unrecognized file/directory: ${destination}`);
        }
      }
    }
    if (kind === 'settings' && previousContent === null) {
      installedContent = mergeSettings(desiredContent, null, previousSourceContent, destination);
    }
    return { destination, desired, previous, previousContent, kind, installedContent };
  });
  const retiredPlan = retiredTargets.flatMap(([source, kind]) => {
    const destination = path.join(home, source);
    const info = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (!info) return [];
    const oldSource = path.join(base, source);
    const previousSource = previousRoot
      ? path.join(path.resolve(previousRoot), source)
      : null;
    if (kind === 'link') {
      if (!info.isSymbolicLink()) {
        throw new Error(`Refusing to retire unrecognized file/directory: ${destination}`);
      }
      const previous = fs.readlinkSync(destination);
      const resolved = path.resolve(path.dirname(destination), previous);
      if (resolved !== oldSource && resolved !== previousSource) {
        throw new Error(`Refusing to retire unrecognized link: ${destination}`);
      }
      return [{ destination, desired: null, previous, previousContent: null,
        kind: 'retired-link', installedContent: null }];
    }
    if (!info.isFile()) {
      throw new Error(`Refusing to retire unrecognized file/directory: ${destination}`);
    }
    const previousContent = fs.readFileSync(destination, 'utf8');
    const recognized = [oldSource, previousSource]
      .filter(sourcePath => sourcePath && fs.existsSync(sourcePath))
      .some(sourcePath => sameManagedText(
        previousContent, fs.readFileSync(sourcePath, 'utf8'),
      ));
    if (!recognized) {
      throw new Error(`Refusing to retire unrecognized file: ${destination}`);
    }
    return [{ destination, desired: null, previous: null, previousContent,
      kind: 'retired-file', installedContent: null }];
  });
  const plan = [...installedPlan, ...retiredPlan];
  const receipt = path.join(home, `copilot-install-${Date.now()}-${randomUUID()}.json`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify({ version: 1, plan }, null, 2), { flag: 'wx', mode: 0o600 });
  for (const item of plan) {
    if (item.kind.startsWith('retired-')) {
      fs.unlinkSync(item.destination);
      continue;
    }
    fs.mkdirSync(path.dirname(item.destination), { recursive: true });
    if (item.previous !== null || item.previousContent !== null) fs.unlinkSync(item.destination);
    if (item.kind === 'link') fs.symlinkSync(item.desired, item.destination);
    else fs.writeFileSync(item.destination, item.installedContent, { flag: 'wx', mode: 0o600 });
  }
  return {
    receipt,
    links: installedPlan.filter(item => item.kind === 'link').map(item => item.destination),
    retired: retiredPlan.map(item => item.destination),
  };
}

export function uninstall(receipt) {
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  for (const item of data.plan) {
    const info = fs.lstatSync(item.destination, { throwIfNoEntry: false });
    const unchanged = item.kind.startsWith('retired-')
      ? !info
      : item.kind === 'link'
      ? info?.isSymbolicLink() &&
        path.resolve(path.dirname(item.destination), fs.readlinkSync(item.destination)) === item.desired
      : info?.isFile() &&
        sameManagedText(fs.readFileSync(item.destination, 'utf8'), item.installedContent);
    if (!unchanged) {
      throw new Error(`Refusing rollback of changed destination: ${item.destination}`);
    }
  }
  for (const item of data.plan) {
    if (!item.kind.startsWith('retired-')) fs.unlinkSync(item.destination);
    if (item.previous !== null) fs.symlinkSync(item.previous, item.destination);
    else if (item.previousContent !== null && item.previousContent !== undefined) {
      fs.writeFileSync(item.destination, item.previousContent, { flag: 'wx', mode: 0o600 });
    }
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (process.argv[2] === '--rollback') uninstall(process.argv[3]);
    else console.log(JSON.stringify(install(root, process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot'), process.argv[2]), null, 2));
  } catch (error) { console.error(`install: ${error.message}`); process.exitCode = 1; }
}
