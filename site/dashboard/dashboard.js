const element = id => document.getElementById(id);
const login = element('login');
const inventory = element('inventory');
const status = element('status');
const detail = element('detail');
const retry = element('retry');
let repositories = [];
let selected;
let page = 0;

const pageSize = 16;
const search = element('search');
const ownerFilter = element('owner-filter');
const stateFilter = element('state-filter');
const list = element('repos');
const previous = element('previous');
const next = element('next');

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

function enhanceFilter(select) {
  const field = node('div', undefined, 'filter-picker');
  const trigger = node('button', undefined, 'picker-trigger');
  const value = node('span');
  const menu = node('div', undefined, 'picker-menu');
  const label = select.labels[0].textContent;
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  menu.id = select.id + '-menu';
  trigger.setAttribute('aria-controls', menu.id);
  trigger.append(value, node('span', undefined, 'picker-chevron'));
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.hidden = true;
  field.append(trigger, menu);
  select.after(field);
  select.hidden = true;

  function sync() {
    value.textContent = select.selectedOptions[0]?.label ?? '';
    trigger.setAttribute('aria-label', label + ', ' + value.textContent);
  }

  function close(restoreFocus = false) {
    trigger.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    if (restoreFocus) trigger.focus();
  }

  function open(position = 'selected') {
    menu.replaceChildren();
    for (const option of select.options) {
      const item = node('button', undefined, 'picker-option');
      item.append(node('span', option.label));
      item.type = 'button';
      item.tabIndex = -1;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(option.selected));
      item.onclick = () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change'));
        close(true);
      };
      menu.append(item);
    }
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const triggerBounds = trigger.getBoundingClientRect();
    menu.classList.toggle('above',
      window.innerHeight - triggerBounds.bottom < menu.offsetHeight && triggerBounds.top > window.innerHeight - triggerBounds.bottom,
    );
    const choice = position === 'first' ? menu.firstElementChild
      : position === 'last' ? menu.lastElementChild
      : menu.querySelector('[aria-checked="true"]');
    choice?.focus();
  }

  trigger.onclick = () => menu.hidden ? open() : close(true);
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    open(event.key === 'ArrowDown' ? 'first' : 'last');
  });
  menu.addEventListener('keydown', event => {
    const options = [...menu.children];
    const current = options.indexOf(document.activeElement);
    let target;
    switch (event.key) {
      case 'Tab':
        close(true);
        return;
      case 'Escape':
        event.preventDefault();
        close(true);
        return;
      case 'ArrowDown': target = options[(current + 1) % options.length]; break;
      case 'ArrowUp': target = options[(current - 1 + options.length) % options.length]; break;
      case 'Home': target = options[0]; break;
      case 'End': target = options.at(-1); break;
      default:
        if (event.key.length !== 1 || event.key === ' ' || event.ctrlKey || event.altKey || event.metaKey) return;
        target = [...options.slice(current + 1), ...options.slice(0, current + 1)]
          .find(option => option.textContent.toLowerCase().startsWith(event.key.toLowerCase()));
    }
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });
  field.addEventListener('focusout', event => {
    if (!field.contains(event.relatedTarget)) close();
  });
  document.addEventListener('pointerdown', event => {
    if (!field.contains(event.target)) close();
  });
  select.addEventListener('change', sync);
  sync();
  return sync;
}

const syncOwnerFilter = enhanceFilter(ownerFilter);
enhanceFilter(stateFilter);

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
const stateOf = repo => repo.enrollment ? 'enrolled' : repo.needsRelink ? 'attention' : 'installed';
const stateLabels = { enrolled: 'Enrolled', attention: 'Needs attention', installed: 'Installed only' };
const stateRank = { attention: 0, enrolled: 1, installed: 2 };

function updateOwners() {
  const active = ownerFilter.value;
  const owners = [...new Set(repositories.map(repo => repo.owner))].sort((a, b) => a.localeCompare(b));
  ownerFilter.replaceChildren(new Option('All owners', ''), ...owners.map(owner => new Option(owner, owner)));
  if (owners.includes(active)) ownerFilter.value = active;
  syncOwnerFilter();
}

