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

// A path segment that is absent, or that is a file where a directory was
// expected, both mean "nothing is stored here".
const MISSING_ENTRY_ERRORS = ['NotFoundError', 'TypeMismatchError'];

function isMissingEntry(err) {
  return !!err && MISSING_ENTRY_ERRORS.includes(err.name);
}

/**
 * @param {string} dirName directory under the origin private file system
 */
export async function createOpfsStore(dirName) {
  const root = await navigator.storage.getDirectory();
  const rootDir = await root.getDirectoryHandle(dirName, { create: true });

  async function resolveDir(dirPath, create) {
    let dir = rootDir;
    for (const segment of dirPath.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  }

  async function resolveParent(path, create) {
    const segments = path.split('/');
    const name = segments.pop();
    return { dir: await resolveDir(segments.join('/'), create), name };
  }

  async function resolveFile(path, create) {
    const { dir, name } = await resolveParent(path, create);
    return dir.getFileHandle(name, { create });
  }

  return {
    async readText(path) {
      const file = await (await resolveFile(path, false)).getFile();
      return file.text();
    },

    async getFile(path) {
      return (await resolveFile(path, false)).getFile();
    },

    async writeStream(path) {
      const handle = await resolveFile(path, true);
      const writable = await handle.createWritable();
      return {
        write: (chunk) => writable.write(chunk),
        close: () => writable.close(),
      };
    },

    async publish(path) {
      const handle = await resolveFile(`${path}.ok`, true);
      const writable = await handle.createWritable();
      await writable.close();
    },

    async isPublished(path) {
      try {
        await resolveFile(`${path}.ok`, false);
        return true;
      } catch (err) {
        if (isMissingEntry(err)) return false;
        throw err;
      }
    },

    async remove(path) {
      try {
        const { dir, name } = await resolveParent(path, false);
        await dir.removeEntry(name, { recursive: true });
      } catch (err) {
        if (!isMissingEntry(err)) throw err;
      }
    },

    async list(dirPath) {
      try {
        const dir = await resolveDir(dirPath, false);
        const names = [];
        for await (const name of dir.keys()) names.push(name);
        return names;
      } catch (err) {
        if (isMissingEntry(err)) return [];
        throw err;
      }
    },

    async lastModified(path) {
      const file = await (await resolveFile(path, false)).getFile();
      return file.lastModified;
    },
  };
}

/** Web Lock wrapper; keeps `navigator` out of the install path. */
export function createWebLock() {
  return {
    request: (name, callback) => navigator.locks.request(name, callback),
  };
}
