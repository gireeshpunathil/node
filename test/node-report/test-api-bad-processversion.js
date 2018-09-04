'use strict';

// Testcase to check report succeeds if process.version is damaged
require('../common');
if (process.argv[2] === 'child') {
  // Tamper with the process object
  delete process.version;
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
    const validateOpts = { pid: child.pid, expectNodeVersion: true,
                           commandline: child.spawnargs.join(' ') };
    helper.validate(report, validateOpts);
  });
}
