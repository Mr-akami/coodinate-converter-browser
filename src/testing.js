/*
 * Entry point for tests and the demo page, not for applications.
 *
 * Preloading every grid in the Manifest downloads close to a gigabyte, which
 * is only reasonable when checking offline behaviour or filling a cache before
 * a benchmark. It is kept out of the public surface so no application reaches
 * for it by accident.
 */

/**
 * @param {ReturnType<import('./proj-api.js').createProjApi>} proj
 * @param {'all' | Array<{src: string, dst: string, x?: number, y?: number}>} spec
 * @param {{onProgress?: (event: {done: number, total: number}) => void, signal?: AbortSignal}} [options]
 */
export function preloadGrids(proj, spec, options = {}) {
  const rpc = proj[INTERNAL_RPC];
  if (!rpc) throw new TypeError('preloadGrids: not a proj instance');
  return rpc.request(
    { type: 'preloadGrids', spec },
    { onProgress: options.onProgress, signal: options.signal },
  );
}

export const INTERNAL_RPC = Symbol.for('proj-wasm.internal.rpc');
