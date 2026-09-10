/*
 * Stand-in for the Emscripten `Module.FS` object.
 *
 * Fidelity notes, taken from the generated `dist/proj_wasm.js`:
 *   - `FS.mount` requires an existing directory that is not already a mount
 *     point; it does not create the directory.
 *   - WORKERFS exposes each mounted File under its `file.name`.
 *   - Errors are `ErrnoError` instances carrying a numeric `errno` only
 *     (there is no `code` property).
 */

const ERRNO = { ENOENT: 44, EEXIST: 20, EBUSY: 10, ENOTDIR: 54 } as const;

class FakeErrnoError extends Error {
  errno: number;

  constructor(errno: number, message: string) {
    super(message);
    this.name = 'ErrnoError';
    this.errno = errno;
  }
}

interface FakeFileSystemType {
  name: string;
}

interface FakeMount {
  type: FakeFileSystemType;
  opts: { files?: File[] };
  mountpoint: string;
}

type ResolvedEntry =
  | { kind: 'memfs'; path: string; bytes: Uint8Array }
  | { kind: 'workerfs'; path: string; mountpoint: string; file: File };

interface FakeFs {
  filesystems: { MEMFS: FakeFileSystemType; WORKERFS: FakeFileSystemType; NODEFS: FakeFileSystemType };
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  mount(type: FakeFileSystemType, opts: { files?: File[] }, mountpoint: string): void;
  symlink(target: string, linkpath: string): void;

  readonly ops: string[];
  readonly mounts: FakeMount[];
  /** Create a directory and every missing parent (test setup only). */
  mkdirp(path: string): void;
  /** Follow symlinks and mounts the way `FS.open` would. */
  resolve(path: string): ResolvedEntry | null;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

export function createFakeFs(): FakeFs {
  const dirs = new Set<string>(['/']);
  const files = new Map<string, Uint8Array>();
  const symlinks = new Map<string, string>();
  const mounts: FakeMount[] = [];
  const ops: string[] = [];

  function requireDir(path: string): void {
    if (!dirs.has(path)) throw new FakeErrnoError(ERRNO.ENOENT, `no such directory: ${path}`);
  }

  function exists(path: string): boolean {
    return dirs.has(path) || files.has(path) || symlinks.has(path);
  }

  const fs: FakeFs = {
    filesystems: {
      MEMFS: { name: 'MEMFS' },
      WORKERFS: { name: 'WORKERFS' },
      NODEFS: { name: 'NODEFS' },
    },

    ops,
    mounts,

    mkdir(path) {
      ops.push(`mkdir:${path}`);
      requireDir(parentOf(path));
      if (exists(path)) throw new FakeErrnoError(ERRNO.EEXIST, `exists: ${path}`);
      dirs.add(path);
    },

    writeFile(path, data) {
      ops.push(`writeFile:${path}`);
      requireDir(parentOf(path));
      files.set(path, data.slice());
    },

    mount(type, opts, mountpoint) {
      ops.push(`mount:${type.name}:${mountpoint}`);
      if (!dirs.has(mountpoint)) throw new FakeErrnoError(ERRNO.ENOTDIR, `not a directory: ${mountpoint}`);
      if (mounts.some((m) => m.mountpoint === mountpoint)) {
        throw new FakeErrnoError(ERRNO.EBUSY, `already mounted: ${mountpoint}`);
      }
      mounts.push({ type, opts, mountpoint });
    },

    symlink(target, linkpath) {
      ops.push(`symlink:${linkpath}->${target}`);
      requireDir(parentOf(linkpath));
      if (exists(linkpath)) throw new FakeErrnoError(ERRNO.EEXIST, `exists: ${linkpath}`);
      symlinks.set(linkpath, target);
    },

    mkdirp(path) {
      const segments = path.split('/').filter(Boolean);
      let current = '';
      for (const segment of segments) {
        current += `/${segment}`;
        if (!dirs.has(current)) dirs.add(current);
      }
    },

    resolve(path) {
      let current = path;
      for (let hops = 0; hops < 8 && symlinks.has(current); hops += 1) {
        current = symlinks.get(current)!;
      }

      for (const mount of mounts) {
        const prefix = `${mount.mountpoint}/`;
        if (!current.startsWith(prefix)) continue;
        const entry = current.slice(prefix.length);
        const file = (mount.opts.files ?? []).find((candidate) => candidate.name === entry);
        if (file) return { kind: 'workerfs', path: current, mountpoint: mount.mountpoint, file };
      }

      const bytes = files.get(current);
      if (bytes) return { kind: 'memfs', path: current, bytes };
      return null;
    },
  };

  return fs;
}
