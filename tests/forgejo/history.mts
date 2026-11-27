import {execFile} from 'node:child_process';
import {createCipheriv, createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);

export function git(cwd: string, login: string, password: string, args: string[]) {
  return exec('git', args, {
    cwd, timeout: 90_000,
    env: {PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'http', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`},
  });
}

const cohorts = {
  small: {files: 80, commits: 12, blobBytes: 128 * 1024},
  medium: {files: 400, commits: 48, blobBytes: 512 * 1024},
  large: {files: 1200, commits: 96, blobBytes: 2 * 1024 * 1024},
};

export async function seedHistory(dir: string, org: string, cohort: keyof typeof cohorts,
  branchNames: string[], run: (args: string[]) => ReturnType<typeof git>
) {
  const {files, commits, blobBytes} = cohorts[cohort];
  const file = (n: number) => join(dir, 'src', `module-${n % 16}`, `file-${n}.ts`);
  const commit = async (message: string) => {
    await run(['add', '.']);
    await run(['commit', '--quiet', '-m', message]);
  };
  await run(['init', '--quiet', '-b', 'main']);
  for (let n = 0; n < 16; n++) await mkdir(join(dir, 'src', `module-${n}`), {recursive: true});
  await writeFile(join(dir, '.access.yml'), `version: 1\norg: ${org}\nrules: []\n`);
  for (let n = 0; n < files; n++) {
    await writeFile(file(n), Array.from({length: 64}, (_, line) =>
      `export const item${line} = "${org}-${n}-${line}";\n`).join(''));
  }
  const entropy = (label: string, bytes: number) => createCipheriv('aes-256-ctr',
    createHash('sha256').update(`${org}/${dir.split('/').at(-1)}/${label}`).digest(), Buffer.alloc(16))
    .update(Buffer.alloc(bytes));
  for (let n = 0; n < commits; n++) {
    await writeFile(join(dir, 'snapshot.bin'), entropy(`public-${n}`, blobBytes));
    for (let edit = 0; edit < 6; edit++) {
      const index = (n * 13 + edit * 17) % files;
      await writeFile(file(index), `export const build = "${org}-${index}-${n}";\n`, {flag: 'a'});
    }
    await commit(`Public change ${n}`);
  }
  const sha = async (ref: string) => (await run(['rev-parse', ref])).stdout.trim();
  const main = await sha('main');
  const branches = new Map<string, string>();
  for (const [index, name] of branchNames.entries()) {
    const olderBase = index % 3 !== 0;
    await run(['switch', '--quiet', '-c', name, olderBase ? 'main~4' : 'main']);
    await writeFile(join(dir, `${name}.txt`), `Synthetic private canary ${org}/${name}\n`);
    await commit(`Start ${name}`);
    await writeFile(join(dir, 'private.bin'), entropy(name, blobBytes));
    await commit(`Implement ${name}`);
    if (index % 3 === 2) await run(['merge', '--quiet', '--no-ff', '-m', 'Merge current public base', 'main']);
    branches.set(name, await sha(name));
  }
  await run(['switch', '--quiet', 'main']);
  return {main, branches, files: (await run(['ls-files'])).stdout.trim().split('\n').length,
    publicCommits: Number((await run(['rev-list', '--count', 'main'])).stdout),
    publicBinaryHistoryBytes: commits * blobBytes, privateBinaryHistoryBytes: branchNames.length * blobBytes};
}
