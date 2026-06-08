# Shadow LLM Evaluator — Design Spec

**Date:** 2026-06-08
**Status:** Approved for planning

## 1. Goal

A service whose `/v1/chat` endpoint serves a **primary** model synchronously while, on a
**sampled** fraction of requests, asynchronously evaluating one or more **candidate** models
against the primary using a **deterministic, pluggable heuristic engine**. Evaluation results
are persisted to Postgres, queryable per request, and surfaced as **real-time metrics** via a
lightweight built-in dashboard.

The service **runs locally via Docker Compose**. Models are served through **DO serverless
inference** (OpenAI-compatible API, single model-access key) — the one external dependency.
The design is **horizontally scalable** by construction and its operational config is
**runtime-editable** via an endpoint.

Both models are assumed to return valid JSON payloads.

## 2. Tech Stack

- **Language/runtime:** Node.js + TypeScript
- **HTTP framework:** Fastify (schema validation, fast async)
- **Queue:** BullMQ on Redis
- **Database:** PostgreSQL (local container)
- **Model backend:** DigitalOcean serverless inference (OpenAI-compatible). One model-access key.
- **Dashboard:** built-in static page + JSON `/v1/stats` endpoint (aggregates from Postgres). No
  Prometheus/Grafana.
- **Validation:** zod
- **Testing:** Vitest + supertest + testcontainers
- **Packaging:** Docker (multi-stage) + docker-compose
- **Run target:** local Docker Compose (api + worker + postgres + redis). No cloud deploy in v1.

> **Implementation note:** Confirm the exact DO serverless-inference base URL and auth header
> against current DO docs at implementation time; that API is evolving. The provider client is
> an OpenAI-compatible client with a configurable base URL, so swapping a direct OpenAI/Anthropic
> adapter in later is trivial.

## 3. Topology (components)

| Component | Responsibility |
|---|---|
| **API service** (`src/api`) | Serves `/v1/chat`, `/v1/config`, `/v1/requests/:id`, `/v1/evaluations/:id`, `/v1/stats`, the dashboard page, `/healthz`. Calls primary, returns immediately, makes sampling decision, writes request + queued eval rows, enqueues jobs. Stateless. |
| **Worker** (`src/worker`) | BullMQ consumer. Calls the candidate via DO inference, runs the heuristic engine, updates the eval row (status + scores + verdict) in Postgres. |
| **Redis** | BullMQ job queue only. Local container. |
| **Postgres** | `requests`, `evaluations`, and dynamic `config` tables. Local container. |
| **DO serverless inference** | OpenAI-compatible model backend. |

**Repo structure:** single TypeScript package with two entrypoints (`src/api`, `src/worker`)
sharing `src/shared` (types, config, model catalog, provider client, heuristic engine).

```
src/
  api/          # Fastify app + routes + dashboard + entrypoint
  worker/       # BullMQ worker + entrypoint
  shared/
    config/     # ConfigService, zod schemas, static env loader, model catalog
    providers/  # OpenAI-compatible DO inference client + ModelProvider interface
    heuristics/ # HeuristicRule interface, built-in rules, composite scorer
    queue/      # BullMQ queue + job types
    db/         # Postgres client, migrations, repositories
    stats/      # SQL aggregate queries for the dashboard
    types/      # shared domain types
public/
  dashboard.html  # polls /v1/stats + per-request lookup
```

## 4. Data Model

One request → one `requests` row → 0..N `evaluations` rows (one per candidate).

```
requests                         evaluations
─────────                        ───────────
request_id (PK, uuid)  ◀──────┐  eval_id (PK, uuid)
primary_model                 └─ request_id (FK)
primary_response (jsonb)         candidate_model
messages (jsonb)                 status        queued│running│completed│failed
sampled (bool)                   candidate_response (jsonb, null until done)
created_at                       rule_scores (jsonb)   -- per-rule 0..1 + details
                                 composite_score (numeric, null until done)
                                 verdict       pass│fail│null
                                 primary_latency_ms, candidate_latency_ms
                                 attempts, error (text, null)
                                 created_at, started_at, finished_at
                                 UNIQUE(request_id, candidate_model)
```

A separate `config` table holds versioned dynamic config rows (§6).

## 5. Request / Data Flow

```
Client                API service                     Redis(BullMQ)   Worker          Postgres
  │  POST /v1/chat        │                                │            │                │
  │─────────────────────▶│                                │            │                │
  │                       │ 1. requestId = uuid()          │            │                │
  │                       │ 2. call PRIMARY (sync)         │            │                │
  │  primary response     │                                │            │                │
  │  + X-Request-Id       │                                │            │                │
  │◀─────────────────────│                                │            │                │
  │                       │ 3. INSERT requests row ───────────────────────────────────▶│
  │                       │ 4. sampling decision           │            │                │
  │                       │ 5a. INSERT eval row(s)         │            │                │
  │                       │     status=queued, evalId ─────────────────────────────────▶│
  │                       │ 5b. enqueue job, jobId=evalId ▶│            │                │
  │                       │                                │─ job ─────▶│ status=running ▶│
  │                       │                                │            │ call CANDIDATE  │
  │                       │                                │            │ run heuristics  │
  │                       │                                │            │ UPDATE eval ───▶│
  │                       │                                │            │ status=completed│
```

