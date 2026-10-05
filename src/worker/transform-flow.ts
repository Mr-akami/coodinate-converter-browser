/*
 * The transform and preload flow, owned by the worker.
 *
 * Order matters here: which grids the operation needs, which of those the
 * Data Origin ships, when the strict check runs and when PROJ's caches are
 * invalidated together decide what the browser suite observes.
 *
 * Refusing is the default. A caller that asks for a transform and gets a
 * number back should be able to trust it, and a ballpark result can be tens of
 * metres out with nothing in the return value to say so. `allowBallpark` opts
 * into cs2cs behaviour, where an unavailable grid falls through.
 */

import { MissingGridError } from '../errors.js';
import { createLru } from './lru.js';
import type {
  Coordinate, CrsInfo, CrsKinds, EnumeratedGrid, GridProvider, GridRef,
  Manifest, OperationInfo, PairSpec, ProjModule,
} from '../types.js';

// One entry per (CRS pair, 1 degree cell). Bounded so a long session cannot
// grow it without limit; large enough to keep neighbouring points cache-hot.
const PREPARE_CACHE_CAPACITY = 64;
const PRELOAD_BATCH_SIZE = 6;

function basenameOf(path: string | undefined): string {
  if (!path || typeof path !== 'string') return '';
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function nameFromUrl(url: string | undefined): string {
  if (!url || typeof url !== 'string') return '';
  const slash = url.lastIndexOf('/');
  if (slash < 0) return '';
  const tail = url.slice(slash + 1);
  const query = tail.indexOf('?');
  return query >= 0 ? tail.slice(0, query) : tail;
}

// PROJ reports fullName as an absolute path when the grid is on disk and as
// "" when it is not, so the Manifest name comes from whichever field has it.
function resolveGridName(grid: EnumeratedGrid): string {
  return basenameOf(grid.fullName) || nameFromUrl(grid.url) || grid.shortName || '';
}

export interface TransformFlow {
  transform(request: {
    src: string; dst: string; x: number; y: number; z: number;
    allowBallpark?: boolean; signal?: AbortSignal;
  }): Promise<Coordinate>;
  transformMany(request: {
    src: string; dst: string; xyz: Float64Array;
    allowBallpark?: boolean; signal?: AbortSignal;
  }): Promise<Float64Array>;
  describe(request: {
    src: string; dst: string; x?: number; y?: number;
    allowBallpark?: boolean; signal?: AbortSignal;
  }): Promise<OperationInfo>;
  preloadGrids(
    spec: 'all' | PairSpec[],
    options?: {
      onProgress?: (event: { done: number; total: number }) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ fetched: number }>;
  listCrs(request: {
    lon: number; lat: number; kinds?: CrsKinds; authorities?: string[] | null;
  }): CrsInfo[];
  clearPrepareCache(): void;
}

export function createTransformFlow({ projModule, gridProvider, manifest }: {
  projModule: ProjModule;
  gridProvider: GridProvider;
  manifest: Manifest;
}): TransformFlow {
  const preparedGridSets = createLru<string, GridRef[]>(PREPARE_CACHE_CAPACITY);
  // Once a pair is known to have an instantiable non-ballpark operation with
  // the mounted grids, repeat calls skip the check until grids change.
  const strictCheckedOk = new Set<string>();
  // Node reading a local directory has no Manifest: every grid PROJ knows
  // counts there, and what is missing is permanent.
  const catalog = Object.keys(manifest.grids ?? {});
  if (catalog.length > 0) projModule.setGridCatalog(catalog);

  function refreshMounts(): void {
    projModule.refreshAfterGridWrite();
    strictCheckedOk.clear();
  }

  function prepareGridSet(
    src: string, dst: string, x: number, y: number, strict: boolean,
  ): GridRef[] {
    /*
     * The cache key carries a coarse coordinate cell because PROJ picks a
     * different regional operation per point (NAD27 to WGS84 needs HPGN-NY in
     * the northeast and HPGN-CS in California). The cell only decides how
     * often grids are re-enumerated; PROJ still picks the operation per point.
     */
    const cell = (Number.isFinite(x) && Number.isFinite(y))
      ? `${Math.floor(x)}|${Math.floor(y)}`
      : 'nan';
    const key = `${src}|${dst}|${cell}`;
    const cached = preparedGridSets.get(key);
    if (cached) return cached;

    let enumerated: EnumeratedGrid[];
    try {
      enumerated = projModule.gridsNeeded(src, dst, x, y, 0);
    } catch (err) {
      // Ballpark-only pairs and CRS resolution failures still go to
      // pw_transform, which decides; strict mode keeps the classified error.
      if (strict && err instanceof MissingGridError) throw err;
      enumerated = [];
    }

    const grids = enumerated.map((grid) => ({
      shortName: grid.shortName || '',
      fullName: resolveGridName(grid),
      url: grid.url || '',
    }));
    preparedGridSets.set(key, grids);
    return grids;
  }

  function followUpGrids(
    src: string, dst: string, x: number, y: number, missing: GridRef[],
  ): GridRef[] {
    let enumerated: EnumeratedGrid[];
    try {
      enumerated = projModule.gridsNeeded(src, dst, x, y, 1);
    } catch {
      // This second enumeration only widens what we can fetch; without it the
      // transform still runs with whatever is mounted.
      return [];
    }

    const extra: GridRef[] = [];
    for (const grid of enumerated) {
      const name = resolveGridName(grid);
      if (!name || !manifest.grids[name] || gridProvider.isMounted(name)) continue;
      if (missing.some((entry) => entry.fullName === name)) continue;
      if (extra.some((entry) => entry.fullName === name)) continue;
      extra.push({ shortName: name, fullName: name, url: '' });
    }
    return extra;
  }

  /*
   * Why a strict transform cannot be answered.
   *
   * "A grid is missing" and "a grid is missing and you cannot get it" are
   * different problems with different fixes — retry the fetch, or add the file
   * to the Data Origin — so the error says which. Node, reading a local
   * directory, has no Manifest and therefore nothing it could obtain, so
   * anything missing there is permanent by definition.
   */
  function verifyStrictOperation(src: string, dst: string, x: number, y: number): void {
    const pairKey = `${src}|${dst}`;
    if (strictCheckedOk.has(pairKey)) return;

    if (projModule.strictCheck(src, dst, x, y) === 1) {
      strictCheckedOk.add(pairKey);
      return;
    }

    const missing = projModule
      .gridsNeeded(src, dst, x, y, 0)
      .filter((grid) => !grid.available && grid.fullName)
      .map((grid) => ({
        shortName: grid.shortName,
        fullName: grid.fullName,
        url: grid.url,
        obtainable: Boolean(manifest.grids[grid.fullName]),
      }));

    if (missing.length === 0) {
      throw new MissingGridError(
        `no accurate operation exists from ${src} to ${dst}`,
        { reason: 'ballpark_only', missingGrids: [] },
      );
    }

    const names = missing.map((grid) => grid.fullName).join(', ');
    const anyObtainable = missing.some((grid) => grid.obtainable);
    throw new MissingGridError(
      anyObtainable
        ? `missing grid(s): ${names}`
        : `missing grid(s) the data origin does not carry: ${names}`,
      { reason: 'missing_grid', missingGrids: missing },
    );
  }

  /*
   * Fetch whatever the operation needs, then transform. Shared by transform
   * and transformMany so both see the same grids; the only difference is how
   * many points come back.
   */
  async function ensureGridsFor({ src, dst, x, y, allowBallpark, signal }: {
    src: string; dst: string; x: number; y: number;
    allowBallpark?: boolean; signal?: AbortSignal;
  }): Promise<void> {
    const strict = !allowBallpark;
    const grids = prepareGridSet(src, dst, x, y, strict);
    const missing = grids.filter(
      (grid) => grid.fullName && !gridProvider.isMounted(grid.fullName),
    );

    const unshippable = missing.filter((grid) => !manifest.grids[grid.fullName]);
    if (unshippable.length > 0 && !strict) {
      missing.push(...followUpGrids(src, dst, x, y, missing));
    }

    if (missing.length > 0) {
      const notInManifest = missing.filter((grid) => !manifest.grids[grid.fullName]);
      if (notInManifest.length > 0 && strict) {
        throw new MissingGridError(
          `grid(s) not in manifest: ${notInManifest.map((grid) => grid.fullName).join(', ')}`,
          { reason: 'missing_grid', missingGrids: notInManifest },
        );
      }

      let ensured = 0;
      for (const grid of missing.filter((entry) => manifest.grids[entry.fullName])) {
        try {
          await gridProvider.ensureGrid(grid.fullName, { signal });
          ensured += 1;
        } catch (err) {
          // Default mode keeps cs2cs behaviour and lets pw_transform fall back.
          if (strict) throw err;
        }
      }
      if (ensured > 0) refreshMounts();
    }

    if (strict) verifyStrictOperation(src, dst, x, y);
  }

  async function transform({ src, dst, x, y, z, allowBallpark = false, signal }: {
    src: string; dst: string; x: number; y: number; z: number;
    allowBallpark?: boolean; signal?: AbortSignal;
  }): Promise<Coordinate> {
    await ensureGridsFor({ src, dst, x, y, allowBallpark, signal });
    return projModule.transform(src, dst, x, y, z, allowBallpark);
  }

  /**
   * Many points in one call. Grids are resolved from the first point, which is
   * what makes this worth having: one enumeration and one round trip for the
   * whole array instead of one per point. PROJ still picks the operation per
   * point inside pw_transform_many, so a long array crossing regions is
   * transformed correctly; only the grid pre-fetch is decided up front, and a
   * point needing a grid the first point did not is reported rather than
   * silently downgraded.
   *
   */
  async function transformMany({ src, dst, xyz, allowBallpark = false, signal }: {
    src: string; dst: string; xyz: Float64Array;
    allowBallpark?: boolean; signal?: AbortSignal;
  }): Promise<Float64Array> {
    if (!(xyz instanceof Float64Array)) {
      throw new TypeError('transformMany: xyz must be a Float64Array');
    }
    if (xyz.length % 3 !== 0) {
      throw new RangeError('transformMany: xyz length must be a multiple of 3');
    }
    if (xyz.length > 0) {
      await ensureGridsFor({
        src, dst, x: xyz[0], y: xyz[1], allowBallpark, signal,
      });
    }
    return projModule.transformMany(src, dst, xyz, allowBallpark);
  }

  async function describe({ src, dst, x = NaN, y = NaN, allowBallpark = true, signal }: {
    src: string; dst: string; x?: number; y?: number;
    allowBallpark?: boolean; signal?: AbortSignal;
  }): Promise<OperationInfo> {
    // Describing is a question, not a transform, so it fetches grids first:
    // otherwise it would report the operation available before the fetch and
    // a caller would act on a stale answer.
    await ensureGridsFor({ src, dst, x, y, allowBallpark: true, signal });
    return projModule.describe(src, dst, x, y, allowBallpark);
  }

  function resolvePreloadNames(spec: 'all' | PairSpec[]): string[] {
    if (spec === 'all') return Object.keys(manifest.grids);
    if (!Array.isArray(spec)) {
      throw new Error('preloadGrids: spec must be "all" or an array of {src,dst,x?,y?}');
    }

    const names = new Set<string>();
    for (const pair of spec) {
      // A pair without a point asks PROJ for the grids of the operation it
      // would pick with no coordinate to go on; NaN is how the C side says so.
      const enumerated = projModule.gridsNeeded(
        pair.src, pair.dst, pair.x ?? NaN, pair.y ?? NaN, 0,
      );
      for (const grid of enumerated) {
        const name = resolveGridName(grid);
        if (name && !grid.available) names.add(name);
      }
    }
    return [...names];
  }

  async function preloadGrids(
    spec: 'all' | PairSpec[],
    options: {
      onProgress?: (event: { done: number; total: number }) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ fetched: number }> {
    const { onProgress, signal } = options;
    const names = resolvePreloadNames(spec);
    if (names.length === 0) {
      if (onProgress) onProgress({ done: 0, total: 0 });
      return { fetched: 0 };
    }

    const total = names.length;
    let done = 0;
    for (let start = 0; start < names.length; start += PRELOAD_BATCH_SIZE) {
      const batch = names.slice(start, start + PRELOAD_BATCH_SIZE);
      await Promise.all(batch.map((name) => gridProvider.ensureGrid(name, { signal })));
      done += batch.length;
      if (onProgress) onProgress({ done, total });
    }
    refreshMounts();
    return { fetched: done };
  }

  /*
   * The coordinate systems usable at a point, most local first.
   *
   * Ordering by area matters more than it looks: at any populated point the
   * database offers a world-wide system and a local one, and the local one is
   * almost always the right answer. Sorting here rather than in each caller
   * means every caller gets that for free.
   */
  function listCrs({ lon, lat, kinds = {}, authorities = null }: {
    lon: number; lat: number; kinds?: CrsKinds; authorities?: string[] | null;
  }): CrsInfo[] {
    const bits = (kinds.horizontal === false ? 0 : 1)
      | (kinds.vertical ? 2 : 0)
      | (kinds.threeDimensional ? 4 : 0);

    const list = projModule.listCrs(
      lon, lat, bits, authorities && authorities.length ? authorities.join(',') : null,
    );

    return list.sort((a, b) => {
      const areaA = a.areaSquareDegrees ?? Number.POSITIVE_INFINITY;
      const areaB = b.areaSquareDegrees ?? Number.POSITIVE_INFINITY;
      if (areaA !== areaB) return areaA - areaB;
      return a.id.localeCompare(b.id);
    });
  }

  function clearPrepareCache(): void {
    preparedGridSets.clear();
  }

  return { transform, transformMany, describe, listCrs, preloadGrids, clearPrepareCache };
}
