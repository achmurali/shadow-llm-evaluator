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
