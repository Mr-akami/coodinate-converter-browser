import { createProjApi } from './proj-api.js';
import { createRpc } from './rpc.js';

/*
 * Initialize the PROJ runtime against a server that exposes
 *   GET <apiBaseUrl>/manifest                       (302 → /v/<version>/manifest)
 *   GET <apiBaseUrl>/v/<version>/manifest           JSON
 *   GET <apiBaseUrl>/v/<version>/proj.db            sqlite db
 *   GET <apiBaseUrl>/v/<version>/grids/<name>       grid file
 *
 * Returns a `{ worker, api, manifest }` triple; use
 * `api.transform(src, dst, x, y, z)`. Everything below this call happens in
 * one worker: it owns the OPFS copy of proj-data, fetches grids on demand and
 * mounts them for PROJ. After the first load the runtime starts from the
 * newest complete Data Version already stored, so it works offline.
 */
export async function initProjRuntime({
  apiBaseUrl = '/api/proj-data',
  dataDirName = 'proj-data',
  memfsPath = '/proj-data',
  wasmUrl,
  moduleUrl,
  onProgress,
} = {}) {
  const workerUrl = new URL('./proj-worker.js', import.meta.url).href;
  const worker = new Worker(workerUrl, { type: 'module' });
  const rpc = createRpc(worker);

  const ready = await rpc.request({
    type: 'init',
    apiBaseUrl,
    dataDirName,
    memfsPath,
    wasmUrl: wasmUrl ? new URL(wasmUrl, location.href).href : undefined,
    moduleUrl: moduleUrl
      ? new URL(moduleUrl, location.href).href
      : new URL('../dist/proj_wasm.js', import.meta.url).href,
  }, { onProgress });

  const api = createProjApi(rpc, ready.manifest);
  return { worker, api, manifest: ready.manifest };
}
