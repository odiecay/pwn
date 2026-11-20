// Shared console logger and error reporting for the Wobkot pages.
//
// This file is loaded as a classic script before misc.js / userland.js so the
// exploit code keeps working unchanged. It is deliberately small: the pages
// own the layout, this owns the text.

const logger = {
  verbose: true, // enable for debug logs

  init() {
    this.console = document.getElementById('console');
  },
  info(msg) {
    this.log('[+]', `${msg}`);
  },
  error(msg) {
    this.log('[-]', `${msg}`);
  },
  debug(msg) {
    if (this.verbose) this.log('[*]', `${msg}`);
  },
  warn(msg) {
    this.log('[!]', `${msg}`);
  },
  log(prefix, msg) {
    if (!this.console) return;

    this.console.append(`${prefix} ${String(msg).replace(/\n/g, `\n${prefix} `)}\n`);
    this.console.scrollTop = this.console.scrollHeight;
  },
};

function install_error_handlers() {
  window.onerror = function (message, source, line, column, error) {
    let msg = message;

    if (error && error.stack) {
      msg += `\n${error.stack}`;
    } else {
      msg += `\n@${source}:${line}:${column}`;
    }

    logger.error(msg);
    return true;
  };

  window.onunhandledrejection = function (event) {
    const err = event.reason;

    let msg = err && err.message ? err.message : String(err);

    if (err && err.stack) {
      msg += `\n${err.stack}`;
    }

    logger.error(msg);
  };
}

// Classic scripts share the global lexical environment, but assigning these
// explicitly keeps the contract obvious to every page and to the tools.
globalThis.logger = logger;
globalThis.install_error_handlers = install_error_handlers;
