// Fast path: Wobkot's WebKit primitive + Afterglow's kernel exploit.
//
// The page is meant to run as soon as it is reached from the hub: the hub
// passes ?run=1, the referrer guard arms it, and run() starts on DOM ready.
// The noisy step log lives behind the "show log" button; the top of the page
// shows the four stages and the elapsed time.

(function () {
  'use strict';

  const PAYLOAD_KEY = 'wobkot.fast.payload';
  const HISTORY_KEY = 'wobkot.fast.history';
  const ATTEMPT_KEY = 'wobkot.fast.kernelAttempted';
  const ALREADY_KEY = 'wobkot.fast.alreadyJailbroken';
  const BUILD = '23';

  const state = {
    busy: false,
    done: false,
    armed: false,
    started: 0,
    step: null,
    fw: '',
    phases: {},
    lastPhase: 0,
    alreadyJailbroken: false,
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

  function setHint(text) {
    setText('hint', text || '');
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

  function setIcon(status) {
    const node = el('icon');
    if (node) node.className = 'icon ' + status;
  }

  function showDetails(force) {
    const node = el('details');
    const button = el('toggle-details');
    if (!node) return;

    const show = force === undefined ? node.style.display !== 'block' : force;
    node.style.display = show ? 'block' : 'none';
    if (button) button.textContent = show ? 'Hide details' : 'Details';

    if (show && force === undefined) {
      try {
        node.scrollIntoView({ block: 'start' });
      } catch (err) {
        node.scrollIntoView(true);
      }
    }
  }

  function updatePayloadSummary() {
    const payload = selectedPayload();
    setText('payload-name', payload === 'goldhen' ? 'GoldHEN' : payload === 'hen' ? 'ps4-hen' : 'none');
  }

  function setButtons(visible) {
    for (const id of ['start', 'retry', 'fallback', 'run-anyway', 'menu']) {
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

  function resetSteps() {
    for (const name of ['webkit', 'validate', 'kernel', 'payload']) setStep(name, '');
  }

  function setTiming() {
    if (!state.started) return;
    const seconds = (performance.now() - state.started) / 1000;
    setText('timing', seconds.toFixed(1) + ' s');
  }

  function startTimer() {
    state.started = performance.now();
    state.phases = {};
    state.lastPhase = 0;
    setTiming();
  }

  function finishTimer() {
    setTiming();
  }

  function markPhase(name) {
    if (!state.started) return;
    const elapsed = (performance.now() - state.started) / 1000;
    const previous = state.lastPhase || 0;
    state.phases[name] = elapsed - previous;
    state.lastPhase = elapsed;
    setTiming();
    try {
      logger.debug(`[phase] ${name} ${state.phases[name].toFixed(1)} s`);
    } catch (err) {
      // logging must never break the run
    }
  }

  function showLog(force) {
    const wrap = el('log-wrap');
    const button = el('toggle-log');
    if (!wrap) return;

    const show = force === undefined ? wrap.style.display !== 'block' : force;
    wrap.style.display = show ? 'block' : 'none';
    if (button) button.textContent = show ? 'Hide log' : 'Show log';

    if (show && typeof logger !== 'undefined' && logger && logger.render) logger.render();
    if (show) {
      try {
        wrap.scrollIntoView({ block: 'nearest' });
      } catch (err) {
        wrap.scrollIntoView(false);
      }
    }
  }

  function withVersion(src) {
    return src + (src.indexOf('?') === -1 ? '?' : '&') + 'v=' + BUILD;
  }

  function loadScript(src, type) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = withVersion(src);
      if (type) script.type = type;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  function prefetchLink(url) {
    try {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = url;
      document.head.appendChild(link);
    } catch (err) {
      // prefetch is an optimisation, never a failure
    }
  }

  function prefetch(url) {
    // Warm the HTTP cache for the payload files. Read the body into a Blob,
    // not an ArrayBuffer: the body still lands in the cache, but the 300 KB
    // lives in the browser's blob store instead of the JS heap. This runs
    // after the heap spray, so it does not compete with the primitive.
    try {
      fetch(url, { cache: 'force-cache' })
        .then((res) => (res.ok ? res.blob() : null))
        .catch(() => {});
    } catch (err) {
      // prefetch is an optimisation, never a failure
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
      if (saved) {
        const radio = document.querySelector(`input[name="payload"][value="${saved}"]`);
        if (radio) radio.checked = true;
      }
    } catch (err) {
      // storage can be unavailable; GoldHEN stays selected
    }
    updatePayloadSummary();
  }

  function rememberPayload() {
    try {
      localStorage.setItem(PAYLOAD_KEY, selectedPayload());
    } catch (err) {
      // ignore
    }
    updatePayloadSummary();
  }

  function readHistory() {
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (err) {
      return [];
    }
  }

  function phaseText(entry) {
    const phases = entry && entry.phases;
    if (!phases) return '';
    const parts = [];
    for (const name of ['load', 'browser', 'check', 'module', 'kernel']) {
      if (typeof phases[name] === 'number' && isFinite(phases[name])) {
        parts.push(name + ' ' + phases[name].toFixed(1));
      }
    }
    return parts.join(' · ');
  }

  function renderHistory() {
    const node = el('history');
    if (!node) return;

    node.textContent = '';
    const history = readHistory();
    if (!history.length) {
      const empty = document.createElement('div');
      empty.className = 'run-empty';
      empty.textContent = 'No runs recorded yet.';
      node.appendChild(empty);
      return;
    }

    for (const entry of history.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'run-row';

      const time = document.createElement('b');
      time.textContent = (entry.sec || '?') + ' s';
      row.appendChild(time);

      const result = document.createElement('span');
      result.className = entry.ok ? 'ok' : 'bad';
      result.textContent = entry.ok ? 'ok' : 'fail';
      row.appendChild(result);

      const split = document.createElement('span');
      split.className = 'run-split';
      split.textContent = entry.note === 'already jailbroken' ? 'already jailbroken' : phaseText(entry);
      if (split.textContent) row.appendChild(split);

      node.appendChild(row);
    }
  }

  function reportRun(entry) {
    try {
      fetch('/event', {
        method: 'POST',
        body: JSON.stringify(entry),
        keepalive: true,
      }).catch(() => {});
    } catch (err) {
      // static hosts have no /event
    }
  }

  function recordRun(ok, note) {
    const seconds = state.started ? ((performance.now() - state.started) / 1000).toFixed(1) : '';
    const entry = {
      sec: seconds,
      ok,
      fw: state.fw,
      payload: selectedPayload(),
      phases: state.phases,
      note: (note || '').slice(0, 160),
      t: Date.now(),
    };

    try {
      const history = readHistory();
      history.unshift(entry);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 12)));
    } catch (err) {
      // ignore storage failures
    }

    renderHistory();
    reportRun(entry);
  }

  function kernelAttempted() {
    try {
      return sessionStorage.getItem(ATTEMPT_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function markKernelAttempted() {
    try {
      sessionStorage.setItem(ATTEMPT_KEY, '1');
    } catch (err) {
      // ignore
    }
  }

  function alreadyJailbroken() {
    try {
      return sessionStorage.getItem(ALREADY_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function markAlreadyJailbroken() {
    try {
      sessionStorage.setItem(ALREADY_KEY, '1');
    } catch (err) {
      // ignore
    }
  }

  function showAlreadyJailbroken() {
    setIcon('done');
    setHeadline('Already jailbroken', 'done');
    setStatus('This console is already jailbroken on this boot. Reboot before another run.', 'done');
    setHint('Use Run anyway only if you have rebooted the console.');
    setError('');
    setButtons(['run-anyway', 'menu']);
    for (const name of ['webkit', 'validate', 'kernel', 'payload']) setStep(name, 'done');
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

    setIcon('fail');
    setHeadline('Stopped', 'fail');
    setHint('');
    setError(message);
    showLog(false);

    if (state.unsafe) {
      setStatus('Do not close this page. Cold boot the console.', 'fail');
      setButtons([]);
      setStep(state.step || 'kernel', 'fail');
      const foot = el('foot');
      if (foot) foot.style.display = 'none';
    } else if (state.kernelTouched) {
      setStatus('Kernel attempt made. Cold boot before another run.', 'fail');
      setButtons(['fallback', 'menu']);
      setStep(state.step || 'kernel', 'fail');
    } else {
      setStatus('Stopped before kernel. Reload and retry, or use Afterglow.', 'fail');
      setButtons(['retry', 'fallback', 'menu']);
      setStep(state.step || 'webkit', 'fail');
    }

    recordRun(false, message);
  }

  async function run() {
    if (state.busy || state.done) return;

    state.busy = true;
    state.kernelTouched = false;
    state.unsafe = false;
    state.alreadyJailbroken = false;
    state.ctx = null;
    setError('');
    showDetails(false);
    setIcon('running');
    setHeadline('Running', '');
    setStatus('Starting...', 'running');
    setHint('');
    setButtons([]);
    resetSteps();
    startTimer();

    try {
      // Keep the proven load order. Wobkot's primitive is heap-sensitive, and
      // this is the sequence that completed on 14.02. The heavy Afterglow
      // module is loaded only after the primitive and validation are done.
      await loadScript('../src/logger.js');
      logger.init();
      logger.bufferOnly = true;
      install_error_handlers();

      await loadScript('../src/strategy.js');
      await loadScript('../src/misc.js');
      await loadScript('../src/ps4/impl.js');
      await loadScript('../src/userland.js');
      await loadScript('../src/afterglow_host.js');
      markPhase('load');

      version.init();
      state.fw = version.key;
      setText('fw', 'PS4 ' + version.key);

      const route = routeFor(version.console, version.major, version.minor);
      if (!route.supported || route.engine !== 'combined') {
        throw new Error(`This page is for PS4 14.00-14.02. Detected ${version}.`);
      }

      state.step = 'webkit';
      setStep('webkit', 'active');
      setStatus('Building browser primitive...', 'running');
      setHint('If the browser warns about memory, press OK. It may reload and start again.');
      arw.init();
      afterglow_check_arw();
      markPhase('browser');
      setHint('');
      setStep('webkit', 'done');

      // The spray is done. Warm the kernel module while validation runs; the
      // payload files are warmed at the kernel stage, right before they are
      // needed, so no temporary buffer competes with the spray.
      prefetchLink(withVersion('../src/afterglow_bridge.js'));
      prefetchLink('../src/afterglow_fast.js');

      state.step = 'validate';
      setStep('validate', 'active');
      setStatus('Checking offsets and ROP...', 'running');
      const base = afterglow_precheck_webkit_base();
      afterglow_validate_gadgets(base);
      const expected = afterglow_precheck_kernel_bases(base);
      rop.init();
      afterglow_validate_bases(base);
      if (!libc_base.eq(expected.libc)) throw new Error('libc base changed during rop.init()');
      if (!libkernel_base.eq(expected.libkernel)) throw new Error('libkernel base changed during rop.init()');
      afterglow_precheck_pivot();

      setStatus('Checking ROP...', 'running');
      const pid = fn.getpid.invoke();
      if (!Number.isFinite(pid) || pid <= 0 || pid > 1000000) {
        throw new Error(`getpid returned an implausible value: ${pid}`);
      }
      logger.debug(`pid: ${pid}`);
      markPhase('check');
      setStep('validate', 'done');

      state.step = 'kernel';
      setStep('kernel', 'active');
      setStatus('Running kernel exploit...', 'running');

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
        if (text.indexOf('kernel is already open') !== -1) {
          state.alreadyJailbroken = true;
          setStatus('Kernel is already open.', 'running');
        } else if (text.indexOf('[1] leak') !== -1) setStatus('Leaking kernel base...', 'running');
        else if (text.indexOf('[4] mapping') !== -1) setStatus('Walking kernel mappings...', 'running');
        else if (text.indexOf('[5] widen') !== -1) setStatus('Patching kernel text...', 'running');
        else if (text.indexOf('[6] kernel patched') !== -1) setStatus('Kernel patched. Escaping sandbox...', 'running');
        else if (text.indexOf('[9] jailbroken') !== -1) setStatus('Root. Defusing handles...', 'running');
        else if (text.indexOf('[p] thread rc=0') !== -1) setStatus('Payload thread running...', 'running');
      };

      markPhase('module');

      if (query().get('probe') === '1') {
        const probe = Afterglow.probeAfterglow(state.ctx);
        if (!probe.ok) throw new Error(`Afterglow probe refused: ${probe.reasons.join('; ')}`);
      }

      markKernelAttempted();
      const iface = await Afterglow.runAfterglow(state.ctx, { tries: 4 });
      if (!iface) {
        if (state.alreadyJailbroken) {
          state.done = true;
          finishTimer();
          markAlreadyJailbroken();
          showAlreadyJailbroken();
          recordRun(true, 'already jailbroken');
          return;
        }
        throw new Error('Afterglow did not return a kernel interface');
      }

      state.kernelTouched = state.kernelTouched || state.ctx.kernel_touched;
      state.unsafe = state.ctx.unsafe === true || iface.defused === false;

      if (state.unsafe) {
        state.done = true;
        throw new Error('Kernel is open, but the handles are NOT defused.');
      }

      state.done = true;
      finishTimer();
      markPhase('kernel');
      setStep('kernel', 'done');

      if (iface.payload) {
        const label = selectedPayload() === 'hen' ? 'ps4-hen' : 'GoldHEN';
        setStep('payload', 'done');
        setStatus(`${label} started.`, 'done');
      } else {
        setStep('payload', 'skip');
        setStatus('Kernel open; no payload selected.', 'done');
      }

      setIcon('done');
      setHeadline('Jailbroken', 'done');
      setHint('');
      setButtons(['menu']);
      showLog(false);
      markAlreadyJailbroken();
      recordRun(true, '');
      globalThis.afterglow_iface = iface;
    } catch (err) {
      state.kernelTouched = state.kernelTouched || (state.ctx && state.ctx.kernel_touched);
      state.unsafe = state.unsafe || (state.ctx && state.ctx.unsafe === true);
      state.done = true;
      finishTimer();
      markFailure(err);
    } finally {
      state.busy = false;
      const start = el('start');
      if (start) start.disabled = false;
    }
  }

  function ready() {
    setIcon('idle');
    setHeadline('Ready', '');
    setStatus('Press Start.', 'idle');
    setHint('');
    setButtons(['start', 'fallback', 'menu']);
    resetSteps();
  }

  function boot() {
    const params = query();
    const manual =
      params.get('menu') === '1' ||
      params.get('run') === '0' ||
      params.get('stop') === '1';

    // Auto-start is the default. The one-attempt guard below is what prevents
    // a restored page from firing a second kernel attempt in the same session.
    state.armed = !manual;

    restorePayload();

    el('start').addEventListener('click', (event) => {
      event.preventDefault();
      run();
    });

    el('retry').addEventListener('click', (event) => {
      event.preventDefault();
      if (safeToLeave()) location.reload();
    });

    const runAnyway = el('run-anyway');
    if (runAnyway) {
      runAnyway.addEventListener('click', (event) => {
        event.preventDefault();
        try {
          sessionStorage.removeItem(ALREADY_KEY);
          sessionStorage.removeItem(ATTEMPT_KEY);
        } catch (err) {
          // ignore
        }
        state.done = false;
        state.busy = false;
        run();
      });
    }

    el('toggle-log').addEventListener('click', (event) => {
      event.preventDefault();
      showLog();
    });

    el('toggle-details').addEventListener('click', (event) => {
      event.preventDefault();
      showDetails();
    });

    const hideDetails = el('hide-details');
    if (hideDetails) {
      hideDetails.addEventListener('click', (event) => {
        event.preventDefault();
        showDetails(false);
        const hero = document.querySelector('.hero');
        if (hero) {
          try {
            hero.scrollIntoView({ block: 'start' });
          } catch (err) {
            hero.scrollIntoView(true);
          }
        }
      });
    }

    el('change-payload').addEventListener('click', (event) => {
      event.preventDefault();
      showDetails(true);
      const details = el('details');
      if (details) {
        try {
          details.scrollIntoView({ block: 'start' });
        } catch (err) {
          details.scrollIntoView(true);
        }
      }
    });

    for (const radio of document.querySelectorAll('input[name="payload"]')) {
      radio.addEventListener('change', rememberPayload);
    }

    setText('fw', 'PS4');
    const uaFirmware = /PlayStation\s+4[/ ](\d+\.\d+)/.exec(navigator.userAgent);
    if (uaFirmware) setText('fw', 'PS4 ' + uaFirmware[1]);
    showDetails(false);
    showLog(false);
    updatePayloadSummary();
    renderHistory();

    if (alreadyJailbroken() && params.get('force') !== '1') {
      showAlreadyJailbroken();
      return;
    }

    if (kernelAttempted() && params.get('force') !== '1') {
      setIcon('warn');
      setHeadline('Reboot required', 'warn');
      setStatus(
        'A kernel attempt already happened in this browser session. Reboot the console before another run.',
        'warn',
      );
      setButtons(['menu']);
      resetSteps();
      return;
    }

    if (state.armed) run();
    else ready();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
