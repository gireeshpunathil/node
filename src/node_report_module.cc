#include "node_report.h"
#include "node_internals.h"

#include <sstream>
#include <v8.h>

using v8::EscapableHandleScope;
using v8::FunctionCallbackInfo;
using v8::HandleScope;
using v8::Isolate;
using v8::NewStringType;
using v8::StackTrace;
using v8::String;
using v8::V8;
using v8::Value;

namespace nodereport {

// Internal/static function declarations
static void OnFatalError(const char* location, const char* message);
bool OnUncaughtException(Isolate* isolate);
#ifdef _WIN32
static void PrintStackFromStackTrace(Isolate* isolate, FILE* fp);
#else  // signal trigger functions for Unix platforms and OSX
static void SignalDumpAsyncCallback(uv_async_t* handle);
inline void* ReportSignalThreadMain(void* unused);
static int StartWatchdogThread(void* (*thread_main)(void* unused));
static void RegisterSignalHandler(int signo, void (*handler)(int),
                                  struct sigaction* saved_sa);
static void RestoreSignalHandler(int signo, struct sigaction* saved_sa);
static void SignalDump(int signo);
static void SetupSignalHandler();
#endif

// Default node-report option settings
static unsigned int nodereport_events = NR_APICALL;
static unsigned int nodereport_verbose = 0;
#ifdef _WIN32  // signal trigger not supported on Windows
static unsigned int nodereport_signal = 0;
#else  // trigger signal supported on Unix platforms and OSX
static unsigned int nodereport_signal = SIGUSR2;  // default signal is SIGUSR2
static int report_signal = 0;  // atomic for signal handling in progress
static uv_sem_t report_semaphore;  // semaphore for hand-off to watchdog
static uv_async_t nodereport_trigger_async;  // async handle for event loop
static uv_mutex_t node_isolate_mutex;  // mutex for watchdog thread
static struct sigaction saved_sa;  // saved signal action
#endif

// State variables for v8 hooks and signal initialisation
static bool exception_hook_initialised = false;
static bool error_hook_initialised = false;
static bool signal_thread_initialised = false;

static Isolate* node_isolate;

/*******************************************************************************
 * External JavaScript API for triggering a report
 *
 ******************************************************************************/
void TriggerReport(const FunctionCallbackInfo<Value>& info) {
  Isolate* isolate = info.GetIsolate();
  HandleScope scope(isolate);
  char filename[NR_MAXNAME + 1] = "";
  MaybeLocal<Value> error;
  int err_index = 0;

  if (info[0]->IsString()) {
    // Filename parameter supplied
    String::Utf8Value filename_parameter(isolate, info[0]);
    if (filename_parameter.length() < NR_MAXNAME) {
      snprintf(filename, sizeof(filename), "%s", *filename_parameter);
    } else {
      isolate->ThrowException(String::NewFromUtf8(
                              isolate,
                              "node-report: filename parameter is too long",
                              NewStringType::kNormal).ToLocalChecked());
    }
    err_index++;
  }

  // We need to pass the JavaScript object so we can query it for a stack trace.
  if (info[err_index]->IsNativeError()) {
    error = info[err_index];
  }

  if (nodereport_events & NR_APICALL) {
    TriggerNodeReport(isolate, kJavaScript,
                      "JavaScript API",
                      __func__,
                      filename,
                      error);
    // Return value is the report filename
    info.GetReturnValue().Set(String::NewFromUtf8(isolate, filename));
  }
}

/*******************************************************************************
 * External JavaScript API for returning a report
 *
 ******************************************************************************/
void GetReport(const FunctionCallbackInfo<Value>& info) {
  Isolate* isolate = info.GetIsolate();
  HandleScope scope(isolate);
  std::ostringstream out;

  MaybeLocal<Value> error;
  if (info[0]->IsNativeError()) {
    error = info[0];
  }

  GetNodeReport(isolate, kJavaScript, "JavaScript API", __func__, error, out);
  // Return value is the contents of a report as a string.
  info.GetReturnValue().Set(String::NewFromUtf8(isolate, out.str().c_str()));
}

/*******************************************************************************
 * External JavaScript APIs for node-report configuration
 *
 ******************************************************************************/
void SetEvents(const FunctionCallbackInfo<Value>& info) {
  Isolate* isolate = info.GetIsolate();
  String::Utf8Value parameter(isolate, info[0]);
  SetEvents(isolate, *parameter);
}
void SetEvents(Isolate* isolate, const char* args) {
  unsigned int previous_events = nodereport_events;  // save previous settings
  nodereport_events = ProcessNodeReportEvents(args);

  // If report newly requested for fatalerror, set up the V8 callback
  if ((nodereport_events & NR_FATALERROR) &&
      (error_hook_initialised == false)) {
    isolate->SetFatalErrorHandler(OnFatalError);
    error_hook_initialised = true;
  }

  // If report newly requested for exceptions,
  // tell V8 to capture stack trace and set up the callback
  if ((nodereport_events & NR_EXCEPTION) &&
      (exception_hook_initialised == false)) {
    isolate->SetCaptureStackTraceForUncaughtExceptions(true,
                                                       32,
                                                       StackTrace::kDetailed);
    // The hook for uncaught exception won't get called unless the
    // --abort_on_uncaught_exception option is set
    V8::SetFlagsFromString("--abort_on_uncaught_exception",
                               sizeof("--abort_on_uncaught_exception")-1);
    isolate->SetAbortOnUncaughtExceptionCallback(OnUncaughtException);
    exception_hook_initialised = true;
  }

#ifndef _WIN32
  // If report newly requested on external user signal
  // set up watchdog thread and handler
  if ((nodereport_events & NR_SIGNAL) && (signal_thread_initialised == false)) {
    SetupSignalHandler();
  }
  // If report no longer required on external user signal,
  // reset the OS signal handler
  if (!(nodereport_events & NR_SIGNAL) && (previous_events & NR_SIGNAL)) {
    RestoreSignalHandler(nodereport_signal, &saved_sa);
  }
#endif
}
void SetSignal(const FunctionCallbackInfo<Value>& info) {
#ifndef _WIN32
  String::Utf8Value parameter(info.GetIsolate(), info[0]);
  unsigned int previous_signal = nodereport_signal;  // save previous setting
  nodereport_signal = ProcessNodeReportSignal(*parameter);

  // If signal event active and selected signal has changed,
  // switch the OS signal handler
  if ((nodereport_events & NR_SIGNAL) &&
      (nodereport_signal != previous_signal)) {
    RestoreSignalHandler(previous_signal, &saved_sa);
    RegisterSignalHandler(nodereport_signal, SignalDump, &saved_sa);
  }
#endif
}
void SetFileName(const FunctionCallbackInfo<Value>& info) {
  String::Utf8Value parameter(info.GetIsolate(), info[0]);
  ProcessNodeReportFileName(*parameter);
}
void SetDirectory(const FunctionCallbackInfo<Value>& info) {
  String::Utf8Value parameter(info.GetIsolate(), info[0]);
  ProcessNodeReportDirectory(*parameter);
}
void SetVerbose(const FunctionCallbackInfo<Value>& info) {
  String::Utf8Value parameter(info.GetIsolate(), info[0]);
  nodereport_verbose = ProcessNodeReportVerboseSwitch(*parameter);
}

/*******************************************************************************
 * Callbacks for triggering report on fatal error, uncaught exception and
 * external signals
 ******************************************************************************/
static void OnFatalError(const char* location, const char* message) {
  if (location) {
    fprintf(stderr, "FATAL ERROR: %s %s\n", location, message);
  } else {
    fprintf(stderr, "FATAL ERROR: %s\n", message);
  }
  // Trigger report if requested
  if (nodereport_events & NR_FATALERROR) {
    TriggerNodeReport(Isolate::GetCurrent(),
                      kFatalError,
                      message,
                      location,
                      nullptr,
                      MaybeLocal<Value>());
  }
  fflush(stderr);
  raise(SIGABRT);
}

bool OnUncaughtException(Isolate* isolate) {
  // Trigger report if requested
  if (nodereport_events & NR_EXCEPTION) {
    TriggerNodeReport(isolate,
                      kException,
                      "exception",
                      __func__,
                      nullptr,
                      MaybeLocal<Value>());
  }
  if ((version_and_command.commandline_string.find(
       "abort-on-uncaught-exception")
       != std::string::npos) ||
      (version_and_command.commandline_string.find(
       "abort_on_uncaught_exception")
       != std::string::npos)) {
    return true;  // abort required
  }
  return false;
}

#ifdef _WIN32
static void PrintStackFromStackTrace(Isolate* isolate, FILE* fp) {
  Local<StackTrace> stack = StackTrace::CurrentStackTrace(
                              isolate,
                              255,
                              StackTrace::kDetailed);
  // Print the JavaScript function name and source information for each frame
  for (int i = 0; i < stack->GetFrameCount(); i++) {
    Local<StackFrame> frame = stack->GetFrame(i);
    String::Utf8Value fn_name_s(isolate, frame->GetFunctionName());
    String::Utf8Value script_name(isolate, frame->GetScriptName());
    const int line_number = frame->GetLineNumber();
    const int column = frame->GetColumn();

    if (frame->IsEval()) {
      if (frame->GetScriptId() == Message::kNoScriptIdInfo) {
        fprintf(fp, "at [eval]:%i:%i\n", line_number, column);
      } else {
        fprintf(fp, "at [eval] (%s:%i:%i)\n",
                *script_name, line_number, column);
      }
    } else {
      if (fn_name_s.length() == 0) {
        fprintf(fp, "%s:%i:%i\n", *script_name, line_number, column);
      } else {
        fprintf(fp, "%s (%s:%i:%i)\n",
                *fn_name_s, *script_name, line_number, column);
      }
    }
  }
}
#else
// Signal handling functions, not supported on Windows
static void SignalDumpInterruptCallback(Isolate* isolate, void* data) {
  if (report_signal != 0) {
    if (nodereport_verbose) {
      fprintf(stdout,
              "node-report: SignalDumpInterruptCallback handling signal\n");
    }
    if (nodereport_events & NR_SIGNAL) {
      if (nodereport_verbose) {
        fprintf(stdout,
                "node-report: SignalDumpInterruptCallback triggering report\n");
      }
      TriggerNodeReport(isolate,
                        kSignal_JS,
                        node::signo_string(report_signal),
                        __func__,
                        nullptr,
                        MaybeLocal<Value>());
    }
    report_signal = 0;
  }
}
static void SignalDumpAsyncCallback(uv_async_t* handle) {
  if (report_signal != 0) {
    if (nodereport_verbose) {
      fprintf(stdout,
              "node-report: SignalDumpAsyncCallback handling signal\n");
    }
    if (nodereport_events & NR_SIGNAL) {
      if (nodereport_verbose) {
        fprintf(stdout,
                "node-report: SignalDumpAsyncCallback triggering NodeReport\n");
      }
      TriggerNodeReport(Isolate::GetCurrent(),
                        kSignal_UV,
                        node::signo_string(report_signal),
                        __func__,
                        nullptr,
                        MaybeLocal<Value>());
    }
    report_signal = 0;
  }
}

/*******************************************************************************
 * Utility functions for signal handling support (platforms except Windows)
 *  - RegisterSignalHandler() - register a raw OS signal handler
 *  - SignalDump() - implementation of raw OS signal handler
 *  - StartWatchdogThread() - create a watchdog thread
 *  - ReportSignalThreadMain() - implementation of watchdog thread
 *  - SetupSignalHandler() - initialisation of signal handlers and threads
 ******************************************************************************/
// Utility function to register an OS signal handler
static void RegisterSignalHandler(int signo, void (*handler)(int),
                                  struct sigaction* saved_sa) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = handler;
  sigfillset(&sa.sa_mask);  // mask all signals while in the handler
  sigaction(signo, &sa, saved_sa);
}

