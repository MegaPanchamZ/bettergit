import { Pool } from 'pg';
import { App, Octokit } from 'octokit';
import { z } from 'zod';
export const db = new Pool({ connectionString: process.env.DATABASE_URL });
export const app = new App({ appId: process.env.GITHUB_APP_ID!, privateKey: process.env.GITHUB_PRIVATE_KEY!, webhooks: { secret: process.env.GITHUB_WEBHOOK_SECRET! } });
export async function user(token: string) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret || !/^ghu_[a-zA-Z0-9]+$/.test(token)) throw new Error('unauthorized');
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const { data } = await new Octokit().rest.apps.checkToken({
    client_id: clientId,
    access_token: token,
    headers: { authorization: `Basic ${credentials}` },
  });
  const u = data.user;
  if (data.app.client_id !== clientId || !u?.id || !u.login) throw new Error('unauthorized');
  const github = new Octokit({ auth: token });
  const { rows } = await db.query('INSERT INTO users(github_id,github_username) VALUES($1,$2) ON CONFLICT(github_id) DO UPDATE SET github_username=$2 RETURNING *', [u.id,u.login]);
  return { ...rows[0], github };
}
export async function access(userId: string, groupId: string, admin = false) {
  const { rows } = await db.query('SELECT g.*,r.org_name,r.repo_name,r.installation_id FROM groups g JOIN repos r ON r.id=g.repo_id WHERE g.id=$1', [groupId]);
  const g = rows[0]; if (!g) throw new Error('forbidden');
  const gh = await app.getInstallationOctokit(Number(g.installation_id));
  const { rows: users } = await db.query('SELECT github_username,github_id FROM users WHERE id=$1',[userId]);
  const current=users[0]? await gh.request('GET /user/{account_id}',{account_id:Number(users[0].github_id)}):null;
  const username = current?.data.login; if (!username) throw new Error('forbidden');
  const { data: permission } = await gh.rest.repos.getCollaboratorPermissionLevel({ owner:g.org_name,repo:g.repo_name,username });
  if (admin) { if (permission.permission !== 'admin') throw new Error('forbidden'); }
  else {
    if (!['read','triage','write','maintain','admin'].includes(permission.permission)) throw new Error('forbidden');
    if (!g.github_team_id) throw new Error('group team ID requires verified enrollment');
    const { data: org } = await gh.rest.orgs.get({org:g.org_name});
    const { data: member } = await gh.request('GET /organizations/{org_id}/team/{team_id}/memberships/{username}', {
      org_id: org.id, team_id: Number(g.github_team_id), username,
    });
    if (member.state !== 'active') throw new Error('forbidden');
  }
  return g;
}
export const envelopeSchema = z.object({ userId:z.string().regex(/^\d+$/), version:z.number().int().positive(), envelope:z.string().max(65536).refine(s => {
  const bytes = Buffer.from(s,'base64'); return bytes.toString('base64') === s && bytes.subarray(0,22).toString() === 'age-encryption.org/v1\n';
}) }).strict();
export async function fetchEnvelope(userId:string,groupId:string,ip:string) {
  const g=await access(userId,groupId);
  const client=await db.connect();
  try { await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int,$2::int)',[userId,groupId]);
    const revoked=await client.query('SELECT 1 FROM revocations WHERE user_id=$1 AND group_id=$2',[userId,groupId]);
    if(revoked.rowCount) throw new Error('revoked');
    const {rows}=await client.query('SELECT encrypted_dek_blob,key_version FROM wrapped_deks WHERE group_id=$1 AND user_id=$2 ORDER BY key_version DESC LIMIT 1',[groupId,userId]);
    if (!rows[0]) throw new Error('no envelope');
    await client.query("INSERT INTO audit_logs(user_id,repo_id,group_id,action,ip_address) VALUES($1,$2,$3,'DEK_FETCH',$4)",[userId,g.repo_id,groupId,ip]);
    await client.query('COMMIT'); return rows[0];
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
