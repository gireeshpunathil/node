'use strict';

// Testcase to check report succeeds if part of process.versions is damaged
require('../common');
if (process.argv[2] === 'child') {
  // Tamper with the process object
  Object.defineProperty(process.versions, 'uv', { get() {
    throw new Error('boom');
  }
  });
  const util = require('util');
  util.triggerNodeReport();
} else {
  const helper = require('./helper.js');
  const spawn = require('child_process').spawn;
  const assert = require('assert');

  const child = spawn(process.execPath, [__filename, 'child']);
  child.on('exit', (code) => {
    assert.strictEqual(code, 0, 'Process exited unexpectedly');
    const reports = helper.findReports(child.pid);
    assert.strictEqual(reports.length, 1, 'No reports found');
    const report = reports[0];
    const validateOpts = { pid: child.pid,
                           expectedVersions: Object.keys(
                             process.versions).filter((c) => c !== 'uv'),
                           commandline: child.spawnargs.join(' ')
    };
    helper.validate(report, validateOpts);
  });
}
