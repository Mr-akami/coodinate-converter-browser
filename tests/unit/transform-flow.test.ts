/*
 * CT-FLOW — the observable meaning of strict and default transforms.
 * Source: order.md "Baseline to preserve" (the browser suite result depends on
 * this order) and the plan's CT-FLOW row, whose evidence is a unit test with a
 * fake projModule / gridProvider.
 *
 * Default mode matches cs2cs: when the best operation needs a grid the Data
 * Origin does not ship, the flow asks again for the grids the operation PROJ
 * will actually use, fetches what it can, suppresses fetch failures and lets
 * pw_transform fall back. Strict mode refuses instead.
 */

import { describe, expect, it } from 'vitest';

import { MissingGridError } from '../../src/errors.js';
import { createTransformFlow } from '../../src/worker/transform-flow.js';

interface RawGrid {
  shortName: string;
  fullName: string;
  url: string;
  available: number;
}

/** A grid as PROJ reports it: on disk unless `available: 0`. */
function rawGrid(name: string, overrides: Partial<RawGrid> = {}): RawGrid {
  return {
    shortName: name.replace(/\.[^.]+$/, ''),
    fullName: `/proj-data/${name}`,
    url: `https://data.test/${name}`,
    available: 1,
    ...overrides,
  };
}

/** A grid PROJ wants but cannot open: fullName is empty, url still names it. */
function unavailableGrid(name: string): RawGrid {
  return rawGrid(name, { fullName: '', available: 0 });
}

interface HarnessOptions {
  enumerate?: (discardMissing: number) => RawGrid[];
  strictCheck?: () => number;
  manifestGrids?: string[];
  failingGrids?: string[];
  mountedGrids?: string[];
}

function harness(options: HarnessOptions = {}) {
  const {
    enumerate = () => [],
    strictCheck = () => 1,
    manifestGrids = [],
    failingGrids = [],
    mountedGrids = [],
  } = options;

  const log: string[] = [];
  const mounted = new Set<string>(mountedGrids);
  const ensureSignals: Array<AbortSignal | undefined> = [];

  const projModule = {
    gridsNeeded(src: string, dst: string, x: number, y: number, discardMissing: number) {
      log.push(`gridsNeeded:${discardMissing}:${src}|${dst}|${x}|${y}`);
      return enumerate(discardMissing);
    },
    setGridCatalog() {},
    strictCheck(src: string, dst: string) {
      log.push(`strictCheck:${src}|${dst}`);
      return strictCheck();
    },
    transform(src: string, dst: string, x: number, y: number, z: number) {
      log.push(`transform:${src}|${dst}`);
      return { x: x + 1, y: y + 2, z: z + 3 };
    },
    refreshAfterGridWrite() {
      log.push('refresh');
    },
  };

  const gridProvider = {
    isMounted: (name: string) => mounted.has(name),
    async ensureGrid(name: string, options: { signal?: AbortSignal } = {}) {
      log.push(`ensure:${name}`);
      ensureSignals.push(options.signal);
      if (failingGrids.includes(name)) {
        throw new MissingGridError(`grid fetch failed: ${name}`, {
          reason: 'fetch_failed',
          missingGrids: [{ shortName: name, fullName: name, url: '' }],
        });
      }
      mounted.add(name);
    },
  };

  const manifest = {
    version: 'v1',
    grids: Object.fromEntries(manifestGrids.map((name) => [name, { size: 1, sha256: 'x' }])),
  };

  return {
    log,
    mounted,
    ensureSignals,
    flow: createTransformFlow({ projModule, gridProvider, manifest }),
  };
}

const point = { src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.7, y: 35.6, z: 0 };

