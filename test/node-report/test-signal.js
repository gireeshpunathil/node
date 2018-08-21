// Flags: --report-events signal
'use strict';
// Testcase to produce report on signal interrupting a js busy-loop,
// showing it is interruptible.
require('../common');
if (process.argv[2] === 'child') {
  // Exit on loss of parent process
  process.on('disconnect', () => process.exit(2));

  function busyLoop() {
    const list = [];
    for (let i = 0; i < 1e10; i++) {
      for (let j = 0; j < 1000; j++) {
        list.push(new MyRecord());
      }
      for (let k = 0; k < 1000; k++) {
        list[k].id += 1;
        list[k].account += 2;
      }
      for (let l = 0; l < 1000; l++) {
        list.pop();
      }
    }
  }

  function MyRecord() {
    this.name = 'foo';
    this.id = 128;
    this.account = 98454324;
  }

  process.send('child started', busyLoop);
} else {
  const helper = require('./helper.js');
  const fork = require('child_process').fork;
  const assert = require('assert');

  if (helper.isWindows()) {
    assert.fail('Unsupported on Windows', { skip: true });
    return;
  }

  const child = fork(__filename, ['child'], { silent: true });
  // Wait for child to indicate it is ready before sending signal
  child.on('message', () => child.kill('SIGUSR2'));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    // Terminate the child after the report has been written
    if (stderr.includes('Node.js report completed')) {
      child.kill('SIGTERM');
    }
  });
  child.on('exit', (code, signal) => {
    assert.strictEqual(code, null, 'Proces exited unexpectedly');
    assert.deepStrictEqual(signal, 'SIGTERM',
                           'Process exited with unexpected signal');
    const reports = helper.findReports(child.pid);
    assert.strictEqual(reports.length, 1, 'No reports found');
    const report = reports[0];
    helper.validate(report, { pid: child.pid,
                              commandline: child.spawnargs.join(' ')
    });
  });
}
