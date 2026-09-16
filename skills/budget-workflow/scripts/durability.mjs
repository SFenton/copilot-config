import fs from 'node:fs';

export function fsyncDirectory(directory, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return false;
  const fileSystem = options.fileSystem ?? fs;
  const descriptor = fileSystem.openSync(directory, 'r');
  try {
    fileSystem.fsyncSync(descriptor);
    return true;
  } finally {
    fileSystem.closeSync(descriptor);
  }
}
