import { ensureProjData } from './opfs/proj-data.js';

async function mountOpfs(Module, mountPoint = '/opfs') {
  const { FS } = Module;
  if (!FS || typeof FS.mkdir !== 'function') {
    throw new Error('FS is not available in this build');
  }
  try {
    FS.mkdir(mountPoint);
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      throw err;
    }
  }

  if (typeof Module.ccall !== 'function') {
    throw new Error('ccall is not available in this build');
  }
  if (Module.OPFS && typeof FS.mount === 'function') {
    try {
      FS.mount(Module.OPFS, {}, mountPoint);
      return;
    } catch (err) {
      if (typeof Module._wasmfs_create_opfs_backend !== 'function') {
        throw err;
      }
    }
  }

  if (typeof Module._wasmfs_create_opfs_backend !== 'function') {
    throw new Error('wasmfs OPFS backend is not available in this build (rebuild with -lopfs.js and export _wasmfs_create_opfs_backend)');
  }
  if (typeof Module._wasmfs_mount !== 'function') {
    throw new Error('wasmfs mount is not available in this build (export _wasmfs_mount)');
  }

  const backend = await Module.ccall(
    'wasmfs_create_opfs_backend',
    'number',
    [],
    [],
    { async: true }
  );
  const rc = await Module.ccall(
    'wasmfs_mount',
    'number',
    ['string', 'number'],
    [mountPoint, backend],
    { async: true }
  );
  if (rc < 0) {
    throw new Error(`wasmfs_mount failed: ${rc}`);
  }
}

export async function initProjRuntime({
  dataUrl,
  dataVersion,
  dataDirName = 'proj-data',
  mountPoint = '/opfs',
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

  await mountOpfs(Module, mountPoint);

  const dataPath = `${mountPoint}/${dataDirName}`;
  const rc = Module.ccall('pw_init', 'number', ['string'], [dataPath]);
  if (rc !== 0) {
    throw new Error(`proj_init failed: ${rc}`);
  }

  return { Module, dataPath, mountPoint };
}
