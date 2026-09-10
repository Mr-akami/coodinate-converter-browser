import { createProjApi } from './proj-api.js';
import { createRpc } from './rpc.js';

export {
  MissingGridError,
  ProjWorkerError,
  DataVerificationError,
} from './errors.js';

/*
 * Create a PROJ instance against a Data Origin: a plain static location that
 * serves
 *   GET <dataBaseUrl>/manifest                    (302 -> /v/<version>/manifest)
 *   GET <dataBaseUrl>/v/<version>/manifest        JSON
 *   GET <dataBaseUrl>/v/<version>/proj.db         sqlite db
 *   GET <dataBaseUrl>/v/<version>/grids/<name>    grid file
 *
 * Everything below this call happens in one worker: it owns the OPFS copy of
 * proj-data, fetches grids on demand and mounts them for PROJ. After the first
 * load the instance starts from the newest complete Data Version already
 * stored, so it works offline.
 *
 * `workerUrl` and `wasmUrl` default to files next to this module, which is
 * what a bundler resolves; pass them when the assets are served from
 * somewhere else.
 */
export async function createProj({
  dataBaseUrl = '/api/proj-data',
  dataDirName = 'proj-data',
  memfsPath = '/proj-data',
  workerUrl,
  wasmUrl,
  moduleUrl,
  onProgress,
} = {}) {
  const resolvedWorkerUrl = workerUrl
    ? new URL(workerUrl, location.href).href
    : new URL('./proj-worker.js', import.meta.url).href;

  const worker = new Worker(resolvedWorkerUrl, { type: 'module' });
  const rpc = createRpc(worker);

  let ready;
  try {
    ready = await rpc.request({
      type: 'init',
      apiBaseUrl: dataBaseUrl,
      dataDirName,
      memfsPath,
      wasmUrl: wasmUrl ? new URL(wasmUrl, location.href).href : undefined,
      moduleUrl: moduleUrl
        ? new URL(moduleUrl, location.href).href
        : new URL('../dist/proj_wasm.js', import.meta.url).href,
    }, { onProgress });
  } catch (err) {
    // A failed init leaves a worker nobody will ever talk to.
    rpc.dispose();
    throw err;
  }

  return createProjApi(rpc, ready.manifest);
}