describe('createTransformFlow — allowBallpark', () => {
  it('fetches the grids the operation needs, refreshes once, then transforms', async () => {
    const { log, flow } = harness({
      enumerate: () => [unavailableGrid('a.tif'), unavailableGrid('b.tif')],
      manifestGrids: ['a.tif', 'b.tif'],
    });

    const result = await flow.transform({ ...point, allowBallpark: true });

    expect(log).toEqual([
      'gridsNeeded:0:EPSG:4326|EPSG:6677|139.7|35.6',
      'ensure:a.tif',
      'ensure:b.tif',
      'refresh',
      'transform:EPSG:4326|EPSG:6677',
    ]);
    expect(result).toEqual({ x: 140.7, y: 37.6, z: 3 });
  });

  it('asks again with discardMissing when the ideal grid set is not shippable', async () => {
    const { log, flow } = harness({
      enumerate: (discardMissing) => (discardMissing
        ? [unavailableGrid('shipped.tif')]
        : [unavailableGrid('unshipped.tif')]),
      manifestGrids: ['shipped.tif'],
    });

    await flow.transform({ ...point, allowBallpark: true });

    expect(log).toEqual([
      'gridsNeeded:0:EPSG:4326|EPSG:6677|139.7|35.6',
      'gridsNeeded:1:EPSG:4326|EPSG:6677|139.7|35.6',
      'ensure:shipped.tif',
      'refresh',
      'transform:EPSG:4326|EPSG:6677',
    ]);
  });

  it('still transforms when a grid cannot be fetched, and does not refresh', async () => {
    const { log, flow } = harness({
      enumerate: () => [unavailableGrid('a.tif')],
      manifestGrids: ['a.tif'],
      failingGrids: ['a.tif'],
    });

    await flow.transform({ ...point, allowBallpark: true });

    expect(log).toEqual([
      'gridsNeeded:0:EPSG:4326|EPSG:6677|139.7|35.6',
      'ensure:a.tif',
      'transform:EPSG:4326|EPSG:6677',
    ]);
  });

  it('does not fetch a grid that is already mounted', async () => {
    const { log, flow } = harness({
      enumerate: () => [rawGrid('a.tif')],
      manifestGrids: ['a.tif'],
      mountedGrids: ['a.tif'],
    });

    await flow.transform({ ...point, allowBallpark: true });

    expect(log.filter((entry) => entry.startsWith('ensure:'))).toEqual([]);
    expect(log).not.toContain('refresh');
  });

  it('hands the caller AbortSignal to the grid fetch', async () => {
    const { flow, ensureSignals } = harness({
      enumerate: () => [unavailableGrid('a.tif')],
      manifestGrids: ['a.tif'],
    });
    const controller = new AbortController();

    await flow.transform({ ...point, signal: controller.signal });

    expect(ensureSignals).toEqual([controller.signal]);
  });

  it('treats a ballpark-only enumeration as no grids and transforms anyway', async () => {
    const { log, flow } = harness({
      enumerate: () => {
        throw new MissingGridError('no non-ballpark operation available', { reason: 'ballpark_only' });
      },
    });

    await flow.transform({ ...point, allowBallpark: true });

    expect(log).toEqual([
      'gridsNeeded:0:EPSG:4326|EPSG:6677|139.7|35.6',
      'transform:EPSG:4326|EPSG:6677',
    ]);
  });
});

describe('createTransformFlow — strict mode', () => {
  it('refuses a grid the Data Origin does not ship, without a second enumeration', async () => {
    const { log, flow } = harness({
      enumerate: () => [unavailableGrid('unshipped.tif')],
      manifestGrids: [],
    });

    const error = await flow.transform({ ...point }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingGridError);
    expect((error as MissingGridError).reason).toBe('missing_grid');
    expect((error as MissingGridError).missingGrids?.map((g) => g.fullName)).toEqual(['unshipped.tif']);
    expect(log).toEqual(['gridsNeeded:0:EPSG:4326|EPSG:6677|139.7|35.6']);
  });

  it('propagates a fetch failure instead of falling back', async () => {
    const { log, flow } = harness({
      enumerate: () => [unavailableGrid('a.tif')],
      manifestGrids: ['a.tif'],
      failingGrids: ['a.tif'],
    });

    const error = await flow.transform({ ...point }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingGridError);
    expect((error as MissingGridError).reason).toBe('fetch_failed');
    expect(log).not.toContain('transform:EPSG:4326|EPSG:6677');
  });

  it('lists the grids PROJ names when the strict check fails', async () => {
    const { flow } = harness({
      enumerate: () => [rawGrid('a.tif', { available: 0 })],
      manifestGrids: ['a.tif'],
      mountedGrids: ['a.tif'],
      strictCheck: () => 0,
    });

    const error = await flow.transform({ ...point }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingGridError);
    expect((error as MissingGridError).reason).toBe('missing_grid');
    expect((error as MissingGridError).missingGrids?.map((g) => g.fullName))
      .toEqual(['/proj-data/a.tif']);
  });

  it('reports ballpark_only when the strict check fails and PROJ names no grid', async () => {
    // PROJ leaves fullName empty unless it opened the file
    // (DatabaseContext::lookForGridInfo), so this is the usual shape of a
    // strict-check failure.
    const { flow } = harness({
      enumerate: () => [unavailableGrid('a.tif')],
      manifestGrids: ['a.tif'],
      mountedGrids: ['a.tif'],
      strictCheck: () => 0,
    });

    const error = await flow.transform({ ...point }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingGridError);
    expect((error as MissingGridError).reason).toBe('ballpark_only');
    expect((error as MissingGridError).missingGrids).toEqual([]);
  });

  it('checks a CRS pair once, and again after new grids are mounted', async () => {
    const grids = [unavailableGrid('a.tif')];
    const { log, flow } = harness({
      enumerate: () => grids,
      manifestGrids: ['a.tif', 'b.tif'],
    });

    await flow.transform({ ...point });
    await flow.transform({ ...point });

    expect(log.filter((entry) => entry.startsWith('strictCheck:'))).toHaveLength(1);

    grids.push(unavailableGrid('b.tif'));
    // A different 1 degree cell re-enumerates, finds b.tif and refreshes.
    await flow.transform({ ...point, x: 141.2, strict: true });

    expect(log.filter((entry) => entry.startsWith('strictCheck:'))).toHaveLength(2);
  });
});