1. **API receives the request**, generates a `requestId` (uuid), returned in the `X-Request-Id`
   response header.
2. **Primary is called synchronously** via DO inference and returned to the client immediately —
   client latency is only the primary call.
3. **Insert the `requests` row** (primary model + response, messages).
4. **Sampling decision** (global rate + per-model/route overrides + force header, §7).
5. **If sampled**, for each candidate:
   - **Insert an `evaluations` row** with its own `evalId`, `status = queued`.
   - **Enqueue a BullMQ job** with `jobId = evalId` (this is the unit of work; dedup is automatic).
   - Enqueue is **best-effort** — a Redis failure is logged and never breaks the client response
     (the row remains `queued` and is visible as such).
   - If *not* sampled, no eval rows / jobs; the `requests` row records `sampled = false`.
6. **Worker** consumes a job (keyed by `evalId`):
   - Sets the eval row `status = running`, `started_at`.
   - Calls the candidate via DO inference (same messages/tools/response_format), measures latency.
   - Runs the heuristic engine (primary vs candidate → per-rule scores, composite, verdict).
   - Updates the row: `status = completed`, candidate response, scores, verdict, latencies,
     `finished_at`.
   - **On failure/timeout**: BullMQ retries with backoff (`attempts` tracked); after the final
     failed attempt → `status = failed` with `error` captured.

### Per-request status tracking

Status lifecycle on each eval row:

```
queued ──▶ running ──▶ completed
                  └──▶ failed
```

- **`GET /v1/requests/:requestId`** → the request plus **all** its candidate evaluations and
  their statuses/scores/verdicts in one response. (`404` if unknown.)
- **`GET /v1/evaluations/:evalId`** → a single candidate evaluation's full detail.

Per-request status is a Postgres lookup (not an aggregate-metrics concern).

## 6. Heuristic Engine (core)

The engine is **pluggable**: each comparison dimension is a self-contained rule.

```ts
interface HeuristicRule {
  name: string;
  evaluate(primary: Json, candidate: Json, ctx: RuleContext): RuleResult;
  // RuleResult = { score: number /* 0..1 */, details: Record<string, unknown> }
}
```

**Built-in rules (all five at launch):**

1. **Structural / schema match** — same key set, nesting, and value types.
2. **Exact field-value match** — per-field scalar equality → field-level agreement ratio.
3. **Text similarity** — normalized Levenshtein / Jaccard token overlap on string fields.
4. **Numeric tolerance** — numeric fields agree within a configurable absolute/relative tolerance.
5. **Tool-call agreement** — same tools invoked, with argument match (handles `tool_calls`).

**Composite scorer:** weighted average of active rule scores → composite `0..1`.
**Verdict:** `pass`/`fail` by a configurable threshold.

Rule set, weights, thresholds, and tolerances are **config-driven** (§ below, runtime-editable).
Adding a new dimension = one new rule file registered in the engine. The engine handles both
message `content` JSON and `tool_calls`. If a candidate returns invalid JSON (despite the
assumption), it is flagged `parse_error` and the structural rule scores 0 rather than crashing.

## 7. Configuration

Two tiers.

**Static / bootstrap (env, immutable at runtime):**
`DO_INFERENCE_BASE_URL`, `DO_INFERENCE_KEY`, `DATABASE_URL`, `REDIS_URL`, ports, `ADMIN_KEY`,
optional `AUTH_KEY`, worker concurrency, per-call timeouts, retry/backoff settings.

**Dynamic (Postgres `config` table, runtime-editable):**
- sampling: global `rate` + per-model / per-route overrides + force-header name
- default candidate set
- heuristic config: enabled rules, weights, thresholds, tolerances

Read through a `ConfigService` that **caches the dynamic config with a short TTL (~5s)** and
re-reads from Postgres on expiry — so edits propagate to every API/worker instance within the
TTL, with no pub/sub. Each update writes a **new versioned row** (durable audit trail). If the
table is empty, the service seeds and serves built-in defaults.

**Endpoints:**
- `GET /v1/config` — current effective dynamic config + version.
- `PUT /v1/config` — **admin-key protected**, zod-validated; writes a new version with
  optimistic concurrency (rejects stale version with `409`).

## 8. Sampling

- Configurable **global rate** (`0.0–1.0`), random per-request draw.
- **Per-model / per-route overrides** layered on the global default.
- **Force header** (e.g. `X-Shadow-Eval: force`) opts a specific request in regardless of rate,
  for testing/demos.
- The `requests.sampled` flag + eval-row counts make the effective rate observable.

## 9. Metrics & Dashboard

No Prometheus/Grafana. Every aggregate is a SQL `GROUP BY` over `requests` / `evaluations`.

