'use strict';

// Testcase to produce report on uncaught exception
require('../common');
if (process.argv[2] === 'child') {
  function myException(request, response) {
    const m = '*** test-exception.js: throwing uncaught Error';
    throw new Error(m);
  }

  myException();

} else {
  const helper = require('./helper.js');
  const spawn = require('child_process').spawn;
  const assert = require('assert');

  const child = spawn(process.execPath,
                      ['--report-events', 'exception', __filename, 'child']);
  // Capture stderr output from the child process
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('exit', (code) => {
    assert.strictEqual(code, 1, 'Process exited unexpectedly');
    assert.ok(new RegExp('myException').test(stderr),
              'Check for expected stack trace frame in stderr');
    const reports = helper.findReports(child.pid);
    assert.strictEqual(reports.length, 1, 'No reports found');
    const report = reports[0];
    helper.validate(report, { pid: child.pid,
                              commandline: child.spawnargs.join(' ')
    });
  });
}
