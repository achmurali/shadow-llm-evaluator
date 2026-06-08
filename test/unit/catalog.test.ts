import { describe, it, expect } from 'vitest';
import { loadCatalog, Catalog } from '../../src/shared/config/catalog.js';

const raw = { models: { a: { inferenceName: 'A' }, b: { inferenceName: 'B' } } };

describe('catalog', () => {
  it('resolves inference name', () => {
    const c: Catalog = loadCatalog(raw);
    expect(c.resolve('a')).toBe('A');
    expect(c.has('b')).toBe(true);
    expect(c.has('zzz')).toBe(false);
  });
  it('throws resolving unknown model', () => {
    const c = loadCatalog(raw);
    expect(() => c.resolve('zzz')).toThrow(/unknown model/i);
  });
});
