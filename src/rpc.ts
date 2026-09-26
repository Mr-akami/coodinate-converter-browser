/*
 * The only RPC implementation between the main thread and the PROJ worker.
 *
 * A worker that emits `error` or `messageerror` is gone for good: every
 * pending request is rejected with a ProjWorkerError and the instance stays
 * disposed, so no caller waits forever. There is no timeout — a first grid
 * download can legitimately take minutes — so callers cancel with an
 * AbortSignal instead, which also tells the worker to stop the work.
 */

import {
  MISSING_GRID_REASONS, MissingGridError, ProjWorkerError,
  type MissingGridReason,
} from './errors.js';
import type { Rpc, RpcPort, RpcRequestOptions } from './types.js';

interface WorkerReply {
  id?: unknown;
  type?: string;
  error?: string;
  errorKind?: MissingGridReason;
  missingGrids?: import('./types.js').GridRef[];
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
  onProgress?: RpcRequestOptions['onProgress'];
}

function buildReplyError(data: WorkerReply): Error {
  if (data.errorKind && MISSING_GRID_REASONS.includes(data.errorKind)) {
    return new MissingGridError(data.error || data.errorKind, {
      reason: data.errorKind,
      missingGrids: data.missingGrids,
    });
  }
  return new Error(data.error || 'proj worker request failed');
}

export function createRpc(port: RpcPort): Rpc {
  const pending = new Map<number, PendingRequest>();
  let nextId = 0;
  let disposedWith: ProjWorkerError | null = null;

  function dispose(error: ProjWorkerError) {
    disposedWith = error;
    for (const entry of pending.values()) {
      entry.detach();
      entry.reject(error);
    }
    pending.clear();
  }

  port.addEventListener('message', (event: { data: WorkerReply }) => {
    const data = event.data;
    const entry = pending.get(data?.id as number);
    if (!entry) return;
    if (data.type === 'progress') {
      if (entry.onProgress) entry.onProgress(data as never);
      return;
    }
    pending.delete(data.id as number);
    entry.detach();
    if (data.type === 'error') entry.reject(buildReplyError(data));
    else entry.resolve(data);
  });

  port.addEventListener('error', (event: { message?: string }) => {
    dispose(new ProjWorkerError(`proj worker failed: ${event?.message ?? 'unknown error'}`));
  });

  port.addEventListener('messageerror', () => {
    dispose(new ProjWorkerError('proj worker sent a message that could not be deserialised'));
  });

  function request<T = any>(
    message: Record<string, unknown>,
    options: RpcRequestOptions = {},
  ): Promise<T> {
    if (disposedWith) return Promise.reject(disposedWith);

    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const { signal, onProgress } = options;

      const onAbort = () => {
        pending.delete(id);
        detach();
        port.postMessage({ type: 'abort', id });
        reject(signal!.reason);
      };
      const detach = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      if (signal) {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      pending.set(id, { resolve, reject, detach, onProgress });
      // `transfer` names buffers to move rather than copy; it is a delivery
      // detail, so it never reaches the worker as part of the message.
      const { transfer, ...body } = message;
      port.postMessage({ ...body, id }, (transfer as Transferable[]) || []);
    });
  }

  /*
   * Shut the transport down deliberately. Everything still in flight is
   * rejected the same way a worker crash rejects it, so a caller never waits
   * on a port nobody is listening to any more.
   */
  function disposeTransport() {
    if (!disposedWith) {
      dispose(new ProjWorkerError('proj worker disposed'));
    }
    if (typeof port.terminate === 'function') port.terminate();
  }

  return { request, dispose: disposeTransport };
}
