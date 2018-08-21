'use strict';

// Testcase for passing an error object to the API call.
require('../common');
const assert = require('assert');
if (process.argv[2] === 'child') {
  const util = require('util');
  try {
    throw new Error('Testing error handling');
  } catch (err) {
    util.triggerNodeReport(err);
  }
} else {
  const helper = require('./helper.js');
  const spawn = require('child_process').spawn;

  const child = spawn(process.execPath, [__filename, 'child']);
  child.on('exit', (code) => {
    assert.strictEqual(code, 0, 'Process exited unexpectedly');
    const reports = helper.findReports(child.pid);
    assert.strictEqual(reports.length, 1, 'No reports found');
    const report = reports[0];
    helper.validate(report, { pid: child.pid,
                              commandline: child.spawnargs.join(' '),
                              expectedException: 'Testing error handling',
    });
  });
}
