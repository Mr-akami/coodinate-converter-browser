/*
 * Bounded map with least-recently-used eviction. The prepare cache keys on a
 * 1 degree coordinate cell, so an unbounded map grows for the life of the
 * page.
 */

/**
 * @param {number} capacity maximum number of entries kept
 */
export function createLru(capacity) {
  /** @type {Map<unknown, unknown>} */
  const entries = new Map();

  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },

    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > capacity) {
        entries.delete(entries.keys().next().value);
      }
    },

    clear() {
      entries.clear();
    },
  };
}
