/*
 * Development server.
 *
 * Production does not have one: the library is a package, and the Data Origin
 * is static files on whatever storage the host application uses. This exists
 * so the demo page and the browser suite have something to fetch from, and so
 * the fault-injection routes the suite needs have somewhere to live.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerProjDataRoutes, type ProjDataConfig } from './routes/proj-data.ts';
import { registerStaticRoutes } from './routes/static.ts';
import { registerDevFaultRoutes, type DevFaultConfig } from './routes/dev-fault.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIST_DIR = resolve(ROOT, process.env.PROJ_DATA_DIST || 'data-dist');

if (!existsSync(resolve(DATA_DIST_DIR, 'manifest.json'))) {
  console.error(`no Data Origin at ${DATA_DIST_DIR}`);
  console.error('Run `npm run build:data` first.');
  process.exit(1);
}

const projConfig: ProjDataConfig = { dataDistDir: DATA_DIST_DIR };

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
  console.log(`[dev] data origin: ${DATA_DIST_DIR}`);
  console.log(`[dev] listening on http://localhost:${info.port}/`);
});
