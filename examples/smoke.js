import { initProjRuntime } from '../src/proj-runtime.js';
import { createProjApi } from '../src/proj-api.js';

const logEl = document.querySelector('#log');

function log(msg) {
  if (logEl) {
    logEl.textContent += `${msg}\n`;
  }
  console.log(msg);
}

async function main() {
  log('Starting PROJ runtime...');

  const { Module, dataPath } = await initProjRuntime({
    dataUrl: '/assets/proj-data.tar.gz',
    dataVersion: '2025-02-01',
    dataDirName: 'proj-data',
    wasmUrl: '/dist/proj_wasm.wasm',
    moduleUrl: `/dist/proj_wasm.js?v=${Date.now()}`,
    debug: true,
    onProgress: (p) => {
      if (p.stage === 'extract') {
        const total = p.total ? `/${p.total}` : '';
        log(`Extracting... bytes ${p.bytes}${total}, entries ${p.entries}`);
      }
    },
  });

  log(`wasmfs OPFS backend: ${typeof Module._wasmfs_create_opfs_backend}`);
  log(`wasmfs mount: ${typeof Module._wasmfs_mount}`);
  log(`Module.OPFS: ${Module.OPFS ? 'yes' : 'no'}`);
  log(`OPFS data path: ${dataPath}`);

  const proj = createProjApi(Module);
  const result = proj.transform('EPSG:4326', 'EPSG:3857', 139.6917, 35.6895, 0);

  log(`Result: ${JSON.stringify(result)}`);
}

main().catch((err) => {
  log(`Error: ${err && err.message ? err.message : String(err)}`);
  const mod = globalThis.__projModule;
  if (mod) {
    log(`Debug _wasmfs_create_opfs_backend: ${typeof mod._wasmfs_create_opfs_backend}`);
    log(`Debug _wasmfs_mount: ${typeof mod._wasmfs_mount}`);
  } else {
    log('Debug: __projModule not set');
  }
});
