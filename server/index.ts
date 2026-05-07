import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerProjDataRoutes, type ProjDataConfig } from './routes/proj-data.ts';
import { registerStaticRoutes } from './routes/static.ts';
import { registerDevFaultRoutes, type DevFaultConfig } from './routes/dev-fault.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PROJ_DATA_DIR = resolve(ROOT, process.env.PROJ_DATA_DIR || 'third_party/sc-proj-data/proj');
const MANIFEST_PATH = resolve(ROOT, process.env.PROJ_MANIFEST || 'server/manifest.json');

if (!existsSync(MANIFEST_PATH)) {
  console.error(`manifest not found at ${MANIFEST_PATH}`);
  console.error('Run `npm run build:manifest` first.');
  process.exit(1);
}
if (!existsSync(PROJ_DATA_DIR)) {
  console.error(`proj-data dir not found at ${PROJ_DATA_DIR}`);
  process.exit(1);
}

const manifestText = await readFile(MANIFEST_PATH, 'utf8');
const manifest = JSON.parse(manifestText);
if (!manifest.version || !manifest.projDb || !manifest.grids) {
  console.error('manifest is missing version/projDb/grids');
  process.exit(1);
}

console.log(`[server] proj-data dir: ${PROJ_DATA_DIR}`);
console.log(`[server] manifest version: ${manifest.version}`);
console.log(`[server] grids in manifest: ${Object.keys(manifest.grids).length}`);

const projConfig: ProjDataConfig = {
  manifest,
  manifestText,
  projDataDir: PROJ_DATA_DIR,
};

const devFaultConfig: DevFaultConfig = {
  enabled: process.env.NODE_ENV !== 'production',
  forced404: new Set<string>(),
};

const app = new Hono();
app.use('*', logger());

registerProjDataRoutes(app, projConfig, devFaultConfig);
registerDevFaultRoutes(app, devFaultConfig);
registerStaticRoutes(app, ROOT);

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[server] listening on http://${info.address}:${info.port}`);
  console.log(`[server] manifest:  http://localhost:${info.port}/api/proj-data/manifest`);
  console.log(`[server] front:     http://localhost:${info.port}/`);
});
