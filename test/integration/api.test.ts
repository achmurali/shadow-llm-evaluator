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
