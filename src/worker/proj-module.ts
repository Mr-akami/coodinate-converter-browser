/*
 * The wasm module: load it, put proj.db in MEMFS and expose the pw_* calls.
 *
 * The C ABI is fixed by src/proj_wasm.h; this file only maps its status codes
 * onto the errors the rest of the runtime classifies on.
 */

import { MissingGridError } from '../errors.js';
import { ensureMemfsDir } from './memfs.js';
import type {
  Coordinate, CrsInfo, EnumeratedGrid, OperationInfo, ProjModule,
} from '../types.js';

// pw_grids_needed status codes: -1 bad argument, -2 CRS, -3 ballpark only.
const GRIDS_NEEDED_BALLPARK_ONLY = -3;
// pw_transform result codes.
const TRANSFORM_MISSING_GRID = 5;
const TRANSFORM_BALLPARK_ONLY = 6;

/**
 * `projDbBytes` is the browser path: the database is copied into MEMFS because
 * that is the only filesystem available there. `nodeDataDir` is the Node path:
 * the real directory is mounted, so PROJ reads proj.db and every grid straight
 * off the disk they already sit on, with nothing copied and nothing to fetch.
 */
export async function createProjModule({
  moduleUrl, wasmUrl, memfsPath, projDbBytes, nodeDataDir,
}: {
  moduleUrl: string;
  wasmUrl?: string;
  memfsPath: string;
  projDbBytes?: Uint8Array;
  nodeDataDir?: string;
}): Promise<ProjModule> {
  const loaded: any = await import(/* @vite-ignore */ moduleUrl);
  const createModule = loaded.default || loaded;

  const Module: any = await createModule({
    locateFile: (path: string) => (wasmUrl && path.endsWith('.wasm') ? wasmUrl : path),
  });

  ensureMemfsDir(Module.FS, memfsPath);
  if (nodeDataDir) {
    Module.FS.mount(Module.NODEFS, { root: nodeDataDir }, memfsPath);
  } else {
    Module.FS.writeFile(`${memfsPath}/proj.db`, projDbBytes!);
  }

  const rc = Module.ccall('pw_init', 'number', ['string'], [memfsPath]);
  if (rc !== 0) throw new Error(`pw_init failed: ${rc}`);

  const coordinate = (value: number) => (Number.isFinite(value) ? value : NaN);

  return {
    fs: Module.FS,

    gridsNeeded(src: string, dst: string, x: number, y: number, discardMissing: number): EnumeratedGrid[] {
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

    strictCheck(src: string, dst: string, x: number, y: number): number {
      return Module.ccall(
        'pw_strict_check',
        'number',
        ['string', 'string', 'number', 'number'],
        [src, dst, coordinate(x), coordinate(y)],
      );
    },

    transform(src: string, dst: string, x: number, y: number, z: number, allowBallpark = true): Coordinate {
      const ptr = Module._malloc(3 * 8);
      if (!ptr) throw new Error('malloc failed');
      try {
        const base = ptr >> 3;
        Module.HEAPF64[base] = x;
        Module.HEAPF64[base + 1] = y;
        Module.HEAPF64[base + 2] = z || 0;

        const status = Module.ccall(
          'pw_transform',
          'number',
          ['string', 'string', 'number', 'number', 'number', 'number'],
          [src, dst, allowBallpark ? 1 : 0, ptr, ptr + 8, ptr + 16],
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

    /*
     * One call for many points. The whole reason it exists is that a caller
     * transforming a large array must not pay a worker round trip per point;
     * PROJ still resolves the operation per point inside, so results match
     * transform() exactly.
     *
     * `xyz` is interleaved x,y,z and is written in place.
     */
    transformMany(src: string, dst: string, xyz: Float64Array, allowBallpark = true): Float64Array {
      const count = Math.floor(xyz.length / 3);
      if (count === 0) return xyz;

      const bytes = count * 3 * 8;
      const ptr = Module._malloc(bytes);
      if (!ptr) throw new Error('malloc failed');
      try {
        Module.HEAPF64.set(xyz.subarray(0, count * 3), ptr >> 3);
        const status = Module.ccall(
          'pw_transform_many',
          'number',
          ['string', 'string', 'number', 'number', 'number'],
          [src, dst, allowBallpark ? 1 : 0, ptr, count],
        );

        if (status >= 0) {
          throw new Error(
            `pw_transform_many failed at point ${status} (${src} to ${dst})`,
          );
        }
        if (status === -TRANSFORM_MISSING_GRID) {
          throw new MissingGridError(`missing grid for ${src} to ${dst}`, { reason: 'missing_grid' });
        }
        if (status === -TRANSFORM_BALLPARK_ONLY) {
          throw new MissingGridError(`ballpark only for ${src} to ${dst}`, { reason: 'ballpark_only' });
        }
        if (status !== -1) {
          throw new Error(`pw_transform_many failed: ${status} (${src} to ${dst})`);
        }

        xyz.set(Module.HEAPF64.subarray(ptr >> 3, (ptr >> 3) + count * 3));
        return xyz;
      } finally {
        Module._free(ptr);
      }
    },

    describe(src: string, dst: string, x: number, y: number, allowBallpark = true): OperationInfo {
      const statusPtr = Module._malloc(4);
      if (!statusPtr) throw new Error('malloc failed');
      let jsonPtr = 0;
      try {
        jsonPtr = Module.ccall(
          'pw_describe',
          'number',
          ['string', 'string', 'number', 'number', 'number', 'number'],
          [src, dst, coordinate(x), coordinate(y), allowBallpark ? 1 : 0, statusPtr],
        );
        const status = Module.HEAP32[statusPtr >> 2];
        if (status !== 0 || !jsonPtr) {
          throw new Error(`pw_describe failed: ${status} (${src} to ${dst})`);
        }
        return JSON.parse(Module.UTF8ToString(jsonPtr));
      } finally {
        if (jsonPtr) Module._free(jsonPtr);
        Module._free(statusPtr);
      }
    },

    listCrs(lon: number, lat: number, kinds: number, authorities: string | null): CrsInfo[] {
      const statusPtr = Module._malloc(4);
      if (!statusPtr) throw new Error('malloc failed');
      let jsonPtr = 0;
      try {
        jsonPtr = Module.ccall(
          'pw_list_crs',
          'number',
          ['number', 'number', 'number', 'string', 'number'],
          [lon, lat, kinds, authorities, statusPtr],
        );
        const status = Module.HEAP32[statusPtr >> 2];
        if (status !== 0 || !jsonPtr) {
          throw new Error(`pw_list_crs failed: ${status} at ${lon}, ${lat}`);
        }
        return JSON.parse(Module.UTF8ToString(jsonPtr));
      } finally {
        if (jsonPtr) Module._free(jsonPtr);
        Module._free(statusPtr);
      }
    },

    refreshAfterGridWrite(): void {
      // Recreates the PROJ context so newly mounted grids become visible;
      // this also drops DatabaseContext's cached grid availability.
      const status = Module.ccall('pw_refresh_after_grid_write', 'number', [], []);
      if (status !== 0) throw new Error(`pw_refresh_after_grid_write failed: ${status}`);
    },
  };
}
