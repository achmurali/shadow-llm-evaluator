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
