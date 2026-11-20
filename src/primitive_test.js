// Safe self-test: build the Wobkot WebKit primitive and validate it.
// No kernel exploit, no kernel write, no payload.
//
// On PS4 14.x this is the quickest way to prove that the offsets the fast
// path uses are the right ones for the console in front of you.

(function () {
  'use strict';

  const state = { busy: false, done: false };

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(text, tone) {
    const node = el('status');
    if (!node) return;
    node.textContent = text;
    node.className = tone || '';
  }

  function loadScript(src, type) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      if (type) script.type = type;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function run() {
    if (state.busy || state.done) return;

    state.busy = true;
    el('start').disabled = true;
    setStatus('Loading...', 'running');

    try {
      await loadScript('src/logger.js');
      logger.init();
      install_error_handlers();

      await loadScript('src/strategy.js');
      await loadScript('src/misc.js');
      version.init();

      const route = routeFor(version.console, version.major, version.minor);
      if (!route.supported) throw new Error(route.reason || 'Unsupported console');

      logger.info('===PRIMITIVE SELF-TEST===');
      logger.info(`console ${version.console}, firmware ${version.key}`);

      if (version.console === 4) await loadScript('src/ps4/impl.js');
      else if (version.console === 5) await loadScript('src/ps5/impl.js');
      else throw new Error(`Unsupported console ${version.console}`);

      await loadScript('src/userland.js');

      const t0 = performance.now();
      logger.info('Building ARW...');
      arw.init();

      if (version.console === 4) {
        await loadScript('src/afterglow_host.js');

        logger.info('Checking WebKit base and gadgets...');
        const base = afterglow_precheck_webkit_base();
        afterglow_validate_gadgets(base);

        logger.info('Checking libc/libkernel bases before rop.init()...');
        const expected = afterglow_precheck_kernel_bases(base);

        logger.info('Building ROP...');
        rop.init();
        afterglow_validate_bases(base);

        if (!libc_base.eq(expected.libc)) throw new Error('libc base changed during rop.init()');
        if (!libkernel_base.eq(expected.libkernel)) throw new Error('libkernel base changed during rop.init()');

        logger.info('Checking the ROP pivot frame...');
        afterglow_precheck_pivot();
      } else {
        logger.info('Building ROP...');
        rop.init();
      }

      const pid = fn.getpid.invoke();
      const elapsed = (performance.now() - t0).toFixed(1);

      if (!Number.isFinite(pid) || pid <= 0 || pid > 1000000) {
        throw new Error(`getpid returned an implausible value: ${pid}`);
      }

      logger.info(`pid: ${pid}`);
      logger.info(`webkit_base: ${webkit_base}`);
      logger.info(`libc_base: ${libc_base}`);
      logger.info(`libkernel_base: ${libkernel_base}`);
      logger.info(`syscall stubs: ${syscalls.size}`);
      logger.info(`elapsed: ${elapsed} ms`);
      logger.info('===PASS===');

      setStatus(`PASS - primitive ready in ${elapsed} ms. Reload before another run.`, 'done');
      state.done = true;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logger.error(message);
      if (err && err.stack) logger.error(err.stack);
      setStatus('FAIL - this firmware did not validate. Check the log and use the recommended engine.', 'fail');
    } finally {
      state.busy = false;
      el('start').disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    el('start').addEventListener('click', function (event) {
      event.preventDefault();
      run();
    });
  });
})();
