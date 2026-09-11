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
import type {
  Coordinate, CrsInfo, CrsKinds, OperationInfo, Rpc, TransformOptions,
} from './types.js';

/** The public surface of a PROJ instance. */
export interface Proj {
  transform(
    src: string, dst: string, x: number, y: number, z?: number,
    opts?: TransformOptions,
  ): Promise<Coordinate>;
  transformMany(
    src: string, dst: string, xyz: Float64Array, opts?: TransformOptions,
  ): Promise<Float64Array>;
  prepare(
    src: string, dst: string, point?: { x?: number; y?: number },
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  describe(
    src: string, dst: string, point?: { x?: number; y?: number },
    opts?: TransformOptions,
  ): Promise<OperationInfo>;
  listCrs(
    lon: number, lat: number,
    opts?: { kinds?: CrsKinds; authorities?: string[]; signal?: AbortSignal },
  ): Promise<CrsInfo[]>;
  dispose(): void;
  readonly dataVersion: string;
}

export { MissingGridError, ProjWorkerError, DataVerificationError };

/**
   * @param) => Promise<any>, dispose: () => void}} rpc
   * @param} manifest
 */
export function createProjApi(rpc: Rpc, manifest: { version: string }): Proj {
  function requirePair(src: string, dst: string): void {
    if (!src || !dst) throw new TypeError('src and dst are required');
  }

  /**
   * Transform one point. Coordinates are always lon,lat or easting,northing —
   * never the EPSG authority order — in both directions.
   *
   * @param src source CRS, e.g. 'EPSG:4326'
   * @param dst target CRS
   * @param x longitude or easting
   * @param y latitude or northing
   * @param [z] height
   * @param} [opts]
   */
  async function transform(
    src: string, dst: string, x: number, y: number, z = 0,
    opts: TransformOptions = {},
  ): Promise<Coordinate> {
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
   * @param src
   * @param dst
   * @param xyz interleaved x,y,z; length must be a multiple of 3
   * @param} [opts]
   */
  async function transformMany(
    src: string, dst: string, xyz: Float64Array, opts: TransformOptions = {},
  ): Promise<Float64Array> {
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
   * @param src
   * @param dst
   * @param} [point]
   * @param} [opts]
   */
  async function prepare(
    src: string, dst: string, point: { x?: number; y?: number } = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
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
   * @param src
   * @param dst
   * @param} [point]
   * @param} [opts]
   */
  async function describe(
    src: string, dst: string, point: { x?: number; y?: number } = {},
    opts: TransformOptions = {},
  ): Promise<OperationInfo> {
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

  /**
   * The coordinate reference systems usable at a point, most local first.
   *
   * This is what lets an application ask a user to choose a system without
   * shipping its own copy of the database or offering a list of ten thousand
   * in which the right answer is unfindable. Only systems whose declared area
   * of use contains the point are returned, and deprecated ones never are.
   *
   * `kinds` selects the families: horizontal (geographic 2D and projected) is
   * on unless switched off, vertical and three-dimensional are off unless
   * asked for. `authorities` narrows by authority, e.g. `['EPSG']`.
   */
  async function listCrs(
    lon: number, lat: number,
    opts: { kinds?: CrsKinds; authorities?: string[]; signal?: AbortSignal } = {},
  ): Promise<CrsInfo[]> {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new TypeError('listCrs: lon and lat are required');
    }
    const result = await rpc.request(
      {
        type: 'listCrs',
        lon, lat,
        kinds: opts.kinds,
        authorities: opts.authorities ?? null,
      },
      { signal: opts.signal },
    );
    return result.crs;
  }

  function dispose(): void {
    rpc.dispose();
  }

  const api: Proj = {
    transform,
    transformMany,
    prepare,
    describe,
    listCrs,
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
