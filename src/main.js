// Legacy Wobkot entry point.
//
// This page is for PS4 9.00-11.52 (Lapse kernel) and PS5. PS4 12.00 and newer
// are routed to Afterglow by src/strategy.js; opening this page on those
// firmwares shows a link instead of running the wrong chain.

function load_script(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src + (src.indexOf('?') === -1 ? '?' : '&') + 'v=13';
    script.onload = resolve;
    script.onerror = () => {
      reject(new Error(`Failed to load script: ${src}`));
    };
    document.head.appendChild(script);
  });
}

async function load_file(src) {
  const res = await fetch(src);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${src}`);
  }

  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

function append_line(text) {
  const console_el = document.getElementById('console');
  if (!console_el) return;

  console_el.append(text + '\n');
  console_el.scrollTop = console_el.scrollHeight;
}

function append_link(text, href) {
  const console_el = document.getElementById('console');
  if (!console_el) return;

  const link = document.createElement('a');
  link.href = href;
  link.textContent = text;
  link.style.color = '#9fb3d0';
  console_el.append(link);
  console_el.append('\n');
  console_el.scrollTop = console_el.scrollHeight;
}

function show_engine_notice(route) {
  append_line(
    `[!] PS4 ${version} uses the ${route.engineInfo.label} engine, not the legacy Wobkot chain.`,
  );
  append_line('');

  const link = document.createElement('a');
  link.href = route.path;
  link.textContent = `Open ${route.engineInfo.label}`;
  link.style.color = '#9fb3d0';
  document.getElementById('console').append(link);
  append_line('');

  if (route.engineInfo.id === 'combined') {
    const proven = document.createElement('a');
    proven.href = 'afterglow/index.html';
    proven.textContent = 'Open the proven Afterglow engine';
    proven.style.color = '#9fb3d0';
    document.getElementById('console').append(proven);
    append_line('');
  }

  const hub = document.createElement('a');
  hub.href = 'index.html';
  hub.textContent = 'Back to the hub';
  hub.style.color = '#9fb3d0';
  document.getElementById('console').append(hub);
  append_line('');
}

function show_unsupported_notice(route) {
  append_line(`[-] ${route.reason || 'Unsupported console or firmware.'}`);
  append_line('');

  const hub = document.createElement('a');
  hub.href = 'index.html';
  hub.textContent = 'Back to the hub';
  hub.style.color = '#9fb3d0';
  document.getElementById('console').append(hub);
  append_line('');
}

async function main() {
  await load_script('src/logger.js');
  logger.init();
  install_error_handlers();

  await load_script('src/strategy.js');
  await load_script('src/misc.js');

  version.init();

  const route = routeFor(version.console, version.major, version.minor);

  if (!route.supported) {
    show_unsupported_notice(route);
    return;
  }

  if (route.engine !== 'wobkot') {
    show_engine_notice(route);
    return;
  }

  switch (version.console) {
    case 4:
      await load_script('src/ps4/impl.js');
      break;
    case 5:
      await load_script('src/ps5/impl.js');
      break;
    default:
      throw new Error(`Unsupported console ${version.console}`);
  }

  if (version.console === 4) {
    const payload = await fetch('src/ps4/payload.bin', { method: 'HEAD' });
    if (!payload.ok) {
      logger.error('Missing src/ps4/payload.bin.');
      append_line('Put a PS4 payload there before running the legacy chain.');
      append_link('Payload instructions', 'PAYLOADS.md');
      return;
    }
  }

  if (version.console === 5) {
    for (const file of ['src/ps5/elfldr.elf', 'src/ps5/kexp.bin']) {
      const payload = await fetch(file, { method: 'HEAD' });
      if (!payload.ok) {
        logger.error(`Missing ${file}.`);
        append_line('Put the PS5 payload files in src/ps5/.');
        append_link('Payload instructions', 'PAYLOADS.md');
        return;
      }
    }
  }

  await load_script('src/userland.js');
  await userland_main();

  await load_script('src/kernel.js');
  await kernel_main();
}

main().catch((err) => {
  if (typeof logger !== 'undefined') logger.error(err && err.message ? err.message : String(err));
  else append_line(`[-] ${err}`);
});
