import { Queue, Worker, JobsOptions, ConnectionOptions } from 'bullmq';

export const QUEUE_NAME = 'evaluations';
export interface EvalJob { evalId: string; }

/** Parse a redis:// URL into BullMQ connection options.
 *  (ioredis options don't accept a `url` field, so passing one would silently
 *  connect to localhost regardless of REDIS_URL.) maxRetriesPerRequest=null is
 *  required by BullMQ for the connection it owns. */
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
