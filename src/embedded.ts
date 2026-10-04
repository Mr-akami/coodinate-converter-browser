/*
 * PROJ inside the caller's own (dedicated) worker, with a synchronous transform.
 *
 * The default runtime keeps PROJ in its own worker behind an async RPC, which is
 * right for UI code. A host that runs a synchronous computation in a worker of its
 * own (a Rust/wasm tiler calling back into JS mid-run, say) cannot await, so this
 * entry installs the same Data Version, OPFS grid store and transform flow in the
 * calling thread and adds `transformManySync`.
 *
 * Grids are still fetched only asynchronously: call `prepare` for the pairs and
 * areas the synchronous work will touch. `transformManySync` is strict by default
 * and throws MissingGridError when a needed grid is not mounted yet, so a host can
 * catch it, `prepare`, and retry; it never substitutes a ballpark silently.
 */

import { MissingGridError } from './errors.js';
import { installProjData } from './worker/data-install.js';
import { createGridProvider } from './worker/grid-provider.js';
import { createOpfsStore, createWebLock } from './worker/opfs-store.js';
import { createProjModule } from './worker/proj-module.js';
import { createTransformFlow } from './worker/transform-flow.js';
import type { FetchImpl, OperationInfo, ProgressEvent } from './types.js';

export { MissingGridError };

// Built from parts so Vite does not inline the Emscripten loader (see proj-runtime.ts).
const WASM_MODULE_PATH = ['..', 'proj_wasm.js'].join('/');

export interface EmbeddedProj {
  /** The Data Version in use. */
  readonly dataVersion: string;
  /**
   * Fetch and mount the grids `src`→`dst` needs at each sample point
   * (interleaved x,y,z in `src` axis order: lon,lat or easting,northing).
   * Without samples, the grids of the operation PROJ picks with no point.
   */
  prepare(src: string, dst: string, samples?: Float64Array, options?: { allowBallpark?: boolean; signal?: AbortSignal }): Promise<void>;
  /** Transform interleaved x,y,z synchronously; returns a new array. */
  transformManySync(src: string, dst: string, xyz: Float64Array, allowBallpark?: boolean): Float64Array;
  /** The operation a transform would use (fetches its grids first). */
  describe(src: string, dst: string, x?: number, y?: number): Promise<OperationInfo>;
}

export async function createEmbeddedProj({
  dataBaseUrl,
  dataDirName = 'proj-data',
  memfsPath = '/proj-data',
  wasmUrl,
  moduleUrl,
  fetchImpl = (url, init) => fetch(url, init),
  onProgress,
}: {
  /** Data Origin base URL (serves `manifest`, `v/<version>/…`). */
  dataBaseUrl: string;
  dataDirName?: string;
  memfsPath?: string;
  wasmUrl?: string;
  moduleUrl?: string;
  fetchImpl?: FetchImpl;
  onProgress?: (event: ProgressEvent) => void;
}): Promise<EmbeddedProj> {
  const base = dataBaseUrl.replace(/\/$/, '');
  const store = await createOpfsStore(dataDirName);
  const { dataVersion, manifest } = await installProjData({
    store,
    lock: createWebLock(),
    fetchImpl,
    manifestUrl: `${base}/manifest.json`,
    projDbUrlPattern: `${base}/v/{version}/proj.db`,
    onProgress: onProgress ?? (() => {}),
  });

  const projDbFile = await store.getFile(`${dataVersion}/proj.db`);
  const projModule = await createProjModule({
    moduleUrl: moduleUrl ?? new URL(WASM_MODULE_PATH, import.meta.url).href,
    wasmUrl,
    memfsPath,
    projDbBytes: new Uint8Array(await projDbFile.arrayBuffer()),
  });

  const gridProvider = createGridProvider({
    store,
    fs: projModule.fs,
    memfsPath,
    dataVersion,
    gridsBaseUrl: `${base}/v/${encodeURIComponent(dataVersion)}/grids/`,
    manifest,
    fetchImpl,
  });
  if ((await gridProvider.mountPublishedGrids()) > 0) projModule.refreshAfterGridWrite();
  const flow = createTransformFlow({ projModule, gridProvider, manifest });

  return {
    dataVersion,
    async prepare(src, dst, samples, options = {}) {
      const { allowBallpark = false, signal } = options;
      if (!samples || samples.length < 3) {
        await flow.preloadGrids([{ src, dst }], { signal });
        return;
      }
      for (let i = 0; i + 2 < samples.length; i += 3) {
        await flow.transform({
          src, dst, x: samples[i], y: samples[i + 1], z: samples[i + 2], allowBallpark, signal,
        });
      }
    },
    transformManySync(src, dst, xyz, allowBallpark = false) {
      if (!(xyz instanceof Float64Array) || xyz.length % 3 !== 0) {
        throw new TypeError('transformManySync: xyz must be a Float64Array of x,y,z triples');
      }
      return projModule.transformMany(src, dst, xyz.slice(), allowBallpark);
    },
    describe(src, dst, x = NaN, y = NaN) {
      return flow.describe({ src, dst, x, y });
    },
  };
}
