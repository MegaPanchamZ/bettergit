BEGIN;
-- Resume guard jobs parked by the former ten-attempt cap.
UPDATE guard_deliveries SET failed_at=NULL,attempts=0,retry_after=now()
WHERE event<>'offboarding' AND failed_at IS NOT NULL AND completed_at IS NULL;
COMMIT;
