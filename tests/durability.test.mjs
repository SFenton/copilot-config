import test from 'node:test';
import assert from 'node:assert/strict';
import { fsyncDirectory } from '../skills/budget-workflow/scripts/durability.mjs';

test('directory fsync is skipped only on Windows', () => {
  const fileSystem = {
    openSync() {
      throw new Error('Windows must not open a directory for fsync');
    },
  };
  assert.equal(fsyncDirectory('ignored', {
    platform: 'win32',
    fileSystem,
  }), false);
});

test('directory fsync remains strict on Linux and macOS', () => {
  for (const platform of ['darwin', 'linux']) {
    const calls = [];
    const fileSystem = {
      openSync(directory, mode) {
        calls.push(['open', directory, mode]);
        return 42;
      },
      fsyncSync(descriptor) {
        calls.push(['fsync', descriptor]);
      },
      closeSync(descriptor) {
        calls.push(['close', descriptor]);
      },
    };
    assert.equal(fsyncDirectory('/fixture', { platform, fileSystem }), true);
    assert.deepEqual(calls, [
      ['open', '/fixture', 'r'],
      ['fsync', 42],
      ['close', 42],
    ]);
  }
});

test('directory fsync closes descriptors and propagates POSIX failures', () => {
  const error = Object.assign(new Error('sync failed'), { code: 'EIO' });
  const calls = [];
  const fileSystem = {
    openSync() {
      return 7;
    },
    fsyncSync() {
      throw error;
    },
    closeSync(descriptor) {
      calls.push(descriptor);
    },
  };
  assert.throws(() => fsyncDirectory('/fixture', {
    platform: 'linux',
    fileSystem,
  }), error);
  assert.deepEqual(calls, [7]);
});
