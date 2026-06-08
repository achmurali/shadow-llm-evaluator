import { Queue, Worker, JobsOptions, ConnectionOptions } from 'bullmq';

export const QUEUE_NAME = 'evaluations';
export interface EvalJob { evalId: string; }

/** BullMQ requires maxRetriesPerRequest=null on the connection it owns. */
export function createConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null } as ConnectionOptions;
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
