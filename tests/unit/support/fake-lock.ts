/*
 * Stand-in for the Web Locks wrapper the install path is given.
 * Mirrors `navigator.locks.request(name, callback)`: the callback's result is
 * returned and the lock is held for exactly as long as the callback runs.
 */

import type { OpLog } from './op-log';

interface Lock {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

interface FakeLock extends Lock {
  readonly names: string[];
  readonly held: boolean;
}

export function createFakeLock(log?: OpLog): FakeLock {
  const names: string[] = [];
  let depth = 0;

  return {
    names,

    get held() {
      return depth > 0;
    },

    async request(name, callback) {
      names.push(name);
      depth += 1;
      log?.record(`lock:acquire:${name}`);
      try {
        return await callback();
      } finally {
        depth -= 1;
        log?.record(`lock:release:${name}`);
      }
    },
  };
}
