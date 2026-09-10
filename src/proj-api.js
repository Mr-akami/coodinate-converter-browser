/*
 * The public API.
 *
 * Every call is a request to the single worker, which owns OPFS, the grid
 * mounts and the PROJ context. Grids are fetched as the operation needs them.
 *
 * `transform` refuses rather than guessing. When the best operation between
 * two CRS needs a grid that cannot be obtained, it throws `MissingGridError`
 * instead of returning the ballpark answer PROJ would otherwise fall back to,
 * because that answer can be tens of metres out with nothing in the return
 * value to say so. Pass `allowBallpark: true` for cs2cs behaviour.
 */

import { MissingGridError, ProjWorkerError, DataVerificationError } from './errors.js';

export { MissingGridError, ProjWorkerError, DataVerificationError };

/**
 * @param {{request: (message: object, options?: {signal?: AbortSignal, onProgress?: Function}) => Promise<any>, dispose: () => void}} rpc
 * @param {{version: string}} manifest
 */
export function createProjApi(rpc, manifest) {
  function requirePair(src, dst) {
    if (!src || !dst) throw new TypeError('src and dst are required');
  }

  /**
   * Transform one point. Coordinates are always lon,lat or easting,northing —
   * never the EPSG authority order — in both directions.
   *
   * @param {string} src source CRS, e.g. 'EPSG:4326'
   * @param {string} dst target CRS
   * @param {number} x longitude or easting
   * @param {number} y latitude or northing
   * @param {number} [z] height
   * @param {{allowBallpark?: boolean, signal?: AbortSignal}} [opts]
   * @returns {Promise<{x: number, y: number, z: number}>}
   */
  async function transform(src, dst, x, y, z = 0, opts = {}) {
    requirePair(src, dst);
    const result = await rpc.request(
      {
        type: 'transform',
        src, dst, x, y, z,
        allowBallpark: opts.allowBallpark === true,
      },
      { signal: opts.signal },
    );
    return { x: result.x, y: result.y, z: result.z };
  }

  /**
   * Transform many points in one round trip.
   *
   * `xyz` is interleaved x,y,z. The array is transferred to the worker and a
   * transformed array of the same length is returned; treat the one you passed
   * in as consumed, because transferring detaches it. Returning a new array
   * rather than writing in place is what the transfer costs, and it is still
   * one message instead of one per point.
   *
   * @param {string} src
   * @param {string} dst
   * @param {Float64Array} xyz interleaved x,y,z; length must be a multiple of 3
   * @param {{allowBallpark?: boolean, signal?: AbortSignal}} [opts]
   * @returns {Promise<Float64Array>}
   */
  async function transformMany(src, dst, xyz, opts = {}) {
    requirePair(src, dst);
    if (!(xyz instanceof Float64Array)) {
      throw new TypeError('transformMany: xyz must be a Float64Array');
    }
    if (xyz.length % 3 !== 0) {
      throw new RangeError('transformMany: xyz length must be a multiple of 3');
    }
    if (xyz.length === 0) return new Float64Array(0);

    const result = await rpc.request(
      {
        type: 'transformMany',
        src, dst,
        xyz: xyz.buffer,
        allowBallpark: opts.allowBallpark === true,
        transfer: [xyz.buffer],
      },
      { signal: opts.signal },
    );
    return new Float64Array(result.xyz);
  }

  /**
   * Fetch and mount whatever transforming between these CRS at this point
   * would need, so the first real transform does not pay for it.
   *
   * @param {string} src
   * @param {string} dst
   * @param {{x?: number, y?: number}} [point]
   * @param {{signal?: AbortSignal}} [opts]
   */
  async function prepare(src, dst, point = {}, opts = {}) {
    requirePair(src, dst);
    await rpc.request(
      {
        type: 'preloadGrids',
        spec: [{ src, dst, x: point.x, y: point.y }],
      },
      { signal: opts.signal },
    );
  }

  /**
   * What a transform between these CRS at this point would actually do: the
   * name of the operation PROJ selects, its stated accuracy in metres, whether
   * it is a ballpark, and the grids it needs.
   *
   * This is where accuracy metadata lives, deliberately off the `transform`
   * path so that transforming a million points does not carry it a million
   * times.
   *
   * @param {string} src
   * @param {string} dst
   * @param {{x?: number, y?: number}} [point]
   * @param {{allowBallpark?: boolean, signal?: AbortSignal}} [opts]
   * @returns {Promise<{name: string, accuracy: number | null, ballpark: boolean,
   *   grids: Array<{shortName: string, fullName: string, url: string, available: boolean}>}>}
   */
  async function describe(src, dst, point = {}, opts = {}) {
    requirePair(src, dst);
    const result = await rpc.request(
      {
        type: 'describe',
        src, dst,
        x: point.x, y: point.y,
        allowBallpark: opts.allowBallpark !== false,
      },
      { signal: opts.signal },
    );
    return result.info;
  }

  function dispose() {
    rpc.dispose();
  }

  const api = {
    transform,
    transformMany,
    prepare,
    describe,
    dispose,
    dataVersion: manifest.version,
  };

  /* The testing entry point reaches the worker through this, so that
     preloading every grid stays available to the suite without being part of
     what an application sees. */
  Object.defineProperty(api, Symbol.for('proj-wasm.internal.rpc'), {
    value: rpc,
    enumerable: false,
  });

  return api;
}
