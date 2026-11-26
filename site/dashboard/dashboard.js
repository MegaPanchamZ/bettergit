const element = id => document.getElementById(id);
const login = element('login');
const inventory = element('inventory');
const dashboardNotices = element('dashboard-notices');
const statusMessage = element('status-message');
const enrollmentAlert = element('enrollment-alert');
const enrollmentNoticeList = element('enrollment-notices');
const enrollmentAnnouncements = element('enrollment-announcements');
const dismissEnrollmentNotices = element('dismiss-enrollment-notices');
const statusSeparator = document.createTextNode('');
enrollmentAlert.after(statusSeparator);
const noticeSeparator = document.createTextNode('');
statusMessage.after(noticeSeparator);
const detail = element('detail');
const filteredDetail = element('filtered-detail');
const retry = element('retry');
const additionalRetries = element('additional-retries');
const additionalRetryButtons = new Map();
let repositories = [];
let selected;
let inventoryRequest = 0;
let appliedInventoryRequest = 0;
const enrollmentNotices = new Set();
let inventoryMessage = 'Loading repositories…';
let inventoryFailed = false;
const ownerCounts = new Map();
const pendingRefresh = new Set();
const failedRefreshes = new Set();
const retryingRefreshes = new Set();
const enrollmentErrors = new Map();
const backgroundEnrollmentErrors = new Set();
const enrollmentPanels = new Map();
const search = element('search');
const ownerFilter = element('owner-filter');
const stateFilter = element('state-filter');
const list = element('repos');
const results = element('results');

new ResizeObserver(() => {
  const offset = !inventory.hidden && !dashboardNotices.hidden ? dashboardNotices.offsetHeight + 16 : 0;
  document.documentElement.style.setProperty('--notice-offset', offset + 'px');
}).observe(dashboardNotices);

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

