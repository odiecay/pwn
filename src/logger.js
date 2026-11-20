// Shared console logger and error reporting for the Wobkot pages.
//
// This file is loaded as a classic script before misc.js / userland.js so the
// exploit code keeps working unchanged. It is deliberately small: the pages
// own the layout, this owns the text.

const DEBUG = (() => {
  try {
    return new URLSearchParams(location.search).get('debug') === '1';
  } catch (err) {
    return false;
  }
})();

const logger = {
  verbose: DEBUG, // debug lines are off unless ?debug=1
  remote: DEBUG, // POST the log only in debug mode

  init() {
    this.console = document.getElementById('console');
    this.lines = [];
    this.bufferOnly = false;
  },
  render() {
    if (!this.console) return;
    this.console.textContent = (this.lines || []).join('');
    this.console.scrollTop = this.console.scrollHeight;
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
  send_remote(prefix, msg) {
    if (!this.remote) return;

    const text = `${prefix} ${String(msg)}`;

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        if (navigator.sendBeacon('/log', text)) return;
      }
    } catch (err) {
      // fall through to fetch
    }

    try {
      if (typeof fetch === 'function') {
        fetch('/log', { method: 'POST', body: text, keepalive: true }).catch(() => {});
      }
    } catch (err) {
      // logging must never break the exploit
    }
  },
  log(prefix, msg) {
    const line = `${prefix} ${String(msg).replace(/\n/g, `\n${prefix} `)}\n`;

    if (this.bufferOnly) {
      if (!this.lines) this.lines = [];
      this.lines.push(line);
      if (this.lines.length > 500) this.lines.shift();
      this.send_remote(prefix, msg);
      return;
    }

    if (!this.console) {
      this.send_remote(prefix, msg);
      return;
    }

    this.console.append(line);
    this.console.scrollTop = this.console.scrollHeight;
    this.send_remote(prefix, msg);
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
