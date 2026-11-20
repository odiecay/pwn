// ES-module bridge for the combined engine.
//
// afterglow.js is an ES module and imports int64.js relative to itself. Classic
// Wobkot scripts cannot import it directly, so this tiny module loads it and
// publishes the namespace plus the int64 constructor on globalThis.

import * as Afterglow from './afterglow_fast.js';
import { int64 } from '../afterglow/int64.js';

globalThis.Afterglow = Afterglow;
globalThis.AfterglowInt64 = int64;
