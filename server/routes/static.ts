import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve } from 'node:path';

/*
 * Serve the demo and the suite straight from the repository, so a change to a
 * source file is visible on reload without a build step.
 *
 * This is development only. A published application imports the package and
 * serves whatever its own bundler produced; nothing here ships.
 */
export function registerStaticRoutes(app: Hono, root: string): void {
  app.use('/dist/*', serveStatic({ root: '.', rewriteRequestPath: (p) => p }));
  app.use('/examples/*', serveStatic({ root: '.', rewriteRequestPath: (p) => p }));
  app.use('/tests/*', serveStatic({ root: '.', rewriteRequestPath: (p) => p }));

  app.get('/', serveStatic({ path: './index.html' }));
}
