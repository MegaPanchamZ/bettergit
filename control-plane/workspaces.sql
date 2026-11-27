BEGIN;
CREATE TABLE workspaces (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 parent_repo_id bigint NOT NULL REFERENCES repos,
 name text NOT NULL,
 github_repo_id bigint UNIQUE,
 repo_name text NOT NULL,
 creator_id bigint NOT NULL REFERENCES users,
 allowed_users jsonb NOT NULL DEFAULT '[]',
 allowed_ids jsonb NOT NULL DEFAULT '[]',
 explicit_ids jsonb NOT NULL DEFAULT '[]',
 group_ids jsonb NOT NULL DEFAULT '[]',
 revoked_ids jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','blocked','archived')),
 checked_at timestamptz,
 retry_after timestamptz NOT NULL DEFAULT now(),
 issue text,
 archive_requested boolean NOT NULL DEFAULT false,
 member_sources jsonb NOT NULL DEFAULT '{}',
 UNIQUE(parent_repo_id,name)
);
ALTER TABLE shadow_repos ADD COLUMN workspace_id bigint REFERENCES workspaces;
INSERT INTO workspaces(parent_repo_id,name,github_repo_id,repo_name,creator_id,allowed_users,allowed_ids,explicit_ids,status)
 SELECT parent_repo_id,branch_name||'-'||id,github_repo_id,repo_name,creator_id,allowed_users,allowed_ids,allowed_ids,
 CASE WHEN status IN ('ready','published') THEN 'pending' ELSE 'archived' END FROM shadow_repos;
UPDATE shadow_repos s SET workspace_id=w.id FROM workspaces w WHERE w.repo_name=s.repo_name AND w.parent_repo_id=s.parent_repo_id;
ALTER TABLE shadow_repos ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX workspace_reconciliation ON workspaces(retry_after) WHERE status<>'archived';
CREATE TABLE workspace_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id bigint NOT NULL REFERENCES workspaces,
 actor_id bigint REFERENCES users,
 action text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
