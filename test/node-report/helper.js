'use strict';
require('../common');
const child_process = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');

const osMap = {
  'aix': 'AIX',
  'darwin': 'Darwin',
  'linux': 'Linux',
  'sunos': 'SunOS',
  'win32': 'Windows',
};

const REPORT_SECTIONS = [
  'Node Report',
  'JavaScript Stack Trace',
  'JavaScript Heap',
  'System Information'
];

const reNewline = '(?:\\r*\\n)';

exports.findReports = (pid) => {
  // Default filenames are of the form node-report.<date>.<time>.<pid>.<seq>.txt
  const format = '^node-report\\.\\d+\\.\\d+\\.' + pid + '\\.\\d+\\.txt$';
  const filePattern = new RegExp(format);
  const files = fs.readdirSync('.');
  return files.filter((file) => filePattern.test(file));
};

exports.isAIX = () => {
  return process.platform === 'aix';
};

exports.isPPC = () => {
  return process.arch.startsWith('ppc');
};

exports.isSunOS = () => {
  return process.platform === 'sunos';
};

exports.isWindows = () => {
  return process.platform === 'win32';
};

exports.validate = (report, options) => {
  assert.ok(() => {
    fs.readFile(report, (err, data) => {
      this.validateContent(data, options);
    });
  });
};

exports.validateContent = function validateContent(data, options) {
  const pid = options ? options.pid : process.pid;
  const reportContents = data.toString();
  const nodeComponents = Object.keys(process.versions);
  const expectedVersions = options ?
    options.expectedVersions || nodeComponents :
    nodeComponents;
  if (options.expectedException) {
    REPORT_SECTIONS.push('JavaScript Exception Details');
  }

  const glibcRE = /\(glibc:\s([\d.]+)/;
  const nodeReportSection = getSection(reportContents, 'Node Report');
  const sysInfoSection = getSection(reportContents, 'System Information');
  const exceptionSection = getSection(reportContents,
                                      'JavaScript Exception Details');
  const libcPath = getLibcPath(sysInfoSection);
  const libcVersion = getLibcVersion(libcPath);

  // Check all sections are present
  REPORT_SECTIONS.forEach((section) => {
    assert.ok(new RegExp('==== ' + section).test(reportContents),
              'Missing ' + section + ' section in report');
  });


  // Check report header section
  assert.ok(new RegExp('Process ID: ' + pid).test(nodeReportSection),
            'Node Report header section missing expected process ID');
  if (options && options.expectNodeVersion === false) {
    assert.ok(new RegExp('Unable to determine Node\\.js version').test(
      nodeReportSection),
              'Header section missing expected Node.js version');
  } else {
    assert.ok(new RegExp('Node\\.js version: ' + process.version).test(
      nodeReportSection),
              'Header section missing expected Node.js version');
  }
  if (options && options.expectedException) {
    assert.ok(new RegExp('Uncaught Error: ' + options.expectedException)
              .test(exceptionSection),
              'Node Report JavaScript Exception missing expected message');
  }
  if (options && options.commandline) {
    if (this.isWindows()) {
      // On Windows we need to strip double quotes from the command line in
      // the report, and escape backslashes in the regex comparison string.
      const commandline = new RegExp('Command line: ' +
                         (options.commandline).replace(/\\/g, '\\\\'));
      const nreportSec = (nodeReportSection.replace(/"/g, ''));
      assert.ok(commandline.test(nreportSec),
                'Node report missing expected command line');
    } else {
      assert.ok(new RegExp('Command line: ' + options.commandline)
                .test(nodeReportSection),
                'Node report missing expected command line');
    }
  }
  nodeComponents.forEach((c) => {
    if (c !== 'node') {
      if (expectedVersions.indexOf(c) === -1) {
        assert.ok(!(new RegExp(c + ': ' + process.versions[c])
                  .test(nodeReportSection)),
                  'Header section does not contain ' + c + ' version');
      } else {
        assert.ok(new RegExp(c + ': ' + process.versions[c])
                  .test(nodeReportSection),
                  'Header section missing expected ' + c + ' version');
      }
    }
  });
  if (this.isWindows()) {
    assert.ok(new RegExp('Machine: ' + os.hostname(), 'i')
              .test(nodeReportSection), // ignore case on Windows
              'Header section missing os.hostname()');
  } else if (this.isAIX()) {
    assert.ok(new RegExp('Machine: ' + os.hostname().split('.')[0])
                .test(nodeReportSection), // truncate on AIX
              'Header section missing os.hostname()');
  } else {
    assert.ok(new RegExp('Machine: ' + os.hostname()).test(nodeReportSection),
              'Header section missing os.hostname()');
  }

  const osName = osMap[os.platform()];
  const osVersion = nodeReportSection.match(/OS version: .*(?:\r*\n)/);
  if (this.isWindows()) {
    assert.ok(new RegExp('OS version: ' + osName)
              .test(osVersion), 'Checking OS version');
  } else if (this.isAIX() && !os.release().includes('.')) {
    // For Node.js prior to os.release() fix for AIX:
    // https://github.com/nodejs/node/pull/10245
    assert.ok(new RegExp('OS version: ' + osName + ' \\d+\\.' + os.release())
              .test(osVersion), 'Checking OS version');
  } else {
    assert.ok(new RegExp('OS version: ' + osName + ' .*' + os.release())
              .test(osVersion), 'Checking OS version');
  }

  // Check report System Information section
  // If the report contains a glibc version, check it against libc.so.6
  const glibcMatch = glibcRE.exec(nodeReportSection);
  if (glibcMatch != null && libcVersion) {
    assert.deepStrictEqual(glibcMatch[1], libcVersion,
                           'Reported glibc version mismath with host ' +
                           libcPath);
  }
  // Find a line which ends with "/api.node" or "\api.node" (Unix or
  // Windows paths) to see if the library for node report was loaded.
  // assert.ok(new RegExp('.*(\/|\\)api\.node').test(sysInfoSection),
  // 'System Information section contains node-report library.');
};

const getLibcPath = (section) => {
  const libcMatch = /\n\s+(\/\.*\/libc\.so\.6)\b/.exec(section);
  return (libcMatch != null ? libcMatch[1] : undefined);
};

const getLibcVersion = (path) => {
  if (!path) {
    return undefined;
  }
  const child = child_process.spawnSync('strings',
                                        [path], { encoding: 'utf8' });
  const match = /GNU C Library.*\bversion ([\d.]+)\b/.exec(child.stdout);
  return (match != null ? match[1] : undefined);
};

const getSection = exports.getSection = (report, section) => {
  const re = new RegExp('==== ' + section +
                        ' =+' + reNewline + '+([\\S\\s]+?)' +
                        reNewline + '+={80}' + reNewline);
  const match = re.exec(report);
  return match ? match[1] : '';
};

process.on('exit', () => {
  // Default filenames are of the form node-report.<date>.<time>.<pid>.<seq>.txt
  const format = '^node-report\\.\\d+\\.\\d+\\.\\d+\\.\\d+\\.txt$';
  const filePattern = new RegExp(format);
  const files = fs.readdirSync('.');
  const file = files.filter((f) => filePattern.test(f));
  file.forEach((f) => {
    try {
      fs.unlinkSync(f);
    } catch (e) {}
  });
});