describe('createTransformFlow — prepare cache', () => {
  it('re-uses the enumeration inside one 1 degree cell and redoes it outside', async () => {
    const { log, flow } = harness({ enumerate: () => [], manifestGrids: [] });

    await flow.transform({ ...point });
    await flow.transform({ ...point, x: point.x + 0.1 });

    expect(log.filter((entry) => entry.startsWith('gridsNeeded:'))).toHaveLength(1);

    await flow.transform({ ...point, x: point.x + 1 });

    expect(log.filter((entry) => entry.startsWith('gridsNeeded:'))).toHaveLength(2);
  });

  it('enumerates again after the prepare cache is cleared', async () => {
    const { log, flow } = harness({ enumerate: () => [], manifestGrids: [] });

    await flow.transform({ ...point });
    flow.clearPrepareCache();
    await flow.transform({ ...point });

    expect(log.filter((entry) => entry.startsWith('gridsNeeded:'))).toHaveLength(2);
  });
});

describe('createTransformFlow — preloadGrids', () => {
  it('fetches every Manifest grid and reports progress', async () => {
    const names = ['a.tif', 'b.tif', 'c.tif', 'd.tif', 'e.tif', 'f.tif', 'g.tif'];
    const { log, flow } = harness({ manifestGrids: names });
    const events: Array<{ done: number; total: number }> = [];

    const result = await flow.preloadGrids('all', { onProgress: (event) => events.push(event) });

    expect(result).toEqual({ fetched: 7 });
    expect(log.filter((entry) => entry.startsWith('ensure:'))).toEqual(names.map((n) => `ensure:${n}`));
    expect(events).toEqual([{ done: 6, total: 7 }, { done: 7, total: 7 }]);
    expect(log.filter((entry) => entry === 'refresh')).toHaveLength(1);
  });

  it('takes only the unavailable grids of the given CRS pairs', async () => {
    const { log, flow } = harness({
      enumerate: () => [rawGrid('mounted.tif'), unavailableGrid('needed.tif')],
      manifestGrids: ['mounted.tif', 'needed.tif'],
    });

    const result = await flow.preloadGrids([{ src: 'EPSG:4326', dst: 'EPSG:6677', x: 1, y: 2 }]);

    expect(result).toEqual({ fetched: 1 });
    expect(log.filter((entry) => entry.startsWith('ensure:'))).toEqual(['ensure:needed.tif']);
  });

  it('hands the caller AbortSignal to each grid fetch', async () => {
    const { flow, ensureSignals } = harness({ manifestGrids: ['a.tif', 'b.tif'] });
    const controller = new AbortController();

    await flow.preloadGrids('all', { signal: controller.signal });

    expect(ensureSignals).toEqual([controller.signal, controller.signal]);
  });

  it('reports an empty run without refreshing', async () => {
    const { log, flow } = harness({ manifestGrids: [] });
    const events: Array<{ done: number; total: number }> = [];

    const result = await flow.preloadGrids('all', { onProgress: (event) => events.push(event) });

    expect(result).toEqual({ fetched: 0 });
    expect(events).toEqual([{ done: 0, total: 0 }]);
    expect(log).toEqual([]);
  });

  it('rejects a spec that is neither "all" nor a list of CRS pairs', async () => {
    const { flow } = harness();

    await expect(flow.preloadGrids('some' as never)).rejects.toThrow(/spec must be/);
  });
});
