/*
 * Ordered log of the side effects a fake records, shared by several fakes in
 * one test so that "which happened first" can be asserted across them
 * (e.g. store writes relative to lock acquisition).
 */

export interface OpLog {
  readonly entries: string[];
  record(op: string): void;
  waitFor(predicate: (op: string) => boolean): Promise<void>;
  indexOf(op: string): number;
}

export function createOpLog(): OpLog {
  const entries: string[] = [];
  const waiters: Array<{ predicate: (op: string) => boolean; resolve: () => void }> = [];

  return {
    entries,

    record(op) {
      entries.push(op);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(op)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },

    waitFor(predicate) {
      if (entries.some(predicate)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },

    indexOf(op) {
      return entries.indexOf(op);
    },
  };
}
