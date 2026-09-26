/*
 * The Node entry point, against the real proj-data directory.
 *
 * The point of running the same wasm on Node is that a server and a browser
 * agree, so the test that matters most compares Node's answers with the values
 * the browser suite is held to. If those ever diverge the whole reason for
 * this entry point is gone.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Imported from the built library rather than from source: the Node entry
 * resolves its worker and its wasm module relative to its own location, so
 * only the built layout exercises those paths.
 */
import { createProjNode, resolveDataDir } from '../../dist/lib/node.js';

const DATA_DIR = resolve(import.meta.dirname, '../../third_party/sc-proj-data/proj');
const BUILT = resolve(import.meta.dirname, '../../dist/lib/node.js');
const WASM = resolve(import.meta.dirname, '../../dist/proj_wasm.js');

const DATA_ORIGIN = resolve(import.meta.dirname, '../../data-dist');
const ready = existsSync(resolve(DATA_DIR, 'proj.db')) && existsSync(WASM) && existsSync(BUILT);
const withData = ready ? describe : describe.skip;

describe('resolveDataDir', () => {
  it('prefers the explicit option over the environment', () => {
    expect(resolveDataDir(DATA_DIR, { PROJ_DATA: '/nowhere' })).toBe(DATA_DIR);
  });

  it('falls back to PROJ_DATA, then to PROJ_LIB', () => {
    expect(resolveDataDir(undefined, { PROJ_DATA: DATA_DIR })).toBe(DATA_DIR);
    expect(resolveDataDir(undefined, { PROJ_LIB: DATA_DIR })).toBe(DATA_DIR);
  });

  it('names every path it tried when none of them held a proj.db', () => {
    expect(() => resolveDataDir('/no/such/dir', { PROJ_DATA: '/nor/this' }))
      .toThrow(/\/no\/such\/dir[\s\S]*\/nor\/this/);
  });

  it('says what to set when nothing pointed anywhere at all', () => {
    expect(() => resolveDataDir(undefined, {})).toThrow(/PROJ_DATA/);
  });
});

