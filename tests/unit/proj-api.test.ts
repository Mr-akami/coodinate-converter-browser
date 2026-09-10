/*
 * The public surface.
 *
 * The API is a thin pass-through to the worker, so what matters here is that
 * each call reaches the worker with the arguments it needs — the AbortSignal
 * and the transfer list are easy to accept and then quietly drop — and that
 * the strict default is actually the default rather than a documented
 * intention.
 */

import { describe, expect, it } from 'vitest';

import { createProjApi } from '../../src/proj-api.js';

function fakeRpc(reply: Record<string, unknown> = {}) {
  const calls: Array<{ message: any; options: any }> = [];
  let disposed = false;
  return {
    calls,
    get disposed() {
      return disposed;
    },
    request(message: any, options: any) {
      calls.push({ message, options });
      return Promise.resolve(reply);
    },
    dispose() {
      disposed = true;
    },
  };
}

const manifest = { version: 'v1' };

describe('createProjApi', () => {
  it('reports the Data Version it was built against', () => {
    const api = createProjApi(fakeRpc(), manifest);

    expect(api.dataVersion).toBe('v1');
  });

  it('does not expose the worker, the Manifest or the internals', () => {
    const api = createProjApi(fakeRpc(), manifest);

    expect(Object.keys(api).sort()).toEqual([
      'dataVersion', 'describe', 'dispose', 'prepare', 'transform', 'transformMany',
    ]);
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
      allowBallpark: false,
    });
  });

  it('refuses a ballpark answer unless the caller asks for one', async () => {
    const rpc = fakeRpc({ x: 1, y: 2, z: 3 });
    const api = createProjApi(rpc, manifest);

    await api.transform('EPSG:4326', 'EPSG:6677', 1, 2);
    expect(rpc.calls[0]!.message.allowBallpark).toBe(false);

    await api.transform('EPSG:4326', 'EPSG:6677', 1, 2, 0, { allowBallpark: true });
    expect(rpc.calls[1]!.message.allowBallpark).toBe(true);
  });

  it('defaults the height to zero', async () => {
    const rpc = fakeRpc({ x: 1, y: 2, z: 0 });
    const api = createProjApi(rpc, manifest);

    await api.transform('EPSG:4326', 'EPSG:3857', 139.7, 35.6);

    expect(rpc.calls[0]!.message.z).toBe(0);
  });

  it('forwards the AbortSignal', async () => {
    const rpc = fakeRpc({ x: 1, y: 2, z: 3 });
    const api = createProjApi(rpc, manifest);
    const controller = new AbortController();

    await api.transform('EPSG:4326', 'EPSG:6677', 1, 2, 0, { signal: controller.signal });

    expect(rpc.calls[0]!.options.signal).toBe(controller.signal);
  });

  it('rejects a call without both CRS ids before reaching the worker', async () => {
    const rpc = fakeRpc();
    const api = createProjApi(rpc, manifest);

    await expect(api.transform('', 'EPSG:6677', 1, 2)).rejects.toThrow(/src and dst are required/);
    expect(rpc.calls).toEqual([]);
  });

  it('sends a batch as one transferred buffer and returns the result', async () => {
    const out = new Float64Array([9, 8, 7]);
    const rpc = fakeRpc({ type: 'resultMany', xyz: out.buffer });
    const api = createProjApi(rpc, manifest);
    const input = new Float64Array([1, 2, 3]);

    const result = await api.transformMany('EPSG:4326', 'EPSG:6677', input);

    expect(Array.from(result)).toEqual([9, 8, 7]);
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0]!.message.type).toBe('transformMany');
    expect(rpc.calls[0]!.message.transfer).toEqual([input.buffer]);
  });

  it('rejects a batch whose length is not a whole number of points', async () => {
    const rpc = fakeRpc();
    const api = createProjApi(rpc, manifest);

    await expect(
      api.transformMany('EPSG:4326', 'EPSG:6677', new Float64Array([1, 2, 3, 4])),
    ).rejects.toThrow(/multiple of 3/);
    expect(rpc.calls).toEqual([]);
  });

  it('rejects a batch that is not a Float64Array', async () => {
    const rpc = fakeRpc();
    const api = createProjApi(rpc, manifest);

    await expect(
      api.transformMany('EPSG:4326', 'EPSG:6677', [1, 2, 3] as unknown as Float64Array),
    ).rejects.toThrow(/Float64Array/);
    expect(rpc.calls).toEqual([]);
  });

  it('returns an empty batch without troubling the worker', async () => {
    const rpc = fakeRpc();
    const api = createProjApi(rpc, manifest);

    const result = await api.transformMany('EPSG:4326', 'EPSG:6677', new Float64Array(0));

    expect(result.length).toBe(0);
    expect(rpc.calls).toEqual([]);
  });

  it('prepares the grids one CRS pair at a point needs', async () => {
    const rpc = fakeRpc({ type: 'preloaded', fetched: 2 });
    const api = createProjApi(rpc, manifest);

    await api.prepare('EPSG:4326', 'EPSG:6677', { x: 139.7, y: 35.6 });

    expect(rpc.calls[0]!.message).toEqual({
      type: 'preloadGrids',
      spec: [{ src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.7, y: 35.6 }],
    });
  });

  it('describes the operation, allowing ballpark so a ballpark can be reported', async () => {
    const info = { name: 'op', accuracy: 1, ballpark: false, grids: [] };
    const rpc = fakeRpc({ type: 'described', info });
    const api = createProjApi(rpc, manifest);

    const result = await api.describe('EPSG:4326', 'EPSG:6677', { x: 1, y: 2 });

    expect(result).toBe(info);
    // describe answers "what would happen", so refusing to look at a ballpark
    // would make the one case worth asking about unreportable.
    expect(rpc.calls[0]!.message.allowBallpark).toBe(true);
  });

  it('disposes the transport underneath it', () => {
    const rpc = fakeRpc();
    const api = createProjApi(rpc, manifest);

    api.dispose();

    expect(rpc.disposed).toBe(true);
  });
});
