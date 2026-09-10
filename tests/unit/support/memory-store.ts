/*
 * In-memory stand-in for the OPFS-backed store the worker owns.
 *
 * Models the parts of the OPFS contract the storage layer depends on:
 *   - a writable created for a path replaces the file contents when closed
 *   - reads of an absent path reject
 *   - `getFile` yields a File whose `name` is the entry name (WORKERFS uses it)
 *   - removing an absent entry succeeds
 */

import type { OpLog } from './op-log';

interface StoreWritable {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface Store {
  readText(path: string): Promise<string>;
  getFile(path: string): Promise<File>;
  writeStream(path: string): Promise<StoreWritable>;
  publish(path: string): Promise<void>;
  isPublished(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  list(dirPath: string): Promise<string[]>;
  lastModified(path: string): Promise<number>;
}

export interface MemoryStore extends Store {
  /** Seed an entry without its `.ok` sidecar (an unverified / absent file). */
  seedUnpublished(path: string, data: Uint8Array | string, lastModified?: number): void;
  /** Seed an entry together with its `.ok` sidecar (a verified file). */
  seedPublished(path: string, data: Uint8Array | string, lastModified?: number): void;
  paths(): string[];
  bytes(path: string): Uint8Array;
  text(path: string): string;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function createMemoryStore(log?: OpLog): MemoryStore {
  const files = new Map<string, { bytes: Uint8Array; lastModified: number }>();
  let clock = 1_000;

  const record = (op: string) => log?.record(op);
  const nextTimestamp = () => (clock += 1);

  function put(path: string, data: Uint8Array | string, lastModified?: number): void {
    files.set(path, {
      bytes: toBytes(data),
      lastModified: lastModified ?? nextTimestamp(),
    });
  }

  function read(path: string): { bytes: Uint8Array; lastModified: number } {
    const entry = files.get(path);
    if (!entry) throw new Error(`NotFoundError: ${path}`);
    return entry;
  }

  return {
    async readText(path) {
      record(`readText:${path}`);
      return new TextDecoder().decode(read(path).bytes);
    },

    async getFile(path) {
      record(`getFile:${path}`);
      const entry = read(path);
      return new File([entry.bytes as BlobPart], basename(path), {
        lastModified: entry.lastModified,
      });
    },

    async writeStream(path) {
      record(`writeStream:${path}`);
      const chunks: Uint8Array[] = [];
      return {
        async write(chunk) {
          record(`write:${path}`);
          chunks.push(chunk.slice());
        },
        async close() {
          record(`close:${path}`);
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          put(path, merged);
        },
      };
    },

    async publish(path) {
      record(`publish:${path}`);
      put(`${path}.ok`, '');
    },

    async isPublished(path) {
      record(`isPublished:${path}`);
      return files.has(`${path}.ok`);
    },

    async remove(path) {
      record(`remove:${path}`);
      files.delete(path);
      const prefix = `${path}/`;
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) files.delete(key);
      }
    },

    async list(dirPath) {
      record(`list:${dirPath}`);
      const prefix = dirPath === '' ? '' : `${dirPath.replace(/\/+$/, '')}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        names.add(rest.split('/')[0]!);
      }
      return [...names];
    },

    async lastModified(path) {
      record(`lastModified:${path}`);
      return read(path).lastModified;
    },

    seedUnpublished(path, data, lastModified) {
      put(path, data, lastModified);
    },

    seedPublished(path, data, lastModified) {
      put(path, data, lastModified);
      put(`${path}.ok`, '', lastModified);
    },

    paths() {
      return [...files.keys()].sort();
    },

    bytes(path) {
      return read(path).bytes;
    },

    text(path) {
      return new TextDecoder().decode(read(path).bytes);
    },
  };
}
