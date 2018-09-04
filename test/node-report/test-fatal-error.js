'use strict';

require('../common');
const assert = require('assert');
// Testcase to produce report on fatal error (javascript heap OOM)
if (process.argv[2] === 'child') {

  const list = [];
  while (true) {
    const record = new MyRecord();
    list.push(record);
  }

  function MyRecord() {
    this.name = 'foo';
    this.id = 128;
    this.account = 98454324;
  }
} else {
  const helper = require('./helper.js');
  const spawn = require('child_process').spawn;

  const args = ['--report-events',
                'fatalerror',
                '--max-old-space-size=20',
                __filename,
                'child'];
  const child = spawn(process.execPath, args);
  child.on('exit', (code) => {
    assert.notStrictEqual(code, 0, 'Process exited unexpectedly');
    const reports = helper.findReports(child.pid);
    assert.strictEqual(reports.length, 1, 'No reports found');
    const report = reports[0];
    const options = { pid: child.pid };
    // Node.js currently overwrites the command line on AIX
    // https://github.com/nodejs/node/issues/10607
    if (!(helper.isAIX() || helper.isSunOS())) {
      options.commandline = child.spawnargs.join(' ');
    }
    helper.validate(report, options);
  });
}
