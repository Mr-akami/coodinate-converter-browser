/*
 * Public JS API for the PROJ wasm runtime.
 *
 * Every call is a request to the single worker, which owns OPFS, the grid
 * mounts and the PROJ context. `transform` fetches the grids the operation
 * needs; with `strict: true` it refuses to answer when the best non-ballpark
 * operation is unavailable, throwing `MissingGridError` instead of silently
 * returning a Helmert / ballpark result.
 */

import { MissingGridError } from './errors.js';

export { MissingGridError };

/**
 * @param {{request: (message: object, options?: {signal?: AbortSignal, onProgress?: Function}) => Promise<any>}} rpc
 * @param {{version: string, grids: Record<string, {size: number, sha256: string}>}} manifest
 */
export function createProjApi(rpc, manifest) {
  /**
   * @param {string} src source CRS (e.g. 'EPSG:4326')
   * @param {string} dst target CRS
   * @param {number} x lon / easting
   * @param {number} y lat / northing
   * @param {number} z height
   * @param {{strict?: boolean, signal?: AbortSignal}} [opts]
   */
  async function transform(src, dst, x, y, z = 0, opts = {}) {
    if (!src || !dst) throw new Error('src and dst are required');
    const result = await rpc.request(
      { type: 'transform', src, dst, x, y, z, strict: opts.strict === true },
      { signal: opts.signal },
    );
    return { x: result.x, y: result.y, z: result.z };
  }

  /**
   * Fetch and mount grids up front. `'all'` takes every grid in the Manifest;
   * an array of `{src, dst, x?, y?}` takes only what those transforms need.
   *
   * @param {'all' | Array<{src: string, dst: string, x?: number, y?: number}>} spec
   * @param {{onProgress?: (event: {done: number, total: number}) => void, signal?: AbortSignal}} [options]
   */
  async function preloadGrids(spec, options = {}) {
    const result = await rpc.request(
      { type: 'preloadGrids', spec },
      { signal: options.signal, onProgress: options.onProgress },
    );
    return { fetched: result.fetched };
  }

  async function clearPrepareCache() {
    await rpc.request({ type: 'clearPrepareCache' });
  }

  return { transform, preloadGrids, manifest, clearPrepareCache };
}
