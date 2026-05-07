import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve } from 'node:path';

/*
 * Serve the static frontend (index.html, src/*, dist/*, examples/*, tests/*)
 * from the repository root. Backwards compatibility: also serves the legacy
 * /assets/proj-data.tar.gz so existing pages keep working until Phase 5.
 */
export function registerStaticRoutes(app: Hono, root: string): void {
  app.use('/dist/*', serveStatic({ root: '.', rewriteRequestPath: (p) => p }));
  app.use('/src/*', serveStatic({ root: '.', rewriteRequestPath: (p) => p }));
  app.use('/assets/*', serveStatic({ root: '.', rewriteRequestPath: (p) => p }));
  app.use('/examples/*', serveStatic({ root: '.', rewriteRequestPath: (p) => p }));
  app.use('/tests/*', serveStatic({ root: '.', rewriteRequestPath: (p) => p }));

  app.get('/', serveStatic({ path: './index.html' }));
}
