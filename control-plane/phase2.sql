BEGIN;
ALTER TABLE audit_logs ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
CREATE TABLE revocations (user_id bigint NOT NULL REFERENCES users,group_id bigint NOT NULL REFERENCES groups,revoked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,group_id));
CREATE TABLE ci_policies (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, group_id bigint NOT NULL REFERENCES groups, issuer text NOT NULL, audience text NOT NULL, subject text NOT NULL, required_claims jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE ci_requests (id uuid PRIMARY KEY, policy_id bigint NOT NULL REFERENCES ci_policies, public_key text NOT NULL, oidc_token text NOT NULL, token_id text NOT NULL UNIQUE, encrypted_dek_blob text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, consumed_at timestamptz);
CREATE TABLE offboarding_reports (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL REFERENCES users, repo_id bigint NOT NULL REFERENCES repos, removed_at timestamptz NOT NULL DEFAULT now(), report jsonb NOT NULL);
CREATE FUNCTION immutable_ci_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
IF (NEW.group_id,NEW.issuer,NEW.audience,NEW.subject,NEW.required_claims) IS DISTINCT FROM (OLD.group_id,OLD.issuer,OLD.audience,OLD.subject,OLD.required_claims) THEN RAISE EXCEPTION 'create a new policy revision instead'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_ci_policy BEFORE UPDATE ON ci_policies FOR EACH ROW EXECUTE FUNCTION immutable_ci_policy();
COMMIT;
