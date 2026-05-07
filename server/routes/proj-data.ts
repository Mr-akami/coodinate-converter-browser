import type { Hono } from 'hono';
import { createReadStream, statSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';

export interface ManifestGridEntry {
  size: number;
  sha256: string;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  projDb: { size: number; sha256: string };
  grids: Record<string, ManifestGridEntry>;
}

export interface ProjDataConfig {
  manifest: Manifest;
  manifestText: string;
  projDataDir: string; // absolute path
}

export interface DevFaultRef {
  enabled: boolean;
  forced404: Set<string>;
}

const SAFE_NAME = /^[A-Za-z0-9._+\-]+$/;

function streamFile(path: string): ReadableStream<Uint8Array> {
  const node = createReadStream(path);
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}

export function registerProjDataRoutes(
  app: Hono,
  cfg: ProjDataConfig,
  fault: DevFaultRef,
): void {
  const { manifest, manifestText, projDataDir } = cfg;
  const version = manifest.version;
  const projDbPath = resolve(projDataDir, 'proj.db');
  const projDbSize = manifest.projDb.size;
  const projDbEtag = `"${manifest.projDb.sha256}"`;

  // Convenience redirect: /api/proj-data/manifest -> /v/<current>/manifest
  app.get('/api/proj-data/manifest', (c) => {
    return c.redirect(`/api/proj-data/v/${version}/manifest`, 302);
  });

  // /v/:version/manifest — current version returns body, others 410.
  app.get('/api/proj-data/v/:version/manifest', (c) => {
    const v = c.req.param('version');
    if (v !== version) {
      return c.text('manifest version retired', 410);
    }
    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('ETag', `"manifest-${version}"`);
    return c.body(manifestText);
  });

  app.get('/api/proj-data/v/:version/proj.db', async (c) => {
    const v = c.req.param('version');
    if (v !== version) return c.text('version retired', 410);

    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch === projDbEtag) {
      c.header('ETag', projDbEtag);
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(null, 304);
    }

    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Length', String(projDbSize));
    c.header('ETag', projDbEtag);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(streamFile(projDbPath));
  });

  app.get('/api/proj-data/v/:version/grids/:name', async (c) => {
    const v = c.req.param('version');
    if (v !== version) return c.text('version retired', 410);

    let name: string;
    try {
      name = decodeURIComponent(c.req.param('name'));
    } catch {
      return c.text('bad name encoding', 400);
    }

    // Defense layer 1: reject control chars and structural separators.
    if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') ||
        name === '.' || name === '..') {
      return c.text('bad name', 400);
    }

    // Defense layer 2: manifest allow-list match.
    const entry = manifest.grids[name];
    if (!entry) return c.text('not in manifest', 404);

    // Defense layer 3: dev-mode forced 404.
    if (fault.enabled && fault.forced404.has(name)) {
      return c.text('forced 404 (dev)', 404);
    }

    // Defense layer 4: filesystem path containment check.
    const full = resolve(projDataDir, name);
    const rel = relative(projDataDir, full);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return c.text('path escape rejected', 400);
    }

    let stat;
    try {
      stat = statSync(full);
    } catch {
      return c.text('grid file missing on disk', 404);
    }
    if (!stat.isFile()) return c.text('not a file', 404);
    if (stat.size !== entry.size) {
      return c.text('manifest size mismatch (rebuild manifest)', 500);
    }

    const etag = `"${entry.sha256}"`;
    if (c.req.header('if-none-match') === etag) {
      c.header('ETag', etag);
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(null, 304);
    }

    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Length', String(entry.size));
    c.header('ETag', etag);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('X-Grid-SHA256', entry.sha256);
    return c.body(streamFile(full));
  });
}
