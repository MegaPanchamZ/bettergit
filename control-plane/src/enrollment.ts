import { app, db, user } from './service.js';
import { matching } from './guard.js';

export async function enrollRepository(
  account: Awaited<ReturnType<typeof user>>,
  owner: string,
  repo: string,
  expectedHead?: string,
) {
  const { data: repository } = await account.github.rest.repos.get({ owner, repo });
  if (!repository.permissions?.admin) throw new Error('administrator required');
  const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
  const gh = await app.getInstallationOctokit(installation.id);
  const { data: head } = await gh.rest.repos.getCommit({ owner, repo, ref: repository.default_branch });
  if (expectedHead !== undefined && head.sha !== expectedHead) throw new Error('default branch changed');
  const { data: content } = await gh.rest.repos.getContent({ owner, repo, path: '.access.yml', ref: head.sha });
  if (Array.isArray(content) || !('content' in content)) throw new Error('policy missing');
  const policy = Buffer.from(content.content, 'base64').toString();
  await matching(policy, []);
  const conflict = expectedHead === undefined
    ? 'DO UPDATE SET approved_policy=$5,baseline_sha=$6'
    : 'DO NOTHING';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO repos(github_repo_id,org_name,repo_name,installation_id,approved_policy,baseline_sha)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(github_repo_id) ${conflict} RETURNING id`,
    [repository.id, repository.owner.login.toLowerCase(), repository.name, installation.id, policy, head.sha],
  );
  if (!rows[0]) throw new Error('repository already enrolled');
  return rows[0];
}
