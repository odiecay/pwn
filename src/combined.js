// Fast path: Wobkot's WebKit primitive + Afterglow's kernel exploit.
//
// The page is meant to run as soon as it is reached from the hub: the hub
// passes ?run=1, the referrer guard arms it, and run() starts on DOM ready.
// The noisy step log lives behind the "show log" button; the top of the page
// shows the four stages and the elapsed time.

(function () {
  'use strict';

  const PAYLOAD_KEY = 'wobkot.fast.payload';

  const state = {
    busy: false,
    done: false,
    armed: false,
    started: 0,
    timer: null,
    step: null,
    kernelTouched: false,
    unsafe: false,
    ctx: null,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    const node = el(id);
    if (node) node.textContent = text;
  }

  function setStatus(text, tone) {
    const node = el('status');
    if (!node) return;
    node.textContent = text;
    node.className = tone || '';
  }

  function setHeadline(text, tone) {
    const node = el('headline');
    if (!node) return;
    node.textContent = text;
    node.className = tone || '';
  }

  function setError(text) {
    const node = el('error');
    if (!node) return;
    node.textContent = text || '';
    node.style.display = text ? 'block' : 'none';
  }

  function setButtons(visible) {
    for (const id of ['start', 'retry', 'fallback', 'menu']) {
      const node = el(id);
      if (!node) continue;
      node.style.display = visible.indexOf(id) !== -1 ? '' : 'none';
    }
  }

  function setStep(name, status) {
    const node = el('step-' + name);
    if (!node) return;
    node.classList.remove('active', 'done', 'fail', 'skip');
    if (status) node.classList.add(status);
  }

  function setBar(percent) {
    const node = el('bar');
    if (node) node.style.width = percent + '%';
  }

  function resetSteps() {
    for (const name of ['webkit', 'validate', 'kernel', 'payload']) setStep(name, '');
    setBar(0);
  }

  function setTiming() {
    if (!state.started) return;
    const seconds = (performance.now() - state.started) / 1000;
    setText('timing', seconds.toFixed(1) + ' s');
  }

  function startTimer() {
    stopTimer();
    state.started = performance.now();
    setTiming();
    state.timer = setInterval(setTiming, 100);
  }

  function stopTimer() {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function showLog(force) {
    const wrap = el('log-wrap');
    const button = el('toggle-log');
    if (!wrap) return;

    const show = force === undefined ? wrap.style.display === 'none' : force;
    wrap.style.display = show ? 'block' : 'none';
    if (button) button.textContent = show ? 'hide log' : 'show log';
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

  function prefetch(url) {
    try {
      fetch(url, { cache: 'force-cache' })
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .catch(() => {});
    } catch (err) {
      // prefetch is an optimisation, never a failure
    }
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

  function selectedPayload() {
    const radio = document.querySelector('input[name="payload"]:checked');
    return radio ? radio.value : 'goldhen';
  }

  function restorePayload() {
    try {
      const saved = localStorage.getItem(PAYLOAD_KEY);
      if (!saved) return;
      const radio = document.querySelector(`input[name="payload"][value="${saved}"]`);
      if (radio) radio.checked = true;
    } catch (err) {
      // storage can be unavailable; GoldHEN stays selected
    }
  }

  function rememberPayload() {
    try {
      localStorage.setItem(PAYLOAD_KEY, selectedPayload());
    } catch (err) {
      // ignore
    }
  }

  function buildParams() {
    const params = query();
    const payload = selectedPayload();

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

    params.delete('run');
    return params;
  }

  function safeToLeave() {
    return !state.kernelTouched && !state.unsafe;
  }

  function markFailure(err) {
    const message = err && err.message ? err.message : String(err);

    if (typeof logger !== 'undefined' && logger) {
      logger.error(message);
      if (err && err.stack) logger.debug(err.stack);
    }

    setHeadline('Fast path stopped', 'fail');
    setError(message);
    showLog(true);

    if (state.unsafe) {
      setStatus('Do not close this page. Cold boot the console.', 'fail');
      setButtons([]);
      setStep(state.step || 'kernel', 'fail');
      const foot = el('foot');
      if (foot) foot.style.display = 'none';
    } else if (state.kernelTouched) {
      setStatus('Kernel stage was attempted. Cold boot before retrying.', 'fail');
      setButtons(['fallback', 'menu']);
      setStep(state.step || 'kernel', 'fail');
    } else {
      setStatus('Stopped before touching the kernel. Retry or use the proven engine.', 'fail');
      setButtons(['retry', 'fallback', 'menu']);
      setStep(state.step || 'webkit', 'fail');
    }
  }

  async function run() {
    if (state.busy || state.done) return;

    state.busy = true;
    state.kernelTouched = false;
    state.unsafe = false;
    state.ctx = null;
    setError('');
    setHeadline('Jailbreaking...', 'running');
    setStatus('Loading...', 'running');
    setButtons([]);
    resetSteps();
    startTimer();
    setBar(5);

    try {
      // Keep the proven load order. Wobkot's primitive is heap-sensitive, and
      // this is the sequence that completed on 14.02. The heavy Afterglow
      // module is loaded only after the primitive and validation are done.
      await loadScript('../src/logger.js');
      logger.init();
      install_error_handlers();

      await loadScript('../src/strategy.js');
      await loadScript('../src/misc.js');
      await loadScript('../src/ps4/impl.js');
      await loadScript('../src/userland.js');
      await loadScript('../src/afterglow_host.js');

      version.init();
      setText('fw', 'PS4 ' + version.key);

      const route = routeFor(version.console, version.major, version.minor);
      if (!route.supported || route.engine !== 'combined') {
        throw new Error(`This page is for PS4 14.00-14.02. Detected ${version}.`);
      }

      state.step = 'webkit';
      setStep('webkit', 'active');
      setStatus('Building WebKit primitive...', 'running');
      arw.init();
      afterglow_check_arw();
      setStep('webkit', 'done');
      setBar(35);

      state.step = 'validate';
      setStep('validate', 'active');
      setStatus('Validating 14.02 offsets...', 'running');
      setBar(45);
      const base = afterglow_precheck_webkit_base();
      afterglow_validate_gadgets(base);
      const expected = afterglow_precheck_kernel_bases(base);
      rop.init();
      afterglow_validate_bases(base);
      if (!libc_base.eq(expected.libc)) throw new Error('libc base changed during rop.init()');
      if (!libkernel_base.eq(expected.libkernel)) throw new Error('libkernel base changed during rop.init()');
      afterglow_precheck_pivot();
      setStep('validate', 'done');
      setBar(60);

      setStatus('Calling getpid...', 'running');
      const pid = fn.getpid.invoke();
      if (!Number.isFinite(pid) || pid <= 0 || pid > 1000000) {
        throw new Error(`getpid returned an implausible value: ${pid}`);
      }
      logger.debug(`pid: ${pid}`);

      state.step = 'kernel';
      setStep('kernel', 'active');
      setStatus('Running Afterglow kernel exploit...', 'running');
      setBar(70);

      // Warm the payload and patch set while the kernel stage runs. The
      // server's no-cache still revalidates, but the body is already local.
      const payload_choice = selectedPayload();
      if (payload_choice === 'goldhen') prefetch('goldhen.bin');
      else if (payload_choice === 'hen') prefetch('hen.bin');
      prefetch('patchset-' + version.key.replace('.', '') + '.bin');

      await loadScript('../src/afterglow_bridge.js', 'module');

      state.ctx = make_afterglow_ctx({
        fw: version.key,
        params: buildParams(),
      });

      // Surface Afterglow's main phases while its detailed log stays hidden.
      const afterglow_mark = state.ctx.mark;
      state.ctx.mark = function (tag, detail) {
        afterglow_mark(tag, detail);

        const text = String(detail == null ? '' : detail);
        if (text.indexOf('[1] leak') !== -1) setStatus('Leaking kernel base...', 'running');
        else if (text.indexOf('[4] mapping') !== -1) setStatus('Walking kernel mappings...', 'running');
        else if (text.indexOf('[5] widen') !== -1) setStatus('Patching kernel text...', 'running');
        else if (text.indexOf('[6] kernel patched') !== -1) setStatus('Kernel patched. Escaping sandbox...', 'running');
        else if (text.indexOf('[9] jailbroken') !== -1) setStatus('Root. Defusing handles...', 'running');
        else if (text.indexOf('[p] thread rc=0') !== -1) setStatus('Payload thread running...', 'running');
      };

      if (query().get('probe') === '1') {
        const probe = Afterglow.probeAfterglow(state.ctx);
        if (!probe.ok) throw new Error(`Afterglow probe refused: ${probe.reasons.join('; ')}`);
      }

      const iface = await Afterglow.runAfterglow(state.ctx, { tries: 4 });
      if (!iface) throw new Error('Afterglow did not return a kernel interface');

      state.kernelTouched = state.kernelTouched || state.ctx.kernel_touched;
      state.unsafe = state.ctx.unsafe === true || iface.defused === false;

      if (state.unsafe) {
        state.done = true;
        throw new Error('Kernel is open, but the handles are NOT defused.');
      }

      state.done = true;
      stopTimer();
      setStep('kernel', 'done');
      setBar(90);

      if (iface.payload) {
        const label = selectedPayload() === 'hen' ? 'ps4-hen' : 'GoldHEN';
        setStep('payload', 'done');
        setBar(100);
        setStatus(`Jailbroken in ${((performance.now() - state.started) / 1000).toFixed(1)} s - ${label} started.`, 'done');
      } else {
        setStep('payload', 'skip');
        setBar(100);
        setStatus(`Jailbroken in ${((performance.now() - state.started) / 1000).toFixed(1)} s - kernel open.`, 'done');
      }

      setHeadline('Jailbroken', 'done');
      setButtons(['menu']);
      showLog(false);
      globalThis.afterglow_iface = iface;
    } catch (err) {
      state.kernelTouched = state.kernelTouched || (state.ctx && state.ctx.kernel_touched);
      state.unsafe = state.unsafe || (state.ctx && state.ctx.unsafe === true);
      state.done = true;
      stopTimer();
      markFailure(err);
    } finally {
      state.busy = false;
      const start = el('start');
      if (start) start.disabled = false;
    }
  }

  function ready() {
    setHeadline('Fast path ready', '');
    setStatus('Press start to build the primitive and run Afterglow.', 'idle');
    setButtons(['start', 'fallback', 'menu']);
    resetSteps();
  }

  function boot() {
    const params = query();
    state.armed = params.get('run') === '1' && fromHub();

    restorePayload();

    el('start').addEventListener('click', (event) => {
      event.preventDefault();
      run();
    });

    el('retry').addEventListener('click', (event) => {
      event.preventDefault();
      if (safeToLeave()) location.reload();
    });

    el('toggle-log').addEventListener('click', (event) => {
      event.preventDefault();
      showLog();
    });

    for (const radio of document.querySelectorAll('input[name="payload"]')) {
      radio.addEventListener('change', rememberPayload);
    }

    setText('fw', 'PS4');
    showLog(false);

    if (state.armed) run();
    else ready();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
