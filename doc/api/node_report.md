# node-report

Delivers a human-readable diagnostic summary, written to file
or retrieved as a text.

The report is intended for development, test and production
use, to capture and preserve information for problem determination.
It includes JavaScript and native stack traces, heap statistics,
platform information and resource usage etc. With the report enabled,
reports can be triggered on unhandled exceptions, fatal errors, signals.

Many capabilities are available as APIs too, for being consumed in-process.

Iin-built node-report function is supported in Node.js versions 11.0.0 onwards.
For Node.js versions 8 and below, please use it's [npm counterpart][] instead.

## Usage

```bash
node --report-events fatalerror,signal,exception app.js
```
A report will be triggered automatically on unhandled exceptions and fatal
error events (for example out of memory errors), and can also be triggered
by sending a USR2 signal to a Node.js process (not supported on Windows).

A report can also be triggered via an API call from a JavaScript
application.

```js
const util = require('util');
util.triggerReport();
```
The content of a report can also be returned as a JavaScript string via an
API call from a JavaScript application.

```js
const util = require('util');
const report_str = util.getReport();
console.log(report_str);
```

These APIs can be used without adding the automatic exception
and fatal error hooks and the signal handler.

Content of the report consists of a header section containing the event
type, date, time, PID and Node version, sections containing JavaScript and
native stack traces, a section containing V8 heap information, a section
containing libuv handle information and an OS platform information section
showing CPU and memory usage and system limits. An example report can be
triggered using the Node.js REPL:

```raw
$ node
> const util = require('util');
> util.triggerReport();
Writing Node.js report to file: node-report.20180820.091102.8480.001.txt
Node.js report completed
>
```

When a report is triggered, start and end messages are issued to stderr
and the filename of the report is returned to the caller. The default filename
includes the date, time, PID and a sequence number. Alternatively, a filename
can be specified as a parameter on the `triggerReport()` call.

```js
require('util').triggerReport('myReportName');
```

Both `triggerReport()` and `getReport()` can take an optional `Error` object
as a parameter. If an `Error` object is provided, the message and stack trace
from the object will be included in the report in the `JavaScript Exception
Details` section.
When using node-report to handle errors in a callback or an exception handler
this allows the report to include the location of the original error as well
as where it was handled.
If both a filename and `Error` object are passed to `triggerReport()` the
`Error` object should be the second parameter.

```js
try {
  process.chdir('/foo/foo');
} catch (err) {
  util.triggerReport(err);
}
// ...
```

## Configuration

Additional configuration is available using the following APIs:

```js
const util = require('util');
util.setEvents('exception+fatalerror+signal');
util.setSignal('SIGUSR2|SIGQUIT');
util.setFileName('stdout|stderr|<filename>');
util.setDirectory('<full path>');
util.setVerbose('yes|no');
```

Configuration on module initialization is also available via
environment variables:

```bash
export NODEREPORT_EVENTS=exception+fatalerror+signal+apicall
export NODEREPORT_SIGNAL=SIGUSR2|SIGQUIT
export NODEREPORT_FILENAME=stdout|stderr|<filename>
export NODEREPORT_DIRECTORY=<full path>
export NODEREPORT_VERBOSE=yes|no
```

Detailed API documentation can be found under [`util`][] section.

[npm counterpart]: https://www.npmjs.com/package/node-report
[`util`]: util.html
