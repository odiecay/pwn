// Fast path: Wobkot's WebKit primitive + Afterglow's kernel exploit.
//
// Wobkot is loaded exactly as the legacy page loads it (classic scripts), then
// Afterglow is imported as a module through a tiny bridge. The adapter in
// afterglow_host.js gives Afterglow the process-memory and syscall surface it
// expects, and validates every WebKit address before the first ROP call.
//
// If the primitive does not validate, nothing in the kernel has been touched:
// the page offers the proven Afterglow engine instead.

(function () {
  'use strict';

  const state = {
    busy: false,
    done: false,
    armed: false,
    countdown: null,
    left: 0,
    primitiveReady: false,
    kernelTouched: false,
    unsafe: false,
    error: null,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(text, tone) {
    const node = el('status');
    if (!node) return;
    node.textContent = text;
    node.className = tone || '';
  }

  function setButtons(visible) {
    for (const id of ['start', 'retry', 'fallback', 'back', 'cancel']) {
      const node = el(id);
      if (!node) continue;
      node.style.display = visible.indexOf(id) !== -1 ? '' : 'none';
    }
  }

  function logLine(text) {
    const node = el('console');
    if (!node) return;
    node.append(text + '\n');
    node.scrollTop = node.scrollHeight;
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

  function fromHub() {
    try {
      const ref = new URL(document.referrer);
      if (ref.origin !== location.origin) return false;
      const path = ref.pathname;
      return path === '/' || path === '/index.html' || path.endsWith('/index.html');
    } catch (err) {
      return false;
    }
  }

  function query() {
    return new URLSearchParams(location.search);
  }

  function pickedPayload() {
    const radio = document.querySelector('input[name="payload"]:checked');
    return radio ? radio.value : 'goldhen';
  }

  function buildParams() {
    const params = query();
    const payload = pickedPayload();

    if (payload === 'goldhen') {
      params.set('payload', 'goldhen.bin');
      params.set('mode', 'goldhen');
    } else if (payload === 'hen') {
      params.set('payload', 'hen.bin');
      params.delete('mode');
    } else {
      params.set('payload', '');
      params.delete('mode');
    }

    if (el('probe') && el('probe').checked) params.set('probe', '1');
    else params.delete('probe');

    params.delete('run');
    return params;
  }

  function stopCountdown() {
    if (state.countdown !== null) {
      clearInterval(state.countdown);
      state.countdown = null;
    }
  }

  function startCountdown() {
    if (!state.armed) return;

    state.left = 5;
    setStatus(`Starting fast path in ${state.left}s...`, 'armed');
    setButtons(['start', 'back', 'cancel']);

    state.countdown = setInterval(() => {
      state.left -= 1;
      if (state.left <= 0) {
        stopCountdown();
        run();
        return;
      }
      setStatus(`Starting fast path in ${state.left}s...`, 'armed');
    }, 1000);
  }

  async function run() {
    if (state.busy || state.done) return;

    stopCountdown();
    state.busy = true;
    state.error = null;
    let ctx = null;
    el('start').disabled = true;
    el('start').textContent = 'running';
    setButtons([]);
    setStatus('Loading Wobkot primitive...', 'running');

    try {
      await loadScript('../src/logger.js');
      logger.init();
      install_error_handlers();

      await loadScript('../src/strategy.js');
      await loadScript('../src/misc.js');

      version.init();

      const route = routeFor(version.console, version.major, version.minor);
      if (!route.supported || route.engine !== 'combined') {
        throw new Error(
          `This page is for PS4 14.00-14.02. Detected ${version.console} ${version}. Use the hub.`,
        );
      }

      await loadScript('../src/ps4/impl.js');
      await loadScript('../src/userland.js');
      await loadScript('../src/afterglow_host.js');

      logger.info('===WOBAKOT PRIMITIVE===');
      const t0 = performance.now();

      arw.init();
      const base = afterglow_precheck_webkit_base();
      afterglow_validate_gadgets(base);
      const expected_bases = afterglow_precheck_kernel_bases(base);

      rop.init();
      afterglow_validate_bases(base);

      if (!libc_base.eq(expected_bases.libc)) {
        throw new Error(`libc base changed: ${expected_bases.libc} -> ${libc_base}`);
      }
      if (!libkernel_base.eq(expected_bases.libkernel)) {
        throw new Error(`libkernel base changed: ${expected_bases.libkernel} -> ${libkernel_base}`);
      }

      afterglow_precheck_pivot();
      const pid = fn.getpid.invoke();
      if (!Number.isFinite(pid) || pid <= 0 || pid > 1000000) {
        throw new Error(`getpid returned an implausible value: ${pid}`);
      }
      logger.info(`pid: ${pid}`);
      logger.info(`primitive ready in ${(performance.now() - t0).toFixed(1)} ms`);

      state.primitiveReady = true;
      setStatus('Loading Afterglow kernel stage...', 'running');

      await loadScript('../src/afterglow_bridge.js', 'module');

      ctx = make_afterglow_ctx({
        fw: version.key,
        params: buildParams(),
      });

      if (el('probe') && el('probe').checked) {
        setStatus('Running Afterglow environment probe...', 'running');
        const probe = Afterglow.probeAfterglow(ctx);
        if (!probe.ok) {
          throw new Error(`Afterglow probe refused: ${probe.reasons.join('; ')}`);
        }
      }

      setStatus('Running Afterglow kernel exploit...', 'running');
      const t1 = performance.now();
      const iface = await Afterglow.runAfterglow(ctx, { tries: 4 });

      if (!iface) {
        throw new Error('Afterglow did not return a kernel interface');
      }

      state.kernelTouched = state.kernelTouched || ctx.kernel_touched;
      state.unsafe = ctx.unsafe === true || iface.defused === false;

      if (state.unsafe) {
        state.done = true;
        logger.error('kernel is open, but the handles are NOT defused');
        setStatus('Jailbroken, but the handles are NOT defused. Do not close this page. Cold boot the console.', 'fail');
        setButtons([]);
        if (el('foot')) el('foot').style.display = 'none';
        return;
      }

      state.done = true;
      globalThis.afterglow_iface = iface;
      const payload = iface.payload
        ? ' Payload started.'
        : ' Payload did not start; the kernel is open.';
      logger.info(`kernel stage returned in ${(performance.now() - t1).toFixed(1)} ms`);
      logger.info(`===DONE === jailbroken${payload}`);
      setStatus(`Jailbroken.${payload}`, 'done');
      setButtons(['back']);
    } catch (err) {
      state.error = err;
      state.kernelTouched = state.kernelTouched || (ctx && ctx.kernel_touched);
      state.unsafe = state.unsafe || (ctx && ctx.unsafe === true);

      const message = err && err.message ? err.message : String(err);
      logLine(`[-] ${message}`);
      if (err && err.stack) logLine(err.stack);

      if (state.unsafe) {
        setStatus(
          'Kernel stage stopped with handles NOT defused. Do not close this page. Cold boot the console.',
          'fail',
        );
        setButtons([]);
        if (el('foot')) el('foot').style.display = 'none';
      } else if (state.kernelTouched) {
        setStatus(
          'Kernel stage was attempted. Cold boot before trying again.',
          'fail',
        );
        setButtons(['back']);
      } else {
        setStatus(
          'Fast path stopped before touching the kernel. Close and reopen the browser, or use the proven Afterglow engine.',
          'fail',
        );
        setButtons(['retry', 'fallback', 'back']);
      }
    } finally {
      state.busy = false;
      el('start').disabled = false;
      el('start').textContent = 'start';
    }
  }

  function boot() {
    const params = query();
    state.armed = params.get('run') === '1' && fromHub();

    el('start').addEventListener('click', (event) => {
      event.preventDefault();
      stopCountdown();
      run();
    });

    el('retry').addEventListener('click', (event) => {
      event.preventDefault();
      if (!state.kernelTouched && !state.unsafe) location.reload();
    });

    el('cancel').addEventListener('click', (event) => {
      event.preventDefault();
      stopCountdown();
      state.armed = false;
      setStatus('Fast path is ready when you are.', 'idle');
      setButtons(['start', 'back']);
    });

    if (state.armed) startCountdown();
    else {
      setStatus('Ready. This runs the fast path on PS4 14.00-14.02.', 'idle');
      setButtons(['start', 'back']);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
