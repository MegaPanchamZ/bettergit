BEGIN;
ALTER TABLE guard_deliveries DROP CONSTRAINT guard_deliveries_event_check;
ALTER TABLE guard_deliveries ADD CHECK (event IN ('push','pull_request','merge_group','check_run','offboarding'));
ALTER TABLE guard_deliveries ADD COLUMN failed_at timestamptz;
ALTER TABLE shadow_revocation_jobs ADD COLUMN failed_at timestamptz;

DROP INDEX guard_deliveries_ready;
CREATE INDEX guard_deliveries_ready ON guard_deliveries(retry_after,id)
  WHERE completed_at IS NULL AND failed_at IS NULL;
DROP INDEX shadow_revocation_jobs_ready;
CREATE INDEX shadow_revocation_jobs_ready ON shadow_revocation_jobs(retry_after,id)
  WHERE failed_at IS NULL;
COMMIT;
