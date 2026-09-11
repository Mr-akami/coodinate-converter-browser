/*
 * OPFS backing store for proj-data, plus the Web Lock the install path uses.
 *
 * Layout, relative to the store root:
 *   <dataVersion>/manifest.json  (+ .ok)
 *   <dataVersion>/proj.db        (+ .ok)
 *   <dataVersion>/grids/<name>   (+ .ok)
 *
 * Only the worker touches this. The install path and the grid provider see
 * the interface below and nothing about OPFS itself, so they can run against
 * an in-memory store in tests.
 */

import type { DataStore, Lock } from '../types.js';

// A path segment that is absent, or that is a file where a directory was
// expected, both mean "nothing is stored here".
const MISSING_ENTRY_ERRORS = ['NotFoundError', 'TypeMismatchError'];

function isMissingEntry(err: unknown): boolean {
  return !!err && MISSING_ENTRY_ERRORS.includes((err as Error).name);
}

/** @param dirName directory under the origin private file system */
export async function createOpfsStore(dirName: string): Promise<DataStore> {
  const root = await navigator.storage.getDirectory();
  const rootDir = await root.getDirectoryHandle(dirName, { create: true });

  async function resolveDir(dirPath: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = rootDir;
    for (const segment of dirPath.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  }

  async function resolveParent(path: string, create: boolean) {
    const segments = path.split('/');
    const name = segments.pop() as string;
    return { dir: await resolveDir(segments.join('/'), create), name };
  }

  async function resolveFile(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const { dir, name } = await resolveParent(path, create);
    return dir.getFileHandle(name, { create });
  }

  return {
    async readText(path: string) {
      const file = await (await resolveFile(path, false)).getFile();
      return file.text();
    },

    async getFile(path: string) {
      return (await resolveFile(path, false)).getFile();
    },

    async writeStream(path: string) {
      const handle = await resolveFile(path, true);
      const writable = await handle.createWritable();
      return {
        write: (chunk: Uint8Array) => writable.write(chunk as unknown as BufferSource),
        close: () => writable.close(),
      };
    },

    async publish(path: string) {
      const handle = await resolveFile(`${path}.ok`, true);
      const writable = await handle.createWritable();
      await writable.close();
    },

    async isPublished(path: string) {
      try {
        await resolveFile(`${path}.ok`, false);
        return true;
      } catch (err) {
        if (isMissingEntry(err)) return false;
        throw err;
      }
    },

    async remove(path: string) {
      try {
        const { dir, name } = await resolveParent(path, false);
        await dir.removeEntry(name, { recursive: true });
      } catch (err) {
        if (!isMissingEntry(err)) throw err;
      }
    },

    async list(dirPath: string) {
      try {
        const dir = await resolveDir(dirPath, false);
        const names: string[] = [];
        for await (const name of dir.keys()) names.push(name);
        return names;
      } catch (err) {
        if (isMissingEntry(err)) return [];
        throw err;
      }
    },

    async lastModified(path: string) {
      const file = await (await resolveFile(path, false)).getFile();
      return file.lastModified;
    },
  };
}

/** Web Lock wrapper; keeps `navigator` out of the install path. */
export function createWebLock(): Lock {
  return {
    request: (name, callback) => navigator.locks.request(name, callback),
  };
}