function enhanceFilter(select, counts) {
  const field = node('div', undefined, 'filter-picker');
  const trigger = node('button', undefined, 'picker-trigger');
  const value = node('span');
  const popup = node('div', undefined, 'picker-menu');
  const menu = node('div', undefined, 'picker-options');
  const filter = node('input', undefined, 'picker-search');
  filter.type = 'search';
  filter.placeholder = 'Find an owner';
  filter.setAttribute('aria-label', 'Find an owner');
  filter.autocomplete = 'off';
  const empty = node('p', 'No owners found.', 'muted picker-empty');
  empty.setAttribute('role', 'status');
  popup.append(filter, menu, empty);
  const label = select.labels[0].textContent;
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', counts ? 'dialog' : 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  popup.id = select.id + '-popup';
  trigger.setAttribute('aria-controls', popup.id);
  if (counts) {
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', label);
    field.classList.add('owner-picker');
  } else {
    menu.id = popup.id;
    popup.removeAttribute('id');
  }
  trigger.append(value, node('span', undefined, 'picker-chevron'));
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  popup.hidden = true;
  field.append(trigger, popup);
  select.after(field);
  select.hidden = true;

  function sync() {
    value.textContent = select.selectedOptions[0]?.label ?? '';
    trigger.setAttribute('aria-label', label + ', ' + value.textContent);
  }

  function close(restoreFocus = false) {
    trigger.setAttribute('aria-expanded', 'false');
    popup.hidden = true;
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function renderOptions() {
    const query = filter.value.trim().toLowerCase();
    const options = [];
    for (const option of select.options) {
      if (query && (!option.value || !option.label.toLowerCase().includes(query))) continue;
      const item = node('button', undefined, 'picker-option');
      item.append(node('span', option.label, 'picker-option-label'));
      if (counts && option.value) {
        const count = node('small', String(counts.get(option.value)), 'picker-count');
        count.setAttribute('aria-hidden', 'true');
        item.append(count);
      }
      item.type = 'button';
      item.tabIndex = -1;
      item.title = option.label;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(option.selected));
      item.onclick = () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change'));
        close(true);
      };
      options.push(item);
    }
    menu.replaceChildren(...options);
    menu.scrollTop = 0;
    empty.hidden = options.length > 0;
  }

  function open(position = 'selected') {
    filter.hidden = !counts || counts.size <= 8;
    filter.value = '';
    renderOptions();
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const bounds = trigger.getBoundingClientRect();
    const below = window.innerHeight - bounds.bottom;
    popup.classList.toggle('above', below < popup.offsetHeight && bounds.top > below);
    const choice = position === 'first' ? menu.firstElementChild
      : position === 'last' ? menu.lastElementChild
      : filter.hidden ? menu.querySelector('[aria-checked="true"]') : filter;
    choice?.focus();
  }

  trigger.onclick = event => popup.hidden ? open(event.pointerType === 'touch' ? 'first' : 'selected') : close(true);
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    open(event.key === 'ArrowDown' ? 'first' : 'last');
  });
  filter.addEventListener('input', renderOptions);
  popup.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const items = [...menu.children];
    const current = items.indexOf(document.activeElement);
    if (event.key === 'Tab' || event.key === 'Escape') {
      if (event.key === 'Escape') event.preventDefault();
      close(true);
      return;
    }
    if (event.target === filter && event.key === 'Enter') {
      event.preventDefault();
      items[0]?.click();
      return;
    }
    let target;
    switch (event.key) {
      case 'ArrowDown': target = items[(current + 1) % items.length]; break;
      case 'ArrowUp': target = current <= 0 && !filter.hidden ? filter : items[current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length]; break;
      case 'Home': if (event.target !== filter) target = items[0]; break;
      case 'End': if (event.target !== filter) target = items.at(-1); break;
      default:
        if (event.target === filter || event.key.length !== 1 || event.key === ' ' || event.ctrlKey || event.altKey || event.metaKey) return;
        if (!filter.hidden) {
          filter.value += event.key;
          renderOptions();
          target = filter;
        } else {
          target = [...items.slice(current + 1), ...items.slice(0, current + 1)]
            .find(item => item.textContent.toLowerCase().startsWith(event.key.toLowerCase()));
        }
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

const syncOwnerFilter = enhanceFilter(ownerFilter, ownerCounts);
const syncStateFilter = enhanceFilter(stateFilter);

async function request(path, data) {
  const options = data === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bettergit-Dashboard': '1' },
    body: JSON.stringify(data),
  };
  const response = await fetch('/v1/' + path, options);
  const result = await response.json().catch(error => {
    if (response.ok) throw error;
    return null;
  });
  if (!response.ok) throw Object.assign(new Error(result?.error), { status: response.status });
  return result;
}

const label = repo => repo.owner + '/' + repo.name;
const stateOf = repo => (repo.enrollment || pendingRefresh.has(label(repo))) ? 'enrolled' : repo.needsRelink ? 'attention' : 'installed';
const stateLabels = { enrolled: 'Enrolled', attention: 'Needs attention', installed: 'Installed only' };
const stateRank = { attention: 0, enrolled: 1, installed: 2 };

function updateOwners() {
  const active = ownerFilter.value;
  ownerCounts.clear();
  for (const repo of repositories) ownerCounts.set(repo.owner, (ownerCounts.get(repo.owner) ?? 0) + 1);
  const owners = [...ownerCounts.keys()].sort((a, b) => a.localeCompare(b));
  ownerFilter.replaceChildren(new Option('All owners', ''), ...owners.map(owner => new Option(owner, owner)));
  if (owners.includes(active)) ownerFilter.value = active;
  syncOwnerFilter();
}

