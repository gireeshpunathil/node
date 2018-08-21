'use strict';

// Testcase to check reporting of uv handles.
require('../common');
if (process.argv[2] === 'child') {
  // Exit on loss of parent process
  const exit = () => process.exit(2);
  process.on('disconnect', exit);

  const fs = require('fs');
  const http = require('http');
  const util = require('util');
  const spawn = require('child_process').spawn;

  // Watching files should result in fs_event/fs_poll uv handles.
  let watcher;
  try {
    watcher = fs.watch(__filename);
  } catch (exception) {
    // fs.watch() unavailable
  }
  fs.watchFile(__filename, () => {});

  // Child should exist when this returns as child_process.pid must be set.
  const child_process = spawn(process.execPath,
                              ['-e', "process.stdin.on('data', (x) => " +
                                     'console.log(x.toString()));']);

  const timeout = setInterval(() => {}, 1000);
  // Make sure the timer doesn't keep the test alive and let
  // us check we detect unref'd handles correctly.
  timeout.unref();

  // Datagram socket for udp uv handles.
  const dgram = require('dgram');
  const udp_socket = dgram.createSocket('udp4');
  udp_socket.bind({});

  // Simple server/connection to create tcp uv handles.
  const server = http.createServer((req, res) => {
    req.on('end', () => {
      // Generate the report while the connection is active.
      console.log(util.getNodeReport());
      child_process.kill();

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end();

      // Tidy up to allow process to exit cleanly.
      server.close(() => {
        if (watcher) watcher.close();
        fs.unwatchFile(__filename);
        udp_socket.close();
        process.removeListener('disconnect', exit);
      });
    });
    req.resume();
  });
  server.listen(() => {
    const data = { pid: child_process.pid,
                   tcp_address: server.address(),
                   udp_address: udp_socket.address(),
                   skip_fs_watch: (watcher === undefined ?
                     'fs.watch() unavailable' :
                     false) };
    process.send(data);
    http.get({ port: server.address().port });
  });
} else {
  const helper = require('./helper.js');
  const fork = require('child_process').fork;
  const assert = require('assert');

  const options = { encoding: 'utf8', silent: true };
  const child = fork(__filename, ['child'], options);
  let child_data;
  child.on('message', (data) => { child_data = data; });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.on('exit', (code, signal) => {
    assert.deepStrictEqual(code, 0, 'Process exited unexpectedly');
    assert.deepStrictEqual(signal, null, 'Process should exit cleanly');
    assert.deepStrictEqual(stderr, '', 'Found messages in stderr', stderr);
    const reports = helper.findReports(child.pid);
    assert.deepStrictEqual(reports, [], 'Report files were written:', reports);

    // uv handle specific tests.
    const address_re_str = '\\b(?:0+x)?[0-9a-fA-F]+\\b';
    // fs_event and fs_poll handles for file watching.
    // libuv returns file paths on Windows starting with '\\?\'.
    const summary = helper.getSection(stdout, 'Node.js libuv Handle Summary');
    const fs_event_re = new RegExp('\\[RA]\\s+fs_event\\s+' + address_re_str +
                                   '\\s+filename: (\\\\\\\\\\?\\\\)?' +
                                   __filename.replace(/\\/g, '\\\\'));
    assert.ok(fs_event_re.test(summary), 'fs_event uv handle not found',
              { skip: child_data.skip_fs_watch });
    const fs_poll_re = new RegExp('\\[RA]\\s+fs_poll\\s+' + address_re_str +
                                  '\\s+filename: (\\\\\\\\\\?\\\\)?' +
                                  __filename.replace(/\\/g, '\\\\'));
    assert.ok(fs_poll_re.test(summary), 'fs_poll uv handle not found');

    // pid handle for the process created by child_process.spawn();
    const pid_re = new RegExp('\\[RA]\\s+process\\s+' + address_re_str +
                              '.+\\bpid:\\s' + child_data.pid + '\\b');
    assert.ok(pid_re.test(summary), 'Process uv handle not found');

    // timer handle created by setInterval and unref'd.
    const timeout_re = new RegExp('\\[-A]\\s+timer\\s+' + address_re_str +
                              '.+\\brepeat: 0, timeout in: \\d+ ms\\b');
    assert.ok(timeout_re.test(summary), 'Timer uv handle not found');

    // pipe handle for the IPC channel used by child_process_fork().
    const pipe_re = new RegExp('\\[RA]\\s+pipe\\s+' + address_re_str +
                               '.+\\breadable, writable\\b');
    assert.ok(pipe_re.test(summary), 'Pipe uv handle not found');

    // tcp handles. The report should contain three sockets:
    // 1. The server's listening socket.
    // 2. The inbound socket making the request.
    // 3. The outbound socket sending the response.
    const port = child_data.tcp_address.port;
    const tcp_re = new RegExp('\\[RA]\\s+tcp\\s+' + address_re_str +
                              '\\s+\\S+:' + port + ' \\(not connected\\)');
    assert.ok(tcp_re.test(summary), 'Listening socket tcp uv handle not found');
    const in_tcp_re = new RegExp('\\[RA]\\s+tcp\\s+' + address_re_str +
                                 '\\s+\\S+:\\d+ connected to \\S+:' +
                                 port + '\\b');
    assert.ok(in_tcp_re.test(summary),
              'Inbound connection tcp uv handle not found');
    const out_tcp_re = new RegExp('\\[RA]\\s+tcp\\s+' + address_re_str +
                                  '\\s+\\S+:' + port +
                                  ' connected to \\S+:\\d+\\b');
    assert.ok(out_tcp_re.test(summary),
              'Outbound connection tcp uv handle not found');

    // udp handles.
    const udp_re = new RegExp('\\[RA]\\s+udp\\s+' + address_re_str +
                              '\\s+\\S+:' + child_data.udp_address.port +
                              '\\b');
    assert.ok(udp_re.test(summary), 'Udp uv handle not found');

    // Common report tests.
    assert.ok(() => {
      helper.validateContent(stdout, { pid: child.pid,
                                       commandline: child.spawnargs.join(' ')
      });
    });
  });
}
