import { ensureProjData } from './opfs/proj-data.js';

async function loadOpfsToMemfs(Module, dataDirName, memfsPath) {
  const { FS } = Module;
  if (!FS || typeof FS.mkdir !== 'function') {
    throw new Error('FS is not available in this build');
  }
  try {
    FS.mkdir(memfsPath);
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      throw err;
    }
  }

  const root = await navigator.storage.getDirectory();
  const dataDir = await root.getDirectoryHandle(dataDirName, { create: false });

  for await (const [name, handle] of dataDir.entries()) {
    if (handle.kind !== 'file') continue;
    const file = await handle.getFile();
    const buf = new Uint8Array(await file.arrayBuffer());
    FS.writeFile(`${memfsPath}/${name}`, buf);
  }
}

export async function initProjRuntime({
  dataUrl,
  dataVersion,
  dataDirName = 'proj-data',
  memfsPath = '/proj-data',
  wasmUrl,
  moduleUrl,
  onProgress,
  moduleFactory,
  debug = false,
} = {}) {
  if (!dataUrl) {
    throw new Error('dataUrl is required');
  }
  if (!dataVersion) {
    throw new Error('dataVersion is required');
  }

  await ensureProjData({
    url: dataUrl,
    version: dataVersion,
    dirName: dataDirName,
    onProgress,
  });

  let createModule = moduleFactory;
  if (!createModule) {
    const url = moduleUrl
      ? new URL(moduleUrl, import.meta.url).href
      : new URL('../dist/proj_wasm.js', import.meta.url).href;
    const mod = await import(url);
    createModule = mod.default || mod;
  }

  const Module = await createModule({
    locateFile: (path) => {
      if (wasmUrl && path.endsWith('.wasm')) return wasmUrl;
      return path;
    },
  });

  if (debug) {
    globalThis.__projModule = Module;
  }

  await loadOpfsToMemfs(Module, dataDirName, memfsPath);

  const rc = Module.ccall('pw_init', 'number', ['string'], [memfsPath]);
  if (rc !== 0) {
    throw new Error(`pw_init failed: ${rc}`);
  }

  return { Module, dataPath: memfsPath };
}
