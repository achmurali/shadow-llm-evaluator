# Shadow LLM Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local-first Node/TS service that serves a primary LLM via `/v1/chat`, shadow-evaluates candidate model(s) on sampled requests using a pluggable deterministic heuristic engine, persists results to Postgres, and surfaces real-time metrics on a simple dashboard.

**Architecture:** Single TypeScript package, two entrypoints (`api`, `worker`) sharing `src/shared`. API serves the primary synchronously and enqueues one BullMQ job per candidate (`jobId = evalId`); the worker calls the candidate, runs the heuristic engine, and updates the eval row. Postgres holds `requests`, `evaluations`, and versioned dynamic `config`. Models are served via DO serverless inference (OpenAI-compatible). Everything runs locally via Docker Compose.

**Tech Stack:** Node 20, TypeScript, Fastify, BullMQ + Redis, PostgreSQL (`pg`), zod, Vitest + supertest + Testcontainers, Docker Compose.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .eslintrc.cjs, .env.example
config/models.json                     # model catalog (supported id -> DO inference name)
db/schema.sql                          # idempotent schema (CREATE TABLE IF NOT EXISTS)
docker/Dockerfile                      # multi-stage build, shared by api + worker
docker-compose.yml                     # api + worker + postgres + redis
public/dashboard.html                  # single-page dashboard (polls /v1/stats)

src/shared/
  types.ts                             # Json, ChatMessage, ChatRequest, Comparable, enums
  config/env.ts                        # static env config (zod)
  config/catalog.ts                    # load + validate config/models.json
  config/dynamic.ts                    # DynamicConfig type + zod schema + defaults
  config/service.ts                    # ConfigService (TTL cache over config table)
  db/pool.ts                           # pg Pool + applySchema()
  db/requests.repo.ts                  # requests table access
  db/evaluations.repo.ts              # evaluations table access
  db/config.repo.ts                    # config table access
  providers/types.ts                   # ModelProvider interface + provider req/resp
  providers/do-inference.ts            # OpenAI-compatible DO inference client
  providers/mock.ts                    # deterministic mock provider (tests/demo)
  providers/comparable.ts              # extractComparable(response)
  heuristics/types.ts                  # HeuristicRule, RuleResult, EvaluationResult
  heuristics/json-utils.ts             # flatten, levenshtein, jaccard helpers
  heuristics/rules/structural.ts
  heuristics/rules/exact-match.ts
  heuristics/rules/text-similarity.ts
  heuristics/rules/numeric-tolerance.ts
  heuristics/rules/tool-calls.ts
  heuristics/engine.ts                 # registry + composite scorer + verdict
  queue/queue.ts                       # BullMQ queue, job type, connection
  sampling/sampling.ts                 # shouldSample()
  stats/stats.ts                       # SQL aggregate queries for dashboard

src/api/
  app.ts                               # buildApp(deps) -> Fastify instance
  routes/chat.ts                       # POST /v1/chat
  routes/config.ts                     # GET/PUT /v1/config
  routes/lookup.ts                     # GET /v1/requests/:id, /v1/evaluations/:id
  routes/stats.ts                      # GET /v1/stats + dashboard route
  auth.ts                              # admin + optional request auth
  server.ts                            # entrypoint: wire deps, listen

src/worker/
  processor.ts                         # processJob(evalId, deps)
  worker.ts                            # entrypoint: BullMQ Worker

test/
  unit/...                             # mirrors src
  integration/api.test.ts
  integration/worker.test.ts
  integration/config-propagation.test.ts
  integration/idempotency.test.ts
  helpers/testcontainers.ts            # spin up pg + redis for integration
```

**Decomposition rule:** one file = one responsibility. Heuristic rules are one file each so the engine stays a thin registry. Repos isolate SQL from business logic so handlers/worker are testable against fakes.

---

## Phase 0 — Scaffolding

### Task 1: Initialize the package

**Files:**
- Create: `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.gitignore` (exists — leave), `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "shadow-llm-evaluator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start:api": "node dist/api/server.js",
    "start:worker": "node dist/worker/worker.js",
    "dev:api": "tsx watch src/api/server.ts",
    "dev:worker": "tsx watch src/worker/worker.ts",
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "lint": "eslint . --ext .ts"
  },
  "dependencies": {
    "bullmq": "^5.34.0",
    "fastify": "^5.2.0",
    "ioredis": "^5.4.1",
    "pg": "^8.13.1",
    "uuid": "^11.0.3",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/pg": "^8.11.10",
    "@types/uuid": "^10.0.0",
    "eslint": "^9.17.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `.eslintrc.cjs`** (minimal, non-blocking)

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  env: { node: true, es2022: true },
  extends: ['eslint:recommended'],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: {}
};
```

- [ ] **Step 4: Create `.env.example`**

```bash
PORT=8080
DATABASE_URL=postgres://shadow:shadow@localhost:5432/shadow
REDIS_URL=redis://localhost:6379
DO_INFERENCE_BASE_URL=https://inference.do-ai.run/v1
DO_INFERENCE_KEY=replace-me
ADMIN_KEY=admin-secret
# AUTH_KEY=          # optional; if set, /v1/chat requires it
WORKER_CONCURRENCY=5
MODEL_TIMEOUT_MS=30000
JOB_ATTEMPTS=3
JOB_BACKOFF_MS=2000
CONFIG_CACHE_TTL_MS=5000
CATALOG_PATH=config/models.json
```

- [ ] **Step 5: Install + commit**

Run: `npm install`
Expected: lockfile created, `node_modules` present.

```bash
git add package.json package-lock.json tsconfig.json .eslintrc.cjs .env.example
git commit -m "chore: scaffold TypeScript package"
```

---

### Task 2: Create Vitest config

**Files:**
- Create: `vitest.config.ts`

- [ ] **Step 1: Write the config**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Integration tests share a local Postgres/Redis; run files sequentially
    // so per-file isolated databases and Redis flushes don't race.
    poolOptions: { forks: { singleFork: true } }
  }
});
```

- [ ] **Step 2: Add a smoke test** — `test/unit/smoke.test.ts`

```ts
import { describe, it, expect } from 'vitest';
describe('smoke', () => { it('runs', () => { expect(1 + 1).toBe(2); }); });
```

- [ ] **Step 3: Run it**

Run: `npm run test:unit`
Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts test/unit/smoke.test.ts
git commit -m "chore: add vitest config + smoke test"
```

---

### Task 3: Local infra compose for dev/test (Postgres + Redis)

**Files:**
- Create: `docker-compose.yml` (infra-only services first; app services added in Task 30)

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: shadow
      POSTGRES_PASSWORD: shadow
      POSTGRES_DB: shadow
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shadow"]
      interval: 3s
      timeout: 3s
      retries: 10
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 3s
      retries: 10
```

- [ ] **Step 2: Validate the compose YAML** (Docker is unavailable in this shell; native Postgres +
  Redis are already running and used for tests/dev. This file is a shipped artifact.)

Run: `python3 -c "import yaml; print(sorted(yaml.safe_load(open('docker-compose.yml'))['services']))"`
Expected: `['postgres', 'redis']`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: add local postgres + redis compose"
```

---

## Phase 1 — Shared foundations

### Task 4: Domain types

**Files:**
- Create: `src/shared/types.ts`
- Test: `test/unit/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { EVAL_STATUSES, isEvalStatus } from '../../src/shared/types.js';

describe('eval status', () => {
  it('lists the four statuses', () => {
    expect(EVAL_STATUSES).toEqual(['queued', 'running', 'completed', 'failed']);
  });
  it('guards unknown values', () => {
    expect(isEvalStatus('running')).toBe(true);
    expect(isEvalStatus('nope')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- types`
Expected: FAIL — cannot find module `types.js`.

- [ ] **Step 3: Implement `src/shared/types.ts`**

```ts
export type Json =
  | string | number | boolean | null
  | Json[] | { [key: string]: Json };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id?: string;
  type: 'function';
  function: { name: string; arguments: string }; // arguments is a JSON string
}

export interface ChatRequest {
  model: string;                 // primary
  messages: ChatMessage[];
  candidates?: string[];         // extension: shadow candidates
  tools?: Json;
  response_format?: Json;
  temperature?: number;
}

/** What the heuristic engine actually compares. */
export interface Comparable {
  content: Json | null;          // parsed assistant JSON content (null if unparseable)
  parseError: boolean;
  toolCalls: ToolCall[];
}

export const EVAL_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type EvalStatus = (typeof EVAL_STATUSES)[number];
export function isEvalStatus(v: unknown): v is EvalStatus {
  return typeof v === 'string' && (EVAL_STATUSES as readonly string[]).includes(v);
}

export type Verdict = 'pass' | 'fail';
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -- types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts test/unit/types.test.ts
git commit -m "feat: shared domain types"
```

---

### Task 5: Static env config

**Files:**
- Create: `src/shared/config/env.ts`
- Test: `test/unit/env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/shared/config/env.js';

const base = {
  DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x',
  DO_INFERENCE_BASE_URL: 'https://x/v1', DO_INFERENCE_KEY: 'k', ADMIN_KEY: 'a'
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(8080);
    expect(env.WORKER_CONCURRENCY).toBe(5);
    expect(env.AUTH_KEY).toBeUndefined();
  });
  it('throws when a required var is missing', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined } as any)).toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Run: npm run test:unit -- env`).

- [ ] **Step 3: Implement `src/shared/config/env.ts`**

```ts
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  DO_INFERENCE_BASE_URL: z.string(),
  DO_INFERENCE_KEY: z.string(),
  ADMIN_KEY: z.string(),
  AUTH_KEY: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().default(5),
  MODEL_TIMEOUT_MS: z.coerce.number().default(30_000),
  JOB_ATTEMPTS: z.coerce.number().default(3),
  JOB_BACKOFF_MS: z.coerce.number().default(2_000),
  CONFIG_CACHE_TTL_MS: z.coerce.number().default(5_000),
  CATALOG_PATH: z.string().default('config/models.json')
});

