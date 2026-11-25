BEGIN;
CREATE TABLE guard_verified_commits (
  github_repo_id bigint NOT NULL,
  commit_sha text NOT NULL,
  policy_digest text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(github_repo_id,commit_sha,policy_digest)
);
COMMIT;
