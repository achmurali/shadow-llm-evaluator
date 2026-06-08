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
