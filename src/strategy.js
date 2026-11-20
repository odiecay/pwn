// Firmware routing for the toolkit.
//
// One table, one place to change when a new firmware or engine is added. The
// hub (index.html) and the legacy console page both use this file, so they can
// never disagree about which chain a console should run.
//
// Versions are compared in the same units the rest of Wobkot uses: the major
// number is decimal, the minor number is the hexadecimal part of the firmware
// version. 14.02 -> major 14, minor 0x02. 11.52 -> major 11, minor 0x52.

(function (global) {
  'use strict';

  const ENGINE_WOBKOT = 'wobkot';
  const ENGINE_AFTERGLOW = 'afterglow';
  const ENGINE_COMBINED = 'combined';

  const ENGINES = {
    [ENGINE_WOBKOT]: {
      id: ENGINE_WOBKOT,
      label: 'Wobkot',
      detail: 'Wobkot WebKit primitive + Lapse kernel stage',
    },
    [ENGINE_AFTERGLOW]: {
      id: ENGINE_AFTERGLOW,
      label: 'Afterglow',
      detail: 'Proven Afterglow WebKit + kernel chain',
    },
    [ENGINE_COMBINED]: {
      id: ENGINE_COMBINED,
      label: 'Wobkot x Afterglow',
      detail: 'Wobkot WebKit primitive + Afterglow kernel stage (fast path)',
    },
  };

  // Afterglow's own tables. Listed here only to warn about gaps: the hub
  // sends the whole 12.00-14.02 range to Afterglow, and Afterglow itself
  // refuses an exact firmware it has no table for.
  const AFTERGLOW_VERSIONS = [
    '12.00',
    '12.02',
    '12.50',
    '12.52',
    '13.00',
    '13.02',
    '13.04',
    '13.50',
    '13.52',
    '14.00',
    '14.02',
  ];

  const ROUTES = [
    {
      id: 'ps4-14',
      console: 4,
      minMajor: 14,
      minMinor: 0x00,
      maxMajor: 14,
      maxMinor: 0x02,
      label: 'PS4 14.00 - 14.02',
      primary: ENGINE_COMBINED,
      engines: [ENGINE_COMBINED, ENGINE_AFTERGLOW],
      combinedPath: 'afterglow/combined.html',
      afterglowPath: 'afterglow/index.html',
      legacyPath: 'legacy.html',
      note:
        'Fast path: Wobkot builds the browser primitive, Afterglow runs the ' +
        'kernel exploit. The proven Afterglow chain is the fallback.',
    },
    {
      id: 'ps4-12-13',
      console: 4,
      minMajor: 12,
      minMinor: 0x00,
      maxMajor: 13,
      maxMinor: 0x52,
      label: 'PS4 12.00 - 13.52',
      primary: ENGINE_AFTERGLOW,
      engines: [ENGINE_AFTERGLOW],
      afterglowPath: 'afterglow/index.html',
      legacyPath: 'legacy.html',
      note: 'Afterglow is the proven chain for this range.',
    },
    {
      id: 'ps4-9-11',
      console: 4,
      minMajor: 9,
      minMinor: 0x00,
      maxMajor: 11,
      maxMinor: 0x52,
      label: 'PS4 9.00 - 11.52',
      primary: ENGINE_WOBKOT,
      engines: [ENGINE_WOBKOT],
      legacyPath: 'legacy.html',
      note: 'Wobkot legacy chain (WebKit + Lapse).',
    },
    {
      id: 'ps5',
      console: 5,
      minMajor: 0,
      minMinor: 0x00,
      maxMajor: 99,
      maxMinor: 0xff,
      label: 'PS5',
      primary: ENGINE_WOBKOT,
      engines: [ENGINE_WOBKOT],
      legacyPath: 'legacy.html',
      note: 'Wobkot PS5 chain, as provided by upstream.',
    },
  ];

  function parsePlayStationUA(ua) {
    const match = /PlayStation\s+(\d+)[/ ](\d+)\.(\d+)/.exec(String(ua || ''));
    if (!match) return null;

    const console = Number.parseInt(match[1], 10);
    const major = Number.parseInt(match[2], 10);
    const minor = Number.parseInt(match[3], 16);

    return {
      console,
      major,
      minor,
      key: versionKey(major, minor),
    };
  }

  function versionKey(major, minor) {
    return `${major}.${minor.toString(16).padStart(2, '0')}`;
  }

  function compareVersion(aMajor, aMinor, bMajor, bMinor) {
    if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
    if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
    return 0;
  }

  function enginePath(route, engine) {
    switch (engine) {
      case ENGINE_COMBINED:
        return route.combinedPath || null;
      case ENGINE_AFTERGLOW:
        return route.afterglowPath || null;
      case ENGINE_WOBKOT:
        return route.legacyPath || null;
      default:
        return null;
    }
  }

  function routeFor(console, major, minor) {
    for (const route of ROUTES) {
      if (route.console !== console) continue;
      if (compareVersion(major, minor, route.minMajor, route.minMinor) < 0) continue;
      if (compareVersion(major, minor, route.maxMajor, route.maxMinor) > 0) continue;

      const alternatives = route.engines
        .filter((engine) => engine !== route.primary)
        .map((engine) => ({
          engine,
          label: ENGINES[engine].label,
          detail: ENGINES[engine].detail,
          path: enginePath(route, engine),
        }));

      return {
        supported: true,
        route,
        engine: route.primary,
        engineInfo: ENGINES[route.primary],
        path: enginePath(route, route.primary),
        alternatives,
        label: route.label,
        note: route.note,
        key: versionKey(major, minor),
      };
    }

    let reason = 'Unsupported console';
    if (console === 4) {
      reason =
        'This toolkit has no chain for PS4 firmware ' +
        versionKey(major, minor) +
        '. Supported PS4 ranges are 9.00-11.52, 12.00-13.52 and 14.00-14.02.';
    } else if (console === 5) {
      reason = 'This toolkit has no chain for this PS5 firmware.';
    }

    return {
      supported: false,
      route: null,
      engine: null,
      engineInfo: null,
      path: null,
      alternatives: [],
      label: null,
      note: reason,
      key: versionKey(major, minor),
      reason,
    };
  }

  function isAfterglowVersion(key) {
    return AFTERGLOW_VERSIONS.indexOf(key) !== -1;
  }

  global.PS4_TOOLKIT_ENGINES = ENGINES;
  global.PS4_TOOLKIT_ROUTES = ROUTES;
  global.AFTERGLOW_VERSIONS = AFTERGLOW_VERSIONS;
  global.parsePlayStationUA = parsePlayStationUA;
  global.versionKey = versionKey;
  global.routeFor = routeFor;
  global.isAfterglowVersion = isAfterglowVersion;
})(typeof globalThis !== 'undefined' ? globalThis : this);
