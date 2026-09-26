/*
 * CT-HEAP — grid bytes never enter the wasm heap.
 * Source: order.md Scope 1 ("Grids must never enter the wasm heap. Replace the
 * MEMFS `FS.writeFile` path with WORKERFS: mount the OPFS `File` objects so
 * PROJ reads only the bytes it needs.") and Scope 2 (the worker owns OPFS:
 * it fetches, hashes, stores and mounts).
 *
 * PROJ resolves a grid as `<search path>/<name>` and does not recurse
 * (third_party/proj/src/filemanager.cpp), so the grid has to be reachable at
 * `<memfsPath>/<name>` while the bytes stay in the OPFS File.
 */

import { describe, expect, it } from 'vitest';

import { createGridProvider } from '../../src/worker/grid-provider.js';

import { bytesResponse, createFakeFetch, statusResponse } from './support/fake-fetch';
import { createFakeFs } from './support/fake-fs';
import { createMemoryStore } from './support/memory-store';
import { fixtureBytes, makeManifest } from './support/manifest-factory';

const MEMFS_PATH = '/proj-data';
const GRIDS_BASE_URL = 'https://data.test/api/proj-data/v/v1/grids/';

function setup(grids: Record<string, Uint8Array>, routes: Record<string, () => Response> = {}) {
  const fs = createFakeFs();
  fs.mkdirp(MEMFS_PATH);
  const store = createMemoryStore();
  const remote = createFakeFetch(routes);
  const manifest = makeManifest('v1', fixtureBytes(1, 16), grids);
  const provider = createGridProvider({
    store,
    fs,
    memfsPath: MEMFS_PATH,
    dataVersion: 'v1',
    gridsBaseUrl: GRIDS_BASE_URL,
    manifest,
    fetchImpl: remote.fetchImpl,
  });
  return { fs, store, remote, manifest, provider };
}

async function mountedBytes(fs: ReturnType<typeof createFakeFs>, path: string) {
  const resolved = fs.resolve(path);
  if (!resolved || resolved.kind !== 'workerfs') return null;
  return new Uint8Array(await resolved.file.arrayBuffer());
}

describe('createGridProvider', () => {
  it('mounts a stored grid through WORKERFS instead of copying it into the wasm heap', async () => {
    const grid = fixtureBytes(5, 96);
    const { fs, store, remote, provider } = setup({ 'g.tif': grid });
    store.seedPublished('v1/grids/g.tif', grid);

    await provider.ensureGrid('g.tif');

    expect(fs.ops.filter((op) => op.startsWith('writeFile:'))).toEqual([]);
    expect(remote.calls).toEqual([]);
    expect(fs.mounts).toHaveLength(1);
    expect(fs.mounts[0]!.type).toBe(fs.filesystems.WORKERFS);
    expect(await mountedBytes(fs, `${MEMFS_PATH}/g.tif`)).toEqual(grid);
  });

  it('mounts outside the PROJ search directory so proj.db is not shadowed', async () => {
    const grid = fixtureBytes(5, 96);
    const { fs, store, provider } = setup({ 'g.tif': grid });
    store.seedPublished('v1/grids/g.tif', grid);

    await provider.ensureGrid('g.tif');

    expect(fs.mounts[0]!.mountpoint).not.toBe(MEMFS_PATH);
  });

  it('downloads, verifies and publishes a grid that is not stored yet, then mounts it', async () => {
    const grid = fixtureBytes(6, 96);
    const { fs, store, remote, provider } = setup(
      { 'g.tif': grid },
      { [`${GRIDS_BASE_URL}g.tif`]: () => bytesResponse(grid) },
    );

    await provider.ensureGrid('g.tif');

    expect(remote.urls()).toEqual([`${GRIDS_BASE_URL}g.tif`]);
    expect(await store.isPublished('v1/grids/g.tif')).toBe(true);
    expect(store.bytes('v1/grids/g.tif')).toEqual(grid);
    expect(fs.ops.filter((op) => op.startsWith('writeFile:'))).toEqual([]);
    expect(await mountedBytes(fs, `${MEMFS_PATH}/g.tif`)).toEqual(grid);
  });

  it('passes the caller AbortSignal to the Data Origin request', async () => {
    const grid = fixtureBytes(6, 96);
    const { remote, provider } = setup(
      { 'g.tif': grid },
      { [`${GRIDS_BASE_URL}g.tif`]: () => bytesResponse(grid) },
    );
    const controller = new AbortController();

    await provider.ensureGrid('g.tif', { signal: controller.signal });

    expect(remote.calls[0]!.init?.signal).toBe(controller.signal);
  });

  it('neither publishes nor mounts a grid whose bytes fail the manifest hash', async () => {
    const grid = fixtureBytes(6, 96);
    const { fs, store, provider } = setup(
      { 'g.tif': grid },
      { [`${GRIDS_BASE_URL}g.tif`]: () => bytesResponse(fixtureBytes(7, 96)) },
    );

    await expect(provider.ensureGrid('g.tif')).rejects.toThrow();

    expect(await store.isPublished('v1/grids/g.tif')).toBe(false);
    expect(fs.resolve(`${MEMFS_PATH}/g.tif`)).toBeNull();
  });

  it('neither publishes nor mounts a grid the Data Origin does not serve', async () => {
    const grid = fixtureBytes(6, 96);
    const { fs, store, provider } = setup(
      { 'g.tif': grid },
      { [`${GRIDS_BASE_URL}g.tif`]: () => statusResponse(404) },
    );

    await expect(provider.ensureGrid('g.tif')).rejects.toThrow();

    expect(await store.isPublished('v1/grids/g.tif')).toBe(false);
    expect(fs.resolve(`${MEMFS_PATH}/g.tif`)).toBeNull();
  });

  it('mounts a grid once even when it is required again', async () => {
    const grid = fixtureBytes(5, 96);
    const { fs, store, provider } = setup({ 'g.tif': grid });
    store.seedPublished('v1/grids/g.tif', grid);

    await provider.ensureGrid('g.tif');
    await provider.ensureGrid('g.tif');

    expect(fs.mounts).toHaveLength(1);
  });

  it('mounts a second grid alongside the first', async () => {
    const first = fixtureBytes(5, 96);
    const second = fixtureBytes(9, 96);
    const { fs, store, provider } = setup({ 'a.tif': first, 'b.tif': second });
    store.seedPublished('v1/grids/a.tif', first);
    store.seedPublished('v1/grids/b.tif', second);

    await provider.ensureGrid('a.tif');
    await provider.ensureGrid('b.tif');

    expect(fs.mounts).toHaveLength(2);
    expect(fs.mounts[0]!.mountpoint).not.toBe(fs.mounts[1]!.mountpoint);
    expect(await mountedBytes(fs, `${MEMFS_PATH}/a.tif`)).toEqual(first);
    expect(await mountedBytes(fs, `${MEMFS_PATH}/b.tif`)).toEqual(second);
  });

  it('mounts only the published grids of the current Data Version at startup', async () => {
    const complete = fixtureBytes(5, 96);
    const halfWritten = fixtureBytes(8, 96);
    const { fs, store, provider } = setup({ 'a.tif': complete, 'b.tif': halfWritten });
    store.seedPublished('v1/grids/a.tif', complete);
    store.seedUnpublished('v1/grids/b.tif', halfWritten);

    await provider.mountPublishedGrids();

    expect(await mountedBytes(fs, `${MEMFS_PATH}/a.tif`)).toEqual(complete);
    expect(fs.resolve(`${MEMFS_PATH}/b.tif`)).toBeNull();
  });
});