- **`GET /v1/stats`** — JSON aggregates computed live from Postgres. **Delivered (v1):** per
  candidate — total / completed / failed counts, pass rate, average composite score, average
  candidate-vs-primary latency; plus a global status breakdown (queued/running/completed/failed)
  and the effective sampling rate. (Candidate error rate is `failed / total`, derivable from the
  per-candidate counts the dashboard already shows.)
- **Future enhancements (not in v1):** per-rule score breakdown, request throughput over time, and
  `?since=` / `?candidate=` query filters. Deferred to keep v1 focused — the delivered aggregates
  already answer "how is each candidate performing vs the primary."
- **`public/dashboard.html`** — a static page served by the API that polls `/v1/stats` every few
  seconds (a plain per-candidate table + status pills) for "real-time" metrics, plus a
  **per-request lookup** box (paste a `requestId` → renders its candidate evals + statuses via
  `/v1/requests/:id`).

One datastore, one UI, no extra containers.

## 10. Scalability

Horizontally scalable by construction:
- **API**: stateless (sampling is a per-request draw). Scales behind a load balancer in a real
  deploy; locally it runs as a single published instance (fixed host port).
- **Worker**: N BullMQ workers share the Redis queue; work distributes automatically. This is the
  horizontally-scalable unit locally — `docker compose up -d --scale worker=N`.
- **All shared state** lives in Postgres + Redis — nothing node-local.
- **Idempotency**: `jobId = evalId` (the eval row is created before enqueue) — a duplicated/retried
  job maps to one row; the worker's status check + single-row update prevents double processing.
- **Dynamic config** is shared via Postgres (§7), so all replicas converge within the cache TTL.
- **Stats** are computed from Postgres on demand, so they're correct regardless of replica count.

## 11. Error Handling / Edge Cases

- **Candidate failure/timeout** → eval row stays `running` across retries (`attempts` incremented);
  BullMQ backoff; after final attempt → `status = failed`, `error` captured. Worker never crashes.
- **Primary failure** → `502` to client, no request/eval rows beyond an optional error log.
- **Unknown model** (`model` or any `candidate` not in catalog) → `400`.
- **Candidate invalid JSON** → graceful `parse_error`; structural rule scores 0.
- **Redis/queue down** → primary response still returns; eval rows remain `queued`; enqueue
  failure logged (best-effort).
- **Stale config version on PUT** → `409`.
- **Missing/invalid auth** → `401` (`/v1/chat` only if `AUTH_KEY` set; `/v1/config` always).

## 12. Testing Strategy

**Unit:**
- Each heuristic rule + edge cases; composite scorer
- Sampling logic (rate, overrides, force header)
- `ConfigService` (TTL cache behavior, zod validation, version-conflict)
- Config + catalog validation
- Provider client (HTTP mocked)
- Stats SQL aggregation helpers

**Integration:**
- API with mocked DO inference: returns primary; writes `requests` row; enqueues + writes
  `queued` eval row on force-sample; skips at `rate=0`
- Worker end-to-end against ephemeral Redis + Postgres (testcontainers) with mock inference →
  eval row transitions `queued → running → completed` with scores/verdict persisted
- `PUT /v1/config` change observed by a second reader after the TTL
- **Idempotency**: re-delivered job (same `evalId`) → single completed row, no double processing
- `GET /v1/requests/:id` returns request + its evals; `GET /v1/stats` returns expected aggregates

**Test models are deterministic mocks** — no real keys/tokens in CI.

## 13. Running Locally

- **`docker-compose.yml`** runs everything locally: api + worker + postgres + redis. Multi-stage
  Dockerfiles.
- A single **`.env`** holds the `DO_INFERENCE_BASE_URL` + `DO_INFERENCE_KEY` (the only external
  dependency) and local Postgres/Redis URLs.
- `docker-compose up` brings up the full stack; migrations run on start.
- Horizontal scaling demoed via `docker compose up -d --scale worker=N` (the worker is the
  scalable unit locally; the API runs as a single published instance and scales behind an LB in a
  real deploy).
- **README**: setup, full env reference, how to run, how to exercise `/v1/chat`, how to read the
  dashboard, scaling instructions.
- **Architecture diagram**: Mermaid in README (+ rendered image).

## 14. Out of Scope (YAGNI for v1)

- **Streaming** (`stream: true`) — full JSON needed to compare; noted as a future extension.
- Auth/multi-tenancy beyond the optional static `AUTH_KEY` + admin key.
- LLM-as-judge / semantic-embedding scoring (requirement is *deterministic* heuristics).
- Prometheus/Grafana / autoscaling / Kubernetes (the design supports scaling; not built for v1).
- **Cloud deployment** (DigitalOcean Droplet, Managed Postgres/Redis) — v1 runs locally only; the
  Compose setup ports to a Droplet later with no code change (swap local DB/Redis URLs for managed
  ones). DO serverless inference is the sole external dependency even locally.
