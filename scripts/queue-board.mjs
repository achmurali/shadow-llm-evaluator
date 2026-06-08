// Standalone Bull Board dashboard for the BullMQ "evaluations" queue.
// Run: node --env-file-if-exists=.env scripts/queue-board.mjs   (default port 8082)
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import express from 'express';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const u = new URL(REDIS_URL);
const connection = {
  host: u.hostname,
  port: Number(u.port || 6379),
  username: u.username || undefined,
  password: u.password || undefined,
  db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
  maxRetriesPerRequest: null
};

const queue = new Queue('evaluations', { connection });

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/');
createBullBoard({ queues: [new BullMQAdapter(queue)], serverAdapter });

const app = express();
app.use('/', serverAdapter.getRouter());

const port = Number(process.env.BOARD_PORT || 8082);
app.listen(port, '0.0.0.0', () => console.log(`bull-board listening on http://0.0.0.0:${port}`));
