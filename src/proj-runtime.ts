import { createProjApi, type Proj } from './proj-api.js';
import { createRpc } from './rpc.js';

/*
 * Where the Emscripten module sits relative to the built library, which lands
 * in dist/lib/ alongside its .wasm one directory up.
 *
 * The path is assembled at runtime rather than written as a literal because a
 * bundler that recognises it treats the module as an asset and inlines all
 * 100 kB of it as a data URL, losing the .wasm sibling it needs.
 */
const WASM_MODULE_PATH = ['..', 'proj_wasm.js'].join('/');

/*
 * The worker, likewise assembled at runtime. Written as a literal it is
 * recognised as a worker entry and inlined as a data URL — with the
 * TypeScript source, unbuilt — which fails the moment it runs.
 */
const WORKER_PATH = ['.', 'proj-worker.js'].join('/');

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
}: {
  dataBaseUrl?: string;
  dataDirName?: string;
  memfsPath?: string;
  workerUrl?: string;
  wasmUrl?: string;
  moduleUrl?: string;
  onProgress?: (event: import('./types.js').ProgressEvent) => void;
} = {}): Promise<Proj> {
  const resolvedWorkerUrl = workerUrl
    ? new URL(workerUrl, location.href).href
    : new URL(WORKER_PATH, import.meta.url).href;

  const worker = new Worker(resolvedWorkerUrl, { type: 'module' });
  const rpc = createRpc(worker);

  let ready: { manifest: { version: string } };
  try {
    ready = await rpc.request({
      type: 'init',
      apiBaseUrl: dataBaseUrl,
      dataDirName,
      memfsPath,
      wasmUrl: wasmUrl ? new URL(wasmUrl, location.href).href : undefined,
      // Resolved with a string the bundler cannot see through, so the
      // Emscripten module stays an artifact fetched at runtime. Spelling the
      // path literally here makes Vite inline the whole module as a data URL.
      moduleUrl: moduleUrl
        ? new URL(moduleUrl, location.href).href
        : new URL(WASM_MODULE_PATH, import.meta.url).href,
    }, { onProgress });
  } catch (err) {
    // A failed init leaves a worker nobody will ever talk to.
    rpc.dispose();
    throw err;
  }

  return createProjApi(rpc, ready.manifest);
}
