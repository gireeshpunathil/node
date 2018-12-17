'use strict';
const common = require('../common');
const assert = require('assert');
const { spawn } = require('child_process');

// Harden the thread interactions on the exit path.
// Ensure workers are able to bail out safe at
// arbitrary execution points.

if (process.argv[2] === 'child') {
  const { Worker, isMainThread } = require('worker_threads');
  if (isMainThread) {
    for (let i = 0; i < 10; i++)
      new Worker(__filename);

    // Allow workers to go live.
    setTimeout(() => {
      process.exit(0);
    }, 100);
  } else {
    for (let i = 0; i < 1000; i++) {
      require('v8').deserialize(require('v8').serialize({ foo: 'bar' }));
      require('vm').runInThisContext('x = "foo";');
      eval('const y = "vm";');
    }
  }
} else {
  let stdout, stderr;
  const child = spawn(process.execPath, ['--experimental-worker',
                                         __filename, 'child']);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.on('exit', common.mustCall((code, signal) => {
    assert.strictEqual(code, 0);
    assert.strictEqual(signal, null);
    assert.strictEqual(stdout, undefined);
    assert.strictEqual(stderr, undefined);
  }));
}
