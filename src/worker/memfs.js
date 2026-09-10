/*
 * MEMFS directory helper shared by the wasm module setup and the grid mounts.
 */

// Emscripten's FS.ErrnoError carries a numeric `errno` only (no `code`).
// EEXIST is 20 in its ERRNO_CODES table.
const EEXIST = 20;

/**
 * @param {{mkdir: (path: string) => void}} fs Emscripten `Module.FS`
 * @param {string} path
 */
export function ensureMemfsDir(fs, path) {
  try {
    fs.mkdir(path);
  } catch (err) {
    if (!err || err.errno !== EEXIST) throw err;
  }
}
