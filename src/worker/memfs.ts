/*
 * MEMFS directory helper shared by the wasm module setup and the grid mounts.
 */

// Emscripten's FS.ErrnoError carries a numeric `errno` only (no `code`).
// EEXIST is 20 in its ERRNO_CODES table.
const EEXIST = 20;

/** @param fs Emscripten `Module.FS` */
export function ensureMemfsDir(fs: { mkdir(path: string): void }, path: string): void {
  try {
    fs.mkdir(path);
  } catch (err) {
    if (!err || (err as { errno?: number }).errno !== EEXIST) throw err;
  }
}