function showRepository(repo) {
  selected = repo;
  updateSelection();
  detail.replaceChildren();
  if (!repo) {
    detail.append(node('p', repositories.length ? 'Choose a repository.' : 'No repositories are available to this account.', 'muted'));
    return;
  }

  const url = 'https://github.com/' + [repo.owner, repo.name].map(encodeURIComponent).join('/');
  const policyUrl = ref => url + '/blob/' + ref.split('/').map(encodeURIComponent).join('/') + '/.access.yml';
  const heading = node('div', undefined, 'repo-heading');
  const state = node('span', stateLabels[stateOf(repo)], 'state ' + stateOf(repo));
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
  detail.append(baseline);
  if (repo.administrator) {
    const workspaces = node('section', undefined, 'private-workspaces');
    detail.append(workspaces);
    void renderWorkspaces(repo, workspaces);
  }
  detail.append(node('h3', 'Approved access policy'));
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

function updateSelection() {
  for (const button of list.querySelectorAll('button[data-repo]')) {
    button.setAttribute('aria-pressed', String(Boolean(selected) && button.dataset.repo === label(selected)));
  }
}

function renderList() {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = repositories.filter(repo => {
    const fullname = label(repo).toLowerCase();
    return (!ownerFilter.value || repo.owner === ownerFilter.value)
      && (!stateFilter.value || stateOf(repo) === stateFilter.value)
      && terms.every(term => fullname.includes(term));
  });
  page = Math.min(page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  const start = page * pageSize;
  const results = matches.slice(start, start + pageSize);
  list.replaceChildren();
  element('results').scrollTop = 0;

  for (const repo of results) {
    const item = node('li');
    const button = node('button', undefined, 'repo-row');
    button.type = 'button';
    button.dataset.repo = label(repo);
    button.title = label(repo);

    const name = node('span', undefined, 'repo-name');
    name.append(node('strong', repo.name), node('small', repo.owner));
    const state = stateOf(repo);
    button.append(name, node('span', stateLabels[state], 'row-state ' + state));
    button.onclick = () => {
      showRepository(repo);
      if (matchMedia('(max-width: 740px)').matches) detail.focus();
    };
    item.append(button);
    list.append(item);
  }

  const empty = element('empty-results');
  empty.hidden = results.length > 0;
  empty.textContent = repositories.length ? 'No repositories match these filters.' : 'No repositories available.';
  const count = matches.length;
  element('result-count').textContent = count > pageSize
    ? `${start + 1}–${start + results.length} of ${count}`
    : `${count} ${count === 1 ? 'repository' : 'repositories'}`;
  element('pagination').hidden = count <= pageSize;
  previous.setAttribute('aria-disabled', String(page === 0));
  next.setAttribute('aria-disabled', String(start + pageSize >= count));
  updateSelection();
}

function resetPage() {
  page = 0;
  renderList();
}

function changePage(button, step) {
  if (button.getAttribute('aria-disabled') === 'true') return;
  page += step;
  renderList();
}

async function load(preferred) {
  status.textContent = 'Loading repositories…';
  retry.hidden = true;
  try {
    const result = await request('inventory');
    repositories = result.repositories.sort((a, b) =>
      stateRank[stateOf(a)] - stateRank[stateOf(b)] || label(a).localeCompare(label(b)),
    );
    updateOwners();
    element('username').textContent = '@' + result.account;
    element('account').hidden = false;
    login.hidden = true;
    inventory.hidden = false;
    status.textContent = '';
    showRepository(repositories.find(repo => label(repo) === preferred) ?? repositories[0]);
    renderList();
  } catch (error) {
    if (error.status === 401) {
      repositories = [];
      showRepository(undefined);
      updateOwners();
      resetPage();
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

search.addEventListener('input', resetPage);
search.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return;
  const first = list.querySelector('button');
  first?.focus();
  first?.click();
});
ownerFilter.addEventListener('change', resetPage);
stateFilter.addEventListener('change', resetPage);
previous.addEventListener('click', () => changePage(previous, -1));
next.addEventListener('click', () => changePage(next, 1));
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

async function renderWorkspaces(repo, container) {
  const call = (operation, id, audience) => request('dashboard/workspaces', { operation, id: String(id), audience });
  container.replaceChildren(node('h3', 'Private workspaces'), node('p', 'Loading workspaces…', 'muted'));
  try {
    const [workspaces, groups] = await Promise.all([
      call('list', repo.enrollment.id), call('groups', repo.enrollment.id),
    ]);
    if (selected !== repo) return;
    container.replaceChildren(node('h3', 'Private workspaces'));
    container.append(node('p', 'All branches in a workspace share its audience. Members receive push access. Organization owners and privileged Apps may also have access.', 'muted'));
    const message = node('p', '', 'muted');
    message.setAttribute('role', 'status');
    const filterLabel = node('label', 'Find a workspace');
    const filter = node('input');filter.type = 'search';filter.placeholder = 'Search name or status';
    filterLabel.append(filter);
    const cards = node('div');
    filter.oninput = () => { for (const card of cards.children) card.hidden = !card.dataset.search.includes(filter.value.trim().toLowerCase()); };
    const editor = node('div');
    async function edit(workspace) {
      editor.replaceChildren();
      const form = node('form', undefined, 'workspace-form');
      const nameLabel = node('label', 'Workspace name');
      const name = node('input');
      name.required = true;
      name.pattern = '[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}';
      name.value = workspace?.name ?? '';
      name.disabled = Boolean(workspace);
      nameLabel.append(name);
      const usersLabel = node('label', 'Explicit members (GitHub usernames, separated by commas)');
      const users = node('input');
      users.value = workspace?.allowed_users.join(', ') ?? '';
      usersLabel.append(users);
      const teamChoices = node('fieldset');
      teamChoices.append(node('legend', 'Access groups'));
      for (const group of groups) {
        const label = node('label', undefined, 'workspace-group');
        const checkbox = node('input');
        checkbox.type = 'checkbox'; checkbox.value = group.id;
        checkbox.checked = workspace?.group_ids.includes(String(group.id)) ?? false;
        label.append(checkbox, document.createTextNode(group.name));teamChoices.append(label);
      }
      const save = node('button', workspace ? 'Apply audience' : 'Create workspace', 'primary');
      save.type = 'submit';
      form.append(nameLabel, usersLabel, teamChoices, save);
      form.onsubmit = async event => {
        event.preventDefault();save.disabled = true;
        const audience = {
          allow: users.value.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean),
          groups: [...teamChoices.querySelectorAll('input:checked')].map(input => input.value),
        };
        if (!workspace) audience.name = name.value;
        try {
          const updated = await call(workspace ? 'members' : 'create', workspace?.id ?? repo.enrollment.id, audience);
          await renderWorkspaces(repo, container);
          status.textContent = updated.status === 'ready' ? 'Workspace access verified.' : 'Workspace saved. Access needs attention; inspect its status.';
        } catch { message.textContent = 'Could not save the workspace. Check the audience and GitHub App permissions.'; save.disabled = false; }
      };
      editor.append(form);name.disabled ? users.focus() : name.focus();
    }
    for (const w of workspaces) {
      const card = node('article', undefined, 'workspace-card');
      card.dataset.search = (w.name + ' ' + w.status).toLowerCase();
      card.append(node('strong', w.name), node('span', w.status, 'state'),
        node('p', w.checked_at ? 'Last verified: ' + new Date(w.checked_at).toLocaleString() : 'Access has not been verified.', 'muted'));
      if (w.issue) card.append(node('p', w.issue));
      const controls = node('div', undefined, 'actions');
      const inspect = node('button', 'Access and branches');inspect.type = 'button';
      const info = node('div');
      inspect.onclick = async () => {
        inspect.disabled = true;
        try {
          const full = await call('show', w.id);
          info.replaceChildren();
          for (const member of Object.values(full.member_sources)) info.append(node('p', '@' + member.login + ' — ' + member.sources.join(', ')));
          if (full.status !== 'ready') info.append(node('p', 'Listed members reflect the last successful verification.'));
          if (full.revoked_ids.length) info.append(node('p', 'Offboarding exclusions: ' + full.revoked_ids.join(', ') + '. Previously downloaded keys and clones remain accessible.'));
          info.append(node('p', full.branches.length + ' branches'));
          for (const branch of full.branches) info.append(node('p', branch.branch_name + ' · ' + branch.status + ' · Join ID ' + branch.id));
          const history = node('details');history.append(node('summary', 'Access history'));
          for (const e of full.events) history.append(node('p', new Date(e.created_at).toLocaleString() + ' · ' + e.action));
          info.append(history);
        } catch { message.textContent = 'Could not load workspace access.'; }
        finally { inspect.disabled = false; }
      };
      controls.append(inspect);
      if (w.status !== 'archived') {
        const members = node('button', 'Edit audience');members.type = 'button';members.onclick = () => edit(w);
        const sync = node('button', 'Verify access');sync.type = 'button';
        sync.onclick = async () => {
          sync.disabled = true;
          try { await call('reconcile', w.id);await renderWorkspaces(repo, container); }
          catch { message.textContent = 'Access verification failed.';sync.disabled = false; }
        };
        const archive = node('button', 'Archive…');archive.type = 'button';
        archive.onclick = () => {
          info.replaceChildren(node('p', 'Archiving removes managed collaborator access and keeps the repository history. Privileged administrators retain access.'));
          const confirm = node('button', 'Archive and remove managed access');confirm.type = 'button';
          confirm.onclick = async () => {
            confirm.disabled = true;
            try { await call('archive', w.id);await renderWorkspaces(repo, container); }
            catch { message.textContent = 'Archiving could not complete. Inspect workspace status.';confirm.disabled = false; }
          };
          info.append(confirm);
        };
        controls.append(members, sync, archive);
      }
      card.append(controls, info);cards.append(card);
    }
    const create = node('button', 'New private workspace', 'primary');create.type = 'button';create.onclick = () => edit();
    container.append(filterLabel, cards, create, message, editor);
  } catch {
    if (selected === repo) container.replaceChildren(node('h3', 'Private workspaces'), node('p', 'Workspace management is unavailable. Check the server migration and GitHub App access.', 'muted'));
  }
}
