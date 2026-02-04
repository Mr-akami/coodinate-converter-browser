import { ensureProjData } from './opfs/proj-data.js';

async function collectOpfsFiles(dataDirName) {
  const root = await navigator.storage.getDirectory();
  const dataDir = await root.getDirectoryHandle(dataDirName, { create: false });
  const files = [];
  for await (const [name, handle] of dataDir.entries()) {
    if (handle.kind === 'directory') {
      throw new Error(
        `proj-data must be flat (no subdirectories). Found: ${name}/`
      );
    }
    if (handle.kind !== 'file') continue;
    const file = await handle.getFile();
    files.push(file);
  }
  return files;
}

export async function initProjRuntime({
  dataUrl,
  dataVersion,
  dataDirName = 'proj-data',
  memfsPath = '/proj-data',
  wasmUrl,
  moduleUrl,
  onProgress,
} = {}) {
  if (!dataUrl) throw new Error('dataUrl is required');
  if (!dataVersion) throw new Error('dataVersion is required');

  await ensureProjData({
    url: dataUrl,
    version: dataVersion,
    dirName: dataDirName,
    onProgress,
  });

  const files = await collectOpfsFiles(dataDirName);

  const workerUrl = new URL('./proj-worker.js', import.meta.url).href;
  const worker = new Worker(workerUrl, { type: 'module' });

  const resolvedModuleUrl = moduleUrl
    ? new URL(moduleUrl, location.href).href
    : new URL('../dist/proj_wasm.js', import.meta.url).href;
  const resolvedWasmUrl = wasmUrl
    ? new URL(wasmUrl, location.href).href
    : undefined;

  const msg = {
    type: 'init',
    memfsPath,
    wasmUrl: resolvedWasmUrl,
    moduleUrl: resolvedModuleUrl,
    files,
  };
  await rpc(worker, msg);

  return { worker };
}

let _nextId = 0;
function rpc(worker, msg, transferables) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const handler = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', handler);
      if (e.data.type === 'error') {
        reject(new Error(e.data.error));
      } else {
        resolve(e.data);
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ ...msg, id }, transferables || []);
  });
}