function showRepository(repo) {
  const focused = document.activeElement;
  const name = repo && label(repo);
  selected = repo;
  detail.hidden = false;
  filteredDetail.hidden = true;
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
  const back = node('button', 'Back to repositories', 'back-to-repos');
  back.type = 'button';
  back.onclick = () => {
    revealSelectedRow();
    focusRepositoryRow(name);
  };
  detail.append(back, heading);
  if (enrollmentNotices.has(name)) showEnrollmentConfirmation(name);

  const actions = node('div', undefined, 'actions');
  actions.append(link('Repository ↗', url), link('Policy file ↗', policyUrl(repo.defaultBranch)));
  if (repo.administrator) {
    actions.append(link('Manage GitHub access ↗', url + '/settings/access'),
      link('Branch rules ↗', url + '/settings/rules'));
  }
  detail.append(actions);

  const enrollmentPanel = enrollmentPanels.get(name);
  if (!repo.enrollment && !repo.needsRelink && repo.administrator && enrollmentPanel) {
    detail.append(enrollmentPanel);
    if (enrollmentPanel.contains(focused)) focused.focus({ preventScroll: true });
    return;
  }

  if (pendingRefresh.has(name)) {
    const panel = node('div');
    const message = node('p', 'Repository enrolled. Could not refresh its details.', 'muted enrollment-refresh-message');
    message.setAttribute('role', 'status');
    const refresh = node('button', 'Refresh repository', 'primary enrollment-refresh');
    refresh.type = 'button';
    refresh.onclick = () => retryEnrollmentRefresh(name);
    panel.append(message, refresh);
    enrollmentPanels.set(name, panel);
    detail.append(panel);
    updateRefreshButton(name);
    return;
  }

  if (!repo.enrollment) {
    if (repo.needsRelink) {
      detail.append(node('p', 'This repository has an enrollment tied to a different GitHub App installation.', 'muted'));
    } else if (repo.administrator) {
      const panel = node('div');
      const review = node('button', 'Review for enrollment', 'primary');
      const feedback = node('p', enrollmentErrors.get(name) ?? '', 'enrollment-error');
      feedback.setAttribute('role', 'alert');
      review.type = 'button';
      review.onclick = () => prepare(repo, policyUrl, panel, review, feedback);
      panel.append(node('p', 'Enroll to approve the policy on the default branch as the guard baseline.', 'muted'), review, feedback);
      detail.append(panel);
    } else {
      detail.append(node('p', 'A repository administrator can enroll this repository.', 'muted'));
    }
    return;
  }

  const baseline = node('p', undefined, 'muted');
  baseline.append('Approved baseline ', link(repo.enrollment.baseline.slice(0, 12), policyUrl(repo.enrollment.baseline)));
  detail.append(baseline);
  detail.append(node('h3', 'Approved access policy'));
  if (repo.enrollment.rules.length === 0) {
    detail.append(node('p', 'This policy has no protected paths.', 'muted'));
    return;
  }
  const table = node('table');
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', 'Approved access policy');
  const headers = table.createTHead().insertRow();
  headers.parentElement.setAttribute('role', 'rowgroup');
  headers.setAttribute('role', 'row');
  for (const title of ['Protected path', 'GitHub team', 'Encryption']) {
    const header = node('th', title);
    header.scope = 'col';
    header.setAttribute('role', 'columnheader');
    headers.append(header);
  }
  const rows = table.createTBody();
  rows.setAttribute('role', 'rowgroup');
  for (const rule of repo.enrollment.rules) {
    const row = rows.insertRow();
    row.setAttribute('role', 'row');
    const path = row.insertCell();
    path.setAttribute('role', 'cell');
    path.append(node('code', rule.path));
    if (rule.stub) path.append(node('div', 'Stub: ' + rule.stub, 'muted'));
    const teams = row.insertCell();
    teams.setAttribute('role', 'cell');
    const teamLabel = node('span', 'GitHub team', 'policy-cell-label');
    teamLabel.setAttribute('aria-hidden', 'true');
    teams.append(teamLabel);
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
    const mode = row.insertCell();
    mode.setAttribute('role', 'cell');
    const modeLabel = node('span', 'Encryption', 'policy-cell-label');
    modeLabel.setAttribute('aria-hidden', 'true');
    mode.append(modeLabel, document.createTextNode(rule.mode === 'file' ? 'Whole file' : 'Values'));
  }
  const wrapper = node('div', undefined, 'table-wrap');
  wrapper.append(table);
  detail.append(wrapper);
}

