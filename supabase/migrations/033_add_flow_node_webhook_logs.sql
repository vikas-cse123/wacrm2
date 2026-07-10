-- 033_add_flow_node_webhook_logs.sql
CREATE TABLE flow_node_webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  flow_id UUID NOT NULL,
  node_id TEXT NOT NULL,
  contact_id UUID,
  phone_number TEXT,
  url TEXT NOT NULL,
  payload JSONB NOT NULL,
  status_code INT,
  response_body TEXT,
  success BOOLEAN,
  error TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON flow_node_webhook_logs (account_id, flow_id, created_at DESC);
ALTER TABLE flow_node_webhook_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "account members can view own webhook logs"
  ON flow_node_webhook_logs FOR SELECT
  USING (account_id IN (SELECT account_id FROM profiles WHERE id = auth.uid()));