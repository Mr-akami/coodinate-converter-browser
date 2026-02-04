// PROJ WASM Worker
// Receives File objects from main thread, mounts WORKERFS, runs WASM transforms.

let Module = null;

function mountWorkerFs(FS, WORKERFS, mountPath, files) {
  if (!WORKERFS) {
    throw new Error('WORKERFS not available. Build with -lworkerfs.js.');
  }
  try {
    FS.mkdir(mountPath);
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }
  FS.mount(WORKERFS, { files }, mountPath);
}

async function handleInit(msg) {
  const { memfsPath, wasmUrl, moduleUrl, files } = msg;

  const url = moduleUrl || '../dist/proj_wasm.js';
  const mod = await import(url);
  const createModule = mod.default || mod;

  Module = await createModule({
    locateFile: (path) => {
      if (wasmUrl && path.endsWith('.wasm')) return wasmUrl;
      return path;
    },
  });

  mountWorkerFs(Module.FS, Module.WORKERFS, memfsPath, files);

  const rc = Module.ccall('pw_init', 'number', ['string'], [memfsPath]);
  if (rc !== 0) throw new Error(`pw_init failed: ${rc}`);
}

function handleTransform(msg) {
  const { src, dst, x, y, z } = msg;
  const bytes = 3 * 8;
  const ptr = Module._malloc(bytes);
  if (!ptr) throw new Error('malloc failed');

  try {
    const base = ptr >> 3;
    Module.HEAPF64[base] = x;
    Module.HEAPF64[base + 1] = y;
    Module.HEAPF64[base + 2] = z;

    const rc = Module.ccall(
      'pw_transform', 'number',
      ['string', 'string', 'number', 'number', 'number'],
      [src, dst, ptr, ptr + 8, ptr + 16],
    );
    if (rc !== 0) throw new Error(`pw_transform failed: ${rc}`);

    return {
      x: Module.HEAPF64[base],
      y: Module.HEAPF64[base + 1],
      z: Module.HEAPF64[base + 2],
    };
  } finally {
    Module._free(ptr);
  }
}

self.addEventListener('message', async (e) => {
  const { type, id } = e.data;
  try {
    if (type === 'init') {
      await handleInit(e.data);
      self.postMessage({ type: 'ready', id });
    } else if (type === 'transform') {
      const result = handleTransform(e.data);
      self.postMessage({ type: 'result', id, ...result });
    } else {
      throw new Error(`unknown message type: ${type}`);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, error: err.message || String(err) });
  }
});
