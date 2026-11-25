BEGIN;
CREATE TABLE users (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, github_id bigint UNIQUE NOT NULL, github_username text NOT NULL, age_public_key text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE repos (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, github_repo_id bigint UNIQUE NOT NULL, org_name text NOT NULL, repo_name text NOT NULL, installation_id bigint NOT NULL, approved_policy text NOT NULL, baseline_sha text NOT NULL);
CREATE TABLE groups (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, repo_id bigint NOT NULL REFERENCES repos, name text NOT NULL, github_team_slug text NOT NULL, UNIQUE(repo_id,name));
CREATE TABLE wrapped_deks (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, group_id bigint NOT NULL REFERENCES groups, user_id bigint NOT NULL REFERENCES users, encrypted_dek_blob text NOT NULL, key_version integer NOT NULL CHECK(key_version>0), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(group_id,user_id,key_version));
CREATE TABLE audit_logs (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint REFERENCES users, repo_id bigint NOT NULL REFERENCES repos, group_id bigint REFERENCES groups, action text NOT NULL CHECK(action IN ('DEK_FETCH','KEY_ROTATE','ACCESS_REVOKED')), ip_address inet, timestamp timestamptz NOT NULL DEFAULT now());
CREATE TABLE webhook_deliveries (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
COMMIT;