async function prepare(repo, policyUrl, panel, button, feedback) {
  const name = label(repo);
  if (enrollmentPanels.has(name) || pendingRefresh.has(name)) return;
  enrollmentPanels.set(name, panel);
  button.setAttribute('aria-disabled', 'true');
  button.textContent = 'Preparing review…';
  enrollmentErrors.delete(name);
  backgroundEnrollmentErrors.delete(name);
  feedback.textContent = '';
  const target = { owner: repo.owner, repo: repo.name };
  try {
    const { commit } = await request('dashboard/prepare', target);
    const confirmation = node('div', undefined, 'actions');
    const approve = node('button', 'Approve and enroll', 'primary');
    approve.type = 'button';
    approve.onclick = async () => {
      if (approve.getAttribute('aria-disabled') === 'true' || pendingRefresh.has(name)) return;
      approve.setAttribute('aria-disabled', 'true');
      approve.textContent = 'Enrolling…';
      try {
        await request('dashboard/enroll', { ...target, commit });
        pendingRefresh.add(name);
        approve.textContent = 'Refreshing repository…';
        updateEnrolledRepository(name);
        const reloaded = await load(selected && label(selected), name);
        enrollmentPanels.delete(name);
        if (!reloaded && selected && label(selected) === name) {
          const wasHidden = detail.hidden;
          const restoreFocus = confirmation.contains(document.activeElement);
          showRepository(selected);
          detail.hidden = wasHidden;
          filteredDetail.hidden = !wasHidden;
          if (restoreFocus) detail.querySelector('.enrollment-refresh')?.focus();
        }
      } catch (error) {
        enrollmentPanels.delete(name);
        const restoreFocus = confirmation.contains(document.activeElement);
        confirmation.replaceWith(button);
        const outcomeUnknown = error.status >= 500 || error instanceof TypeError || error instanceof SyntaxError;
        reportEnrollmentError(name, error, feedback, outcomeUnknown);
        if (restoreFocus) {
          button.focus();
          feedback.scrollIntoView({ block: 'nearest' });
        }
      }
    };
    const policy = link('Review .access.yml at ' + commit.slice(0, 12) + ' ↗', policyUrl(commit));
    policy.target = '_blank';
    policy.rel = 'noopener';
    confirmation.append(policy, approve);
    const moveFocus = document.activeElement === button;
    button.replaceWith(confirmation);
    if (moveFocus) approve.focus();
  } catch (error) {
    enrollmentPanels.delete(name);
    reportEnrollmentError(name, error, feedback);
  } finally {
    button.removeAttribute('aria-disabled');
    button.textContent = 'Review for enrollment';
  }
}

function updateEnrolledRepository(name) {
  const showingEnrolledRepo = selected && label(selected) === name;
  if (showingEnrolledRepo && !detail.hidden && stateFilter.value && stateFilter.value !== 'enrolled') {
    stateFilter.value = '';
    syncStateFilter();
  }
  if (showingEnrolledRepo) {
    const badge = detail.querySelector('.repo-heading .state');
    badge.textContent = stateLabels.enrolled;
    badge.className = 'state enrolled';
  }
  const focused = list.contains(document.activeElement) && document.activeElement.dataset.repo;
  const scroll = results.scrollTop;
  renderList();
  results.scrollTop = scroll;
  if (focused) (repositoryRow(focused) ?? results).focus({ preventScroll: true });
  else if (showingEnrolledRepo) revealSelectedRow();
  setLocation();
}

function enrollmentRefreshError(name) {
  return name + ' enrolled. Could not refresh repositories.';
}

