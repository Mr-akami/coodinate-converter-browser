/*
 * The shapes that cross module and thread boundaries.
 *
 * Everything here is either part of the public surface or part of the worker
 * protocol, which is the one place where a wrong shape fails at runtime with
 * no compiler between the two sides.
 */

/** A grid as the Manifest describes it. */
export interface ManifestGrid {
  size: number;
  sha256: string;
}

/** What a Data Origin publishes for one Data Version. */
export interface Manifest {
  version: string;
  generatedAt?: string;
  projDb: ManifestGrid;
  grids: Record<string, ManifestGrid>;
}

/** A grid as PROJ reports it, plus whether the Data Origin could supply it. */
export interface GridRef {
  shortName: string;
  fullName: string;
  url: string;
  obtainable?: boolean;
}

/** PROJ's own report of a grid an operation needs. */
export interface EnumeratedGrid {
  shortName: string;
  fullName: string;
  packageName: string;
  url: string;
  available: number;
}

/** What `describe` answers. */
export interface OperationInfo {
  name: string;
  accuracy: number | null;
  ballpark: boolean;
  grids: EnumeratedGrid[];
}

/** What a CRS is, in terms a chooser can group on. */
export type CrsType =
  | 'geographic2d' | 'geographic3d' | 'projected'
  | 'vertical' | 'compound' | 'geocentric' | 'other';

/** One coordinate reference system usable at a point. */
export interface CrsInfo {
  /** "EPSG:6677", ready to pass to transform. */
  id: string;
  authority: string;
  code: string;
  name: string;
  type: CrsType;
  /** The area of use as the database names it, e.g. "Japan - zone IX". */
  areaName: string;
  /** Size of that area in square degrees; null when none is declared. */
  areaSquareDegrees: number | null;
}

/** Which families of CRS to list. */
export interface CrsKinds {
  horizontal?: boolean;
  vertical?: boolean;
  threeDimensional?: boolean;
}

export interface Coordinate {
  x: number;
  y: number;
  z: number;
}

export interface TransformOptions {
  allowBallpark?: boolean;
  signal?: AbortSignal;
}

/**
 * Progress from the worker. A download reports `stage` with byte counts; a
 * preload reports how many grids of how many are done. One channel carries
 * both, so the fields a caller reads depend on what it asked for.
 */
export interface ProgressEvent {
  stage?: string;
  bytes?: number;
  total?: number;
  done?: number;
}

/** A CRS pair, optionally at a point, for preloading. */
export interface PairSpec {
  src: string;
  dst: string;
  x?: number;
  y?: number;
}

/**
 * The wasm module's exported calls, as the worker uses them. The C ABI is
 * fixed by src/proj_wasm.h.
 */
export interface ProjModule {
  fs: EmscriptenFs;
  gridsNeeded(
    src: string, dst: string, x: number, y: number, discardMissing: number,
  ): EnumeratedGrid[];
  strictCheck(src: string, dst: string, x: number, y: number): number;
  transform(
    src: string, dst: string, x: number, y: number, z: number,
    allowBallpark?: boolean,
  ): Coordinate;
  transformMany(
    src: string, dst: string, xyz: Float64Array, allowBallpark?: boolean,
  ): Float64Array;
  describe(
    src: string, dst: string, x: number, y: number, allowBallpark?: boolean,
  ): OperationInfo;
  listCrs(lon: number, lat: number, kinds: number, authorities: string | null): CrsInfo[];
  refreshAfterGridWrite(): void;
}

/** Only the parts of Emscripten's FS this code touches. */
export interface EmscriptenFs {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  mount(type: unknown, options: Record<string, unknown>, mountpoint: string): void;
  unlink?(path: string): void;
  symlink?(target: string, path: string): void;
}

/** Where grids come from, as the transform flow sees it. */
export interface GridProvider {
  isMounted(name: string): boolean;
  ensureGrid(name: string, options?: { signal?: AbortSignal }): Promise<void>;
}

/** The transport a worker sits behind: a Worker, a MessagePort, or a stand-in. */
export interface RpcPort {
  addEventListener(type: string, handler: (event: any) => void): void;
  postMessage(message: any, transfer?: Transferable[]): void;
  terminate?(): void;
}

export interface RpcRequestOptions {
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

export interface Rpc {
  request<T = any>(message: Record<string, unknown>, options?: RpcRequestOptions): Promise<T>;
  dispose(): void;
}

/**
 * The storage the worker reads and writes. Named as an interface so the
 * install path and the grid provider can run against an in-memory store in
 * tests without touching OPFS.
 */
export interface DataStore {
  readText(path: string): Promise<string>;
  getFile(path: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number }>;
  writeStream(path: string): Promise<{
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
  publish(path: string): Promise<void>;
  isPublished(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  list(dirPath: string): Promise<string[]>;
  lastModified(path: string): Promise<number>;
}

/** Web Locks, narrowed to the one call the install path makes. */
export interface Lock {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
