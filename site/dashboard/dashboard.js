const element = id => document.getElementById(id);
const login = element('login');
const inventory = element('inventory');
const status = element('status');
const detail = element('detail');
const retry = element('retry');
let repositories = [];
let selected;

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function link(text, href) {
  const item = node('a', text);
  item.href = href;
  return item;
}

async function request(path, data) {
  const options = data === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bettergit-Dashboard': '1' },
    body: JSON.stringify(data),
  };
  const response = await fetch('/v1/' + path, options);
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

const label = repo => repo.owner + '/' + repo.name;
const enrollmentState = repo => repo.enrollment ? 'Enrolled' : repo.needsRelink ? 'Enrollment needs attention' : 'Installed';

function showRepository(repo) {
  selected = repo;
  renderList();
  detail.replaceChildren();
  if (!repo) {
    detail.append(node('p', repositories.length ? 'Choose a repository.' : 'No repositories are available to this account.', 'muted'));
    return;
  }

  const url = 'https://github.com/' + [repo.owner, repo.name].map(encodeURIComponent).join('/');
  const policyUrl = ref => url + '/blob/' + ref.split('/').map(encodeURIComponent).join('/') + '/.access.yml';
  const heading = node('div', undefined, 'repo-heading');
  const state = node('span', enrollmentState(repo), repo.enrollment ? 'state enrolled' : 'state');
  heading.append(node('h2', label(repo)), state);
  detail.append(heading);

  const actions = node('div', undefined, 'actions');
  actions.append(link('Repository ↗', url), link('Policy file ↗', policyUrl(repo.defaultBranch)));
  if (repo.administrator) {
    actions.append(link('Manage GitHub access ↗', url + '/settings/access'),
      link('Branch rules ↗', url + '/settings/rules'));
  }
  detail.append(actions);

  if (!repo.enrollment) {
    if (repo.needsRelink) {
      detail.append(node('p', 'This repository has an enrollment tied to a different GitHub App installation.', 'muted'));
    } else if (repo.administrator) {
      const review = node('button', 'Review for enrollment', 'primary');
      review.type = 'button';
      review.onclick = () => prepare(repo, policyUrl, review);
      detail.append(node('p', 'Enroll to approve the policy on the default branch as the guard baseline.', 'muted'), review);
    } else {
      detail.append(node('p', 'A repository administrator can enroll this repository.', 'muted'));
    }
    return;
  }

  const baseline = node('p', undefined, 'muted');
  baseline.append('Approved baseline ', link(repo.enrollment.baseline.slice(0, 12), policyUrl(repo.enrollment.baseline)));
  detail.append(baseline, node('h3', 'Approved access policy'));
  if (repo.enrollment.rules.length === 0) {
    detail.append(node('p', 'This policy has no protected paths.', 'muted'));
    return;
  }
  const table = node('table');
  const headers = table.createTHead().insertRow();
  for (const title of ['Protected path', 'GitHub team', 'Encryption']) {
    const header = node('th', title);
    header.scope = 'col';
    headers.append(header);
  }
  const rows = table.createTBody();
  for (const rule of repo.enrollment.rules) {
    const row = rows.insertRow();
    const path = row.insertCell();
    path.append(node('code', rule.path));
    if (rule.stub) path.append(node('div', 'Stub: ' + rule.stub, 'muted'));
    const teams = row.insertCell();
    for (const group of rule.groups) {
      if (!group.startsWith('github-team:')) {
        teams.append(node('div', group));
        continue;
      }
      const team = group.slice('github-team:'.length);
      const teamUrl = 'https://github.com/orgs/' + encodeURIComponent(repo.enrollment.organization)
        + '/teams/' + encodeURIComponent(team);
      const teamRow = node('div');
      teamRow.append(link(team, teamUrl));
      teams.append(teamRow);
    }
    row.insertCell().textContent = rule.mode === 'file' ? 'Whole file' : 'Values';
  }
  const wrapper = node('div', undefined, 'table-wrap');
  wrapper.append(table);
  detail.append(wrapper);
}