// Utility function to restore an OS signal handler to its previous setting
static void RestoreSignalHandler(int signo, struct sigaction* saved_sa) {
  sigaction(signo, saved_sa, nullptr);
}

// Raw signal handler for triggering a report - runs on an arbitrary thread
static void SignalDump(int signo) {
  // Check atomic for report already pending, storing the signal number
  if (__sync_val_compare_and_swap(&report_signal, 0, signo) == 0) {
    uv_sem_post(&report_semaphore);  // Hand-off to watchdog thread
  }
}

// Utility function to start a watchdog thread - used for processing signals
static int StartWatchdogThread(void* (*thread_main)(void* unused)) {
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  // Minimise the stack size, except on FreeBSD where the minimum is too low
#ifndef __FreeBSD__
  pthread_attr_setstacksize(&attr, PTHREAD_STACK_MIN);
#endif  // __FreeBSD__
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

  sigset_t sigmask;
  sigfillset(&sigmask);
  pthread_sigmask(SIG_SETMASK, &sigmask, &sigmask);
  pthread_t thread;
  const int err = pthread_create(&thread, &attr, thread_main, nullptr);
  pthread_sigmask(SIG_SETMASK, &sigmask, nullptr);
  pthread_attr_destroy(&attr);
  if (err != 0) {
    fprintf(stderr,
            "node-report: StartWatchdogThread pthread_create() failed: %s\n",
            strerror(err));
    fflush(stderr);
    return -err;
  }
  return 0;
}

