/*
 * Grids: fetch, verify, store, mount.
 *
 * The bytes never enter the wasm heap. A stored grid is handed to PROJ as an
 * OPFS File mounted through WORKERFS, which reads only the blocks PROJ asks
 * for; the largest grid is 77 MB and the previous MEMFS copy stayed resident
 * for the life of the page.
 *
 * PROJ resolves a resource as `<search path>/<name>` and does not recurse,
 * and the search path also holds proj.db in MEMFS. Each grid is therefore
 * mounted on its own directory outside the search path and linked into it.
 */

import { DataVerificationError, MissingGridError } from '../errors.js';
import { ensureMemfsDir } from './memfs.js';
import type {
  DataStore, FetchImpl, GridProvider, GridRef, Manifest,
} from '../types.js';
import { responseChunks, writeVerifiedFile } from './verified-write.js';

const MOUNT_ROOT = '/proj-grid-mounts';

export interface WorkerGridProvider extends GridProvider {
  mountPublishedGrids(): Promise<number>;
}

export function createGridProvider({
  store, fs, memfsPath, dataVersion, gridsBaseUrl, manifest, fetchImpl,
}: {
  store: DataStore;
  fs: any;
  memfsPath: string;
  dataVersion: string;
  gridsBaseUrl: string;
  manifest: Manifest;
  fetchImpl: FetchImpl;
}): WorkerGridProvider {
  /** The only record of what PROJ can currently see. */
  const mounted = new Set<string>();

  const gridPath = (name: string) => `${dataVersion}/grids/${name}`;
  const gridRef = (name: string, url: string): GridRef[] =>
    [{ shortName: name, fullName: name, url }];

  async function download(name: string, signal?: AbortSignal) {
    const entry = manifest.grids[name];
    if (!entry) {
      throw new MissingGridError(`grid not in manifest: ${name}`, {
        reason: 'missing_grid',
        missingGrids: gridRef(name, ''),
      });
    }

    const url = gridsBaseUrl + encodeURIComponent(name);
    let response;
    try {
      response = await fetchImpl(url, { credentials: 'same-origin', signal });
    } catch (cause) {
      throw new MissingGridError(`grid fetch failed: ${name}`, {
        reason: 'fetch_failed',
        missingGrids: gridRef(name, url),
        cause,
      });
    }
    if (!response.ok || !response.body) {
      throw new MissingGridError(`grid fetch failed (${response.status}): ${name}`, {
        reason: 'fetch_failed',
        missingGrids: gridRef(name, url),
      });
    }

    try {
      await writeVerifiedFile({
        store,
        path: gridPath(name),
        source: responseChunks(response),
        expected: entry,
      });
    } catch (cause) {
      if (!(cause instanceof DataVerificationError)) throw cause;
      throw new MissingGridError(cause.message, {
        reason: 'hash_mismatch',
        missingGrids: gridRef(name, url),
        cause,
      });
    }
  }

  async function mount(name: string) {
    const file = await store.getFile(gridPath(name));
    const mountpoint = `${MOUNT_ROOT}/${name}`;
    ensureMemfsDir(fs, MOUNT_ROOT);
    ensureMemfsDir(fs, mountpoint);
    fs.mount(fs.filesystems.WORKERFS, { files: [file] }, mountpoint);
    fs.symlink(`${mountpoint}/${name}`, `${memfsPath}/${name}`);
    mounted.add(name);
  }

  return {
    isMounted(name: string): boolean {
      return mounted.has(name);
    },

    async ensureGrid(name: string, options: { signal?: AbortSignal } = {}): Promise<void> {
      if (mounted.has(name)) return;
      if (!(await store.isPublished(gridPath(name)))) await download(name, options.signal);
      await mount(name);
    },

    /** Mounts what previous visits already stored. */
    async mountPublishedGrids(): Promise<number> {
      let count = 0;
      for (const entry of await store.list(`${dataVersion}/grids`)) {
        // Listing returns the sidecars too; skipping them here halves the
        // lookups on a store that already holds hundreds of grids.
        if (entry.endsWith('.ok')) continue;
        if (!(await store.isPublished(gridPath(entry)))) continue;
        await mount(entry);
        count += 1;
      }
      return count;
    },
  };
}
