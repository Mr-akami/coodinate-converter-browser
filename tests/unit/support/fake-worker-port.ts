/*
 * Stand-in for the Worker the RPC layer talks to. Only the members the RPC
 * layer is allowed to use are provided: postMessage, add/removeEventListener
 * and terminate.
 */

interface FakeWorkerPort {
  postMessage(message: unknown): void;
  addEventListener(type: string, handler: (event: any) => void): void;
  removeEventListener(type: string, handler: (event: any) => void): void;
  terminate(): void;

  readonly posted: any[];
  /** Deliver a worker reply / progress message. */
  deliver(data: unknown): void;
  /** Fire a worker-level event ('error' or 'messageerror'). */
  emit(type: string, event: unknown): void;
}

export function createFakeWorkerPort(): FakeWorkerPort {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const posted: any[] = [];

  const port: FakeWorkerPort = {
    posted,

    postMessage(message) {
      posted.push(message);
    },

    addEventListener(type, handler) {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },

    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },

    terminate() {
      // A disposed RPC layer may terminate the worker; nothing to observe.
    },

    emit(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },

    deliver(data) {
      port.emit('message', { type: 'message', data });
    },
  };

  return port;
}