withData('createProjNode', () => {
  /*
   * Rows the browser suite already checks against cs2cs. Node must produce the
   * same numbers, not merely plausible ones.
   */
  function referenceRows(limit: number) {
    const csv = readFileSync(resolve(import.meta.dirname, '../reference.csv'), 'utf8');
    const [header, ...lines] = csv.trim().split('\n');
    const columns = header!.split(',');
    return lines.slice(0, limit).map((line) => {
      const cells = line.split(',');
      const row: Record<string, string> = {};
      columns.forEach((name, i) => { row[name] = cells[i]!; });
      return row;
    });
  }

  it('transforms in a worker thread and matches the browser reference', async () => {
    const proj = await createProjNode({ dataDir: DATA_DIR });
    try {
      for (const row of referenceRows(12)) {
        const result = await proj.transform(
          row.src_crs!, row.dst_crs!,
          Number(row.in_x), Number(row.in_y), Number(row.in_z),
          { allowBallpark: true },
        );
        // The browser suite allows 1e-6 degrees or 0.01 m; the same wasm on the
        // same data should be far closer than that, so anything looser here
        // would hide a real divergence.
        expect(Math.abs(result.x - Number(row.expected_x))).toBeLessThan(1e-7);
        expect(Math.abs(result.y - Number(row.expected_y))).toBeLessThan(1e-7);
        expect(Math.abs(result.z - Number(row.expected_z))).toBeLessThan(1e-4);
      }
    } finally {
      proj.dispose();
    }
  }, 120_000);

  it('gives the same answers in process as in a worker thread', async () => {
    const inThread = await createProjNode({ dataDir: DATA_DIR });
    const inProcess = await createProjNode({ dataDir: DATA_DIR, inProcess: true });
    try {
      const a = await inThread.transform('EPSG:4326', 'EPSG:6677', 139.7671, 35.6812);
      const b = await inProcess.transform('EPSG:4326', 'EPSG:6677', 139.7671, 35.6812);
      expect(b).toEqual(a);
    } finally {
      inThread.dispose();
      inProcess.dispose();
    }
  }, 120_000);

  it('transforms a batch identically to one call per point', async () => {
    const proj = await createProjNode({ dataDir: DATA_DIR });
    try {
      const points = [
        [139.7671, 35.6812, 0],
        [135.5023, 34.6937, 0],
        [141.3469, 43.0621, 0],
      ];
      const batch = await proj.transformMany(
        'EPSG:4326', 'EPSG:6677',
        Float64Array.from(points.flat()),
      );

      for (const [i, point] of points.entries()) {
        const one = await proj.transform('EPSG:4326', 'EPSG:6677', point[0]!, point[1]!, point[2]!);
        expect(batch[i * 3]).toBeCloseTo(one.x, 9);
        expect(batch[i * 3 + 1]).toBeCloseTo(one.y, 9);
        expect(batch[i * 3 + 2]).toBeCloseTo(one.z, 9);
      }
    } finally {
      proj.dispose();
    }
  }, 120_000);

  it('lists the coordinate systems usable at a point, most local first', async () => {
    const proj = await createProjNode({ dataDir: DATA_DIR });
    try {
      const tokyo = await proj.listCrs(139.7671, 35.6812, { authorities: ['EPSG'] });

      const ids = tokyo.map((crs) => crs.id);
      // Japan Plane Rectangular CS IX covers Tokyo; CS I covers Kyushu, and a
      // list that offers it here is worse than no list at all.
      expect(ids).toContain('EPSG:6677');
      expect(ids).not.toContain('EPSG:6669');
      expect(ids).not.toContain('EPSG:27700');

      // Most local first is the whole point of the ordering.
      const areas = tokyo
        .map((crs) => crs.areaSquareDegrees ?? Number.POSITIVE_INFINITY);
      expect(areas).toEqual([...areas].sort((a, b) => a - b));

      const plane = tokyo.find((crs) => crs.id === 'EPSG:6677')!;
      expect(plane.type).toBe('projected');
      expect(plane.name).toMatch(/IX/);
      expect(plane.areaName).toBeTruthy();
    } finally {
      proj.dispose();
    }
  }, 120_000);

  it('keeps vertical systems out of the horizontal list unless asked', async () => {
    const proj = await createProjNode({ dataDir: DATA_DIR });
    try {
      const horizontal = await proj.listCrs(139.7671, 35.6812, { authorities: ['EPSG'] });
      expect(horizontal.some((crs) => crs.type === 'vertical')).toBe(false);

      const vertical = await proj.listCrs(139.7671, 35.6812, {
        kinds: { horizontal: false, vertical: true },
        authorities: ['EPSG', 'CZM'],
      });
      expect(vertical.length).toBeGreaterThan(0);
      expect(vertical.every((crs) => crs.type === 'vertical')).toBe(true);
      // The customised authority is where JGD2024 lives.
      expect(vertical.map((crs) => crs.id)).toContain('CZM:JGD2024');
    } finally {
      proj.dispose();
    }
  }, 120_000);

  it('refuses a ballpark answer by default, as the browser does', async () => {
    /*
     * Even with the whole proj-data directory mounted there is no accurate
     * operation between these two datums, so the answer would be a ballpark.
     * The default refuses it here exactly as it does in the browser, which is
     * the property that makes the two interchangeable.
     */
    const proj = await createProjNode({ dataDir: DATA_DIR });
    try {
      const refusal = await proj
        .transform('EPSG:4301', 'EPSG:6668', 139.7671, 35.6812)
        .then(() => null, (err: any) => err);

      expect(refusal?.name).toBe('MissingGridError');
      expect(refusal?.reason).toBe('ballpark_only');

      const approximate = await proj.transform(
        'EPSG:4301', 'EPSG:6668', 139.7671, 35.6812, 0, { allowBallpark: true },
      );
      expect(approximate.x).toBeCloseTo(139.7638660290314, 9);
    } finally {
      proj.dispose();
    }
  }, 120_000);

  const withOrigin = existsSync(resolve(DATA_ORIGIN, 'manifest.json')) ? it : it.skip;

  withOrigin('reads a Data Origin, grids under grids/, as it reads proj-data', async () => {
    /*
     * A geoid-backed height is the case that needs a grid, so it is the case
     * that shows grids/ is searched: without it the answer is ballpark only.
     */
    const src = 'EPSG:6677+6695';
    const flat = await createProjNode({ dataDir: DATA_DIR, inProcess: true });
    const origin = await createProjNode({ dataDir: DATA_ORIGIN, inProcess: true });
    try {
      expect(origin.dataVersion).toBe(flat.dataVersion);
      const a = await flat.transform(src, 'EPSG:4978', -5995, -35370, 3);
      const b = await origin.transform(src, 'EPSG:4978', -5995, -35370, 3);
      expect(b).toEqual(a);
    } finally {
      flat.dispose();
      origin.dispose();
    }
  }, 120_000);
});
