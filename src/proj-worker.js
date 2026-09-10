// PROJ wasm worker.
// Lifecycle:
//   1. Main thread sends 'init' with proj.db bytes; we mount under MEMFS and call pw_init.
//   2. For each transform, main thread sends 'prepare' (we enumerate grids), then
//      'addGrids' (we mount + invalidate caches), then 'transform' (strict).

let Module = null;
let memfsPath = '/proj-data';
const mountedGrids = new Set();
// Pair-level strict-check memo. PROJ enumeration is expensive; once we know
// (src, dst) is instantiable with the currently-mounted grids, repeat calls
// can skip the check until something changes (addGrids / refresh).
const strictCheckedOk = new Set();

function ensureMemfsDir(FS, path) {
  try {
    FS.mkdir(path);
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }
}

async function handleInit(msg) {
  const { wasmUrl, moduleUrl, projDbBytes, mountPath } = msg;
  if (!projDbBytes) throw new Error('projDbBytes is required');

  memfsPath = mountPath || '/proj-data';

  const url = moduleUrl || '../dist/proj_wasm.js';
  const mod = await import(url);
  const createModule = mod.default || mod;

  Module = await createModule({
    locateFile: (path) => {
      if (wasmUrl && path.endsWith('.wasm')) return wasmUrl;
      return path;
    },
  });

  ensureMemfsDir(Module.FS, memfsPath);
  Module.FS.writeFile(`${memfsPath}/proj.db`, new Uint8Array(projDbBytes));

  const rc = Module.ccall('pw_init', 'number', ['string'], [memfsPath]);
  if (rc !== 0) throw new Error(`pw_init failed: ${rc}`);
}

function handlePrepare(msg) {
  const { src, dst, x, y, discardMissing = 0 } = msg;
  const statusPtr = Module._malloc(4);
  if (!statusPtr) throw new Error('malloc failed');
  let jsonPtr = 0;
  try {
    const xv = Number.isFinite(x) ? x : NaN;
    const yv = Number.isFinite(y) ? y : NaN;
    jsonPtr = Module.ccall(
      'pw_grids_needed',
      'number',
      ['string', 'string', 'number', 'number', 'number', 'number'],
      [src, dst, xv, yv, discardMissing ? 1 : 0, statusPtr],
    );
    const status = Module.HEAP32[statusPtr >> 2];
    if (status < 0) {
      // -1 arg, -2 crs, -3 ballpark_only
      if (status === -3) {
        const err = new Error('no non-ballpark op available');
        err.errorKind = 'ballpark_only';
        throw err;
      }
      throw new Error(`pw_grids_needed failed: ${status}`);
    }
    const grids = JSON.parse(Module.UTF8ToString(jsonPtr));
    return { grids };
  } finally {
    if (jsonPtr) Module._free(jsonPtr);
    Module._free(statusPtr);
  }
}

function handleAddGrids(msg) {
  const { grids } = msg;
  if (!Array.isArray(grids) || grids.length === 0) return { added: 0 };

  for (const g of grids) {
    if (!g || !g.name || !g.bytes) continue;
    const path = `${memfsPath}/${g.name}`;
    Module.FS.writeFile(path, g.bytes instanceof Uint8Array ? g.bytes : new Uint8Array(g.bytes));
    mountedGrids.add(g.name);
  }

  // Invalidate all PROJ caches so the new files are picked up; this also
  // recreates the context (covers DatabaseContext::cacheGridInfo_).
  const rc = Module.ccall('pw_refresh_after_grid_write', 'number', [], []);
  if (rc !== 0) throw new Error(`pw_refresh_after_grid_write failed: ${rc}`);
  strictCheckedOk.clear();
  return { added: grids.length };
}

function handleTransform(msg) {
  const { src, dst, x, y, z, _strict } = msg;

  // Optional strict pre-check (memoized per pair). When _strict is true,
  // verify the best non-ballpark op is instantiable; otherwise let
  // pw_transform pick the best available op including ballpark fallback
  // (matching cs2cs default).
  if (_strict) {
    const pairKey = `${src}|${dst}`;
    if (!strictCheckedOk.has(pairKey)) {
      const xv = Number.isFinite(x) ? x : NaN;
      const yv = Number.isFinite(y) ? y : NaN;
      const ok = Module.ccall(
        'pw_strict_check',
        'number',
        ['string', 'string', 'number', 'number'],
        [src, dst, xv, yv],
      );
      if (ok !== 1) {
        const prep = handlePrepare({ src, dst, x: xv, y: yv });
        const missing = prep.grids.filter((g) => !g.available && g.fullName);
        const err = new Error(missing.length
          ? `missing grid(s): ${missing.map((g) => g.fullName).join(', ')}`
          : 'no non-ballpark operation available (ballpark only)');
        err.errorKind = missing.length ? 'missing_grid' : 'ballpark_only';
        err.missingGrids = missing.map((g) => ({
          shortName: g.shortName,
          fullName: g.fullName,
          url: g.url,
        }));
        throw err;
      }
      strictCheckedOk.add(pairKey);
    }
  }

  const ptr = Module._malloc(3 * 8);
  if (!ptr) throw new Error('malloc failed');
  try {
    const base = ptr >> 3;
    Module.HEAPF64[base] = x;
    Module.HEAPF64[base + 1] = y;
    Module.HEAPF64[base + 2] = z || 0;

    // allow_ballpark=1 keeps this phase's browser behaviour: the strict
    // pre-check above owns the missing-grid decision.
    const rc = Module.ccall(
      'pw_transform', 'number',
      ['string', 'string', 'number', 'number', 'number', 'number'],
      [src, dst, 1, ptr, ptr + 8, ptr + 16],
    );

    if (rc === 5) {
      const err = new Error('missing grid (race)');
      err.errorKind = 'missing_grid';
      throw err;
    }
    if (rc === 6) {
      const err = new Error('ballpark only');
      err.errorKind = 'ballpark_only';
      throw err;
    }
    if (rc !== 0) {
      console.warn(`[proj-worker] pw_transform failed rc=${rc} src=${src} dst=${dst} x=${x} y=${y}`);
      throw new Error(`pw_transform failed: ${rc}`);
    }

    return {
      x: Module.HEAPF64[base],
      y: Module.HEAPF64[base + 1],
      z: Module.HEAPF64[base + 2],
    };
  } finally {
    Module._free(ptr);
  }
}

self.addEventListener('message', async (e) => {
  const { type, id } = e.data;
  try {
    let payload;
    if (type === 'init') {
      await handleInit(e.data);
      payload = { type: 'ready' };
    } else if (type === 'prepare') {
      payload = { type: 'prepared', ...handlePrepare(e.data) };
    } else if (type === 'addGrids') {
      payload = { type: 'added', ...handleAddGrids(e.data) };
    } else if (type === 'transform') {
      payload = { type: 'result', ...handleTransform(e.data) };
    } else {
      throw new Error(`unknown message type: ${type}`);
    }
    self.postMessage({ ...payload, id });
  } catch (err) {
    const message = (typeof err === 'object' && err !== null)
      ? (err.message || err.stack || String(err))
      : String(err);
    self.postMessage({
      type: 'error',
      id,
      error: message,
      errorKind: err && err.errorKind,
      missingGrids: err && err.missingGrids,
    });
  }
});