function renderStatus() {
  const visibleRepo = selected && !detail.hidden && label(selected);
  if (visibleRepo) backgroundEnrollmentErrors.delete(visibleRepo);
  const refreshErrors = inventory.hidden ? [] : [...failedRefreshes].filter(name => name !== visibleRepo);
  const messages = [];
  const errors = [];
  if (inventoryMessage) messages.push(inventoryMessage);
  if (!inventory.hidden) {
    for (const name of backgroundEnrollmentErrors) errors.push(name + ': ' + enrollmentErrors.get(name));
    for (const name of refreshErrors) messages.push(enrollmentRefreshError(name));
  }
  const alert = errors.join('\n');
  const message = messages.join('\n');
  const notices = inventory.hidden ? '' : [...enrollmentNotices].filter(name => name !== visibleRepo)
    .map(name => name + ' enrolled.').join('\n');
  if (enrollmentAlert.textContent !== alert) enrollmentAlert.textContent = alert;
  if (statusMessage.textContent !== message) statusMessage.textContent = message;
  if (enrollmentNoticeList.textContent !== notices) enrollmentNoticeList.textContent = notices;
  statusSeparator.data = alert && message ? '\n' : '';
  noticeSeparator.data = notices && (alert || message) ? '\n' : '';
  dismissEnrollmentNotices.hidden = !notices;
  if (!enrollmentNotices.size && enrollmentAnnouncements.hasChildNodes()) enrollmentAnnouncements.replaceChildren();

  const target = refreshErrors[0];
  const hideRetry = !inventoryFailed && !target;
  const previousTarget = retry.dataset.retryRepo;
  if ((hideRetry || (previousTarget && previousTarget !== target)) && document.activeElement === retry && !inventory.hidden) {
    focusRepositoryRow(previousTarget);
  }
  retry.hidden = hideRetry;
  retry.dataset.retryRepo = target ?? '';
  renderRetryButton(retry, target, refreshErrors.length > 1);

  const extraTargets = refreshErrors.slice(1);
  for (const [name, button] of additionalRetryButtons) {
    if (extraTargets.includes(name)) continue;
    if (document.activeElement === button) {
      if (target === name) retry.focus({ preventScroll: true });
      else focusRepositoryRow(name);
    }
    button.remove();
    additionalRetryButtons.delete(name);
  }
  for (const name of extraTargets) {
    let button = additionalRetryButtons.get(name);
    if (!button) {
      button = node('button');
      button.type = 'button';
      button.onclick = () => retryEnrollmentRefresh(name);
      additionalRetryButtons.set(name, button);
      additionalRetries.append(button);
    }
    renderRetryButton(button, name, true);
  }
  additionalRetries.hidden = !extraTargets.length;
  dashboardNotices.hidden = !alert && !message && !notices;
}

function focusRepositoryRow(name) {
  const row = repositoryRow(name) ?? list.querySelector('[aria-pressed="true"]');
  const target = row ?? results;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest' });
}

function renderRetryButton(button, name, showName) {
  const text = showName ? 'Retry ' + name : 'Retry';
  if (button.textContent !== text) button.textContent = text;
  if (name) button.setAttribute('aria-label', 'Retry refreshing ' + name);
  else button.removeAttribute('aria-label');
  if (retryingRefreshes.has(name)) button.setAttribute('aria-disabled', 'true');
  else button.removeAttribute('aria-disabled');
}

function updateRefreshButton(name) {
  const panel = enrollmentPanels.get(name);
  const button = panel?.querySelector('.enrollment-refresh');
  if (!button) return;
  if (retryingRefreshes.has(name)) {
    button.setAttribute('aria-disabled', 'true');
    button.textContent = 'Refreshing…';
  } else {
    button.removeAttribute('aria-disabled');
    button.textContent = 'Refresh repository';
  }
}

