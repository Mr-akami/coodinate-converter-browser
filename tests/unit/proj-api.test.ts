/*
 * CT-API — the public surface the pages already use.
 * Source: order.md Constraints ("Do not change the public API surface or
 * index.html behaviour"), with the call sites in index.html:240-262,342-360,
 * tests/comparison.js:49, tests/bench.html:37 and examples/smoke.js:28.
 *
 * The API is a pass-through to the worker, so what matters here is that each
 * call reaches the worker with the arguments it needs — including the
 * AbortSignal and the progress callback, which are easy to accept and then
 * drop.
 */

import { describe, expect, it } from 'vitest';

import { createProjApi } from '../../src/proj-api.js';

function fakeRpc(reply: Record<string, unknown> = {}) {
  const calls: Array<{ message: any; options: any }> = [];
  return {
    calls,
    request(message: any, options: any) {
      calls.push({ message, options });
      return Promise.resolve(reply);
    },
  };
}

const manifest = { version: 'v1', grids: { 'a.tif': { size: 1, sha256: 'x' } } };

describe('createProjApi', () => {
  it('exposes the Manifest it was built with', () => {
    const api = createProjApi(fakeRpc(), manifest);

    expect(api.manifest).toBe(manifest);
  });

  it('transforms through the worker and returns only the coordinate', async () => {
    const rpc = fakeRpc({ type: 'result', x: 1, y: 2, z: 3, id: 7 });
    const api = createProjApi(rpc, manifest);

    const result = await api.transform('EPSG:4326', 'EPSG:6677', 139.7, 35.6, 10);

    expect(result).toEqual({ x: 1, y: 2, z: 3 });
    expect(rpc.calls[0]!.message).toEqual({
      type: 'transform',
      src: 'EPSG:4326',
      dst: 'EPSG:6677',
      x: 139.7,
      y: 35.6,
      z: 10,
      strict: false,
    });
  });

  it('defaults the height to zero', async () => {
    const rpc = fakeRpc({ x: 1, y: 2, z: 0 });
    const api = createProjApi(rpc, manifest);

    await api.transform('EPSG:4326', 'EPSG:3857', 139.7, 35.6);

    expect(rpc.calls[0]!.message.z).toBe(0);
  });

  it('forwards strict mode and the AbortSignal', async () => {
    const rpc = fakeRpc({ x: 1, y: 2, z: 3 });
    const api = createProjApi(rpc, manifest);
    const controller = new AbortController();

    await api.transform('EPSG:4326', 'EPSG:6677', 1, 2, 0, {
      strict: true,
      signal: controller.signal,
    });

    expect(rpc.calls[0]!.message.strict).toBe(true);
    expect(rpc.calls[0]!.options.signal).toBe(controller.signal);
  });

  it('rejects a call without both CRS ids before reaching the worker', async () => {
    const rpc = fakeRpc();
    const api = createProjApi(rpc, manifest);

    await expect(api.transform('', 'EPSG:6677', 1, 2)).rejects.toThrow(/src and dst are required/);
    expect(rpc.calls).toEqual([]);
  });

  it('preloads grids with the progress callback and the AbortSignal attached', async () => {
    const rpc = fakeRpc({ type: 'preloaded', fetched: 3 });
    const api = createProjApi(rpc, manifest);
    const controller = new AbortController();
    const onProgress = () => undefined;

    const result = await api.preloadGrids('all', { onProgress, signal: controller.signal });

    expect(result).toEqual({ fetched: 3 });
    expect(rpc.calls[0]!.message).toEqual({ type: 'preloadGrids', spec: 'all' });
    expect(rpc.calls[0]!.options).toEqual({ onProgress, signal: controller.signal });
  });

  it('sends CRS pairs through unchanged', async () => {
    const rpc = fakeRpc({ fetched: 0 });
    const api = createProjApi(rpc, manifest);
    const pairs = [{ src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.7, y: 35.6 }];

    await api.preloadGrids(pairs);

    expect(rpc.calls[0]!.message.spec).toBe(pairs);
  });

  it('clears the prepare cache in the worker that owns it', async () => {
    const rpc = fakeRpc({ type: 'prepareCacheCleared' });
    const api = createProjApi(rpc, manifest);

    await api.clearPrepareCache();

    expect(rpc.calls[0]!.message).toEqual({ type: 'clearPrepareCache' });
  });
});
