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
