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

  const { worker } = await initProjRuntime({
    dataUrl: '/assets/proj-data.tar.gz',
    dataVersion: '2025-02-01',
    dataDirName: 'proj-data',
    wasmUrl: '/dist/proj_wasm.wasm',
    moduleUrl: `/dist/proj_wasm.js?v=${Date.now()}`,
    onProgress: (p) => {
      if (p.stage === 'extract') {
        const total = p.total ? `/${p.total}` : '';
        log(`Extracting... bytes ${p.bytes}${total}, entries ${p.entries}`);
      }
    },
  });

  const proj = createProjApi(worker);
  const result = await proj.transform('EPSG:4326', 'EPSG:3857', 139.6917, 35.6895, 0);

  log(`Result: ${JSON.stringify(result)}`);
}

main().catch((err) => {
  log(`Error: ${err && err.message ? err.message : String(err)}`);
});