async function retryEnrollmentRefresh(name) {
  if (retryingRefreshes.has(name)) return;
  retryingRefreshes.add(name);
  updateRefreshButton(name);
  renderStatus();
  const reloaded = await load(undefined, name);
  retryingRefreshes.delete(name);
  if (!reloaded) {
    updateRefreshButton(name);
    const message = enrollmentPanels.get(name)?.querySelector('.enrollment-refresh-message');
    if (message) message.textContent = 'Repository enrolled. Refresh failed. Try again.';
  }
  renderStatus();
}

function reportEnrollmentError(name, error, feedback, outcomeUnknown = false) {
  if (pendingRefresh.has(name) || repositories.some(repo => label(repo) === name && repo.enrollment)) return;
  const message = outcomeUnknown
    ? 'Could not verify whether enrollment completed. Reload the dashboard to check before trying again.'
    : enrollmentError(error);
  enrollmentErrors.set(name, message);
  feedback.textContent = message;
  if (!feedback.isConnected || detail.hidden) backgroundEnrollmentErrors.add(name);
  renderStatus();
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
  const buttons = list.querySelectorAll('button[data-repo]');
  let active = buttons[0];
  for (const button of buttons) {
    const pressed = selected && button.dataset.repo === label(selected);
    button.setAttribute('aria-pressed', String(Boolean(pressed)));
    button.tabIndex = -1;
    if (pressed) active = button;
  }
  if (active) active.tabIndex = 0;
}

function setLocation() {
  const state = new URLSearchParams();
  if (selected) state.set('repo', label(selected));
  if (search.value) state.set('q', search.value);
  if (ownerFilter.value) state.set('owner', ownerFilter.value);
  if (stateFilter.value) state.set('status', stateFilter.value);
  const url = new URL(location.href);
  url.searchParams.delete('repo');
  url.hash = state.toString();
  if (url.href !== location.href) history.replaceState(null, '', url);
}

function matchingRepositories() {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return repositories.filter(repo => {
    const fullname = label(repo).toLowerCase();
    return (!ownerFilter.value || repo.owner === ownerFilter.value)
      && (!stateFilter.value || stateOf(repo) === stateFilter.value)
      && terms.every(term => fullname.includes(term));
  });
}

function renderList(matches = matchingRepositories(), revealSelection = false) {
  const fragment = document.createDocumentFragment();
  for (const repo of matches) {
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
      setLocation();
      renderStatus();
      if (matchMedia('(max-width: 740px)').matches) detail.focus();
    };
    item.append(button);
    fragment.append(item);
  }

  list.replaceChildren(fragment);
  results.scrollTop = 0;
  const empty = element('empty-results');
  empty.hidden = matches.length > 0;
  empty.textContent = repositories.length ? 'No repositories match these filters.' : 'No repositories available.';
  element('result-count').textContent = `${matches.length} ${matches.length === 1 ? 'repository' : 'repositories'}`;
  updateSelection();
  const selectionHidden = selected && !matches.includes(selected);
  const blocked = Boolean(selectionHidden || (repositories.length && !matches.length));
  detail.hidden = blocked;
  filteredDetail.hidden = !blocked;
  element('filter-message').textContent = selectionHidden
    ? label(selected) + ' is hidden by the active filters.'
    : 'No repositories match these filters.';
  if (revealSelection) revealSelectedRow();
  renderStatus();
}

function revealSelectedRow() {
  const active = list.querySelector('[aria-pressed="true"]');
  if (!active) return;
  const row = active.getBoundingClientRect();
  const viewport = results.getBoundingClientRect();
  if (row.top < viewport.top || row.bottom > viewport.bottom) {
    results.scrollTop += row.top - viewport.top;
  }
}

function repositoryRow(name) {
  return [...list.querySelectorAll('button[data-repo]')].find(button => button.dataset.repo === name);
}

