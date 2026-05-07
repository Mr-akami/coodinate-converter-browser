import { ensureProjData } from './opfs/proj-data.js';
import * as gridStore from './opfs/grid-store.js';
import { createProjApi } from './proj-api.js';

/*
 * Initialize the PROJ runtime against a Hono server that exposes
 *   GET <apiBaseUrl>/manifest                       (302 → /v/<version>/manifest)
 *   GET <apiBaseUrl>/v/<version>/manifest           JSON
 *   GET <apiBaseUrl>/v/<version>/proj.db            sqlite db
 *   GET <apiBaseUrl>/v/<version>/grids/<name>       grid file
 *
 * Returns a `{ worker, api }` pair; use `api.transform(src, dst, x, y, z)`.
 * The transform call automatically lazy-fetches required grids and falls
 * back to a structured `MissingGridError` instead of a silent Helmert
 * approximation.
 */
export async function initProjRuntime({
  apiBaseUrl = '/api/proj-data',
  dataDirName = 'proj-data',
  memfsPath = '/proj-data',
  wasmUrl,
  moduleUrl,
  onProgress,
} = {}) {
  const manifestUrl = `${apiBaseUrl}/manifest`;
  const projDbUrlPattern = `${apiBaseUrl}/v/{version}/proj.db`;

  const installResult = await ensureProjData({
    manifestUrl,
    projDbUrlPattern,
    dirName: dataDirName,
    onProgress,
  });
  const manifest = installResult.manifest;

  // Read proj.db bytes back from OPFS so the wasm worker doesn't redownload.
  const projDbBytes = await readProjDbFromOpfs(dataDirName);

  const workerUrl = new URL('./proj-worker.js', import.meta.url).href;
  const worker = new Worker(workerUrl, { type: 'module' });

  const resolvedModuleUrl = moduleUrl
    ? new URL(moduleUrl, location.href).href
    : new URL('../dist/proj_wasm.js', import.meta.url).href;
  const resolvedWasmUrl = wasmUrl
    ? new URL(wasmUrl, location.href).href
    : undefined;

  await rpc(worker, {
    type: 'init',
    mountPath: memfsPath,
    wasmUrl: resolvedWasmUrl,
    moduleUrl: resolvedModuleUrl,
    projDbBytes: projDbBytes.buffer,
  }, [projDbBytes.buffer]);

  // Mount any grids previously persisted to OPFS so we don't re-fetch them.
  const cachedGrids = await loadCachedGridsFromOpfs(dataDirName, manifest);
  let preloadedGridNames = [];
  if (cachedGrids.length > 0) {
    const transferables = cachedGrids.map((g) => g.bytes.buffer);
    await rpc(worker, {
      type: 'addGrids',
      grids: cachedGrids.map((g) => ({ name: g.name, bytes: g.bytes })),
    }, transferables);
    preloadedGridNames = cachedGrids.map((g) => g.name);
  }

  const gridsBaseUrl = `${apiBaseUrl}/v/${encodeURIComponent(manifest.version)}/grids/`;
  const api = createProjApi(worker, {
    gridsBaseUrl,
    manifest,
    preloadedGridNames,
    persistGridsToOpfs: (name, bytes) => gridStore.writeGrid(name, bytes, dataDirName),
  });

  return { worker, api, manifest };
}

async function loadCachedGridsFromOpfs(dataDirName, manifest) {
  const names = await gridStore.listGrids(dataDirName);
  if (!names.length) return [];

  // Verify each cached file matches the current manifest before mounting,
  // so an outdated cached grid (e.g. version drift) doesn't poison results.
  const out = [];
  for (const name of names) {
    const expected = manifest.grids[name];
    if (!expected) continue; // not in current manifest; ignore (could clean up later)
    const bytes = await gridStore.readGrid(name, dataDirName);
    if (!bytes || bytes.length !== expected.size) continue;
    const hex = await sha256Hex(bytes);
    if (hex !== expected.sha256) continue;
    out.push({ name, bytes });
  }
  return out;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readProjDbFromOpfs(dirName) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(dirName, { create: false });
  const handle = await dir.getFileHandle('proj.db', { create: false });
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

let _nextId = 0;
function rpc(worker, msg, transferables) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const handler = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', handler);
      if (e.data.type === 'error') {
        reject(new Error(e.data.error || 'rpc error'));
      } else {
        resolve(e.data);
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ ...msg, id }, transferables || []);
  });
}