// Watchdog thread implementation for signal-triggered report
inline void* ReportSignalThreadMain(void* unused) {
  for (;;) {
    uv_sem_wait(&report_semaphore);
    if (nodereport_verbose) {
      fprintf(stdout,
              "node-report: signal %s received\n",
              node::signo_string(report_signal));
    }
    uv_mutex_lock(&node_isolate_mutex);
    if (auto isolate = node_isolate) {
      // Request interrupt callback for running JavaScript code
      isolate->RequestInterrupt(SignalDumpInterruptCallback, nullptr);
      // Event loop may be idle, so also request an async callback
      uv_async_send(&nodereport_trigger_async);
    }
    uv_mutex_unlock(&node_isolate_mutex);
  }
  return nullptr;
}

// Utility function to initialise signal handlers and threads
static void SetupSignalHandler() {
  Isolate* isolate = Isolate::GetCurrent();
  int rc = uv_sem_init(&report_semaphore, 0);
  if (rc != 0) {
    fprintf(stderr,
            "node-report: initialization failed, uv_sem_init() returned %d\n",
            rc);
    isolate->ThrowException(String::NewFromUtf8(
                            isolate,
                            "node-report: initialization failed, "
                            "uv_sem_init() returned error\n",
                            NewStringType::kNormal).ToLocalChecked());
  }
  rc = uv_mutex_init(&node_isolate_mutex);
  if (rc != 0) {
    fprintf(stderr, "node-report: initialization failed, "
            "uv_mutex_init() returned %d\n", rc);
    isolate->ThrowException(String::NewFromUtf8(
                            isolate,
                            "node-report: initialization failed, "
                            "uv_mutex_init() returned error\n",
                            NewStringType::kNormal).ToLocalChecked());
  }

  if (StartWatchdogThread(ReportSignalThreadMain) == 0) {
    rc = uv_async_init(uv_default_loop(),
                       &nodereport_trigger_async,
                       SignalDumpAsyncCallback);
    if (rc != 0) {
      fprintf(stderr,
              "node-report: initialization failed, "
              "uv_async_init() returned %d\n",
              rc);
    isolate->ThrowException(String::NewFromUtf8(
                            isolate,
                            "node-report: initialization failed, "
                            "uv_async_init() returned error\n",
                            NewStringType::kNormal).ToLocalChecked());
    }
    uv_unref(reinterpret_cast<uv_handle_t*>(&nodereport_trigger_async));
    RegisterSignalHandler(nodereport_signal, SignalDump, &saved_sa);
    signal_thread_initialised = true;
  }
}
#endif