function applyLocation(preferred, confirmedEnrollments) {
  const focused = document.activeElement;
  const focusedRepo = list.contains(focused) && focused.dataset.repo;
  const focusWasInDetails = detail.contains(focused);
  const focusWasOnRetry = focused === retry || additionalRetries.contains(focused);
  const state = new URLSearchParams(location.hash.slice(1));
  search.value = state.get('q') ?? '';
  const owner = state.get('owner');
  ownerFilter.value = ownerCounts.has(owner) ? owner : '';
  const enrollment = state.get('status');
  const revealEnrollment = confirmedEnrollments?.has(preferred);
  stateFilter.value = !revealEnrollment && Object.hasOwn(stateLabels, enrollment) ? enrollment : '';
  syncOwnerFilter();
  syncStateFilter();
  const requested = preferred ?? state.get('repo') ?? new URLSearchParams(location.search).get('repo');
  const matches = matchingRepositories();
  const explicit = requested && repositories.find(repo => label(repo) === requested);
  const current = selected && matches.find(repo => label(repo) === label(selected));
  showRepository(explicit || current || matches[0]);
  renderList(matches, true);
  setLocation();
  if (confirmedEnrollments?.size) {
    if (focusedRepo) {
      focusRepositoryRow(focusedRepo);
    } else if (focusWasInDetails && !focused.isConnected && !detail.hidden) {
      detail.focus();
    }
    for (const name of confirmedEnrollments) {
      enrollmentNotices.add(name);
      if (!detail.hidden && selected && label(selected) === name) {
        showEnrollmentConfirmation(name, !focusWasOnRetry && (focusWasInDetails || focused === document.body || !focused.isConnected));
      }
    }
    const announcement = [...confirmedEnrollments].map(name => name + ' enrolled.').join(' ');
    enrollmentAnnouncements.append(node('div', announcement));
  }
  renderStatus();
}

function showEnrollmentConfirmation(name, moveFocus = false) {
  if (!detail.querySelector('.enrollment-success')) {
    const confirmation = node('div', undefined, 'enrollment-confirmation');
    const message = node('p', 'Repository enrolled.', 'enrollment-success');
    const dismiss = node('button', 'Dismiss');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss enrollment confirmation');
    dismiss.onclick = () => {
      enrollmentNotices.delete(name);
      confirmation.remove();
      focusRepositoryHeading();
      renderStatus();
    };
    confirmation.append(message, dismiss);
    detail.querySelector('.repo-heading').after(confirmation);
  }
  if (moveFocus) focusRepositoryHeading();
}

function focusRepositoryHeading() {
  const heading = detail.querySelector('h2');
  heading.tabIndex = -1;
  heading.focus();
}

function filterRepositories(chooseMatch = false) {
  const matches = matchingRepositories();
  if ((!selected || (chooseMatch && !matches.includes(selected))) && matches.length) showRepository(matches[0]);
  renderList(matches, !search.value.trim());
  setLocation();
}

list.addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const row = event.target.closest('li');
  if (!row) return;
  event.preventDefault();
  const target = event.key === 'Home' ? list.firstElementChild
    : event.key === 'End' ? list.lastElementChild
    : event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
  if (!target) return;
  event.target.tabIndex = -1;
  const button = target.firstElementChild;
  button.tabIndex = 0;
  button.focus();
});

