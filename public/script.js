'use strict';
const $ = (id) => document.getElementById(id);
const UI = window.AjoUI;
let groupsCache = [],
  workspaceTab = 'round',
  dialogOpener = null;
let user = null,
  group = null,
  authMode = 'login',
  recordTab = 'contributions',
  order = [],
  loadSequence = 0,
  actionHandler;
const formatMoney = (amount) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(amount || 0);
const date = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-NG', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '—';
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const badge = UI.badge;
function notice(message, failure = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('failure', failure);
  $('notice').hidden = !message;
}
function show(id) {
  for (const view of ['auth-view', 'groups-view', 'group-view']) $(view).hidden = view !== id;
  $('boot-state').hidden = true;
  $('account-controls').hidden = !user;
  $('guest-note').hidden = Boolean(user);
  document.title =
    id === 'group-view' && group
      ? `${group.name} — Ajo`
      : id === 'groups-view'
        ? 'Your circles — Ajo'
        : 'Ajo — Your shared savings ledger';
  if (user) {
    $('welcome').textContent = user.name;
    $('account-initial').textContent = UI.initials(user.name);
    $('environment-label').hidden = user.paymentEnvironment !== 'test';
    $('greeting').textContent = `YOUR SHARED SAVINGS / ${user.name.split(' ')[0].toUpperCase()}`;
    $('verify-email-button').hidden = user.emailVerified;
  }
}
async function request(url, options = {}) {
  const headers = { ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (user?.csrfToken) headers['x-csrf-token'] = user.csrfToken;
  let response;
  try {
    response = await fetch(`/api${url}`, {
      ...options,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new Error(
      'Connection lost. Check your internet and refresh the ledger before trying a payment again.',
    );
  }
  const data =
    response.status === 204
      ? null
      : await response
          .json()
          .catch(() => ({ error: 'The service returned an unexpected response.' }));
  if (!response.ok) {
    if (response.status === 401) {
      loadSequence++;
      user = null;
      show('auth-view');
    }
    throw new Error(data?.error || 'Request failed.');
  }
  return data;
}
const post = (url, body = {}, headers = {}) =>
  request(url, { method: 'POST', body: JSON.stringify(body), headers });
async function busy(button, work) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await work();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}
function fields(items) {
  return items
    .map(
      ({
        name,
        label,
        type = 'text',
        required = true,
        value = '',
        min,
        step,
        maxlength,
        autocomplete,
      }) =>
        `<label for="field-${name}">${escape(label)}</label><input id="field-${name}" name="${name}" type="${type}" ${required ? 'required' : ''} value="${escape(value)}" ${min !== undefined ? `min="${min}"` : ''} ${step ? `step="${step}"` : ''} ${maxlength ? `maxlength="${maxlength}"` : ''} ${autocomplete ? `autocomplete="${autocomplete}"` : ''}>`,
    )
    .join('');
}
const passwordField = {
  name: 'password',
  label: 'Confirm your current password',
  type: 'password',
  autocomplete: 'current-password',
};
function dialog(title, description, items, handler, label = 'Continue') {
  dialogOpener = document.activeElement;
  $('account-menu').open = false;
  $('action-title').textContent = title;
  $('action-description').textContent = description;
  $('action-fields').innerHTML = fields(items);
  $('action-error').textContent = '';
  $('action-submit').textContent = label;
  actionHandler = handler;
  $('action-dialog').showModal();
  $('action-fields').querySelector('input, select')?.focus();
}
$('close-dialog').onclick = () => $('action-dialog').close();
$('action-dialog').addEventListener('cancel', (event) => {
  if ($('action-submit').disabled) event.preventDefault();
});
$('action-dialog').addEventListener('close', () => {
  if (dialogOpener?.isConnected && !dialogOpener.closest('[hidden]')) dialogOpener.focus();
  else
    document
      .querySelector('#group-view:not([hidden]) h1, #groups-view:not([hidden]) h1, #auth-heading')
      ?.focus();
});
$('action-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('action-submit');
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  $('close-dialog').disabled = true;
  const handler = actionHandler;
  $('action-error').textContent = '';
  try {
    const values = Object.fromEntries(new FormData(event.target));
    await handler(values);
    $('action-dialog').close();
  } catch (error) {
    $('action-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    $('close-dialog').disabled = false;
  }
};
function switchAuth(mode) {
  authMode = mode;
  UI.selectTab($('login-tab'), mode === 'login');
  UI.selectTab($('signup-tab'), mode === 'signup');
  $('auth-form').setAttribute('aria-labelledby', `${mode}-tab`);
  $('auth-description').textContent =
    mode === 'signup'
      ? 'Create your account, then start a circle or join your people.'
      : 'Your circles, contributions and next steps, in one place.';
  $('name-field').hidden = mode !== 'signup';
  $('auth-name').required = mode === 'signup';
  $('password-hint').hidden = mode !== 'signup';
  $('auth-password').minLength = mode === 'signup' ? 12 : 1;
  $('auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('auth-heading').textContent = mode === 'signup' ? 'Start something together.' : 'Welcome back.';
  $('auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
  $('auth-error').textContent = '';
  $('auth-password').type = 'password';
  $('show-password').textContent = 'Show';
  $('show-password').setAttribute('aria-label', 'Show password');
  $('show-password').setAttribute('aria-pressed', 'false');
}
$('login-tab').onclick = () => switchAuth('login');
$('signup-tab').onclick = () => switchAuth('signup');
$('auth-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('auth-submit');
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  $('auth-error').textContent = '';
  try {
    user = await post(`/auth/${authMode}`, Object.fromEntries(new FormData(event.target)));
    event.target.reset();
    notice('');
    await openLocation();
    if (!$('group-view').hidden) $('group-heading').querySelector('h1').focus();
    else $('groups-title').focus();
  } catch (error) {
    $('auth-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
};
$('logout-button').onclick = (event) =>
  busy(event.target, async () => {
    await post('/auth/logout');
    user = null;
    group = null;
    loadSequence++;
    $('account-menu').open = false;
    setRoute('');
    show('auth-view');
    $('auth-email').focus();
    notice('');
  });
$('verify-email-button').onclick = (event) =>
  busy(event.target, async () => {
    const result = await post('/auth/send-verification');
    notice(result.message);
  });
$('forgot-password-button').onclick = () =>
  dialog(
    'Reset password',
    'We will email a reset link if your account exists and email delivery is configured.',
    [{ name: 'email', label: 'Email address', type: 'email', autocomplete: 'email' }],
    async (values) => {
      const result = await post('/auth/forgot-password', values);
      notice(result.message);
    },
    'Send reset link',
  );
$('password-button').onclick = () =>
  dialog(
    'Change password',
    'All existing sessions will be signed out.',
    [
      passwordField,
      {
        name: 'newPassword',
        label: 'New password (at least 12 characters)',
        type: 'password',
        autocomplete: 'new-password',
      },
    ],
    async (values) => {
      await post('/auth/password', values);
      user = null;
      group = null;
      show('auth-view');
      notice('Password changed. Log in with your new password.');
    },
    'Change password',
  );
function setRoute(hash) {
  if (location.hash !== hash) history.pushState({}, '', location.pathname + hash);
}
function setWorkspace(tab, navigate = true) {
  workspaceTab = ['round', 'ledger', 'details'].includes(tab) ? tab : 'round';
  document.querySelectorAll('[data-workspace]').forEach((button) => {
    const selected = button.dataset.workspace === workspaceTab;
    UI.selectTab(button, selected);
    $(`view-${button.dataset.workspace}`).hidden = !selected;
  });
  if (navigate && group) setRoute(`#group=${encodeURIComponent(group.id)}&view=${workspaceTab}`);
}
function renderDirectory() {
  const query = $('group-search').value.trim().toLocaleLowerCase();
  const status = $('group-filter').value;
  const visible = groupsCache.filter(
    (g) =>
      (!query || g.name.toLocaleLowerCase().includes(query)) &&
      (status === 'all' || g.status === status),
  );
  $('group-count').textContent = `${visible.length} of ${groupsCache.length} circles`;
  $('groups-list').innerHTML = visible.length
    ? visible.map(UI.groupRow).join('')
    : groupsCache.length
      ? UI.empty('No matching circles.', 'Try a different name or status.') +
        '<div class="empty compact"><button class="secondary" data-directory="clear">Clear filters</button></div>'
      : UI.empty(
          'Your first circle starts here.',
          'Create a group with people you know, or join an existing group using their invite code.',
        ) +
        '<div class="empty compact"><div class="actions"><button class="primary" data-directory="create">Create a circle</button><button class="secondary" data-directory="join">Join with a code</button></div></div>';
}
async function loadGroups(navigate = true) {
  const sequence = ++loadSequence;
  show('groups-view');
  if (navigate) setRoute('');
  $('directory-tools').hidden = true;
  $('directory-summary').textContent = '';
  $('groups-list').setAttribute('aria-busy', 'true');
  $('groups-list').innerHTML =
    '<p class="loading-caption"><span class="loading-line" aria-hidden="true"></span> Loading your circles…</p><div class="loading-row" aria-hidden="true"><span class="skeleton"></span></div><div class="loading-row" aria-hidden="true"><span class="skeleton"></span></div>';
  try {
    const groups = await request('/groups');
    if (sequence !== loadSequence) return;
    groupsCache = groups;
    $('directory-tools').hidden = groups.length < 2;
    if (groups.length < 2) {
      $('group-search').value = '';
      $('group-filter').value = 'all';
    }
    const active = groups.filter((g) => g.status === 'active').length;
    const review = groups.filter((g) => g.status === 'review').length;
    $('directory-summary').innerHTML =
      `<span><strong>${groups.length}</strong> ${groups.length === 1 ? 'circle' : 'circles'}</span><span><strong>${active}</strong> active</span>${review ? `<span class="needs-review"><strong>${review}</strong> needing review</span>` : ''}`;
    renderDirectory();
  } catch (error) {
    if (sequence !== loadSequence) return;
    $('groups-list').innerHTML =
      UI.empty('Your circles couldn’t load.', error.message) +
      '<div class="empty compact"><button class="secondary" data-directory="retry">Try again</button></div>';
  } finally {
    if (sequence === loadSequence) $('groups-list').removeAttribute('aria-busy');
  }
}
$('groups-list').onclick = (event) => {
  const button = event.target.closest('[data-group]');
  if (button) busy(button, () => loadGroup(button.dataset.group));
  const action = event.target.closest('[data-directory]')?.dataset.directory;
  if (action === 'create') $('create-button').click();
  if (action === 'join') $('join-button').click();
  if (action === 'retry') loadGroups();
  if (action === 'clear') {
    $('group-search').value = '';
    $('group-filter').value = 'all';
    renderDirectory();
  }
};
$('back-button').onclick = (event) => busy(event.target, loadGroups);
$('create-button').onclick = () => {
  dialog(
    'Create a savings group',
    'Start in draft. Add members and agree on a bank account before opening contributions.',
    [
      { name: 'name', label: 'Group name', maxlength: 80 },
      {
        name: 'contributionAmount',
        label: 'Contribution per member (₦)',
        type: 'number',
        min: 1,
        step: '0.01',
      },
    ],
    async (values) => {
      values.frequency = $('field-frequency').value;
      group = await post('/groups', values);
      workspaceTab = 'round';
      renderGroup();
      show('group-view');
      setWorkspace('round');
    },
    'Create group',
  );
  $('action-fields').insertAdjacentHTML(
    'beforeend',
    '<label for="field-frequency">Frequency</label><select id="field-frequency"><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="daily">Daily</option></select>',
  );
};
$('join-button').onclick = () =>
  dialog(
    'Join a group',
    'You can join before a cycle starts or after it finishes.',
    [{ name: 'inviteCode', label: 'Invite code', maxlength: 10 }],
    async (values) => {
      group = await post('/groups/join', values);
      workspaceTab = 'round';
      renderGroup();
      show('group-view');
      setWorkspace('round');
    },
    'Join group',
  );
async function loadGroup(id = group?.id, navigate = true) {
  if (!id) return;
  const sequence = ++loadSequence;
  const result = await request(`/groups/${id}`);
  if (sequence !== loadSequence) return;
  if (group?.id !== id) {
    workspaceTab = 'round';
    $('record-search').value = '';
    recordTab = 'contributions';
  }
  group = result;
  order = [...group.payoutOrder];
  renderGroup();
  show('group-view');
  setWorkspace(workspaceTab, navigate);
  if (navigate) {
    $('group-heading').querySelector('h1').focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
}
function renderGroup() {
  order = [...group.payoutOrder];
  const admin = group.currentUser.role === 'admin',
    editable = ['draft', 'completed'].includes(group.status);
  $('group-role').textContent = admin ? 'Administrator view' : 'Member view';
  $('group-heading').innerHTML =
    `<div><p class="eyebrow">${escape(group.frequency.toUpperCase())} / ${formatMoney(group.contributionAmount)} PER MEMBER</p><h1 tabindex="-1">${escape(group.name)}</h1></div><div>${badge(group.status)}</div>`;
  $('management-panel').innerHTML =
    `<p class="eyebrow">CIRCLE MANAGEMENT</p><h2>${editable ? 'Ready for the next chapter?' : 'The agreements that keep us together.'}</h2><p class="small">${admin ? 'The roster, bank account and payout order stay fixed during an active cycle. Changes between cycles are visible to the group.' : 'Your administrator coordinates cycle changes. All members approve the settlement account.'}</p><div class="actions">${admin && editable ? '<button class="primary" data-action="start">Start savings cycle</button><button class="quiet danger" data-action="archive">Archive group</button>' : ''}${group.status === 'review' ? '<button class="secondary" data-action="approve-review">Approve financial review</button>' : ''}</div>`;
  const metrics = [
    [
      'Estimated ledger balance',
      group.availableBalance,
      'Confirmed contributions less recorded payouts',
      true,
    ],
    ['Collected this round', group.roundCollected, 'Net confirmed contributions', false],
    ['Outstanding this round', group.outstandingAmount, 'Remaining member obligations', false],
    ['Confirmed payouts', group.totalPaidOut, 'Lifetime recorded disbursements', false],
  ];
  $('group-summary').innerHTML = metrics
    .map(
      ([title, amount, hint, featured]) =>
        `<div class="metric ${featured ? 'featured' : ''}"><span>${title}</span><strong>${formatMoney(amount)}</strong><small>${hint}</small></div>`,
    )
    .join('');
  const guidance = {
    draft:
      'Agree on the roster, bank account and payout order. Start the cycle when everyone is ready.',
    active:
      'The roster, payout order and bank account are fixed for this cycle. Funds settle into the nominated account; the ledger is not a bank balance.',
    completed:
      'This cycle is complete. You can adjust the roster and order before starting the next cycle.',
    review:
      'Financial review required. Contributions and new payouts are paused. Check the activity record and reconcile disputed or historical transactions with the operator.',
    archived:
      'This group is archived. Its financial history remains available for reference and export.',
  };
  $('group-guidance').textContent =
    guidance[group.status] || 'Review this group’s financial state.';
  $('due-label').textContent =
    group.status === 'active' ? `Round ${group.currentRound + 1} · Due ${date(group.dueAt)}` : '';
  $('obligations').innerHTML = group.obligations
    .map(
      (o) =>
        `<div class="obligation ${o.membershipId === group.currentUser.membershipId ? 'is-you' : ''}"><span><span class="avatar" aria-hidden="true">${escape(UI.initials(o.name))}</span><span class="obligation-name">${escape(o.name)}${o.membershipId === group.currentUser.membershipId ? '<span class="you-label">you</span>' : ''}</span></span><span class="amount">${o.due ? `${formatMoney(o.due)} due` : badge('paid')}<small>${formatMoney(o.paid)} confirmed</small></span></div>`,
    )
    .join('');
  const own = group.obligations.find((o) => o.membershipId === group.currentUser.membershipId);
  const next = UI.nextStep(group);
  $('next-step-title').textContent = next.title;
  $('next-step-copy').textContent = next.copy;
  $('pay-button').hidden = !next.pay;
  $('pay-button').disabled = !own?.due;
  $('pay-button').textContent = 'Make my contribution ↗';
  $('next-step-button').hidden = !next.target;
  $('next-step-button').textContent = next.label || '';
  $('next-step-button').onclick = () => {
    if (next.target === 'payout') {
      $('payout-panel').tabIndex = -1;
      $('payout-panel').focus();
      $('payout-panel').scrollIntoView({ block: 'center' });
    } else {
      setWorkspace(next.target);
      $(`tab-${next.target}`).focus();
    }
  };
  const paid = group.membersPaidThisRound.length;
  $('round-progress').innerHTML =
    group.status === 'active'
      ? `<div class="progress-label"><span>${paid} of ${group.obligations.length} fully contributed</span><span>${Math.round((paid / Math.max(1, group.obligations.length)) * 100)}%</span></div><progress class="round-progress" value="${paid}" max="${Math.max(1, group.obligations.length)}" aria-label="Members who have completed this round’s contribution"></progress>`
      : '';
  $('rotation-caption').textContent =
    group.status === 'active'
      ? `Turn ${group.currentRound - group.cycleStartRound + 1} of ${group.cycleSize}. The agreed order stays fixed until the cycle ends.`
      : editable
        ? 'Agree on the order before starting. Changes can only be made between cycles.'
        : 'The agreed payout sequence is preserved with the group record.';
  if (group.status !== 'active' && !group.obligations.length)
    $('obligations').innerHTML = UI.empty(
      'A new round starts with agreement.',
      'Contributions open when your administrator starts the cycle.',
      true,
    );
  setWorkspace(workspaceTab, false);
  renderRotation();
  $('bank-panel').innerHTML = UI.bankPanel(group);
  $('payout-panel').innerHTML = UI.payoutPanel(group);
  $('members-panel').innerHTML = UI.membersPanel(group);
  const recordTransfer = document.querySelector('[data-action="payout"]');
  if (recordTransfer) {
    recordTransfer.disabled = !group.allPaidThisRound;
    if (!group.allPaidThisRound)
      recordTransfer.insertAdjacentHTML(
        'afterend',
        '<p class="small">Available once every member has completed their contribution.</p>',
      );
  }
  $('export-link').href = `/api/groups/${group.id}/export`;
  renderRecords();
}
function renderRotation() {
  const editable =
    group.currentUser.role === 'admin' && ['draft', 'completed'].includes(group.status);
  $('save-order').hidden = !editable;
  $('rotation').innerHTML = order
    .map(
      (id, index) =>
        `<li class="${group.status === 'active' && index === group.currentRound - group.cycleStartRound ? 'current' : group.status === 'active' && index < group.currentRound - group.cycleStartRound ? 'completed' : ''}"><span><span class="position">${index + 1}</span>${escape(group.members.find((m) => m.membershipId === id)?.name)} ${group.currentRecipient?.membershipId === id ? badge('next') : ''}</span>${editable ? `<span class="order-controls"><button data-move="${index}" data-direction="-1" aria-label="Move ${escape(group.members.find((m) => m.membershipId === id)?.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button><button data-move="${index}" data-direction="1" aria-label="Move ${escape(group.members.find((m) => m.membershipId === id)?.name)} down" ${index === order.length - 1 ? 'disabled' : ''}>↓</button></span>` : ''}</li>`,
    )
    .join('');
}
$('rotation').onclick = (event) => {
  const button = event.target.closest('[data-move]');
  if (!button) return;
  const from = Number(button.dataset.move),
    to = from + Number(button.dataset.direction);
  [order[from], order[to]] = [order[to], order[from]];
  renderRotation();
  const direction = to === 0 ? '1' : to === order.length - 1 ? '-1' : button.dataset.direction;
  document.querySelector(`[data-move="${to}"][data-direction="${direction}"]`)?.focus();
  $('order-notice').textContent = 'Order changed. Save it to share with your circle.';
};
$('save-order').onclick = (event) =>
  busy(event.target, async () => {
    await request(`/groups/${group.id}/payout-order`, {
      method: 'PUT',
      body: JSON.stringify({ order }),
    });
    await loadGroup();
    $('order-notice').textContent = 'Payout order saved.';
    $('save-order').focus();
    notice('Payout order saved.');
  });
function renderRecords() {
  document
    .querySelectorAll('[data-record]')
    .forEach((button) => UI.selectTab(button, button.dataset.record === recordTab));
  $('records').setAttribute('aria-labelledby', `record-${recordTab}`);
  let rows;
  if (recordTab === 'contributions')
    rows = [...group.contributions]
      .reverse()
      .map(
        (c) =>
          `<div class="record"><div><strong>${escape(c.memberName)}</strong><p>Round ${c.round + 1} · ${date(c.date)}</p><p class="reference">${escape(c.paymentReference)}</p>${badge(c.disputed ? 'disputed' : c.status)}${['initializing', 'pending', 'unknown'].includes(c.status) ? ` <button class="quiet" data-action="verify" data-id="${escape(c.paymentReference)}">Check payment</button>` : ''}${c.refundedAmount ? `<p>${formatMoney(c.refundedAmount)} refunded</p>` : ''}</div><span class="amount">${formatMoney(c.amount)}</span></div>`,
      );
  else if (recordTab === 'payouts')
    rows = [...group.payoutHistory]
      .reverse()
      .map(
        (p) =>
          `<div class="record"><div><strong>${escape(p.memberName)}</strong><p>Round ${p.round + 1} · ${date(p.date)}</p><p class="reference">${escape(p.transferReference || 'Historical record — unverified')}</p>${badge(p.status)}</div><span class="amount">${formatMoney(p.amount)}</span></div>`,
      );
  else
    rows = group.auditEvents.map(
      (a) =>
        `<div class="record"><div><strong>${escape(UI.activity(a))}</strong><p>${date(a.createdAt)}</p><details><summary>Record details</summary><pre>${escape(JSON.stringify(a.data, null, 2))}</pre></details></div></div>`,
    );
  const query = $('record-search').value.trim().toLocaleLowerCase();
  if (query)
    rows = rows.filter((row) => {
      const template = document.createElement('template');
      template.innerHTML = row;
      return template.content.textContent.toLocaleLowerCase().includes(query);
    });
  const emptyCopy =
    recordTab === 'contributions'
      ? 'Confirmed and pending contributions will appear here, with a reference for each payment.'
      : recordTab === 'payouts'
        ? 'Completed transfers and recipient confirmations will appear here.'
        : 'Changes to the circle will appear here as they happen.';
  $('records').innerHTML = rows.length
    ? rows.join('')
    : UI.empty(
        query ? 'No matching records.' : 'The record starts here.',
        query ? 'Try another name or reference. Search covers displayed records only.' : emptyCopy,
        true,
      );
}
document.querySelectorAll('[data-record]').forEach(
  (button) =>
    (button.onclick = () => {
      recordTab = button.dataset.record;
      $('record-search').value = '';
      renderRecords();
    }),
);
$('pay-button').onclick = () => {
  const own = group.obligations.find((o) => o.membershipId === group.currentUser.membershipId);
  const target = group.id,
    round = group.currentRound;
  dialog(
    'Make your contribution',
    'Your payment goes through Paystack to the agreed group account. Pending payments reserve your obligation until verified.',
    [{ name: 'amount', label: 'Amount (₦)', type: 'number', min: 1, step: '0.01', value: own.due }],
    async (values) => {
      const storageKey = `ajo-payment:${user.id}:${target}:${round}:${values.amount}`;
      let key = sessionStorage.getItem(storageKey);
      if (!key) {
        key = crypto.randomUUID();
        sessionStorage.setItem(storageKey, key);
      }
      const payment = await post(`/groups/${target}/contributions/initiate`, values, {
        'idempotency-key': key,
      });
      window.location.assign(payment.authorizationUrl);
    },
    user.paymentEnvironment === 'test' ? 'Open test checkout' : 'Open Paystack checkout',
  );
};
$('group-view').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action,
    id = button.dataset.id,
    target = group.id;
  const refreshed = async (p, values, headers) => {
    await post(`/groups/${target}${p}`, values, headers);
    await loadGroup(target);
  };
  if (action === 'approve-review')
    dialog(
      'Approve financial review',
      'Confirm you and the group have checked the historical ledger, payouts and current bank statement. All active members must approve the same matching bank attestation.',
      [passwordField],
      (values) => refreshed('/review/approve', values),
      'Approve reviewed records',
    );
  if (action === 'start')
    dialog(
      'Start savings cycle',
      'The roster, bank account and payout order will be fixed until every member has received their turn.',
      [passwordField],
      (values) => refreshed('/start', values),
      'Start cycle',
    );
  if (action === 'archive')
    dialog(
      'Archive group',
      'The group will close to new activity. All financial history remains available.',
      [passwordField],
      async (values) => {
        await request(`/groups/${target}`, { method: 'DELETE', body: JSON.stringify(values) });
        await loadGroups();
      },
      'Archive group',
    );
  if (action === 'bank') {
    dialog(
      'Propose settlement account',
      'The account holder’s name will be verified. All active members must approve before this account is used.',
      [{ name: 'accountNumber', label: '10-digit account number', maxlength: 10 }, passwordField],
      (values) => refreshed('/bank-details', values),
      'Verify & propose',
    );
    $('action-fields').insertAdjacentHTML(
      'afterbegin',
      '<label for="field-bankCode">Bank</label><select id="field-bankCode" name="bankCode" required><option value="">Loading banks…</option></select>',
    );
    const bankSelect = $('field-bankCode');
    request('/paystack/banks')
      .then((banks) => {
        if (!bankSelect.isConnected) return;
        bankSelect.innerHTML =
          '<option value="">Choose bank</option>' +
          banks.map((b) => `<option value="${escape(b.code)}">${escape(b.name)}</option>`).join('');
      })
      .catch((error) => {
        if (bankSelect.isConnected)
          $('action-error').textContent = error.message + ' Close this form and try again.';
      });
  }
  if (action === 'approve-bank')
    dialog(
      'Approve bank account',
      'Check the account holder and bank with your group before approving. The last approval applies the account.',
      [passwordField],
      (values) => refreshed(`/bank-changes/${id}/approve`, values),
      'Approve',
    );
  if (action === 'transfer-admin')
    dialog(
      'Transfer administrator role',
      'The selected member becomes administrator. You become a regular member. This change is recorded for the whole group.',
      [passwordField],
      (values) => refreshed('/administrator', { ...values, membershipId: id }),
      'Transfer role',
    );
  if (action === 'remove')
    dialog(
      'Remove member',
      'Only allowed between cycles. Their contributions and payouts will remain in the record.',
      [passwordField],
      async (values) => {
        await request(`/groups/${target}/members/${id}`, {
          method: 'DELETE',
          body: JSON.stringify(values),
        });
        await loadGroup(target);
      },
      'Remove member',
    );
  if (action === 'reconcile')
    dialog(
      'Record settled bank balance',
      'Check the nominated bank account first. This is your bank-balance attestation, not an automatic bank verification.',
      [
        {
          name: 'balance',
          label: 'Settled balance available to this group (₦)',
          type: 'number',
          min: 0,
          step: '0.01',
        },
        {
          name: 'statementReference',
          label: 'Bank statement / evidence reference',
          maxlength: 120,
        },
        passwordField,
      ],
      (values) => refreshed('/reconcile', values),
      'Record balance',
    );
  if (action === 'payout') {
    const expectedRound = group.currentRound,
      key = crypto.randomUUID();
    dialog(
      'Record a completed transfer',
      `Confirm you have transferred ${formatMoney(group.contributionAmount * group.cycleSize)} to ${group.currentRecipient?.name}. The round advances only when they confirm receipt.`,
      [
        { name: 'transferReference', label: 'Bank transfer reference', maxlength: 120 },
        passwordField,
      ],
      (values) => refreshed('/payout', { ...values, expectedRound }, { 'idempotency-key': key }),
      'Record transfer',
    );
  }
  if (action === 'confirm-payout')
    dialog(
      'Confirm payout received',
      'Only confirm after the money appears in your bank account.',
      [passwordField],
      (values) => refreshed(`/payouts/${id}/confirm`, values),
      'Confirm receipt',
    );
  if (action === 'dispute-payout')
    dialog(
      'Report an unreceived payout',
      'The group will pause for financial review. This report stays in the activity record.',
      [{ name: 'reason', label: 'What happened?', maxlength: 500 }],
      (values) => refreshed(`/payouts/${id}/dispute`, values),
      'Report problem',
    );
  if (action === 'verify')
    busy(button, async () => {
      const result = await post(`/groups/${target}/payments/${id}/verify`);
      await loadGroup(target);
      notice(`Payment status: ${result.status}.`);
    });
  if (action === 'copy')
    busy(button, async () => {
      await navigator.clipboard.writeText(group.inviteCode);
      notice('Invite code copied.');
    });
});
$('show-password').onclick = () => {
  const visible = $('auth-password').type === 'password';
  $('auth-password').type = visible ? 'text' : 'password';
  $('show-password').textContent = visible ? 'Hide' : 'Show';
  $('show-password').setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  $('show-password').setAttribute('aria-pressed', String(visible));
};
$('group-search').oninput = renderDirectory;
$('group-filter').onchange = renderDirectory;
$('record-search').oninput = renderRecords;
$('refresh-group').onclick = (event) =>
  busy(event.currentTarget, async () => {
    await loadGroup(group.id, false);
    notice('Circle records refreshed.');
  });
document
  .querySelectorAll('[data-workspace]')
  .forEach((button) => (button.onclick = () => setWorkspace(button.dataset.workspace)));
document.querySelectorAll('[role="tablist"]').forEach(UI.keyboardTabs);
document.addEventListener('click', (event) => {
  if (!event.target.closest('.account-menu')) $('account-menu').open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('account-menu').open) {
    $('account-menu').open = false;
    $('account-menu').querySelector('summary').focus();
  }
});
async function openLocation() {
  const route = new URLSearchParams(location.hash.slice(1));
  if (!user) return;
  try {
    if (route.has('group')) {
      await loadGroup(route.get('group'), false);
      setWorkspace(route.get('view') || 'round', false);
    } else await loadGroups(false);
  } catch (error) {
    await loadGroups(false);
    notice(error.message, true);
  }
}
window.addEventListener('popstate', () => {
  if (!$('action-submit').disabled) {
    $('action-dialog').close();
    openLocation();
  }
});
(async () => {
  try {
    user = await request('/auth/me');
    await openLocation();
    if (user.paymentEnvironment === 'test')
      notice('Test payment mode. No real money is collected.');
  } catch (error) {
    show('auth-view');
    if (error.message !== 'Please log in.') notice(error.message, true);
  }
  const link = new URLSearchParams(location.hash.slice(1));
  if (link.has('verify')) {
    const token = link.get('verify');
    history.replaceState({}, '', location.pathname);
    try {
      const result = await post('/auth/verify', { token });
      notice(result.message);
      if (user) {
        user = await request('/auth/me');
        show('groups-view');
      }
    } catch (error) {
      notice(error.message, true);
    }
  }
  if (link.has('reset')) {
    const token = link.get('reset');
    history.replaceState({}, '', location.pathname);
    dialog(
      'Set a new password',
      'Use at least 12 characters. Existing sessions will be signed out.',
      [
        {
          name: 'newPassword',
          label: 'New password',
          type: 'password',
          autocomplete: 'new-password',
        },
      ],
      async (values) => {
        const result = await post('/auth/reset', { ...values, token });
        user = null;
        show('auth-view');
        notice(result.message);
      },
      'Reset password',
    );
  }
  const params = new URLSearchParams(location.search);
  if (params.has('payment')) {
    history.replaceState({}, '', location.pathname);
    notice(
      'Returned from checkout. Open your group and check the contribution record for the verified payment status.',
    );
  }
})();
