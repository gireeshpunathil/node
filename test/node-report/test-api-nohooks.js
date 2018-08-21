'use strict';

// Testcase to produce report via API call, using the no-hooks/no-signal
// interface - i.e. require('node-report/api')
require('../common');
if (process.argv[2] === 'child') {
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
    helper.validate(report, { pid: child.pid,
                              commandline: child.spawnargs.join(' ')
    });
  });
}