async function load(preferred, enrolledRepo) {
  const requestId = ++inventoryRequest;
  if (!enrolledRepo) {
    inventoryMessage = inventory.hidden ? 'Loading repositories…' : '';
    inventoryFailed = false;
  }
  renderStatus();
  try {
    const result = await request('inventory');
    if (requestId < appliedInventoryRequest) return finishSupersededRefresh(enrolledRepo);
    if (enrolledRepo && !result.repositories.some(repo => label(repo) === enrolledRepo && repo.enrollment)) {
      throw new Error('Inventory refresh incomplete');
    }
    appliedInventoryRequest = requestId;
    const confirmedEnrollments = new Set();
    for (const repo of result.repositories) {
      const name = label(repo);
      if (repo.enrollment) {
        if (pendingRefresh.delete(name)) confirmedEnrollments.add(name);
        failedRefreshes.delete(name);
        enrollmentErrors.delete(name);
        backgroundEnrollmentErrors.delete(name);
      }
      if (repo.enrollment || repo.needsRelink || !repo.administrator) enrollmentPanels.delete(name);
    }
    repositories = result.repositories.sort((a, b) =>
      stateRank[stateOf(a)] - stateRank[stateOf(b)] || label(a).localeCompare(label(b)),
    );
    updateOwners();
    element('username').textContent = '@' + result.account;
    element('account').hidden = false;
    login.hidden = true;
    inventory.hidden = false;
    inventoryMessage = '';
    inventoryFailed = false;
    applyLocation(confirmedEnrollments.size ? selected && label(selected) : preferred, confirmedEnrollments);
    return true;
  } catch (error) {
    if (requestId < appliedInventoryRequest) return finishSupersededRefresh(enrolledRepo);
    if (error.status === 401) {
      appliedInventoryRequest = requestId;
      enrollmentPanels.clear();
      enrollmentErrors.clear();
      backgroundEnrollmentErrors.clear();
      pendingRefresh.clear();
      failedRefreshes.clear();
      enrollmentNotices.clear();
      enrollmentAnnouncements.replaceChildren();
      repositories = [];
      showRepository(undefined);
      updateOwners();
      renderList();
      element('account').hidden = true;
      inventory.hidden = true;
      login.hidden = false;
      inventoryMessage = enrolledRepo ? enrolledRepo + ' enrolled. Sign in to refresh its details.' : '';
      inventoryFailed = false;
    } else {
      showInventoryRefreshFailure(enrolledRepo);
    }
    renderStatus();
    return false;
  }
}

function finishSupersededRefresh(enrolledRepo) {
  if (!enrolledRepo || !pendingRefresh.has(enrolledRepo)) return true;
  showInventoryRefreshFailure(enrolledRepo);
  renderStatus();
  return false;
}

function showInventoryRefreshFailure(enrolledRepo) {
  if (enrolledRepo) {
    failedRefreshes.add(enrolledRepo);
  } else {
    inventoryMessage = 'Could not load repositories.';
    inventoryFailed = true;
  }
}

search.addEventListener('input', () => filterRepositories());
search.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return;
  const first = list.querySelector('button');
  first?.focus();
  first?.click();
});
ownerFilter.addEventListener('change', () => filterRepositories(true));
stateFilter.addEventListener('change', () => filterRepositories(true));
window.addEventListener('hashchange', () => {
  if (!inventory.hidden) applyLocation();
});
element('clear-filters').addEventListener('click', () => {
  search.value = '';
  ownerFilter.value = '';
  stateFilter.value = '';
  syncOwnerFilter();
  syncStateFilter();
  if (!selected) showRepository(repositories[0]);
  renderList(repositories, true);
  setLocation();
  if (matchMedia('(max-width: 740px)').matches) (list.querySelector('[aria-pressed="true"]') ?? results).focus();
  else search.focus();
});
retry.addEventListener('click', () => {
  if (retry.dataset.retryRepo) void retryEnrollmentRefresh(retry.dataset.retryRepo);
  else void load(selected && label(selected));
});
dismissEnrollmentNotices.addEventListener('click', () => {
  const visibleRepo = selected && !detail.hidden && label(selected);
  for (const name of enrollmentNotices) {
    if (name !== visibleRepo) enrollmentNotices.delete(name);
  }
  focusRepositoryRow(visibleRepo);
  renderStatus();
});
element('logout').addEventListener('click', async () => {
  try {
    await request('dashboard/logout', {});
    location.reload();
  } catch {
    inventoryMessage = 'Could not sign out. Try again.';
    renderStatus();
  }
});

element('sign-in').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  inventoryMessage = '';
  renderStatus();
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
    inventoryMessage = 'GitHub sign-in could not be completed. Try again.';
    renderStatus();
  } finally {
    button.disabled = false;
    element('device').hidden = true;
    element('device-code').textContent = '';
  }
});

void load();
