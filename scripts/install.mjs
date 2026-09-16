#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function sameManagedText(left, right) {
  return typeof left === 'string' &&
    typeof right === 'string' &&
    left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n');
}

export function install(root, home, previousRoot = null) {
  const base = fs.realpathSync(root);
  const targets = [
    ['skills/budget-workflow', 'skills/budget-workflow'],
    ['skills/tandem-research', 'skills/tandem-research'],
    ['hooks/budget-reads.json', 'hooks/budget-reads.json'],
    ['hooks/continuous-improvement.json', 'hooks/continuous-improvement.json'],
    ['instructions/budget-workflow.instructions.md', 'instructions/budget-workflow.instructions.md'],
  ];
  const plan = targets.map(([source, target]) => {
    const destination = path.join(home, target);
    const desired = path.join(base, source);
    if (!fs.existsSync(desired)) throw new Error(`Missing source ${source}`);
    const kind = source.startsWith('skills/') ? 'link' : 'file';
    const installedContent = kind === 'file' ? fs.readFileSync(desired, 'utf8') : null;
    let previous = null;
    let previousContent = null;
    if (fs.existsSync(destination) || fs.lstatSync(path.dirname(destination), { throwIfNoEntry: false })) {
      const info = fs.lstatSync(destination, { throwIfNoEntry: false });
      if (info) {
        if (info.isSymbolicLink()) {
          previous = fs.readlinkSync(destination);
          const resolved = path.resolve(path.dirname(destination), previous);
          if (resolved !== desired && (!previousRoot || resolved !== path.join(path.resolve(previousRoot), source))) {
            throw new Error(`Refusing unrecognized existing link: ${destination}`);
          }
        } else if (kind === 'file' && info.isFile()) {
          const currentContent = fs.readFileSync(destination, 'utf8');
          const knownPrevious = previousRoot ? path.join(path.resolve(previousRoot), source) : null;
          const previousSourceContent = knownPrevious && fs.existsSync(knownPrevious)
            ? fs.readFileSync(knownPrevious, 'utf8') : null;
          if (sameManagedText(currentContent, installedContent) ||
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
    return { destination, desired, previous, previousContent, kind, installedContent };
  });
  const receipt = path.join(home, `budget-install-${Date.now()}.json`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify({ version: 1, plan }, null, 2), { flag: 'wx', mode: 0o600 });
  for (const item of plan) {
    fs.mkdirSync(path.dirname(item.destination), { recursive: true });
    if (item.previous !== null || item.previousContent !== null) fs.unlinkSync(item.destination);
    if (item.kind === 'file') fs.writeFileSync(item.destination, item.installedContent, { flag: 'wx', mode: 0o600 });
    else fs.symlinkSync(item.desired, item.destination);
  }
  return { receipt, links: plan.map(item => item.destination) };
}

export function uninstall(receipt) {
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  for (const item of data.plan) {
    const info = fs.lstatSync(item.destination, { throwIfNoEntry: false });
    const unchanged = item.kind === 'file'
      ? info?.isFile() &&
        sameManagedText(fs.readFileSync(item.destination, 'utf8'), item.installedContent)
      : info?.isSymbolicLink() && path.resolve(path.dirname(item.destination), fs.readlinkSync(item.destination)) === item.desired;
    if (!unchanged) {
      throw new Error(`Refusing rollback of changed destination: ${item.destination}`);
    }
  }
  for (const item of data.plan) {
    fs.unlinkSync(item.destination);
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
