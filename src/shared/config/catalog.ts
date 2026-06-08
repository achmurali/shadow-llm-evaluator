import { readFileSync } from 'node:fs';
import { z } from 'zod';

const schema = z.object({
  models: z.record(z.object({ inferenceName: z.string() }))
});

export interface Catalog {
  has(id: string): boolean;
  resolve(id: string): string;     // -> DO inference model name
  ids(): string[];
}

export function loadCatalog(raw: unknown): Catalog {
  const { models } = schema.parse(raw);
  return {
    has: (id) => id in models,
    resolve: (id) => {
      const m = models[id];
      if (!m) throw new Error(`unknown model: ${id}`);
      return m.inferenceName;
    },
    ids: () => Object.keys(models)
  };
}

export function loadCatalogFromFile(path: string): Catalog {
  return loadCatalog(JSON.parse(readFileSync(path, 'utf8')));
}