export type Env = z.infer<typeof schema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/shared/config/env.ts test/unit/env.test.ts
git commit -m "feat: static env config with zod"
```

---

### Task 6: Model catalog

**Files:**
- Create: `config/models.json`, `src/shared/config/catalog.ts`
- Test: `test/unit/catalog.test.ts`

- [ ] **Step 1: Create `config/models.json`**

```json
{
  "models": {
    "primary-llama": { "inferenceName": "llama3.3-70b-instruct" },
    "candidate-claude": { "inferenceName": "anthropic-claude-3.5-haiku" },
    "candidate-mistral": { "inferenceName": "mistral-nemo-instruct" }
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
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
```

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Implement `src/shared/config/catalog.ts`**

```ts
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
```

- [ ] **Step 5: Run — expect PASS. Commit.**

```bash
git add config/models.json src/shared/config/catalog.ts test/unit/catalog.test.ts
git commit -m "feat: model catalog"
```

---

### Task 7: Dynamic config schema + defaults

**Files:**
- Create: `src/shared/config/dynamic.ts`
- Test: `test/unit/dynamic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { DynamicConfigSchema, DEFAULT_CONFIG } from '../../src/shared/config/dynamic.js';

describe('dynamic config', () => {
  it('default validates', () => {
    expect(() => DynamicConfigSchema.parse(DEFAULT_CONFIG)).not.toThrow();
  });
  it('rejects rate > 1', () => {
    expect(() => DynamicConfigSchema.parse({ ...DEFAULT_CONFIG, sampling: { ...DEFAULT_CONFIG.sampling, rate: 2 } })).toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/config/dynamic.ts`**

```ts
import { z } from 'zod';

const RuleConfig = z.object({
  enabled: z.boolean(),
  weight: z.number().min(0),
  options: z.record(z.unknown()).default({})
});

export const DynamicConfigSchema = z.object({
  sampling: z.object({
    rate: z.number().min(0).max(1),
    overrides: z.object({
      model: z.record(z.number().min(0).max(1)).default({}),
      route: z.record(z.number().min(0).max(1)).default({})
    }).default({ model: {}, route: {} }),
    forceHeader: z.string().default('x-shadow-eval')
  }),
  defaultCandidates: z.array(z.string()).default([]),
  heuristics: z.object({
    rules: z.record(RuleConfig),
    verdictThreshold: z.number().min(0).max(1)
  })
});

export type DynamicConfig = z.infer<typeof DynamicConfigSchema>;

export const DEFAULT_CONFIG: DynamicConfig = {
  sampling: { rate: 0.2, overrides: { model: {}, route: {} }, forceHeader: 'x-shadow-eval' },
  defaultCandidates: ['candidate-claude'],
  heuristics: {
    verdictThreshold: 0.8,
    rules: {
      structural:       { enabled: true, weight: 2, options: {} },
      'exact-match':    { enabled: true, weight: 2, options: {} },
      'text-similarity':{ enabled: true, weight: 1, options: {} },
      'numeric-tolerance':{ enabled: true, weight: 1, options: { absTol: 0, relTol: 0.01 } },
      'tool-calls':     { enabled: true, weight: 2, options: {} }
    }
  }
};
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/config/dynamic.ts test/unit/dynamic.test.ts
git commit -m "feat: dynamic config schema + defaults"
```

---

### Task 8: Postgres pool + schema

**Files:**
- Create: `db/schema.sql`, `src/shared/db/pool.ts`

(No unit test — exercised by integration tests in Phase 6. This is infrastructure code.)

- [ ] **Step 1: Write `db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS requests (
  request_id        UUID PRIMARY KEY,
  primary_model     TEXT NOT NULL,
  messages          JSONB NOT NULL,
  primary_response  JSONB NOT NULL,
  primary_latency_ms INTEGER NOT NULL,
  sampled           BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evaluations (
  eval_id             UUID PRIMARY KEY,
  request_id          UUID NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
  candidate_model     TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  candidate_response  JSONB,
  rule_scores         JSONB,
  composite_score     NUMERIC,
  verdict             TEXT CHECK (verdict IN ('pass','fail')),
  candidate_latency_ms INTEGER,
  attempts            INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  UNIQUE (request_id, candidate_model)
);
CREATE INDEX IF NOT EXISTS idx_eval_request   ON evaluations(request_id);
CREATE INDEX IF NOT EXISTS idx_eval_status    ON evaluations(status);
CREATE INDEX IF NOT EXISTS idx_eval_candidate ON evaluations(candidate_model);
CREATE INDEX IF NOT EXISTS idx_eval_created   ON evaluations(created_at);

CREATE TABLE IF NOT EXISTS config (
  version    INTEGER PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Implement `src/shared/db/pool.ts`**

```ts
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function applySchema(pool: Pool, schemaPath = 'db/schema.sql'): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}
```

- [ ] **Step 3: Commit**

```bash
git add db/schema.sql src/shared/db/pool.ts
git commit -m "feat: postgres pool + schema"
```

---

### Task 9: Requests repository

**Files:**
- Create: `src/shared/db/requests.repo.ts`
- Test: `test/integration/requests-repo.test.ts` (needs Postgres; uses helper from Task 28's helper — create the helper now)
- Create: `test/helpers/testcontainers.ts`

- [ ] **Step 1: Create the test-services helper `test/helpers/testcontainers.ts`**

> **Environment note:** This dev shell has no Docker, so we use **native local Postgres + Redis**
> (installed via apt) instead of Testcontainers. The helper reads `TEST_DATABASE_URL` /
> `TEST_REDIS_URL` (defaulting to the local services) and gives each test file an **isolated
> database** (created + dropped per `startPg()` call) for the same isolation Testcontainers gave.
> The `{ container: { stop } }` shape is preserved so test files don't change. The shipped
> `docker-compose.yml` still provides these services for anyone with Docker.

```ts
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { applySchema } from '../../src/shared/db/pool.js';

const ADMIN_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://shadow:shadow@localhost:5432/shadow';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

function uniqueDbName(): string {
  return 'test_' + randomBytes(6).toString('hex');
}

/** Creates an isolated database, applies the schema, and returns a pool to it.
 *  `container.stop()` drops that database (call AFTER `pool.end()`). */
export async function startPg(): Promise<{ container: { stop: () => Promise<void> }; pool: Pool; url: string }> {
  const admin = new Pool({ connectionString: ADMIN_DB_URL });
  const db = uniqueDbName();
  await admin.query(`CREATE DATABASE ${db}`);
  const url = ADMIN_DB_URL.replace(/\/[^/]+$/, `/${db}`);
  const pool = new Pool({ connectionString: url });
  await applySchema(pool, 'db/schema.sql');
  const container = {
    stop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  };
  return { container, pool, url };
}

/** Flushes the local Redis so each file starts clean. `container.stop()` is a no-op. */
export async function startRedis(): Promise<{ container: { stop: () => Promise<void> }; url: string }> {
  const client = new Redis(REDIS_URL);
  await client.flushall();
  await client.quit();
  return { container: { stop: async () => {} }, url: REDIS_URL };
}
```

> **Test cleanup contract:** every integration test's teardown calls `await pool.end()` **before**
> `await pg.container.stop()` (so the database has no open connections when dropped). The tests in
> this plan already follow that order.

- [ ] **Step 2: Write the failing test `test/integration/requests-repo.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';

let pool: Pool; let stop: () => Promise<void>; let repo: RequestsRepo;

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool; repo = new RequestsRepo(pool);
  stop = async () => { await pool.end(); await pg.container.stop(); };
});
afterAll(() => stop());

describe('RequestsRepo', () => {
  it('inserts and reads a request', async () => {
    const id = await repo.insert({
      requestId: 'a1111111-1111-1111-1111-111111111111',
      primaryModel: 'primary-llama',
      messages: [{ role: 'user', content: 'hi' }],
      primaryResponse: { choices: [] },
      primaryLatencyMs: 42,
      sampled: true
    });
    const row = await repo.get(id);
    expect(row?.primary_model).toBe('primary-llama');
    expect(row?.sampled).toBe(true);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`Run: npm run test:integration -- requests-repo`). Module missing.

- [ ] **Step 4: Implement `src/shared/db/requests.repo.ts`**

```ts
import { Pool } from 'pg';
import { ChatMessage, Json } from '../types.js';

export interface InsertRequest {
  requestId: string;
  primaryModel: string;
  messages: ChatMessage[];
  primaryResponse: Json;
  primaryLatencyMs: number;
  sampled: boolean;
}

export interface RequestRow {
  request_id: string;
  primary_model: string;
  messages: ChatMessage[];
  primary_response: Json;
  primary_latency_ms: number;
  sampled: boolean;
  created_at: string;
}

export class RequestsRepo {
  constructor(private pool: Pool) {}

  async insert(r: InsertRequest): Promise<string> {
    await this.pool.query(
      `INSERT INTO requests (request_id, primary_model, messages, primary_response, primary_latency_ms, sampled)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.requestId, r.primaryModel, JSON.stringify(r.messages), JSON.stringify(r.primaryResponse), r.primaryLatencyMs, r.sampled]
    );
    return r.requestId;
  }

  async get(requestId: string): Promise<RequestRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM requests WHERE request_id = $1', [requestId]);
    return rows[0] ?? null;
  }
}
```

- [ ] **Step 5: Run — expect PASS. Commit.**

```bash
git add src/shared/db/requests.repo.ts test/helpers/testcontainers.ts test/integration/requests-repo.test.ts
git commit -m "feat: requests repository + testcontainers helper"
```

---

### Task 10: Evaluations repository

**Files:**
- Create: `src/shared/db/evaluations.repo.ts`
- Test: `test/integration/evaluations-repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../src/shared/db/evaluations.repo.js';

let pool: Pool; let stop: () => Promise<void>;
let reqRepo: RequestsRepo; let evalRepo: EvaluationsRepo;
const RID = 'b2222222-2222-2222-2222-222222222222';
const EID = 'c3333333-3333-3333-3333-333333333333';

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool; reqRepo = new RequestsRepo(pool); evalRepo = new EvaluationsRepo(pool);
  stop = async () => { await pool.end(); await pg.container.stop(); };
  await reqRepo.insert({ requestId: RID, primaryModel: 'p', messages: [], primaryResponse: {}, primaryLatencyMs: 1, sampled: true });
});
afterAll(() => stop());

describe('EvaluationsRepo', () => {
  it('queues then completes an eval', async () => {
    await evalRepo.enqueue({ evalId: EID, requestId: RID, candidateModel: 'candidate-claude' });
    let row = await evalRepo.get(EID);
    expect(row?.status).toBe('queued');

    await evalRepo.markRunning(EID);
    row = await evalRepo.get(EID);
    expect(row?.status).toBe('running');

    await evalRepo.complete(EID, {
      candidateResponse: { ok: true },
      ruleScores: { structural: { score: 1, weight: 2 } },
      compositeScore: 0.9, verdict: 'pass', candidateLatencyMs: 50
    });
    row = await evalRepo.get(EID);
    expect(row?.status).toBe('completed');
    expect(Number(row?.composite_score)).toBeCloseTo(0.9);
    expect(row?.verdict).toBe('pass');
  });

  it('lists evals by request', async () => {
    const list = await evalRepo.byRequest(RID);
    expect(list.length).toBe(1);
  });

  it('enqueue is idempotent on (request, candidate)', async () => {
    await evalRepo.enqueue({ evalId: 'd4444444-4444-4444-4444-444444444444', requestId: RID, candidateModel: 'candidate-claude' });
    const list = await evalRepo.byRequest(RID);
    expect(list.length).toBe(1); // unchanged: conflict ignored
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/db/evaluations.repo.ts`**

```ts
import { Pool } from 'pg';
import { Json, Verdict, EvalStatus } from '../types.js';

export interface EnqueueEval { evalId: string; requestId: string; candidateModel: string; }
export interface CompleteEval {
  candidateResponse: Json;
  ruleScores: Json;
  compositeScore: number;
  verdict: Verdict;
  candidateLatencyMs: number;
}
export interface EvalRow {
  eval_id: string; request_id: string; candidate_model: string;
  status: EvalStatus; candidate_response: Json | null; rule_scores: Json | null;
  composite_score: string | null; verdict: Verdict | null;
  candidate_latency_ms: number | null; attempts: number; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}

export class EvaluationsRepo {
  constructor(private pool: Pool) {}

  /** Insert as queued. Idempotent on (request_id, candidate_model). */
  async enqueue(e: EnqueueEval): Promise<void> {
    await this.pool.query(
      `INSERT INTO evaluations (eval_id, request_id, candidate_model, status)
       VALUES ($1,$2,$3,'queued')
       ON CONFLICT (request_id, candidate_model) DO NOTHING`,
      [e.evalId, e.requestId, e.candidateModel]
    );
  }

  async markRunning(evalId: string): Promise<void> {
    await this.pool.query(
      `UPDATE evaluations
         SET status='running', attempts = attempts + 1, started_at = COALESCE(started_at, now())
       WHERE eval_id = $1`,
      [evalId]
    );
  }

  async complete(evalId: string, r: CompleteEval): Promise<void> {
    await this.pool.query(
      `UPDATE evaluations
         SET status='completed', candidate_response=$2, rule_scores=$3,
             composite_score=$4, verdict=$5, candidate_latency_ms=$6, finished_at=now(), error=NULL
       WHERE eval_id = $1 AND status <> 'completed'`,
      [evalId, JSON.stringify(r.candidateResponse), JSON.stringify(r.ruleScores),
       r.compositeScore, r.verdict, r.candidateLatencyMs]
    );
  }

  async fail(evalId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE evaluations SET status='failed', error=$2, finished_at=now() WHERE eval_id=$1`,
      [evalId, error]
    );
  }

  async get(evalId: string): Promise<EvalRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM evaluations WHERE eval_id=$1', [evalId]);
    return rows[0] ?? null;
  }

  async byRequest(requestId: string): Promise<EvalRow[]> {
    const { rows } = await this.pool.query('SELECT * FROM evaluations WHERE request_id=$1 ORDER BY created_at', [requestId]);
    return rows;
  }
}
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/db/evaluations.repo.ts test/integration/evaluations-repo.test.ts
git commit -m "feat: evaluations repository (lifecycle + idempotent enqueue)"
```

---

### Task 11: Config repository + ConfigService

**Files:**
- Create: `src/shared/db/config.repo.ts`, `src/shared/config/service.ts`
- Test: `test/unit/config-service.test.ts` (uses a fake repo — pure unit, no DB)

- [ ] **Step 1: Write `src/shared/db/config.repo.ts`**

```ts
import { Pool } from 'pg';
import { DynamicConfig } from '../config/dynamic.js';

export interface ConfigRow { version: number; data: DynamicConfig; }

export class ConfigRepo {
  constructor(private pool: Pool) {}

  async latest(): Promise<ConfigRow | null> {
    const { rows } = await this.pool.query('SELECT version, data FROM config ORDER BY version DESC LIMIT 1');
    return rows[0] ?? null;
  }

  /** Insert next version only if expectedVersion matches current (optimistic concurrency).
   * Returns the new version, or null on conflict. */
  async putNext(data: DynamicConfig, expectedVersion: number): Promise<number | null> {
    const next = expectedVersion + 1;
    const res = await this.pool.query(
      `INSERT INTO config (version, data) VALUES ($1, $2)
       ON CONFLICT (version) DO NOTHING RETURNING version`,
      [next, JSON.stringify(data)]
    );
    return res.rows[0]?.version ?? null;
  }
}
```

- [ ] **Step 2: Write the failing test `test/unit/config-service.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '../../src/shared/config/service.js';
import { DEFAULT_CONFIG } from '../../src/shared/config/dynamic.js';

function fakeRepo(initial = { version: 1, data: DEFAULT_CONFIG }) {
  let row: any = initial;
  return {
    latest: vi.fn(async () => row),
    putNext: vi.fn(async (data: any, expected: number) => {
      if (expected !== row.version) return null;
      row = { version: row.version + 1, data };
      return row.version;
    }),
    _set: (r: any) => { row = r; }
  };
}

describe('ConfigService', () => {
  it('caches within TTL then refetches after expiry', async () => {
    const repo = fakeRepo();
    let now = 1000;
    const svc = new ConfigService(repo as any, 5000, () => now);

    expect((await svc.get()).version).toBe(1);
    repo._set({ version: 2, data: DEFAULT_CONFIG });
    expect((await svc.get()).version).toBe(1);   // cached
    now += 6000;
    expect((await svc.get()).version).toBe(2);   // TTL expired -> refetch
  });

  it('seeds defaults when empty', async () => {
    const repo = { latest: vi.fn(async () => null), putNext: vi.fn(async () => 1) };
    const svc = new ConfigService(repo as any, 5000, () => 0);
    const cfg = await svc.get();
    expect(cfg.version).toBe(1);
    expect(repo.putNext).toHaveBeenCalled();
  });

  it('update rejects stale version', async () => {
    const repo = fakeRepo({ version: 3, data: DEFAULT_CONFIG });
    const svc = new ConfigService(repo as any, 5000, () => 0);
    await svc.get();
    const ok = await svc.update(DEFAULT_CONFIG, 3);
    expect(ok).toBe(4);
    const stale = await svc.update(DEFAULT_CONFIG, 3);  // now current is 4
    expect(stale).toBeNull();
  });
});
```

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Implement `src/shared/config/service.ts`**

```ts
import { ConfigRepo } from '../db/config.repo.js';
import { DynamicConfig, DEFAULT_CONFIG } from './dynamic.js';

export interface VersionedConfig { version: number; config: DynamicConfig; }

export class ConfigService {
  private cache: { version: number; data: DynamicConfig } | null = null;
  private fetchedAt = -Infinity;

  constructor(
    private repo: ConfigRepo,
    private ttlMs: number,
    private now: () => number = () => Date.now()
  ) {}

  async get(): Promise<VersionedConfig> {
    if (this.cache && this.now() - this.fetchedAt < this.ttlMs) {
      return { version: this.cache.version, config: this.cache.data };
    }
    let row = await this.repo.latest();
    if (!row) {
      await this.repo.putNext(DEFAULT_CONFIG, 0); // -> version 1
      row = { version: 1, data: DEFAULT_CONFIG };
    }
    this.cache = row; this.fetchedAt = this.now();
    return { version: row.version, config: row.data };
  }

  /** Returns the new version, or null on stale-version conflict. */
  async update(next: DynamicConfig, expectedVersion: number): Promise<number | null> {
    const v = await this.repo.putNext(next, expectedVersion);
    if (v !== null) { this.cache = { version: v, data: next }; this.fetchedAt = this.now(); }
    return v;
  }
}
```

- [ ] **Step 5: Run — expect PASS. Commit.**

```bash
git add src/shared/db/config.repo.ts src/shared/config/service.ts test/unit/config-service.test.ts
git commit -m "feat: config repo + ConfigService with TTL cache + optimistic concurrency"
```

---

## Phase 2 — Providers

### Task 12: Provider interface + comparable extraction

**Files:**
- Create: `src/shared/providers/types.ts`, `src/shared/providers/comparable.ts`
- Test: `test/unit/comparable.test.ts`

- [ ] **Step 1: Write `src/shared/providers/types.ts`**

```ts
import { ChatMessage, Json } from '../types.js';

export interface ProviderChatRequest {
  messages: ChatMessage[];
  tools?: Json;
  response_format?: Json;
  temperature?: number;
}

/** OpenAI-compatible chat completion (the parts we use). */
export interface ProviderChatResponse {
  choices: Array<{ message: ChatMessage }>;
  [k: string]: Json | undefined;
}

export interface ModelProvider {
  /** modelName is the resolved DO inference model name. */
  chat(modelName: string, req: ProviderChatRequest): Promise<ProviderChatResponse>;
}
```

- [ ] **Step 2: Write the failing test `test/unit/comparable.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { extractComparable } from '../../src/shared/providers/comparable.js';

describe('extractComparable', () => {
  it('parses JSON content', () => {
    const c = extractComparable({ choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] });
    expect(c.content).toEqual({ a: 1 });
    expect(c.parseError).toBe(false);
    expect(c.toolCalls).toEqual([]);
  });
  it('flags unparseable content', () => {
    const c = extractComparable({ choices: [{ message: { role: 'assistant', content: 'not json' } }] });
    expect(c.parseError).toBe(true);
    expect(c.content).toBeNull();
  });
  it('captures tool calls', () => {
    const c = extractComparable({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] } }] });
    expect(c.toolCalls.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Implement `src/shared/providers/comparable.ts`**

```ts
import { Comparable } from '../types.js';
import { ProviderChatResponse } from './types.js';

export function extractComparable(resp: ProviderChatResponse): Comparable {
  const msg = resp.choices?.[0]?.message;
  const toolCalls = msg?.tool_calls ?? [];
  const raw = msg?.content;
  if (raw == null || raw === '') return { content: null, parseError: toolCalls.length === 0, toolCalls };
  try {
    return { content: JSON.parse(raw), parseError: false, toolCalls };
  } catch {
    return { content: null, parseError: true, toolCalls };
  }
}
```

- [ ] **Step 5: Run — expect PASS. Commit.**

```bash
git add src/shared/providers/types.ts src/shared/providers/comparable.ts test/unit/comparable.test.ts
git commit -m "feat: provider interface + comparable extraction"
```

---

### Task 13: Mock provider + DO inference client

**Files:**
- Create: `src/shared/providers/mock.ts`, `src/shared/providers/do-inference.ts`
- Test: `test/unit/do-inference.test.ts`, `test/unit/mock-provider.test.ts`

- [ ] **Step 1: Implement `src/shared/providers/mock.ts`**

```ts
import { ModelProvider, ProviderChatRequest, ProviderChatResponse } from './types.js';

/** Deterministic provider for tests/demo. Maps modelName -> canned JSON content. */
export class MockProvider implements ModelProvider {
  constructor(private responses: Record<string, unknown>, private latencyMs = 1) {}
  async chat(modelName: string, _req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const payload = this.responses[modelName] ?? { echo: modelName };
    return { choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) } }] };
  }
}
```

- [ ] **Step 2: Write the failing test `test/unit/mock-provider.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../src/shared/providers/mock.js';

describe('MockProvider', () => {
  it('returns canned JSON content per model', async () => {
    const p = new MockProvider({ A: { a: 1 }, B: { a: 2 } });
    const r = await p.chat('A', { messages: [] });
    expect(JSON.parse(r.choices[0].message.content!)).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 3: Run — expect PASS** (implementation already written; this verifies it).

- [ ] **Step 4: Write the failing test `test/unit/do-inference.test.ts`** (mock `fetch`)

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DOInferenceProvider } from '../../src/shared/providers/do-inference.js';

afterEach(() => vi.restoreAllMocks());

describe('DOInferenceProvider', () => {
  it('POSTs to /chat/completions with bearer auth', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ));
    const p = new DOInferenceProvider('https://x/v1', 'key', 30000, fetchMock as any);
    const r = await p.chat('model-x', { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.choices[0].message.content).toBe('{"ok":true}');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x/v1/chat/completions');
    expect((init as any).headers.Authorization).toBe('Bearer key');
    expect(JSON.parse((init as any).body).model).toBe('model-x');
  });

  it('throws on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    const p = new DOInferenceProvider('https://x/v1', 'key', 30000, fetchMock as any);
    await expect(p.chat('m', { messages: [] })).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 5: Run — expect FAIL.**

- [ ] **Step 6: Implement `src/shared/providers/do-inference.ts`**

```ts
import { ModelProvider, ProviderChatRequest, ProviderChatResponse } from './types.js';

type FetchFn = typeof fetch;

export class DOInferenceProvider implements ModelProvider {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private timeoutMs: number,
    private fetchFn: FetchFn = fetch
  ) {}

  async chat(modelName: string, req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: modelName, ...req }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`DO inference error ${res.status}: ${await res.text()}`);
      return (await res.json()) as ProviderChatResponse;
    } finally {
      clearTimeout(t);
    }
  }
}
```

- [ ] **Step 7: Run — expect PASS. Commit.**

```bash
git add src/shared/providers/mock.ts src/shared/providers/do-inference.ts test/unit/mock-provider.test.ts test/unit/do-inference.test.ts
git commit -m "feat: mock + DO inference providers"
```

---

## Phase 3 — Heuristic engine

### Task 14: Heuristic types + JSON utils

**Files:**
- Create: `src/shared/heuristics/types.ts`, `src/shared/heuristics/json-utils.ts`
- Test: `test/unit/json-utils.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { flatten, levenshteinRatio, jaccard } from '../../src/shared/heuristics/json-utils.js';

describe('json-utils', () => {
  it('flattens nested objects to dot paths', () => {
    expect(flatten({ a: 1, b: { c: 'x' }, d: [1, 2] }))
      .toEqual({ a: 1, 'b.c': 'x', 'd.0': 1, 'd.1': 2 });
  });
  it('levenshtein ratio: identical = 1, disjoint < 1', () => {
    expect(levenshteinRatio('abc', 'abc')).toBe(1);
    expect(levenshteinRatio('abc', 'abd')).toBeCloseTo(2 / 3);
    expect(levenshteinRatio('', '')).toBe(1);
  });
  it('jaccard token overlap', () => {
    expect(jaccard('the cat', 'the cat')).toBe(1);
    expect(jaccard('the cat', 'the dog')).toBeCloseTo(1 / 3);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/heuristics/types.ts`**

```ts
import { Comparable, Verdict } from '../types.js';

export interface RuleContext { options: Record<string, unknown>; }

export interface RuleResult { score: number; details: Record<string, unknown>; }

export interface HeuristicRule {
  name: string;
  evaluate(primary: Comparable, candidate: Comparable, ctx: RuleContext): RuleResult;
}

export interface EvaluationResult {
  ruleScores: Record<string, { score: number; weight: number; details: Record<string, unknown> }>;
  composite: number;     // 0..1
  verdict: Verdict;
}
```

- [ ] **Step 4: Implement `src/shared/heuristics/json-utils.ts`**

```ts
import { Json } from '../types.js';

export function flatten(value: Json, prefix = ''): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value);
    for (const [k, v] of entries) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') Object.assign(out, flatten(v as Json, path));
      else out[path] = v as Json;
    }
  } else if (prefix) {
    out[prefix] = value;
  }
  return out;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return dp[m][n];
}

export function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

export function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(/\s+/).filter(Boolean));
  const sb = new Set(b.split(/\s+/).filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return inter / union;
}
```

- [ ] **Step 5: Run — expect PASS. Commit.**

```bash
git add src/shared/heuristics/types.ts src/shared/heuristics/json-utils.ts test/unit/json-utils.test.ts
git commit -m "feat: heuristic types + json utils"
```

---

### Task 15: Structural rule

**Files:**
- Create: `src/shared/heuristics/rules/structural.ts`
- Test: `test/unit/rule-structural.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { structuralRule } from '../../src/shared/heuristics/rules/structural.js';
import { Comparable } from '../../src/shared/types.js';

const cmp = (content: any, parseError = false): Comparable => ({ content, parseError, toolCalls: [] });

describe('structuralRule', () => {
  it('scores 1 for same shape and types', () => {
    const r = structuralRule.evaluate(cmp({ a: 1, b: 's' }), cmp({ a: 9, b: 't' }), { options: {} });
    expect(r.score).toBe(1);
  });
  it('penalizes missing/extra keys', () => {
    const r = structuralRule.evaluate(cmp({ a: 1, b: 2 }), cmp({ a: 1 }), { options: {} });
    expect(r.score).toBeLessThan(1);
  });
  it('scores 0 when candidate failed to parse', () => {
    const r = structuralRule.evaluate(cmp({ a: 1 }), cmp(null, true), { options: {} });
    expect(r.score).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/heuristics/rules/structural.ts`**

```ts
import { HeuristicRule, RuleResult } from '../types.js';
import { flatten } from '../json-utils.js';
import { Json } from '../../types.js';

function typeOf(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export const structuralRule: HeuristicRule = {
  name: 'structural',
  evaluate(primary, candidate): RuleResult {
    if (candidate.parseError || candidate.content === null) {
      return { score: 0, details: { reason: 'candidate parse error' } };
    }
    const p = flatten(primary.content ?? {});
    const c = flatten(candidate.content ?? {});
    const keys = new Set([...Object.keys(p), ...Object.keys(c)]);
    if (keys.size === 0) return { score: 1, details: { keys: 0 } };
    let matches = 0;
    for (const k of keys) {
      if (k in p && k in c && typeOf(p[k]) === typeOf(c[k])) matches++;
    }
    return { score: matches / keys.size, details: { matches, total: keys.size } };
  }
};
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/heuristics/rules/structural.ts test/unit/rule-structural.test.ts
git commit -m "feat: structural heuristic rule"
```

---

### Task 16: Exact-match rule

**Files:**
- Create: `src/shared/heuristics/rules/exact-match.ts`
- Test: `test/unit/rule-exact-match.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { exactMatchRule } from '../../src/shared/heuristics/rules/exact-match.js';
import { Comparable } from '../../src/shared/types.js';
const cmp = (content: any, parseError = false): Comparable => ({ content, parseError, toolCalls: [] });

describe('exactMatchRule', () => {
  it('1 when all scalar fields equal', () => {
    expect(exactMatchRule.evaluate(cmp({ a: 1, b: 'x' }), cmp({ a: 1, b: 'x' }), { options: {} }).score).toBe(1);
  });
  it('ratio of equal fields', () => {
    const r = exactMatchRule.evaluate(cmp({ a: 1, b: 'x' }), cmp({ a: 1, b: 'y' }), { options: {} });
    expect(r.score).toBe(0.5);
  });
  it('0 on parse error', () => {
    expect(exactMatchRule.evaluate(cmp({ a: 1 }), cmp(null, true), { options: {} }).score).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/heuristics/rules/exact-match.ts`**

```ts
import { HeuristicRule, RuleResult } from '../types.js';
import { flatten } from '../json-utils.js';

export const exactMatchRule: HeuristicRule = {
  name: 'exact-match',
  evaluate(primary, candidate): RuleResult {
    if (candidate.parseError || candidate.content === null) return { score: 0, details: { reason: 'parse error' } };
    const p = flatten(primary.content ?? {});
    const c = flatten(candidate.content ?? {});
    const keys = Object.keys(p);
    if (keys.length === 0) return { score: 1, details: { fields: 0 } };
    let equal = 0;
    for (const k of keys) if (k in c && JSON.stringify(p[k]) === JSON.stringify(c[k])) equal++;
    return { score: equal / keys.length, details: { equal, total: keys.length } };
  }
};
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/heuristics/rules/exact-match.ts test/unit/rule-exact-match.test.ts
git commit -m "feat: exact-match heuristic rule"
```

---

### Task 17: Text-similarity rule

**Files:**
- Create: `src/shared/heuristics/rules/text-similarity.ts`
- Test: `test/unit/rule-text-similarity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { textSimilarityRule } from '../../src/shared/heuristics/rules/text-similarity.js';
import { Comparable } from '../../src/shared/types.js';
const cmp = (content: any): Comparable => ({ content, parseError: false, toolCalls: [] });

describe('textSimilarityRule', () => {
  it('1 for identical strings', () => {
    expect(textSimilarityRule.evaluate(cmp({ s: 'hello world' }), cmp({ s: 'hello world' }), { options: {} }).score).toBe(1);
  });
  it('partial for near strings', () => {
    const r = textSimilarityRule.evaluate(cmp({ s: 'hello world' }), cmp({ s: 'hello there' }), { options: {} });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });
  it('1 when there are no string fields (nothing to compare)', () => {
    expect(textSimilarityRule.evaluate(cmp({ a: 1 }), cmp({ a: 1 }), { options: {} }).score).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/heuristics/rules/text-similarity.ts`**

```ts
import { HeuristicRule, RuleResult } from '../types.js';
import { flatten, levenshteinRatio } from '../json-utils.js';

export const textSimilarityRule: HeuristicRule = {
  name: 'text-similarity',
  evaluate(primary, candidate): RuleResult {
    if (candidate.parseError || candidate.content === null) return { score: 0, details: { reason: 'parse error' } };
    const p = flatten(primary.content ?? {});
    const c = flatten(candidate.content ?? {});
    const strKeys = Object.keys(p).filter((k) => typeof p[k] === 'string');
    if (strKeys.length === 0) return { score: 1, details: { stringFields: 0 } };
    let sum = 0;
    for (const k of strKeys) {
      const cv = typeof c[k] === 'string' ? (c[k] as string) : '';
      sum += levenshteinRatio(p[k] as string, cv);
    }
    return { score: sum / strKeys.length, details: { stringFields: strKeys.length } };
  }
};
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/heuristics/rules/text-similarity.ts test/unit/rule-text-similarity.test.ts
git commit -m "feat: text-similarity heuristic rule"
```

---

### Task 18: Numeric-tolerance rule

**Files:**
- Create: `src/shared/heuristics/rules/numeric-tolerance.ts`
- Test: `test/unit/rule-numeric-tolerance.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { numericToleranceRule } from '../../src/shared/heuristics/rules/numeric-tolerance.js';
import { Comparable } from '../../src/shared/types.js';
const cmp = (content: any): Comparable => ({ content, parseError: false, toolCalls: [] });

describe('numericToleranceRule', () => {
  it('within relative tolerance counts as match', () => {
    const r = numericToleranceRule.evaluate(cmp({ x: 100 }), cmp({ x: 100.5 }), { options: { absTol: 0, relTol: 0.01 } });
    expect(r.score).toBe(1);
  });
  it('outside tolerance fails', () => {
    const r = numericToleranceRule.evaluate(cmp({ x: 100 }), cmp({ x: 130 }), { options: { absTol: 0, relTol: 0.01 } });
    expect(r.score).toBe(0);
  });
  it('1 when no numeric fields', () => {
    expect(numericToleranceRule.evaluate(cmp({ s: 'a' }), cmp({ s: 'b' }), { options: {} }).score).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/heuristics/rules/numeric-tolerance.ts`**

```ts
import { HeuristicRule, RuleResult, RuleContext } from '../types.js';
import { flatten } from '../json-utils.js';

export const numericToleranceRule: HeuristicRule = {
  name: 'numeric-tolerance',
  evaluate(primary, candidate, ctx: RuleContext): RuleResult {
    if (candidate.parseError || candidate.content === null) return { score: 0, details: { reason: 'parse error' } };
    const absTol = Number(ctx.options.absTol ?? 0);
    const relTol = Number(ctx.options.relTol ?? 0.01);
    const p = flatten(primary.content ?? {});
    const c = flatten(candidate.content ?? {});
    const numKeys = Object.keys(p).filter((k) => typeof p[k] === 'number');
    if (numKeys.length === 0) return { score: 1, details: { numericFields: 0 } };
    let ok = 0;
    for (const k of numKeys) {
      const pv = p[k] as number;
      const cv = typeof c[k] === 'number' ? (c[k] as number) : NaN;
      const tol = Math.max(absTol, Math.abs(pv) * relTol);
      if (Math.abs(pv - cv) <= tol) ok++;
    }
    return { score: ok / numKeys.length, details: { ok, total: numKeys.length, absTol, relTol } };
  }
};
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/heuristics/rules/numeric-tolerance.ts test/unit/rule-numeric-tolerance.test.ts
git commit -m "feat: numeric-tolerance heuristic rule"
```

---

### Task 19: Tool-call agreement rule

**Files:**
- Create: `src/shared/heuristics/rules/tool-calls.ts`
- Test: `test/unit/rule-tool-calls.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { toolCallsRule } from '../../src/shared/heuristics/rules/tool-calls.js';
import { Comparable, ToolCall } from '../../src/shared/types.js';
const tc = (name: string, args: object): ToolCall => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
const cmp = (toolCalls: ToolCall[]): Comparable => ({ content: null, parseError: false, toolCalls });

describe('toolCallsRule', () => {
  it('1 when same tools + args', () => {
    const r = toolCallsRule.evaluate(cmp([tc('search', { q: 'x' })]), cmp([tc('search', { q: 'x' })]), { options: {} });
    expect(r.score).toBe(1);
  });
  it('partial when args differ', () => {
    const r = toolCallsRule.evaluate(cmp([tc('search', { q: 'x' })]), cmp([tc('search', { q: 'y' })]), { options: {} });
    expect(r.score).toBe(0.5); // name matches, args do not
  });
  it('1 when neither side calls tools', () => {
    expect(toolCallsRule.evaluate(cmp([]), cmp([]), { options: {} }).score).toBe(1);
  });
  it('0 when primary calls a tool candidate omits', () => {
    expect(toolCallsRule.evaluate(cmp([tc('a', {})]), cmp([]), { options: {} }).score).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/heuristics/rules/tool-calls.ts`**

```ts
import { HeuristicRule, RuleResult } from '../types.js';
import { ToolCall } from '../../types.js';

function canonicalArgs(a: string): string {
  try { return JSON.stringify(JSON.parse(a)); } catch { return a; }
}

export const toolCallsRule: HeuristicRule = {
  name: 'tool-calls',
  evaluate(primary, candidate): RuleResult {
    const p = primary.toolCalls, c = candidate.toolCalls;
    if (p.length === 0 && c.length === 0) return { score: 1, details: { calls: 0 } };

    // Score per primary tool call: 0.5 for name match, +0.5 for args match. Average over max(len).
    const used = new Set<number>();
    let total = 0;
    for (const pc of p) {
      let best = 0; let bestIdx = -1;
      c.forEach((cc, i) => {
        if (used.has(i)) return;
        let s = 0;
        if (cc.function.name === pc.function.name) {
          s = 0.5 + (canonicalArgs(cc.function.arguments) === canonicalArgs(pc.function.arguments) ? 0.5 : 0);
        }
        if (s > best) { best = s; bestIdx = i; }
      });
      if (bestIdx >= 0) used.add(bestIdx);
      total += best;
    }
    const denom = Math.max(p.length, c.length);
    return { score: total / denom, details: { primaryCalls: p.length, candidateCalls: c.length } };
  }
};
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/heuristics/rules/tool-calls.ts test/unit/rule-tool-calls.test.ts
git commit -m "feat: tool-call agreement heuristic rule"
```

---

### Task 20: Engine (registry + composite + verdict)

**Files:**
- Create: `src/shared/heuristics/engine.ts`
- Test: `test/unit/engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { runEngine, ALL_RULES } from '../../src/shared/heuristics/engine.js';
import { DEFAULT_CONFIG } from '../../src/shared/config/dynamic.js';
import { Comparable } from '../../src/shared/types.js';
const cmp = (content: any): Comparable => ({ content, parseError: false, toolCalls: [] });

describe('runEngine', () => {
  it('registers all five rules', () => {
    expect(Object.keys(ALL_RULES).sort()).toEqual(
      ['exact-match', 'numeric-tolerance', 'structural', 'text-similarity', 'tool-calls']);
  });
  it('identical content -> composite 1 -> pass', () => {
    const r = runEngine(cmp({ a: 1, b: 'x' }), cmp({ a: 1, b: 'x' }), DEFAULT_CONFIG.heuristics);
    expect(r.composite).toBe(1);
    expect(r.verdict).toBe('pass');
  });
  it('divergent content -> fail', () => {
    const r = runEngine(cmp({ a: 1, b: 'hello world' }), cmp({ a: 999, b: 'totally different' }), DEFAULT_CONFIG.heuristics);
    expect(r.composite).toBeLessThan(DEFAULT_CONFIG.heuristics.verdictThreshold);
    expect(r.verdict).toBe('fail');
  });
  it('skips disabled rules', () => {
    const cfg = structuredClone(DEFAULT_CONFIG.heuristics);
    cfg.rules['text-similarity'].enabled = false;
    const r = runEngine(cmp({ a: 1 }), cmp({ a: 1 }), cfg);
    expect(r.ruleScores['text-similarity']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/heuristics/engine.ts`**

```ts
import { HeuristicRule, EvaluationResult } from './types.js';
import { Comparable } from '../types.js';
import { DynamicConfig } from '../config/dynamic.js';
import { structuralRule } from './rules/structural.js';
import { exactMatchRule } from './rules/exact-match.js';
import { textSimilarityRule } from './rules/text-similarity.js';
import { numericToleranceRule } from './rules/numeric-tolerance.js';
import { toolCallsRule } from './rules/tool-calls.js';

export const ALL_RULES: Record<string, HeuristicRule> = {
  [structuralRule.name]: structuralRule,
  [exactMatchRule.name]: exactMatchRule,
  [textSimilarityRule.name]: textSimilarityRule,
  [numericToleranceRule.name]: numericToleranceRule,
  [toolCallsRule.name]: toolCallsRule
};

export function runEngine(
  primary: Comparable,
  candidate: Comparable,
  cfg: DynamicConfig['heuristics']
): EvaluationResult {
  const ruleScores: EvaluationResult['ruleScores'] = {};
  let weighted = 0, totalWeight = 0;

  for (const [name, rc] of Object.entries(cfg.rules)) {
    if (!rc.enabled) continue;
    const rule = ALL_RULES[name];
    if (!rule) continue;
    const res = rule.evaluate(primary, candidate, { options: rc.options });
    ruleScores[name] = { score: res.score, weight: rc.weight, details: res.details };
    weighted += res.score * rc.weight;
    totalWeight += rc.weight;
  }

  const composite = totalWeight > 0 ? weighted / totalWeight : 0;
  return { ruleScores, composite, verdict: composite >= cfg.verdictThreshold ? 'pass' : 'fail' };
}
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/heuristics/engine.ts test/unit/engine.test.ts
git commit -m "feat: heuristic engine (registry + composite + verdict)"
```

---

## Phase 4 — Sampling + Queue

### Task 21: Sampling

**Files:**
- Create: `src/shared/sampling/sampling.ts`
- Test: `test/unit/sampling.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { shouldSample } from '../../src/shared/sampling/sampling.js';
import { DEFAULT_CONFIG } from '../../src/shared/config/dynamic.js';

const cfg = (over: any = {}) => ({ ...DEFAULT_CONFIG.sampling, ...over });

describe('shouldSample', () => {
  it('force header always samples', () => {
    expect(shouldSample(cfg({ rate: 0 }), { model: 'm', route: '/v1/chat', forced: true }, () => 0.99)).toBe(true);
  });
  it('rate=0 never samples', () => {
    expect(shouldSample(cfg({ rate: 0 }), { model: 'm', route: '/v1/chat', forced: false }, () => 0)).toBe(false);
  });
  it('rate=1 always samples', () => {
    expect(shouldSample(cfg({ rate: 1 }), { model: 'm', route: '/v1/chat', forced: false }, () => 0.999)).toBe(true);
  });
  it('model override beats global', () => {
    const c = cfg({ rate: 0, overrides: { model: { m: 1 }, route: {} } });
    expect(shouldSample(c, { model: 'm', route: '/v1/chat', forced: false }, () => 0.5)).toBe(true);
  });
  it('draw below rate samples', () => {
    expect(shouldSample(cfg({ rate: 0.3 }), { model: 'm', route: '/x', forced: false }, () => 0.29)).toBe(true);
    expect(shouldSample(cfg({ rate: 0.3 }), { model: 'm', route: '/x', forced: false }, () => 0.31)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/sampling/sampling.ts`**

```ts
import { DynamicConfig } from '../config/dynamic.js';

type Sampling = DynamicConfig['sampling'];
export interface SampleInput { model: string; route: string; forced: boolean; }

export function shouldSample(
  sampling: Sampling,
  input: SampleInput,
  rng: () => number = Math.random
): boolean {
  if (input.forced) return true;
  const rate =
    sampling.overrides.model[input.model] ??
    sampling.overrides.route[input.route] ??
    sampling.rate;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return rng() < rate;
}
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/sampling/sampling.ts test/unit/sampling.test.ts
git commit -m "feat: sampling decision (overrides + force header)"
```

---

### Task 22: BullMQ queue wiring

**Files:**
- Create: `src/shared/queue/queue.ts`

(No unit test — exercised by integration tests. Thin wrapper over BullMQ.)

- [ ] **Step 1: Implement `src/shared/queue/queue.ts`**

```ts
import { Queue, Worker, JobsOptions, ConnectionOptions } from 'bullmq';

export const QUEUE_NAME = 'evaluations';
export interface EvalJob { evalId: string; }

/** Parse a redis:// URL into BullMQ connection options. (ioredis options don't
 *  accept a `url` field, so passing one would silently connect to localhost
 *  regardless of REDIS_URL.) maxRetriesPerRequest=null is required by BullMQ. */
export function createConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null
  } as ConnectionOptions;
}

export function createQueue(redisUrl: string): Queue<EvalJob> {
  return new Queue<EvalJob>(QUEUE_NAME, { connection: createConnection(redisUrl) });
}

export function defaultJobOpts(attempts: number, backoffMs: number): JobsOptions {
  return {
    attempts,
    backoff: { type: 'exponential', delay: backoffMs },
    removeOnComplete: 1000,
    removeOnFail: 1000
  };
}

/** evalId is the jobId -> automatic dedup/idempotency. */
export async function enqueueEval(
  queue: Queue<EvalJob>, evalId: string, opts: JobsOptions
): Promise<void> {
  await queue.add('evaluate', { evalId }, { ...opts, jobId: evalId });
}

export { Worker };
```

- [ ] **Step 2: Build to typecheck**

Run: `npm run build`
Expected: compiles (note: `Worker` re-export is used in Task 27).

- [ ] **Step 3: Commit**

```bash
git add src/shared/queue/queue.ts
git commit -m "feat: BullMQ queue wiring (jobId = evalId)"
```

---

## Phase 5 — API service

### Task 23: Stats SQL aggregates

**Files:**
- Create: `src/shared/stats/stats.ts`
- Test: `test/integration/stats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../src/shared/db/evaluations.repo.js';
import { getStats } from '../../src/shared/stats/stats.js';

let pool: Pool; let stop: () => Promise<void>;

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool;
  stop = async () => { await pool.end(); await pg.container.stop(); };
  const rr = new RequestsRepo(pool); const er = new EvaluationsRepo(pool);
  await rr.insert({ requestId: 'r1', primaryModel: 'p', messages: [], primaryResponse: {}, primaryLatencyMs: 100, sampled: true });
  await er.enqueue({ evalId: 'e1', requestId: 'r1', candidateModel: 'candidate-claude' });
  await er.markRunning('e1');
  await er.complete('e1', { candidateResponse: {}, ruleScores: {}, compositeScore: 0.9, verdict: 'pass', candidateLatencyMs: 150 });
  await er.enqueue({ evalId: 'e2', requestId: 'r1', candidateModel: 'candidate-mistral' });
  await er.markRunning('e2');
  await er.complete('e2', { candidateResponse: {}, ruleScores: {}, compositeScore: 0.4, verdict: 'fail', candidateLatencyMs: 200 });
});
afterAll(() => stop());

describe('getStats', () => {
  it('aggregates per candidate', async () => {
    const s = await getStats(pool);
    const claude = s.perCandidate.find((c) => c.candidate_model === 'candidate-claude')!;
    expect(claude.completed).toBe(1);
    expect(Number(claude.pass_rate)).toBeCloseTo(1);
    expect(Number(claude.avg_composite)).toBeCloseTo(0.9);
    expect(s.statusBreakdown.completed).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/shared/stats/stats.ts`**

```ts
import { Pool } from 'pg';

export interface CandidateStats {
  candidate_model: string;
  total: number; completed: number; failed: number;
  pass_rate: number; avg_composite: number;
  avg_candidate_latency_ms: number; avg_primary_latency_ms: number;
}
export interface Stats {
  perCandidate: CandidateStats[];
  statusBreakdown: Record<string, number>;
  effectiveSampleRate: number;
}

export async function getStats(pool: Pool): Promise<Stats> {
  const perCandidate = await pool.query(`
    SELECT e.candidate_model,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE e.status='completed')::int AS completed,
           COUNT(*) FILTER (WHERE e.status='failed')::int AS failed,
           COALESCE(AVG((e.verdict='pass')::int) FILTER (WHERE e.status='completed'),0) AS pass_rate,
           COALESCE(AVG(e.composite_score) FILTER (WHERE e.status='completed'),0) AS avg_composite,
           COALESCE(AVG(e.candidate_latency_ms) FILTER (WHERE e.status='completed'),0) AS avg_candidate_latency_ms,
           COALESCE(AVG(r.primary_latency_ms),0) AS avg_primary_latency_ms
    FROM evaluations e JOIN requests r ON r.request_id = e.request_id
    GROUP BY e.candidate_model
    ORDER BY e.candidate_model`);

  const status = await pool.query(`SELECT status, COUNT(*)::int AS n FROM evaluations GROUP BY status`);
  const statusBreakdown: Record<string, number> = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const row of status.rows) statusBreakdown[row.status] = row.n;

  const sampled = await pool.query(`
    SELECT COALESCE(AVG((sampled)::int),0) AS rate FROM requests`);

  return {
    perCandidate: perCandidate.rows,
    statusBreakdown,
    effectiveSampleRate: Number(sampled.rows[0].rate)
  };
}
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/shared/stats/stats.ts test/integration/stats.test.ts
git commit -m "feat: dashboard stats aggregates"
```

---

### Task 24: Auth helpers

**Files:**
- Create: `src/api/auth.ts`
- Test: `test/unit/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { checkAdmin, checkRequestAuth } from '../../src/api/auth.js';

describe('auth', () => {
  it('admin requires matching key', () => {
    expect(checkAdmin('secret', { authorization: 'Bearer secret' })).toBe(true);
    expect(checkAdmin('secret', { authorization: 'Bearer nope' })).toBe(false);
    expect(checkAdmin('secret', {})).toBe(false);
  });
  it('request auth is open when AUTH_KEY unset', () => {
    expect(checkRequestAuth(undefined, {})).toBe(true);
  });
  it('request auth enforced when AUTH_KEY set', () => {
    expect(checkRequestAuth('k', { authorization: 'Bearer k' })).toBe(true);
    expect(checkRequestAuth('k', {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/api/auth.ts`**

```ts
type Headers = Record<string, string | string[] | undefined>;

function bearer(headers: Headers): string | null {
  const h = headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  if (!v?.startsWith('Bearer ')) return null;
  return v.slice('Bearer '.length);
}

export function checkAdmin(adminKey: string, headers: Headers): boolean {
  return bearer(headers) === adminKey;
}

export function checkRequestAuth(authKey: string | undefined, headers: Headers): boolean {
  if (!authKey) return true;       // open when unset
  return bearer(headers) === authKey;
}
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/api/auth.ts test/unit/auth.test.ts
git commit -m "feat: api auth helpers"
```

---

### Task 25: Fastify app + dependency wiring

**Files:**
- Create: `src/api/app.ts`
- Test: covered by `test/integration/api.test.ts` (Task 31). Build-only here.

- [ ] **Step 1: Implement `src/api/app.ts`**

```ts
import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { Env } from '../shared/config/env.js';
import { Catalog } from '../shared/config/catalog.js';
import { ConfigService } from '../shared/config/service.js';
import { ModelProvider } from '../shared/providers/types.js';
import { EvalJob } from '../shared/queue/queue.js';
import { registerChatRoute } from './routes/chat.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerLookupRoutes } from './routes/lookup.js';
import { registerStatsRoutes } from './routes/stats.js';

export interface AppDeps {
  env: Env;
  pool: Pool;
  queue: Queue<EvalJob>;
  catalog: Catalog;
  configService: ConfigService;
  provider: ModelProvider;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get('/healthz', async () => ({ ok: true }));
  registerChatRoute(app, deps);
  registerConfigRoutes(app, deps);
  registerLookupRoutes(app, deps);
  registerStatsRoutes(app, deps);
  return app;
}
```

- [ ] **Step 2: Build — expect FAIL** (route modules not created yet). This task intentionally precedes the route tasks to lock the `AppDeps` contract; do not commit until Task 29 compiles. Proceed to Task 26.

---

### Task 26: POST /v1/chat

**Files:**
- Create: `src/api/routes/chat.ts`

- [ ] **Step 1: Implement `src/api/routes/chat.ts`**

```ts
import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { AppDeps } from '../app.js';
import { ChatRequest } from '../../shared/types.js';
import { checkRequestAuth } from '../auth.js';
import { shouldSample } from '../../shared/sampling/sampling.js';
import { RequestsRepo } from '../../shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../shared/db/evaluations.repo.js';
import { enqueueEval, defaultJobOpts } from '../../shared/queue/queue.js';

export function registerChatRoute(app: FastifyInstance, deps: AppDeps): void {
  const requestsRepo = new RequestsRepo(deps.pool);
  const evalsRepo = new EvaluationsRepo(deps.pool);

  app.post('/v1/chat', async (req, reply) => {
    if (!checkRequestAuth(deps.env.AUTH_KEY, req.headers as any)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body as ChatRequest;
    if (!body?.model || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: 'model and messages are required' });
    }
    if (!deps.catalog.has(body.model)) {
      return reply.code(400).send({ error: `unknown model: ${body.model}` });
    }
    const { config } = await deps.configService.get();
    const candidates = (body.candidates ?? config.defaultCandidates).filter((c) => c !== body.model);
    for (const c of candidates) {
      if (!deps.catalog.has(c)) return reply.code(400).send({ error: `unknown candidate: ${c}` });
    }

    // Call primary synchronously.
    const start = Date.now();
    let primaryResponse;
    try {
      primaryResponse = await deps.provider.chat(deps.catalog.resolve(body.model), {
        messages: body.messages, tools: body.tools, response_format: body.response_format, temperature: body.temperature
      });
    } catch (err) {
      return reply.code(502).send({ error: 'primary model call failed', detail: String(err) });
    }
    const primaryLatencyMs = Date.now() - start;

    const requestId = uuid();
    const forced = String(req.headers[config.sampling.forceHeader] ?? '') === 'force';
    const sampled = candidates.length > 0 &&
      shouldSample(config.sampling, { model: body.model, route: '/v1/chat', forced });

    await requestsRepo.insert({
      requestId, primaryModel: body.model, messages: body.messages,
      primaryResponse: primaryResponse as any, primaryLatencyMs, sampled
    });

    if (sampled) {
      const opts = defaultJobOpts(deps.env.JOB_ATTEMPTS, deps.env.JOB_BACKOFF_MS);
      for (const candidate of candidates) {
        const evalId = uuid();
        await evalsRepo.enqueue({ evalId, requestId, candidateModel: candidate });
        try {
          await enqueueEval(deps.queue, evalId, opts);
        } catch (err) {
          req.log.error({ err }, 'failed to enqueue eval job (best-effort)');
        }
      }
    }

    reply.header('x-request-id', requestId);
    return reply.send(primaryResponse);
  });
}
```

- [ ] **Step 2: Build** (still needs config/lookup/stats routes). Continue to Task 27.

---

### Task 27: GET/PUT /v1/config

**Files:**
- Create: `src/api/routes/config.ts`

- [ ] **Step 1: Implement `src/api/routes/config.ts`**

```ts
import { FastifyInstance } from 'fastify';
import { AppDeps } from '../app.js';
import { checkAdmin } from '../auth.js';
import { DynamicConfigSchema } from '../../shared/config/dynamic.js';

export function registerConfigRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/config', async () => {
    const { version, config } = await deps.configService.get();
    return { version, config };
  });

  app.put('/v1/config', async (req, reply) => {
    if (!checkAdmin(deps.env.ADMIN_KEY, req.headers as any)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body as { expectedVersion?: number; config?: unknown };
    if (typeof body?.expectedVersion !== 'number') {
      return reply.code(400).send({ error: 'expectedVersion (number) required' });
    }
    const parsed = DynamicConfigSchema.safeParse(body.config);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid config', issues: parsed.error.issues });
    }
    const newVersion = await deps.configService.update(parsed.data, body.expectedVersion);
    if (newVersion === null) {
      return reply.code(409).send({ error: 'stale version' });
    }
    return { version: newVersion };
  });
}
```

- [ ] **Step 2: Build. Continue to Task 28.**

---

### Task 28: Lookup routes (requests / evaluations)

**Files:**
- Create: `src/api/routes/lookup.ts`

- [ ] **Step 1: Implement `src/api/routes/lookup.ts`**

```ts
import { FastifyInstance } from 'fastify';
import { AppDeps } from '../app.js';
import { RequestsRepo } from '../../shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../shared/db/evaluations.repo.js';

export function registerLookupRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requestsRepo = new RequestsRepo(deps.pool);
  const evalsRepo = new EvaluationsRepo(deps.pool);

  app.get('/v1/requests/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const request = await requestsRepo.get(id);
    if (!request) return reply.code(404).send({ error: 'request not found' });
    const evaluations = await evalsRepo.byRequest(id);
    return { request, evaluations };
  });

  app.get('/v1/evaluations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await evalsRepo.get(id);
    if (!row) return reply.code(404).send({ error: 'evaluation not found' });
    return row;
  });
}
```

- [ ] **Step 2: Build. Continue to Task 29.**

---

### Task 29: Stats route + dashboard route

**Files:**
- Create: `src/api/routes/stats.ts`

- [ ] **Step 1: Implement `src/api/routes/stats.ts`**

```ts
import { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { AppDeps } from '../app.js';
import { getStats } from '../../shared/stats/stats.js';

export function registerStatsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/stats', async () => getStats(deps.pool));

  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html');
    return readFileSync('public/dashboard.html', 'utf8');
  });
}
```

- [ ] **Step 2: Build the whole project**

Run: `npm run build`
Expected: PASS (all `AppDeps` consumers now exist).

- [ ] **Step 3: Commit the API layer**

```bash
git add src/api/app.ts src/api/routes/chat.ts src/api/routes/config.ts src/api/routes/lookup.ts src/api/routes/stats.ts
git commit -m "feat: api routes (chat, config, lookup, stats) + app wiring"
```

---

### Task 30: API server entrypoint

**Files:**
- Create: `src/api/server.ts`

- [ ] **Step 1: Implement `src/api/server.ts`**

```ts
import { loadEnv } from '../shared/config/env.js';
import { loadCatalogFromFile } from '../shared/config/catalog.js';
import { createPool, applySchema } from '../shared/db/pool.js';
import { ConfigRepo } from '../shared/db/config.repo.js';
import { ConfigService } from '../shared/config/service.js';
import { DOInferenceProvider } from '../shared/providers/do-inference.js';
import { createQueue } from '../shared/queue/queue.js';
import { buildApp } from './app.js';

async function main() {
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);
  await applySchema(pool);
  const catalog = loadCatalogFromFile(env.CATALOG_PATH);
  const configService = new ConfigService(new ConfigRepo(pool), env.CONFIG_CACHE_TTL_MS);
  await configService.get(); // seed defaults if empty
  const provider = new DOInferenceProvider(env.DO_INFERENCE_BASE_URL, env.DO_INFERENCE_KEY, env.MODEL_TIMEOUT_MS);
  const queue = createQueue(env.REDIS_URL);

  const app = buildApp({ env, pool, queue, catalog, configService, provider });
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Build. Commit.**

```bash
git add src/api/server.ts
git commit -m "feat: api server entrypoint"
```

---

## Phase 6 — Worker

### Task 31: Job processor

**Files:**
- Create: `src/worker/processor.ts`
- Test: `test/integration/worker.test.ts`

- [ ] **Step 1: Write the failing test `test/integration/worker.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../src/shared/db/evaluations.repo.js';
import { ConfigRepo } from '../../src/shared/db/config.repo.js';
import { ConfigService } from '../../src/shared/config/service.js';
import { loadCatalog } from '../../src/shared/config/catalog.js';
import { MockProvider } from '../../src/shared/providers/mock.js';
import { processJob } from '../../src/worker/processor.js';

let pool: Pool; let stop: () => Promise<void>;

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool;
  stop = async () => { await pool.end(); await pg.container.stop(); };
});
afterAll(() => stop());

describe('processJob', () => {
  it('runs heuristics and completes the eval', async () => {
    const rr = new RequestsRepo(pool), er = new EvaluationsRepo(pool);
    await rr.insert({
      requestId: 'wr1', primaryModel: 'primary', messages: [], primaryLatencyMs: 10, sampled: true,
      primaryResponse: { choices: [{ message: { role: 'assistant', content: '{"answer":42}' } }] }
    });
    await er.enqueue({ evalId: 'we1', requestId: 'wr1', candidateModel: 'cand' });

    const provider = new MockProvider({ CAND: { answer: 42 } }); // identical -> pass
    const catalog = loadCatalog({ models: { cand: { inferenceName: 'CAND' } } });
    const cfgService = new ConfigService(new ConfigRepo(pool), 5000);

    const deps = { pool, provider, catalog, configService: cfgService, requestsRepo: rr, evalsRepo: er, timeoutMs: 30000 };
    await processJob('we1', deps as any);

    const row = await er.get('we1');
    expect(row?.status).toBe('completed');
    expect(row?.verdict).toBe('pass');
    expect(Number(row?.composite_score)).toBeGreaterThan(0.8);
  });

  it('marks failed when candidate call throws', async () => {
    const rr = new RequestsRepo(pool), er = new EvaluationsRepo(pool);
    await rr.insert({ requestId: 'wr2', primaryModel: 'primary', messages: [], primaryLatencyMs: 10, sampled: true,
      primaryResponse: { choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] } });
    await er.enqueue({ evalId: 'we2', requestId: 'wr2', candidateModel: 'cand' });

    const provider = { chat: async () => { throw new Error('boom'); } };
    const catalog = loadCatalog({ models: { cand: { inferenceName: 'CAND' } } });
    const cfgService = new ConfigService(new ConfigRepo(pool), 5000);
    const deps = { pool, provider, catalog, configService: cfgService, requestsRepo: rr, evalsRepo: er, timeoutMs: 30000 };

    await expect(processJob('we2', deps as any)).rejects.toThrow('boom'); // rethrow so BullMQ retries
    const row = await er.get('we2');
    expect(row?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/worker/processor.ts`**

```ts
import { Pool } from 'pg';
import { Catalog } from '../shared/config/catalog.js';
import { ConfigService } from '../shared/config/service.js';
import { ModelProvider, ProviderChatResponse } from '../shared/providers/types.js';
import { extractComparable } from '../shared/providers/comparable.js';
import { runEngine } from '../shared/heuristics/engine.js';
import { RequestsRepo } from '../shared/db/requests.repo.js';
import { EvaluationsRepo } from '../shared/db/evaluations.repo.js';

export interface ProcessorDeps {
  pool: Pool;
  provider: ModelProvider;
  catalog: Catalog;
  configService: ConfigService;
  requestsRepo: RequestsRepo;
  evalsRepo: EvaluationsRepo;
}

export async function processJob(evalId: string, deps: ProcessorDeps): Promise<void> {
  const evalRow = await deps.evalsRepo.get(evalId);
  if (!evalRow) return;                       // nothing to do
  if (evalRow.status === 'completed') return; // idempotent: already done

  await deps.evalsRepo.markRunning(evalId);
  const request = await deps.requestsRepo.get(evalRow.request_id);
  if (!request) { await deps.evalsRepo.fail(evalId, 'request not found'); return; }

  try {
    const start = Date.now();
    const candidateResp = await deps.provider.chat(
      deps.catalog.resolve(evalRow.candidate_model),
      { messages: request.messages, response_format: undefined }
    );
    const candidateLatencyMs = Date.now() - start;

    const { config } = await deps.configService.get();
    const primary = extractComparable(request.primary_response as ProviderChatResponse);
    const candidate = extractComparable(candidateResp);
    const result = runEngine(primary, candidate, config.heuristics);

    await deps.evalsRepo.complete(evalId, {
      candidateResponse: candidateResp as any,
      ruleScores: result.ruleScores as any,
      compositeScore: result.composite,
      verdict: result.verdict,
      candidateLatencyMs
    });
  } catch (err) {
    await deps.evalsRepo.fail(evalId, String(err));
    throw err; // rethrow so BullMQ records the attempt and retries
  }
}
```

- [ ] **Step 4: Run — expect PASS. Commit.**

```bash
git add src/worker/processor.ts test/integration/worker.test.ts
git commit -m "feat: worker job processor"
```

---

### Task 32: Worker entrypoint

**Files:**
- Create: `src/worker/worker.ts`

- [ ] **Step 1: Implement `src/worker/worker.ts`**

```ts
import { Worker } from 'bullmq';
import { loadEnv } from '../shared/config/env.js';
import { loadCatalogFromFile } from '../shared/config/catalog.js';
import { createPool, applySchema } from '../shared/db/pool.js';
import { ConfigRepo } from '../shared/db/config.repo.js';
import { ConfigService } from '../shared/config/service.js';
import { DOInferenceProvider } from '../shared/providers/do-inference.js';
import { RequestsRepo } from '../shared/db/requests.repo.js';
import { EvaluationsRepo } from '../shared/db/evaluations.repo.js';
import { QUEUE_NAME, EvalJob, createConnection } from '../shared/queue/queue.js';
import { processJob, ProcessorDeps } from './processor.js';

async function main() {
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);
  await applySchema(pool);
  const deps: ProcessorDeps = {
    pool,
    provider: new DOInferenceProvider(env.DO_INFERENCE_BASE_URL, env.DO_INFERENCE_KEY, env.MODEL_TIMEOUT_MS),
    catalog: loadCatalogFromFile(env.CATALOG_PATH),
    configService: new ConfigService(new ConfigRepo(pool), env.CONFIG_CACHE_TTL_MS),
    requestsRepo: new RequestsRepo(pool),
    evalsRepo: new EvaluationsRepo(pool)
  };

  const worker = new Worker<EvalJob>(
    QUEUE_NAME,
    async (job) => { await processJob(job.data.evalId, deps); },
    { connection: createConnection(env.REDIS_URL), concurrency: env.WORKER_CONCURRENCY }
  );

  worker.on('failed', (job, err) => console.error(`job ${job?.id} failed:`, err.message));
  console.log(`worker up, concurrency=${env.WORKER_CONCURRENCY}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Build. Commit.**

```bash
git add src/worker/worker.ts
git commit -m "feat: worker entrypoint"
```

---

## Phase 7 — Integration tests (cross-cutting)

### Task 33: API integration test (mocked provider, in-memory queue spy)

**Files:**
- Test: `test/integration/api.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { startPg, startRedis } from '../helpers/testcontainers.js';
import { loadCatalog } from '../../src/shared/config/catalog.js';
import { ConfigRepo } from '../../src/shared/db/config.repo.js';
import { ConfigService } from '../../src/shared/config/service.js';
import { MockProvider } from '../../src/shared/providers/mock.js';
import { createQueue } from '../../src/shared/queue/queue.js';
import { buildApp } from '../../src/api/app.js';
import { EvaluationsRepo } from '../../src/shared/db/evaluations.repo.js';

let pool: Pool; let queue: Queue; let stop: () => Promise<void>; let app: any;
const env: any = { ADMIN_KEY: 'admin', AUTH_KEY: undefined, JOB_ATTEMPTS: 1, JOB_BACKOFF_MS: 10, PORT: 0 };

beforeAll(async () => {
  const pg = await startPg(); const redis = await startRedis();
  pool = pg.pool; queue = createQueue(redis.url);
  const catalog = loadCatalog({ models: { 'primary-llama': { inferenceName: 'P' }, 'candidate-claude': { inferenceName: 'C' } } });
  const configService = new ConfigService(new ConfigRepo(pool), 5000);
  await configService.get();
  const provider = new MockProvider({ P: { answer: 1 }, C: { answer: 1 } });
  app = buildApp({ env, pool, queue, catalog, configService, provider });
  await app.ready();
  stop = async () => { await app.close(); await queue.close(); await pool.end(); await pg.container.stop(); await redis.container.stop(); };
});
afterAll(() => stop());

describe('POST /v1/chat', () => {
  it('returns primary response + x-request-id, force-samples and enqueues an eval', async () => {
    const res = await supertest(app.server)
      .post('/v1/chat')
      .set('x-shadow-eval', 'force')
      .send({ model: 'primary-llama', messages: [{ role: 'user', content: 'hi' }], candidates: ['candidate-claude'] });
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(JSON.parse(res.body.choices[0].message.content)).toEqual({ answer: 1 });

    const evals = await new EvaluationsRepo(pool).byRequest(res.headers['x-request-id']);
    expect(evals.length).toBe(1);
    expect(evals[0].status).toBe('queued');
  });

  it('400 on unknown model', async () => {
    const res = await supertest(app.server).post('/v1/chat').send({ model: 'nope', messages: [] });
    expect(res.status).toBe(400);
  });

  it('GET /v1/requests/:id returns request + evaluations', async () => {
    const post = await supertest(app.server).post('/v1/chat').set('x-shadow-eval', 'force')
      .send({ model: 'primary-llama', messages: [{ role: 'user', content: 'q' }], candidates: ['candidate-claude'] });
    const id = post.headers['x-request-id'];
    const res = await supertest(app.server).get(`/v1/requests/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.request.request_id).toBe(id);
    expect(res.body.evaluations.length).toBe(1);
  });

  it('PUT /v1/config requires admin and bumps version', async () => {
    const cur = await supertest(app.server).get('/v1/config');
    const noauth = await supertest(app.server).put('/v1/config').send({ expectedVersion: cur.body.version, config: cur.body.config });
    expect(noauth.status).toBe(401);
    const ok = await supertest(app.server).put('/v1/config').set('authorization', 'Bearer admin')
      .send({ expectedVersion: cur.body.version, config: cur.body.config });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(cur.body.version + 1);
  });

  it('rate=0 and no force -> not sampled (no evals)', async () => {
    // set rate 0 via admin
    const cur = await supertest(app.server).get('/v1/config');
    const cfg = structuredClone(cur.body.config); cfg.sampling.rate = 0;
    await supertest(app.server).put('/v1/config').set('authorization', 'Bearer admin')
      .send({ expectedVersion: cur.body.version, config: cfg });
    const res = await supertest(app.server).post('/v1/chat')
      .send({ model: 'primary-llama', messages: [{ role: 'user', content: 'q' }], candidates: ['candidate-claude'] });
    const evals = await new EvaluationsRepo(pool).byRequest(res.headers['x-request-id']);
    expect(evals.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect PASS** (`Run: npm run test:integration -- api`).

- [ ] **Step 3: Commit**

```bash
git add test/integration/api.test.ts
git commit -m "test: api integration (chat/lookup/config/sampling)"
```

---

### Task 34: End-to-end queue + worker + idempotency

**Files:**
- Test: `test/integration/idempotency.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { startPg, startRedis } from '../helpers/testcontainers.js';
import { createQueue, enqueueEval, defaultJobOpts, QUEUE_NAME, createConnection } from '../../src/shared/queue/queue.js';
import { RequestsRepo } from '../../src/shared/db/requests.repo.js';
import { EvaluationsRepo } from '../../src/shared/db/evaluations.repo.js';
import { ConfigRepo } from '../../src/shared/db/config.repo.js';
import { ConfigService } from '../../src/shared/config/service.js';
import { loadCatalog } from '../../src/shared/config/catalog.js';
import { MockProvider } from '../../src/shared/providers/mock.js';
import { processJob } from '../../src/worker/processor.js';
import { Worker } from 'bullmq';

let pool: Pool; let queue: Queue; let stop: () => Promise<void>; let redisUrl: string;

beforeAll(async () => {
  const pg = await startPg(); const redis = await startRedis();
  pool = pg.pool; redisUrl = redis.url; queue = createQueue(redisUrl);
  stop = async () => { await queue.close(); await pool.end(); await pg.container.stop(); await redis.container.stop(); };
});
afterAll(() => stop());

describe('queue + worker e2e', () => {
  it('processes an enqueued eval to completed, and double-enqueue stays single', async () => {
    const rr = new RequestsRepo(pool), er = new EvaluationsRepo(pool);
    await rr.insert({ requestId: 'ir1', primaryModel: 'p', messages: [], primaryLatencyMs: 5, sampled: true,
      primaryResponse: { choices: [{ message: { role: 'assistant', content: '{"x":1}' } }] } });
    await er.enqueue({ evalId: 'ie1', requestId: 'ir1', candidateModel: 'cand' });
    // duplicate enqueue (same request/candidate) is ignored by DB unique constraint
    await er.enqueue({ evalId: 'ie1-dup', requestId: 'ir1', candidateModel: 'cand' });
    expect((await er.byRequest('ir1')).length).toBe(1);

    const deps = {
      pool, provider: new MockProvider({ CAND: { x: 1 } }),
      catalog: loadCatalog({ models: { cand: { inferenceName: 'CAND' } } }),
      configService: new ConfigService(new ConfigRepo(pool), 5000),
      requestsRepo: rr, evalsRepo: er
    } as any;

    const worker = new Worker(QUEUE_NAME, async (job) => processJob(job.data.evalId, deps),
      { connection: createConnection(redisUrl), concurrency: 2 });

    await enqueueEval(queue, 'ie1', defaultJobOpts(1, 10));
    await enqueueEval(queue, 'ie1', defaultJobOpts(1, 10)); // same jobId -> dedup

    // wait for completion
    await new Promise<void>((resolve) => {
      const t = setInterval(async () => {
        const row = await er.get('ie1');
        if (row?.status === 'completed') { clearInterval(t); resolve(); }
      }, 100);
    });

    const row = await er.get('ie1');
    expect(row?.status).toBe('completed');
    expect(row?.attempts).toBe(1); // processed once despite duplicate enqueue
    await worker.close();
  });
});
```

- [ ] **Step 2: Run — expect PASS.**

- [ ] **Step 3: Commit**

```bash
git add test/integration/idempotency.test.ts
git commit -m "test: queue+worker e2e and idempotency"
```

---

### Task 35: Config propagation integration test

**Files:**
- Test: `test/integration/config-propagation.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPg } from '../helpers/testcontainers.js';
import { ConfigRepo } from '../../src/shared/db/config.repo.js';
import { ConfigService } from '../../src/shared/config/service.js';

let pool: Pool; let stop: () => Promise<void>;
beforeAll(async () => { const pg = await startPg(); pool = pg.pool; stop = async () => { await pool.end(); await pg.container.stop(); }; });
afterAll(() => stop());

describe('config propagation across instances', () => {
  it('writer updates; second reader sees it after TTL', async () => {
    let now = 0;
    const writer = new ConfigService(new ConfigRepo(pool), 1000, () => now);
    const reader = new ConfigService(new ConfigRepo(pool), 1000, () => now);

    const initial = await reader.get();           // version 1, cached in reader
    const cfg = structuredClone(initial.config); cfg.sampling.rate = 0.99;
    const v = await writer.update(cfg, initial.version);
    expect(v).toBe(initial.version + 1);

    expect((await reader.get()).config.sampling.rate).not.toBe(0.99); // still cached
    now += 2000;                                   // expire TTL
    expect((await reader.get()).config.sampling.rate).toBe(0.99);     // re-read from PG
  });
});
```

- [ ] **Step 2: Run — expect PASS.**

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all unit + integration tests PASS.

- [ ] **Step 4: Commit**

```bash
git add test/integration/config-propagation.test.ts
git commit -m "test: dynamic config propagation across instances"
```

---

## Phase 8 — UI, Docker, docs

### Task 36: Simple dashboard page

**Files:**
- Create: `public/dashboard.html`

Keep it minimal: one HTML file, vanilla JS, polls `/v1/stats` every 3s, renders a per-candidate table + status counts, plus a request-lookup box. No build step, no framework.

- [ ] **Step 1: Write `public/dashboard.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Shadow LLM Evaluator</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; color: #1a1a1a; }
    h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 28px; }
    table { border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: right; font-variant-numeric: tabular-nums; }
    th:first-child, td:first-child { text-align: left; }
    .pills span { display: inline-block; padding: 4px 10px; margin-right: 8px; border-radius: 12px; background: #eef; }
    input { padding: 6px; width: 340px; } button { padding: 6px 12px; }
    pre { background: #f6f6f6; padding: 12px; overflow:auto; max-height: 360px; }
  </style>
</head>
<body>
  <h1>Shadow LLM Evaluator</h1>

  <h2>Status</h2>
  <div class="pills" id="status"></div>
  <div>Effective sample rate: <b id="rate">–</b></div>

  <h2>Candidate performance</h2>
  <table id="candidates">
    <thead><tr>
      <th>Candidate</th><th>Total</th><th>Completed</th><th>Failed</th>
      <th>Pass rate</th><th>Avg composite</th><th>Cand latency (ms)</th><th>Primary latency (ms)</th>
    </tr></thead>
    <tbody></tbody>
  </table>

  <h2>Request lookup</h2>
  <input id="rid" placeholder="paste request id (X-Request-Id)" />
  <button onclick="lookup()">Look up</button>
  <pre id="lookup"></pre>

  <script>
    const pct = (x) => (Number(x) * 100).toFixed(1) + '%';
    const num = (x) => Number(x).toFixed(0);

    async function refresh() {
      const s = await (await fetch('/v1/stats')).json();
      document.getElementById('rate').textContent = pct(s.effectiveSampleRate);
      document.getElementById('status').innerHTML = Object.entries(s.statusBreakdown)
        .map(([k, v]) => `<span>${k}: <b>${v}</b></span>`).join('');
      document.querySelector('#candidates tbody').innerHTML = s.perCandidate.map((c) => `
        <tr><td>${c.candidate_model}</td><td>${c.total}</td><td>${c.completed}</td><td>${c.failed}</td>
        <td>${pct(c.pass_rate)}</td><td>${Number(c.avg_composite).toFixed(3)}</td>
        <td>${num(c.avg_candidate_latency_ms)}</td><td>${num(c.avg_primary_latency_ms)}</td></tr>`).join('');
    }
    async function lookup() {
      const id = document.getElementById('rid').value.trim();
      if (!id) return;
      const res = await fetch('/v1/requests/' + id);
      document.getElementById('lookup').textContent = JSON.stringify(await res.json(), null, 2);
    }
    refresh(); setInterval(refresh, 3000);
  </script>
</body>
</html>
```

- [ ] **Step 2: Manual smoke (optional, after Task 38 compose):** open `http://localhost:8080/`, confirm the table renders.

- [ ] **Step 3: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: simple polling dashboard"
```

---

### Task 37: Dockerfile

**Files:**
- Create: `docker/Dockerfile`, `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
dist
.git
test
*.log
```

- [ ] **Step 2: Create `docker/Dockerfile`** (multi-stage; one image, two commands)

```dockerfile
# --- build ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY config ./config
COPY db ./db
COPY public ./public
# default command is the API; compose overrides for the worker
CMD ["node", "dist/api/server.js"]
```

- [ ] **Step 3: Validate the Dockerfile** (Docker is unavailable in this dev shell — do NOT run `docker build`)

Run: `test -s docker/Dockerfile && grep -q 'CMD \["node", "dist/api/server.js"\]' docker/Dockerfile && echo OK`
Expected: `OK`. (The image builds wherever Docker exists; it is a shipped artifact, not used to run/test here.)

- [ ] **Step 4: Commit**

```bash
git add docker/Dockerfile .dockerignore
git commit -m "build: multi-stage Dockerfile"
```

---

### Task 38: Full docker-compose (api + worker + postgres + redis)

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Replace `docker-compose.yml` with the full stack**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: shadow
      POSTGRES_PASSWORD: shadow
      POSTGRES_DB: shadow
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shadow"]
      interval: 3s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 3s
      retries: 10

  api:
    build: { context: ., dockerfile: docker/Dockerfile }
    command: ["node", "dist/api/server.js"]
    environment:
      PORT: 8080
      DATABASE_URL: postgres://shadow:shadow@postgres:5432/shadow
      REDIS_URL: redis://redis:6379
      DO_INFERENCE_BASE_URL: ${DO_INFERENCE_BASE_URL}
      DO_INFERENCE_KEY: ${DO_INFERENCE_KEY}
      ADMIN_KEY: ${ADMIN_KEY:-admin-secret}
      AUTH_KEY: ${AUTH_KEY:-}
    ports: ["8080:8080"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

  worker:
    build: { context: ., dockerfile: docker/Dockerfile }
    command: ["node", "dist/worker/worker.js"]
    environment:
      DATABASE_URL: postgres://shadow:shadow@postgres:5432/shadow
      REDIS_URL: redis://redis:6379
      DO_INFERENCE_BASE_URL: ${DO_INFERENCE_BASE_URL}
      DO_INFERENCE_KEY: ${DO_INFERENCE_KEY}
      WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-5}
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
```

- [ ] **Step 2: Validate the compose file** (Docker is unavailable here — do NOT run `docker compose up`)

Run: `python3 -c "import yaml,sys; d=yaml.safe_load(open('docker-compose.yml')); print(sorted(d['services']))"`
Expected: `['api', 'postgres', 'redis', 'worker']`. (Compose runs wherever Docker exists; in this shell the service runs natively — see README "Run natively".)

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "build: full local docker-compose stack"
```

---

### Task 39: README + architecture diagram

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write `README.md`** (replace the stub)

````markdown
# Shadow LLM Evaluator

Serves a **primary** LLM via `/v1/chat` and, on a sampled fraction of requests, shadow-evaluates
**candidate** models against it using a deterministic, pluggable heuristic engine. Results are
persisted to Postgres and shown on a simple real-time dashboard. Models are served via
**DigitalOcean serverless inference** (OpenAI-compatible). Runs locally via Docker Compose.

## Architecture

```mermaid
flowchart LR
  client[Client] -->|POST /v1/chat| api[API service]
  api -->|primary call| do[(DO serverless inference)]
  api -->|insert request + queued eval| pg[(Postgres)]
  api -->|enqueue jobId=evalId| redis[(Redis / BullMQ)]
  redis --> worker[Worker]
  worker -->|candidate call| do
  worker -->|heuristic engine + update eval| pg
  api -->|/v1/stats, /v1/requests/:id| dash[Dashboard]
```

## Request lifecycle
1. `POST /v1/chat` → API generates `requestId`, calls the primary, returns it immediately with
   `X-Request-Id`.
2. If the request is sampled, the API inserts one `queued` eval row per candidate and enqueues a
   BullMQ job (`jobId = evalId`).
3. The worker calls the candidate, runs the heuristic engine, and updates the eval row to
   `completed` (or `failed` after retries).
4. Track a request at `GET /v1/requests/:requestId`; watch aggregates on the dashboard (`/`).

## Run locally (Docker)
```bash
cp .env.example .env          # set DO_INFERENCE_KEY (and base URL)
docker compose up --build -d
curl localhost:8080/healthz
open http://localhost:8080/    # dashboard
```

## Run natively (no Docker)
For environments without Docker. Requires local Postgres + Redis.
```bash
# one-time: install + start services, create the db
sudo apt-get install -y postgresql redis-server
sudo service postgresql start && sudo service redis-server start
sudo -u postgres psql -c "CREATE ROLE shadow LOGIN PASSWORD 'shadow' CREATEDB" \
                      -c "CREATE DATABASE shadow OWNER shadow"

cp .env.example .env          # set DO_INFERENCE_KEY; DATABASE_URL/REDIS_URL already point at localhost
npm install && npm run build
npm run start:api &           # http://localhost:8080
npm run start:worker &
curl localhost:8080/healthz
```

### Example request
```bash
curl -s localhost:8080/v1/chat -H 'content-type: application/json' \
  -H 'x-shadow-eval: force' \
  -d '{"model":"primary-llama","messages":[{"role":"user","content":"Return {\"answer\":42} as JSON"}],
       "candidates":["candidate-claude"],"response_format":{"type":"json_object"}}'
```

## Configuration
- **Static** (env / `.env`): connection strings, `DO_INFERENCE_*`, `ADMIN_KEY`, optional `AUTH_KEY`.
- **Dynamic** (runtime, via `GET/PUT /v1/config`): sampling rate + overrides, default candidates,
  heuristic rules/weights/thresholds. Stored versioned in Postgres; read with a ~5s cache.
- **Model catalog**: `config/models.json` (supported model id → DO inference name).

## Heuristic engine
Pluggable rules in `src/shared/heuristics/rules/` (structural, exact-match, text-similarity,
numeric-tolerance, tool-calls). The engine combines enabled rules by weight into a composite
`0–1` score and a pass/fail verdict. Add a dimension = add one rule file + register it.

## Scaling
Stateless API + N BullMQ workers share Postgres/Redis. Demo locally:
```bash
docker compose up -d --scale api=2 --scale worker=3
```

## Tests
```bash
npm run test:unit          # pure logic, no external services
npm run test:integration   # uses local Postgres + Redis (override TEST_DATABASE_URL / TEST_REDIS_URL)
npm test                   # everything
```
Integration tests create an isolated database per test file against the local Postgres and flush
the local Redis, so they need Postgres + Redis reachable (the "Run natively" services suffice).
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README + architecture diagram"
```

---

## Self-Review (completed against the spec)

**Spec coverage check:**
- §1 goal, §3 topology → Tasks 25–32, 37–38. ✓
- §4 data model (`requests`/`evaluations`/`config`, `UNIQUE(request_id, candidate_model)`) → Task 8. ✓
- §5 flow + status lifecycle + `X-Request-Id` + `/v1/requests/:id` → Tasks 26, 28, 31. ✓
- §6 heuristic engine (all five rules + composite + verdict + parse_error) → Tasks 14–20. ✓
- §7 config (static + dynamic, `GET/PUT /v1/config`, TTL cache, optimistic concurrency, seed) → Tasks 5, 7, 11, 27. ✓
- §8 sampling (rate + overrides + force header) → Task 21. ✓
- §9 stats + dashboard (no Prometheus) → Tasks 23, 29, 36. ✓
- §10 scalability (jobId=evalId idempotency, upsert/conflict, shared state) → Tasks 10, 22, 34. ✓
- §11 error handling (candidate fail→failed+retry, primary fail→502, unknown model→400, parse_error, redis down best-effort, stale config→409, auth→401) → Tasks 24, 26, 27, 31. ✓
- §12 testing (unit + integration matrix) → Tasks 33–35 + per-feature tests. ✓
- §13 running locally (compose, Dockerfile, README, diagram) → Tasks 37–39. ✓

**Placeholder scan:** none — every code step contains complete code.

**Type consistency:** `EvalStatus`/`Verdict` from `types.ts` used consistently; `AppDeps`/`ProcessorDeps` field names match across api/worker; repo method names (`enqueue`, `markRunning`, `complete`, `fail`, `get`, `byRequest`) consistent between definition (Task 10) and callers (Tasks 26, 28, 31, 33–35); `runEngine` signature consistent (Tasks 20, 31).

**Known sequencing note:** Tasks 25–29 build incrementally and the project only fully compiles at Task 29 Step 2 (`AppDeps` consumers all present). This is intentional to lock the `AppDeps` contract first; the single commit lands at Task 29 Step 3.