/*******************************************************************************
 * Native module initializer function, called when the module is require'd
 *
 ******************************************************************************/
void InitializeNodeReport(void) {
  Isolate* isolate = Isolate::GetCurrent();
  node_isolate = isolate;

  SetLoadTime();
  SetVersionString(isolate);
  SetCommandLine();

  const char* verbose_switch = secure_getenv("NODEREPORT_VERBOSE");
  if (verbose_switch != nullptr) {
    nodereport_verbose = ProcessNodeReportVerboseSwitch(verbose_switch);
  }
  const char* trigger_events = secure_getenv("NODEREPORT_EVENTS");
  if (trigger_events != nullptr) {
    // nodereport_events = ProcessNodeReportEvents(trigger_events);
    SetEvents(isolate, trigger_events);
  }
  const char* trigger_signal = secure_getenv("NODEREPORT_SIGNAL");
  if (trigger_signal != nullptr) {
    nodereport_signal = ProcessNodeReportSignal(trigger_signal);
  }
  const char* report_name = secure_getenv("NODEREPORT_FILENAME");
  if (report_name != nullptr) {
    ProcessNodeReportFileName(report_name);
  }
  const char* directory_name = secure_getenv("NODEREPORT_DIRECTORY");
  if (directory_name != nullptr) {
    ProcessNodeReportDirectory(directory_name);
  }
}

// Not called at the moment. The binding is performed
// in src/node_util.cc onto the `util` object. This
// method is maintained if someone wants to leverage
// or extend node_report directly, through
// process.binding('node_report') primitive.
void Initialize(Local<Object> exports) {
  Isolate* isolate = Isolate::GetCurrent();
  InitializeNodeReport();
  NODE_SET_METHOD(exports, "triggerReport", TriggerReport);
  NODE_SET_METHOD(exports, "getReport", GetReport);
  NODE_SET_METHOD(exports, "setEvents", SetEvents);
  NODE_SET_METHOD(exports, "setSignal", SetSignal);
  NODE_SET_METHOD(exports, "setFileName", SetFileName);
  NODE_SET_METHOD(exports, "setDirectory", SetDirectory);
  NODE_SET_METHOD(exports, "setverbose", SetVerbose);

  Local<String> util_prop = String::NewFromUtf8(Isolate::GetCurrent(),
                                                "util",
                                                NewStringType::kNormal)
                                                .ToLocalChecked();
  if (nodereport_verbose) {
#ifdef _WIN32
    fprintf(stdout, "node-report: initialization complete, event flags: %#x\n",
            nodereport_events);
#else
    fprintf(stdout,
            "node-report: initialization complete, "
            "event flags: %#x signal flag: %#x\n",
            nodereport_events,
            nodereport_signal);
#endif
  }
}

}  // namespace nodereport

#if defined(NODE_REPORT)
NODE_BUILTIN_MODULE_CONTEXT_AWARE(node_report, nodereport::Initialize)
#endif  // NODE_REPORT

