import type { Octokit } from 'octokit';
import { parse } from 'yaml';
import { db } from './service.js';

export async function repositoryInventory(github: Octokit) {
  const installations = await github.paginate(github.rest.apps.listInstallationsForAuthenticatedUser, { per_page: 100 });
  const repositories = [];
  const installationsByRepository = new Map<number, string>();

  for (const installation of installations) {
    if (installation.suspended_at) continue;
    const visible = await github.paginate(github.rest.apps.listInstallationReposForAuthenticatedUser, {
      installation_id: installation.id,
      per_page: 100,
    });
    for (const repository of visible) {
      if (!repository.permissions?.pull) continue;
      repositories.push(repository);
      installationsByRepository.set(repository.id, String(installation.id));
    }
  }

  if (!repositories.length) return [];

  const { rows } = await db.query<{
    id: string; github_repo_id: string; installation_id: string; approved_policy: string; baseline_sha: string;
  }>(
    'SELECT id, github_repo_id, installation_id, approved_policy, baseline_sha FROM repos WHERE github_repo_id = ANY($1::bigint[])',
    [Array.from(installationsByRepository.keys())],
  );
  const enrolled = new Map(rows.map(row => [row.github_repo_id, row]));

  return repositories.map(repository => {
    const row = enrolled.get(String(repository.id));
    const enrollment = row && row.installation_id === installationsByRepository.get(repository.id)
      ? { id: row.id, baseline: row.baseline_sha, ...policySummary(row.approved_policy) }
      : null;
    return {
      owner: repository.owner.login,
      name: repository.name,
      defaultBranch: repository.default_branch,
      administrator: repository.permissions?.admin === true,
      enrollment,
      needsRelink: Boolean(row && !enrollment),
    };
  }).sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
}

function policySummary(source: string) {
  const policy = parse(source, { maxAliasCount: 0 });
  const rules = policy.rules.map((rule: { path: string; mode: string; allow: string[]; stub?: string }) => ({
    path: rule.path,
    mode: rule.mode,
    groups: rule.allow,
    stub: rule.stub ?? null,
  }));
  return { organization: policy.org, rules };
}
