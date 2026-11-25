BEGIN;
CREATE FUNCTION enforce_group_team_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.github_team_id IS NULL OR
     (TG_OP = 'UPDATE' AND OLD.github_team_id IS NOT NULL AND OLD.github_team_id IS DISTINCT FROM NEW.github_team_id) THEN
    RAISE EXCEPTION 'groups require an immutable GitHub team ID';
  END IF;
  RETURN NEW;
END
$$;
-- Existing unbound groups fail authorization until an administrator verifies their ID.
CREATE TRIGGER immutable_group_team_identity
BEFORE INSERT OR UPDATE OF github_team_id ON groups
FOR EACH ROW EXECUTE FUNCTION enforce_group_team_identity();

CREATE TABLE shadow_revocation_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  github_id bigint NOT NULL,
  org_name text NOT NULL,
  repository bigint NOT NULL DEFAULT 0,
  require_parent_access_loss boolean NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  retry_after timestamptz NOT NULL DEFAULT now(),
  UNIQUE (github_id, org_name, repository, require_parent_access_loss)
);
CREATE INDEX shadow_revocation_jobs_ready ON shadow_revocation_jobs(retry_after, id);
COMMIT;
