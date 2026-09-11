import { createProj } from '/dist/lib/index.js';

const logEl = document.querySelector('#log');

function log(msg) {
  if (logEl) {
    logEl.textContent += `${msg}\n`;
  }
  console.log(msg);
}

async function main() {
  log('Starting PROJ runtime...');

  const api = await createProj({
    dataBaseUrl: '/api/proj-data',
    dataDirName: 'proj-data',
    wasmUrl: '/dist/proj_wasm.wasm',
    moduleUrl: `/dist/proj_wasm.js?v=${Date.now()}`,
    onProgress: (p) => {
      if (p.stage === 'proj-db') {
        const total = p.total ? `/${p.total}` : '';
        log(`proj.db ${p.bytes}${total}`);
      }
    },
  });

  const result = await api.transform('EPSG:4326', 'EPSG:3857', 139.6917, 35.6895, 0);
  log(`Result: ${JSON.stringify(result)}`);
}

main().catch((err) => {
  log(`Error: ${err && err.message ? err.message : String(err)}`);
});
