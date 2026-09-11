/*
 * Bounded map with least-recently-used eviction. The prepare cache keys on a
 * 1 degree coordinate cell, so an unbounded map grows for the life of the
 * page.
 */

export interface Lru<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  clear(): void;
}

/** @param capacity maximum number of entries kept */
export function createLru<K, V>(capacity: number): Lru<K, V> {
  const entries = new Map<K, V>();

  return {
    get(key: K): V | undefined {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key) as V;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },

    set(key: K, value: V): void {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > capacity) {
        entries.delete(entries.keys().next().value as K);
      }
    },

    clear(): void {
      entries.clear();
    },
  };
}