async function prepare(repo, policyUrl, button) {
  button.disabled = true;
  status.textContent = '';
  const target = { owner: repo.owner, repo: repo.name };
  try {
    const { commit } = await request('dashboard/prepare', target);
    if (selected !== repo) return;
    const confirmation = node('div', undefined, 'actions');
    const approve = node('button', 'Approve and enroll', 'primary');
    approve.type = 'button';
    approve.onclick = async () => {
      approve.disabled = true;
      try {
        await request('dashboard/enroll', { ...target, commit });
        await load(label(repo));
      } catch (error) {
        if (selected !== repo) return;
        showRepository(repo);
        status.textContent = enrollmentError(error);
      }
    };
    confirmation.append(link('Review .access.yml at ' + commit.slice(0, 12) + ' ↗', policyUrl(commit)), approve);
    confirmation.firstChild.target = '_blank';
    confirmation.firstChild.rel = 'noopener';
    button.replaceWith(confirmation);
    approve.focus();
  } catch (error) {
    button.disabled = false;
    if (selected === repo) status.textContent = enrollmentError(error);
  }
}

function enrollmentError(error) {
  switch (error.message) {
    case 'policy_unavailable':
    case 'policy_missing': return 'Commit .access.yml to the default branch, then try again.';
    case 'invalid_policy': return 'The policy failed validation. Check its rules and group signing keys.';
    case 'default_branch_changed': return 'The default branch moved. Review the new commit before enrolling.';
    case 'repository_already_enrolled': return 'This repository has already been enrolled. Reload the dashboard.';
    case 'sign_in_required': return 'Your sign-in expired. Reload the dashboard to sign in again.';
    default: return 'Enrollment could not be completed.';
  }
}

function renderList() {
  const query = element('search').value.trim().toLowerCase();
  const list = element('repos');
  list.replaceChildren();
  for (const repo of repositories.filter(item => label(item).toLowerCase().includes(query))) {
    const item = node('li');
    const button = node('button', label(repo));
    button.type = 'button';
    button.append(node('small', enrollmentState(repo)));
    button.setAttribute('aria-pressed', String(repo === selected));
    button.onclick = () => {
      showRepository(repo);
      list.querySelector('[aria-pressed="true"]')?.focus();
    };
    item.append(button);
    list.append(item);
  }
  if (query && !list.children.length) list.append(node('li', 'No matches', 'muted'));
}

async function load(preferred) {
  status.textContent = 'Loading repositories…';
  retry.hidden = true;
  try {
    const result = await request('inventory');
    repositories = result.repositories;
    element('username').textContent = '@' + result.account;
    element('account').hidden = false;
    login.hidden = true;
    inventory.hidden = false;
    status.textContent = '';
    showRepository(repositories.find(repo => label(repo) === preferred) ?? repositories[0]);
  } catch (error) {
    if (error.status === 401) {
      repositories = [];
      element('account').hidden = true;
      inventory.hidden = true;
      login.hidden = false;
      status.textContent = '';
    } else {
      status.textContent = 'Could not load repositories.';
      retry.hidden = false;
    }
  }
}

element('search').addEventListener('input', renderList);
retry.addEventListener('click', () => load(selected && label(selected)));
element('logout').addEventListener('click', async () => {
  try {
    await request('dashboard/logout', {});
    location.reload();
  } catch {
    status.textContent = 'Could not sign out. Try again.';
  }
});

element('sign-in').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  status.textContent = '';
  try {
    const started = await request('dashboard/start', {});
    if (!started.signedIn) {
      element('device-code').textContent = started.userCode;
      element('device').hidden = false;
      let next = await request('dashboard/poll', {});
      while (!next.signedIn) {
        await new Promise(resolve => setTimeout(resolve, next.retryAfter * 1_000));
        next = await request('dashboard/poll', {});
      }
    }
    await load();
  } catch {
    status.textContent = 'GitHub sign-in could not be completed. Try again.';
  } finally {
    button.disabled = false;
    element('device').hidden = true;
    element('device-code').textContent = '';
  }
});

void load();
