/*
 * The wasm module: load it, put proj.db in MEMFS and expose the pw_* calls.
 *
 * The C ABI is fixed by src/proj_wasm.h; this file only maps its status codes
 * onto the errors the rest of the runtime classifies on.
 */

import { MissingGridError } from '../errors.js';
import { ensureMemfsDir } from './memfs.js';

// pw_grids_needed status codes: -1 bad argument, -2 CRS, -3 ballpark only.
const GRIDS_NEEDED_BALLPARK_ONLY = -3;
// pw_transform result codes.
const TRANSFORM_MISSING_GRID = 5;
const TRANSFORM_BALLPARK_ONLY = 6;

/**
 * @param {{moduleUrl: string, wasmUrl?: string, memfsPath: string, projDbBytes: Uint8Array}} config
 */
export async function createProjModule({ moduleUrl, wasmUrl, memfsPath, projDbBytes }) {
  const loaded = await import(moduleUrl);
  const createModule = loaded.default || loaded;

  const Module = await createModule({
    locateFile: (path) => (wasmUrl && path.endsWith('.wasm') ? wasmUrl : path),
  });

  ensureMemfsDir(Module.FS, memfsPath);
  Module.FS.writeFile(`${memfsPath}/proj.db`, projDbBytes);

  const rc = Module.ccall('pw_init', 'number', ['string'], [memfsPath]);
  if (rc !== 0) throw new Error(`pw_init failed: ${rc}`);

  const coordinate = (value) => (Number.isFinite(value) ? value : NaN);

  return {
    fs: Module.FS,

    gridsNeeded(src, dst, x, y, discardMissing) {
      const statusPtr = Module._malloc(4);
      if (!statusPtr) throw new Error('malloc failed');
      let jsonPtr = 0;
      try {
        jsonPtr = Module.ccall(
          'pw_grids_needed',
          'number',
          ['string', 'string', 'number', 'number', 'number', 'number'],
          [src, dst, coordinate(x), coordinate(y), discardMissing ? 1 : 0, statusPtr],
        );
        const status = Module.HEAP32[statusPtr >> 2];
        if (status === GRIDS_NEEDED_BALLPARK_ONLY) {
          throw new MissingGridError('no non-ballpark operation available', {
            reason: 'ballpark_only',
          });
        }
        if (status < 0) throw new Error(`pw_grids_needed failed: ${status}`);
        return JSON.parse(Module.UTF8ToString(jsonPtr));
      } finally {
        if (jsonPtr) Module._free(jsonPtr);
        Module._free(statusPtr);
      }
    },

    strictCheck(src, dst, x, y) {
      return Module.ccall(
        'pw_strict_check',
        'number',
        ['string', 'string', 'number', 'number'],
        [src, dst, coordinate(x), coordinate(y)],
      );
    },

    transform(src, dst, x, y, z) {
      const ptr = Module._malloc(3 * 8);
      if (!ptr) throw new Error('malloc failed');
      try {
        const base = ptr >> 3;
        Module.HEAPF64[base] = x;
        Module.HEAPF64[base + 1] = y;
        Module.HEAPF64[base + 2] = z || 0;

        // allow_ballpark is 1 for every call: strict mode decides with
        // pw_strict_check beforehand, so this call never owns that decision.
        const status = Module.ccall(
          'pw_transform',
          'number',
          ['string', 'string', 'number', 'number', 'number', 'number'],
          [src, dst, 1, ptr, ptr + 8, ptr + 16],
        );

        if (status === TRANSFORM_MISSING_GRID) {
          throw new MissingGridError(`missing grid for ${src} to ${dst}`, { reason: 'missing_grid' });
        }
        if (status === TRANSFORM_BALLPARK_ONLY) {
          throw new MissingGridError(`ballpark only for ${src} to ${dst}`, { reason: 'ballpark_only' });
        }
        if (status !== 0) {
          throw new Error(`pw_transform failed: ${status} (${src} to ${dst} at ${x}, ${y})`);
        }

        return {
          x: Module.HEAPF64[base],
          y: Module.HEAPF64[base + 1],
          z: Module.HEAPF64[base + 2],
        };
      } finally {
        Module._free(ptr);
      }
    },

    refreshAfterGridWrite() {
      // Recreates the PROJ context so newly mounted grids become visible;
      // this also drops DatabaseContext's cached grid availability.
      const status = Module.ccall('pw_refresh_after_grid_write', 'number', [], []);
      if (status !== 0) throw new Error(`pw_refresh_after_grid_write failed: ${status}`);
    },
  };
}
