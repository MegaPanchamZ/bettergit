BEGIN;
CREATE TABLE shadow_repos (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_repo_id bigint NOT NULL REFERENCES repos, github_repo_id bigint UNIQUE, repo_name text NOT NULL, branch_name text NOT NULL, creator_id bigint NOT NULL REFERENCES users, allowed_users jsonb NOT NULL, allowed_ids jsonb NOT NULL, status text NOT NULL DEFAULT 'provisioning' CHECK(status IN ('provisioning','ready','failed','published')), publish_pr text);
CREATE UNIQUE INDEX active_shadow_name ON shadow_repos(parent_repo_id,branch_name) WHERE status<>'failed';
COMMIT;
