// Diagnostics page: detect the console, show the route, and fetch every file
// the selected engine needs. This is a quick way to catch a server started in
// the wrong directory or a browser holding on to a stale file.

(function () {
  'use strict';

  const FILES = [
    { path: 'index.html', required: true },
    { path: 'legacy.html', required: true },
    { path: 'primitive-test.html', required: true },
    { path: 'diag.html', required: true },
    { path: 'src/strategy.js', required: true },
    { path: 'src/main.js', required: true },
    { path: 'src/logger.js', required: true },
    { path: 'src/misc.js', required: true },
    { path: 'afterglow/index.html', required: true },
    { path: 'afterglow/jb.html', required: true },
    { path: 'afterglow/combined.html', required: true },
    { path: 'afterglow/jb.js', required: true },
    { path: 'afterglow/core.js', required: true },
    { path: 'afterglow/mem.js', required: true },
    { path: 'afterglow/int64.js', required: true },
    { path: 'afterglow/ps4_offsets.js', required: true },
    { path: 'afterglow/afterglow.js', required: true },
    { path: 'afterglow/cache.appcache', required: true },
    { path: 'afterglow/patchset-1402.bin', required: true },
    { path: 'afterglow/goldhen.bin', required: true },
    { path: 'afterglow/hen.bin', required: false },
    { path: 'src/ps4/payload.bin', required: false },
  ];

  function el(id) {
    return document.getElementById(id);
  }

  function row(parent, cells) {
    const tr = document.createElement('tr');
    for (const cell of cells) {
      const td = document.createElement('td');
      if (cell && cell.nodeType) td.appendChild(cell);
      else td.textContent = cell == null ? '' : String(cell);
      tr.appendChild(td);
    }
    parent.appendChild(tr);
  }

  function addConsoleRow(name, value) {
    const tbody = el('console-info');
    const tr = document.createElement('tr');

    const th = document.createElement('th');
    th.textContent = name;
    th.style.width = '190px';

    const td = document.createElement('td');
    td.className = 'mono';
    td.textContent = value;

    tr.appendChild(th);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  async function checkFile(file) {
    const started = performance.now();
    let response;

    try {
      response = await fetch(file.path + '?diag=' + Date.now(), { cache: 'no-store' });
    } catch (err) {
      return {
        file,
        ok: false,
        status: 'FETCH FAILED',
        type: '',
        bytes: '',
        cache: String(err),
        ms: Math.round(performance.now() - started),
      };
    }

    const cache = response.headers.get('cache-control') || '';
    let bytes = '';

    try {
      const buf = await response.arrayBuffer();
      bytes = buf.byteLength.toLocaleString();
    } catch (err) {
      bytes = '?';
    }

    return {
      file,
      ok: response.ok,
      status: response.status + ' ' + response.statusText,
      type: response.headers.get('content-type') || '',
      bytes,
      cache,
      ms: Math.round(performance.now() - started),
    };
  }

  async function run() {
    const tbody = el('files');
    const summary = el('summary');
    tbody.innerHTML = '';
    summary.textContent = 'Checking files...';

    addConsoleRow('User agent', navigator.userAgent);
    addConsoleRow('URL', location.href);
    addConsoleRow('Referrer', document.referrer || '(none)');
    addConsoleRow('Online', navigator.onLine ? 'yes' : 'no');

    const ps = parsePlayStationUA(navigator.userAgent);

    if (ps) {
      addConsoleRow('Detected', `PlayStation ${ps.console}, firmware ${versionKey(ps.major, ps.minor)}`);
      const route = routeFor(ps.console, ps.major, ps.minor);
      addConsoleRow(
        'Route',
        route.supported
          ? `${route.engineInfo.label} -> ${route.path}`
          : route.reason || 'unsupported',
      );
    } else {
      addConsoleRow('Detected', 'No PlayStation user agent');
      addConsoleRow('Preview', 'append ?console=4&fw=14.02 to this URL');
    }

    const results = await Promise.all(FILES.map(checkFile));
    let requiredFailed = 0;

    for (const result of results) {
      const cells = [
        result.file.path + (result.file.required ? '' : ' (optional)'),
        result.status,
        result.type,
        result.bytes,
        result.cache + (result.ms !== undefined ? ` (${result.ms} ms)` : ''),
      ];

      const tr = document.createElement('tr');
      for (let i = 0; i < cells.length; i++) {
        const td = document.createElement('td');
        td.textContent = cells[i];
        if (i === 1) td.className = result.ok ? 'ok' : result.file.required ? 'bad' : 'warn';
        if (i === 0 || i === 2 || i === 3) td.className = 'mono';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);

      if (!result.ok && result.file.required) requiredFailed++;
    }

    if (requiredFailed === 0) {
      summary.textContent = `All ${results.length} files answered. Required files: OK.`;
      summary.className = 'mono ok';
    } else {
      summary.textContent = `${requiredFailed} required file(s) failed. Check the server directory and URL.`;
      summary.className = 'mono bad';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    el('recheck').addEventListener('click', function (event) {
      event.preventDefault();
      run();
    });
    run();
  });
})();
