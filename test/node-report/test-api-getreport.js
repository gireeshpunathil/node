'use strict';

// Testcase for returning report as a string via API call
require('../common');
const assert = require('assert');
if (process.argv[2] === 'child') {
  const util = require('util');
  console.log(util.getNodeReport());
} else {
  const helper = require('./helper.js');
  const spawnSync = require('child_process').spawnSync;

  const args = [__filename, 'child'];
  const child = spawnSync(process.execPath, args);
  // console.log(child.stdout.toString());
  assert.strictEqual(child.stderr.toString(), '',
                     'Found messages on stderr', child.stderr.toString());
  const reportFiles = helper.findReports(child.pid);
  assert.deepStrictEqual(reportFiles, [], 'Found report files');
  helper.validateContent(child.stdout, { pid: child.pid,
                                         commandline: process.execPath +
                                         ' ' + args.join(' ')
  });
}
