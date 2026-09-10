import type { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

/*
 * Serve a generated Data Origin from disk, for development and for the test
 * suite. In production this directory is uploaded to static storage and no
 * server is involved, so this file exists to imitate one — including the cache
 * headers a host is told to set, because getting those wrong is a class of bug
 * the suite should be able to reproduce.
 */

export interface ProjDataConfig {
  /** Absolute path to a directory produced by scripts/build-data-dist.mjs. */
  dataDistDir: string;
}

export interface DevFaultRef {
  enabled: boolean;
  forced404: Set<string>;
}

function streamFile(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
}

/* Version and grid names come from the URL, so they are checked before they
   reach the filesystem rather than after. */
const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/;

function safeJoin(root: string, ...segments: string[]): string | null {
  for (const segment of segments) {
    if (!segment || !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      return null;
    }
  }
  const full = resolve(root, join(...segments));
  const rel = relative(root, full);
  return rel.startsWith('..') || isAbsolute(rel) ? null : full;
}

async function sendFile(
  path: string,
  contentType: string,
  cacheControl: string,
): Promise<Response | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  // Node's Response accepts a web ReadableStream; the DOM lib is not loaded
  // here, so the body type has to be widened explicitly.
  return new Response(streamFile(path) as unknown as ConstructorParameters<typeof Response>[0], {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(info.size),
      'Cache-Control': cacheControl,
    },
  });
}

export function registerProjDataRoutes(
  app: Hono,
  cfg: ProjDataConfig,
  fault: DevFaultRef,
): void {
  const root = cfg.dataDistDir;

  /* The pointer to the current Data Version must never be cached, or a client
     keeps asking for a version that has been retired. */
  app.get('/api/proj-data/manifest', async (c) => {
    const body = await sendFile(
      join(root, 'manifest.json'),
      'application/json; charset=utf-8',
      'no-cache',
    );
    return body ?? c.text('manifest not built', 404);
  });

  app.get('/api/proj-data/v/:version/manifest', async (c) => {
    const path = safeJoin(root, 'v', c.req.param('version'), 'manifest.json');
    if (!path) return c.text('bad version', 400);
    const body = await sendFile(path, 'application/json; charset=utf-8', 'no-cache');
    return body ?? c.text('unknown version', 404);
  });

  /* Everything addressed by version is immutable: the version is derived from
     the hash of proj.db, so these bytes can never change under this path. */
  app.get('/api/proj-data/v/:version/proj.db', async (c) => {
    const path = safeJoin(root, 'v', c.req.param('version'), 'proj.db');
    if (!path) return c.text('bad version', 400);
    const body = await sendFile(
      path, 'application/octet-stream', 'public, max-age=31536000, immutable',
    );
    return body ?? c.text('unknown version', 404);
  });

  app.get('/api/proj-data/v/:version/grids/:name', async (c) => {
    let name: string;
    try {
      name = decodeURIComponent(c.req.param('name'));
    } catch {
      return c.text('bad name encoding', 400);
    }

    if (fault.enabled && fault.forced404.has(name)) {
      return c.text('forced 404 (dev)', 404);
    }

    const path = safeJoin(root, 'v', c.req.param('version'), 'grids', name);
    if (!path) return c.text('bad name', 400);
    const body = await sendFile(
      path, 'application/octet-stream', 'public, max-age=31536000, immutable',
    );
    return body ?? c.text('no such grid', 404);
  });
}
