BEGIN;
ALTER TABLE groups ADD COLUMN github_team_id bigint CHECK (github_team_id > 0);
COMMIT;
