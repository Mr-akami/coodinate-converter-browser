/*
 * The RPC layer between the main thread and the single PROJ worker.
 *
 * Contracts under test (order.md Scope 7 and the Verification item
 * "Add vitest coverage for ... the RPC failure path"):
 *   CT-RPC-DEAD  `error` / `messageerror` reject every pending request with
 *                `ProjWorkerError` and leave the instance disposed; no fixed
 *                timeout is imposed
 *   CT-RPC-ABORT each call takes an `AbortSignal`; aborting releases that call
 *                and tells the worker to stop, without killing the instance
 *   CT-API       an error reply keeps the observable `MissingGridError` shape
 *   CT-PROGRESS  progress messages reach the calling side
 */

import { describe, expect, it, vi } from 'vitest';

import { MissingGridError, ProjWorkerError } from '../../src/errors.js';
import { createRpc } from '../../src/rpc.js';

import { createFakeWorkerPort } from './support/fake-worker-port';

function lastPosted(port: ReturnType<typeof createFakeWorkerPort>) {
  return port.posted[port.posted.length - 1];
}

describe('createRpc — replies', () => {
  it('resolves with the reply that carries the request id and ignores the others', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);

    const pending = rpc.request({ type: 'transform', src: 'EPSG:4326', dst: 'EPSG:6677' });
    const sent = lastPosted(port);

    expect(sent.type).toBe('transform');
    port.deliver({ type: 'result', id: 'unrelated-id', x: 1 });
    port.deliver({ type: 'result', id: sent.id, x: 2 });

    await expect(pending).resolves.toMatchObject({ x: 2 });
  });

  it('maps a missing-grid error reply to MissingGridError', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);
    const missingGrids = [{ shortName: 'jp', fullName: 'jp_gsi_jgd2011.tif', url: '' }];

    const pending = rpc.request({ type: 'transform' });
    port.deliver({
      type: 'error',
      id: lastPosted(port).id,
      error: 'missing grid(s): jp_gsi_jgd2011.tif',
      errorKind: 'missing_grid',
      missingGrids,
    });

    const error = await pending.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingGridError);
    expect((error as MissingGridError).name).toBe('MissingGridError');
    expect((error as MissingGridError).reason).toBe('missing_grid');
    expect((error as MissingGridError).missingGrids).toEqual(missingGrids);
  });

  it('maps a ballpark-only error reply to MissingGridError', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);

    const pending = rpc.request({ type: 'transform' });
    port.deliver({
      type: 'error',
      id: lastPosted(port).id,
      error: 'no non-ballpark operation available',
      errorKind: 'ballpark_only',
    });

    const error = await pending.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingGridError);
    expect((error as MissingGridError).reason).toBe('ballpark_only');
  });

  it('maps an error reply without a kind to a plain Error carrying the message', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);

    const pending = rpc.request({ type: 'init' });
    port.deliver({ type: 'error', id: lastPosted(port).id, error: 'pw_init failed: 3' });

    const error = await pending.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MissingGridError);
    expect((error as Error).message).toContain('pw_init failed: 3');
  });

  it('forwards progress for the calling request only, without settling it', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);
    const events: Array<Record<string, unknown>> = [];

    const pending = rpc.request({ type: 'init' }, { onProgress: (event) => events.push(event) });
    const sent = lastPosted(port);
    port.deliver({ type: 'progress', id: 'unrelated-id', stage: 'proj-db', bytes: 1, total: 2 });
    port.deliver({ type: 'progress', id: sent.id, stage: 'proj-db', bytes: 5, total: 10 });
    port.deliver({ type: 'ready', id: sent.id });

    const result = await pending;

    expect(result).toMatchObject({ type: 'ready' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'proj-db', bytes: 5, total: 10 });
  });
});

describe('createRpc — worker failure is terminal', () => {
  it('rejects every pending request with ProjWorkerError when the worker errors', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);

    const first = rpc.request({ type: 'transform' });
    const second = rpc.request({ type: 'prepare' });
    port.emit('error', { type: 'error', message: 'worker crashed' });

    await expect(first).rejects.toBeInstanceOf(ProjWorkerError);
    await expect(second).rejects.toBeInstanceOf(ProjWorkerError);
  });

  it('rejects later calls on the same instance without posting them', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);

    const pending = rpc.request({ type: 'transform' });
    port.emit('error', { type: 'error', message: 'worker crashed' });
    await expect(pending).rejects.toBeInstanceOf(ProjWorkerError);

    const postedCount = port.posted.length;
    await expect(rpc.request({ type: 'transform' })).rejects.toBeInstanceOf(ProjWorkerError);
    expect(port.posted).toHaveLength(postedCount);
  });

  it('treats an undeserialisable message the same way', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);

    const pending = rpc.request({ type: 'transform' });
    port.emit('messageerror', { type: 'messageerror' });

    await expect(pending).rejects.toBeInstanceOf(ProjWorkerError);
    await expect(rpc.request({ type: 'prepare' })).rejects.toBeInstanceOf(ProjWorkerError);
  });

  it('does not time a slow call out on its own', async () => {
    vi.useFakeTimers();
    try {
      const port = createFakeWorkerPort();
      const rpc = createRpc(port);

      let outcome = 'pending';
      const pending = rpc.request({ type: 'prepare' }).then(
        () => 'resolved',
        () => 'rejected',
      );
      void pending.then((value) => {
        outcome = value;
      });

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(outcome).toBe('pending');

      port.deliver({ type: 'prepared', id: lastPosted(port).id, grids: [] });

      await expect(pending).resolves.toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createRpc — abort', () => {
  it('rejects the aborted call with the signal reason', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);
    const controller = new AbortController();
    const reason = new Error('caller went away');

    const pending = rpc.request({ type: 'prepare' }, { signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('tells the worker to stop the aborted request', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);
    const controller = new AbortController();

    const pending = rpc.request({ type: 'prepare' }, { signal: controller.signal });
    const sent = lastPosted(port);
    controller.abort(new Error('caller went away'));
    await expect(pending).rejects.toThrow();

    expect(port.posted).toContainEqual({ type: 'abort', id: sent.id });
  });

  it('keeps serving later calls, and ignores a reply that arrives after the abort', async () => {
    const port = createFakeWorkerPort();
    const rpc = createRpc(port);
    const controller = new AbortController();

    const aborted = rpc.request({ type: 'prepare' }, { signal: controller.signal });
    const abortedId = lastPosted(port).id;
    controller.abort(new Error('caller went away'));
    await expect(aborted).rejects.toThrow();
    port.deliver({ type: 'prepared', id: abortedId, grids: [] });

    const next = rpc.request({ type: 'transform' });
    port.deliver({ type: 'result', id: lastPosted(port).id, x: 7 });

    await expect(next).resolves.toMatchObject({ x: 7 });
  });
});
