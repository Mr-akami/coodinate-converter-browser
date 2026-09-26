/*
 * CT-LRU — the prepare cache is bounded.
 * Source: order.md Scope 8 ("`preparedGridSets` grows one entry per 1° cell
 * forever. Make it a small LRU.").
 */

import { describe, expect, it } from 'vitest';

import { createLru } from '../../src/worker/lru.js';

describe('createLru', () => {
  it('evicts the least recently used entry once capacity is exceeded', () => {
    const lru = createLru(2);

    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);

    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe(2);
    expect(lru.get('c')).toBe(3);
  });

  it('keeps an entry that was read since it was written', () => {
    const lru = createLru(2);

    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a');
    lru.set('c', 3);

    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBeUndefined();
  });

  it('keeps every entry while the cache is below capacity', () => {
    const lru = createLru(3);

    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);

    expect([lru.get('a'), lru.get('b'), lru.get('c')]).toEqual([1, 2, 3]);
  });

  it('overwrites an existing key instead of evicting another entry', () => {
    const lru = createLru(2);

    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('a', 10);

    expect(lru.get('a')).toBe(10);
    expect(lru.get('b')).toBe(2);
  });

  it('drops every entry on clear', () => {
    const lru = createLru(2);

    lru.set('a', 1);
    lru.clear();

    expect(lru.get('a')).toBeUndefined();
  });
});
