BEGIN;
CREATE TABLE guard_deliveries (
  id text PRIMARY KEY,
  event text NOT NULL CHECK (event IN ('push','pull_request','merge_group','check_run')),
  payload jsonb,
  attempts integer NOT NULL DEFAULT 0,
  retry_after timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX guard_deliveries_ready ON guard_deliveries(retry_after) WHERE completed_at IS NULL;
COMMIT;
