# Third-party components

This toolkit combines two independently maintained projects. The licenses are
not the same; keep the notices with the files if you redistribute this folder.

## Wobkot

- Upstream: https://github.com/ufm42/wobkot
- License: MIT
- Files: `src/main.js`, `src/misc.js`, `src/userland.js`, `src/kernel.js`,
  `src/lapse.js`, `src/thread.js`, `src/worker.js`, `src/ps4/impl.js`,
  `src/ps5/impl.js`, `src/ps5/relapse.js`, and the original Wobkot page assets.
- The MIT text is in `LICENSE.txt`.

## Afterglow

- Upstream: https://github.com/well0nez/afterglow-web
- License: GNU Affero General Public License v3.0 or later
- Vendored under `afterglow/` from commit `587c00a564c4765b78ab413e400a392efdd9a780`
  (`2026-11-14`). The vendored engine is unmodified; `afterglow/combined.html`
  is a local addition.
- The AGPL text is in `afterglow/LICENSE` and `LICENSE-AGPL-3.0.txt`.
- The engine includes material derived from raw13g's host and slopkit; see
  `afterglow/TECHNICAL.md`, `afterglow/LICENSE-raw13g`, and Afterglow's own
  README for provenance.

## Payloads

- `afterglow/goldhen.bin` - GoldHEN by SiSTRo and contributors. GoldHEN is a
  separate GPL-3.0 project; source is at https://github.com/GoldHEN/GoldHEN.
  The bundled file is the copy supplied by Afterglow.
- `afterglow/hen.bin` - ps4-hen, as distributed by Afterglow. See Afterglow's
  README and TECHNICAL.md for the 14.00 patch note.
- `src/ps4/payload.bin` is not bundled; if you add one, its license is whatever
  its author says.

## Combined distribution

The combined work includes AGPL-3.0 code, so treat the whole distribution as
AGPL-3.0. The Wobkot files remain available under MIT; nothing here changes
their upstream license. If you redistribute a modified version, publish the
corresponding source for the AGPL-covered parts.
