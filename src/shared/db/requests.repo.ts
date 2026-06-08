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
