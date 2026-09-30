'use strict';
const $ = (id) => document.getElementById(id);
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
const badge = (status) =>
  `<span class="badge ${escape(status)}">${escape(status.replaceAll('_', ' '))}</span>`;
function notice(message, failure = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('failure', failure);
  $('notice').hidden = !message;
}
function show(id) {
  for (const view of ['auth-view', 'groups-view', 'group-view']) $(view).hidden = view !== id;
  $('account-controls').hidden = !user;
  if (user) {
    $('welcome').textContent = user.name;
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
  try {
    await work();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
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
  $('action-title').textContent = title;
  $('action-description').textContent = description;
  $('action-fields').innerHTML = fields(items);
  $('action-error').textContent = '';
  $('action-submit').textContent = label;
  actionHandler = handler;
  $('action-dialog').showModal();
}
$('close-dialog').onclick = () => $('action-dialog').close();
$('action-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('action-submit');
  if (button.disabled) return;
  button.disabled = true;
  $('action-error').textContent = '';
  try {
    const values = Object.fromEntries(new FormData(event.target));
    await actionHandler(values);
    $('action-dialog').close();
  } catch (error) {
    $('action-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
function switchAuth(mode) {
  authMode = mode;
  $('login-tab').classList.toggle('selected', mode === 'login');
  $('signup-tab').classList.toggle('selected', mode === 'signup');
  $('name-field').hidden = mode !== 'signup';
  $('auth-name').required = mode === 'signup';
  $('password-hint').hidden = mode !== 'signup';
  $('auth-password').minLength = mode === 'signup' ? 12 : 1;
  $('auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('auth-heading').textContent = mode === 'signup' ? 'Start your shared record' : 'Welcome back';
  $('auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
  $('auth-error').textContent = '';
}
$('login-tab').onclick = () => switchAuth('login');
$('signup-tab').onclick = () => switchAuth('signup');
$('auth-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('auth-submit');
  if (button.disabled) return;
  button.disabled = true;
  $('auth-error').textContent = '';
  try {
    user = await post(`/auth/${authMode}`, Object.fromEntries(new FormData(event.target)));
    event.target.reset();
    await loadGroups();
  } catch (error) {
    $('auth-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$('logout-button').onclick = (event) =>
  busy(event.target, async () => {
    await post('/auth/logout');
    user = null;
    group = null;
    loadSequence++;
    show('auth-view');
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
async function loadGroups() {
  const sequence = ++loadSequence;
  show('groups-view');
  $('groups-list').innerHTML = '<p class="empty">Loading your groups…</p>';
  const groups = await request('/groups');
  if (sequence !== loadSequence) return;
  $('groups-list').innerHTML = groups.length
    ? groups
        .map(
          (g) =>
            `<button class="group-card" data-group="${escape(g.id)}">${badge(g.status)}<h2>${escape(g.name)}</h2><strong>${formatMoney(g.availableBalance)}</strong><p>Estimated ledger balance · not verified bank funds</p><p>${g.memberCount} members · ${escape(g.frequency)} · ${formatMoney(g.contributionAmount)} each</p></button>`,
        )
        .join('')
    : '<div class="panel empty">No groups yet. Create a savings circle or ask your administrator for an invite code.</div>';
}
$('groups-list').onclick = (event) => {
  const button = event.target.closest('[data-group]');
  if (button) busy(button, () => loadGroup(button.dataset.group));
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
      renderGroup();
      show('group-view');
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
      renderGroup();
      show('group-view');
    },
    'Join group',
  );
async function loadGroup(id = group?.id) {
  if (!id) return;
  const sequence = ++loadSequence;
  const result = await request(`/groups/${id}`);
  if (sequence !== loadSequence) return;
  group = result;
  order = [...group.payoutOrder];
  renderGroup();
  show('group-view');
}
function renderGroup() {
  order = [...group.payoutOrder];
  const admin = group.currentUser.role === 'admin',
    editable = ['draft', 'completed'].includes(group.status);
  $('group-heading').innerHTML =
    `<div><p class="eyebrow">${escape(group.frequency.toUpperCase())} SAVINGS CIRCLE</p><h1>${escape(group.name)}</h1>${badge(group.status)}</div><div class="actions">${admin && editable ? '<button class="primary" data-action="start">Start savings cycle</button><button class="quiet danger" data-action="archive">Archive group</button>' : ''}${group.status === 'review' ? '<button class="secondary" data-action="approve-review">Approve financial review</button>' : ''}</div>`;
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
        `<div class="obligation"><span>${escape(o.name)}${o.membershipId === group.currentUser.membershipId ? ' · you' : ''}</span><span class="amount">${o.due ? `${formatMoney(o.due)} due` : badge('paid')}<small>${formatMoney(o.paid)} confirmed</small></span></div>`,
    )
    .join('');
  const own = group.obligations.find((o) => o.membershipId === group.currentUser.membershipId);
  $('pay-button').hidden = group.status !== 'active';
  $('pay-button').disabled = !own?.due;
  renderRotation();
  const bankInfo = group.bankAccountConfigured
    ? `<p>${escape(group.accountName)}<br><span class="small">${escape(group.bankName)} · ${escape(group.accountNumber)}</span></p>`
    : '<p class="muted">No agreed bank account yet.</p>';
  $('bank-panel').innerHTML =
    `<h2>Group settlement account</h2>${bankInfo}<p class="small">All active members must approve an account proposal. Account details stay fixed during the cycle.</p>${admin && editable ? '<button class="secondary" data-action="bank">Propose bank account</button>' : ''}${group.bankChanges.map((p) => `<div class="bank-proposal"><strong>${escape(p.accountName)}</strong><p>${escape(p.bankName)} · ${escape(p.accountNumber)}</p><p>${p.approvals.length}/${group.members.length} member approvals</p><button class="quiet" data-action="approve-bank" data-id="${escape(p.id)}">Approve account / apply agreed change</button></div>`).join('')}`;
  const payout = group.pendingPayout;
  $('payout-panel').innerHTML =
    `<h2>Payout this round</h2>${payout ? `<p>${escape(group.payoutHistory.find((p) => p.id === payout.id)?.memberName)} · ${formatMoney(payout.amountKobo / 100)}</p>${badge(payout.status)}<p class="small">Transfer reference: ${escape(payout.transferReference)}</p>${payout.membershipId === group.currentUser.membershipId && ['awaiting_confirmation', 'disputed'].includes(payout.status) ? `<button class="primary" data-action="confirm-payout" data-id="${escape(payout.id)}">Confirm money received</button> <button class="quiet danger" data-action="dispute-payout" data-id="${escape(payout.id)}">I have not received it</button>` : ''}` : group.currentRecipient ? `<p>Next recipient: <strong>${escape(group.currentRecipient.name)}</strong></p><p>${formatMoney(group.contributionAmount * group.cycleSize)} · ${group.membersPaidThisRound.length}/${group.members.length} members fully paid</p>${admin ? '<button class="secondary" data-action="reconcile">Record settled bank balance</button><button class="primary full" data-action="payout">Record manual transfer</button>' : ''}` : '<p class="muted">Start a cycle to see the next recipient.</p>'}${admin && group.status === 'review' ? '<button class="secondary" data-action="reconcile">Record reviewed bank balance</button>' : ''}<p class="small">Ajo does not send this payout. Record your completed bank transfer, then the recipient confirms receipt.</p>`;
  $('members-panel').innerHTML =
    `<h2>Members & invitations</h2>${group.inviteCode && editable ? `<p class="small">Invite code: <strong>${escape(group.inviteCode)}</strong> <button class="quiet" data-action="copy">Copy</button></p>` : ''}${group.members.map((m) => `<div class="member-row"><span>${escape(m.name)} ${m.role === 'admin' ? badge('admin') : ''}</span>${admin && editable && m.role !== 'admin' ? `<span><button class="quiet" data-action="transfer-admin" data-id="${escape(m.membershipId)}">Make admin</button> · <button class="quiet danger" data-action="remove" data-id="${escape(m.membershipId)}">Remove</button></span>` : ''}</div>`).join('')}<p class="small">Removing a member keeps their financial history.</p>`;
  const recordTransfer = document.querySelector('[data-action="payout"]');
  if (recordTransfer) recordTransfer.disabled = !group.allPaidThisRound;
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
        `<li><span><span class="position">${index + 1}</span>${escape(group.members.find((m) => m.membershipId === id)?.name)} ${group.currentRecipient?.membershipId === id ? badge('next') : ''}</span>${editable ? `<span class="order-controls"><button data-move="${index}" data-direction="-1" aria-label="Move recipient up" ${index === 0 ? 'disabled' : ''}>↑</button><button data-move="${index}" data-direction="1" aria-label="Move recipient down" ${index === order.length - 1 ? 'disabled' : ''}>↓</button></span>` : ''}</li>`,
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
};
$('save-order').onclick = (event) =>
  busy(event.target, async () => {
    await request(`/groups/${group.id}/payout-order`, {
      method: 'PUT',
      body: JSON.stringify({ order }),
    });
    await loadGroup();
    notice('Payout order saved.');
  });
function renderRecords() {
  document
    .querySelectorAll('[data-record]')
    .forEach((button) => button.classList.toggle('selected', button.dataset.record === recordTab));
  let rows;
  if (recordTab === 'contributions')
    rows = [...group.contributions]
      .reverse()
      .map(
        (c) =>
          `<div class="record"><div><strong>${escape(c.memberName)}</strong><p>Round ${c.round + 1} · ${date(c.date)}</p><p>${escape(c.paymentReference)}</p>${badge(c.disputed ? 'disputed' : c.status)}${['initializing', 'pending', 'unknown'].includes(c.status) ? ` <button class="quiet" data-action="verify" data-id="${escape(c.paymentReference)}">Check payment</button>` : ''}${c.refundedAmount ? `<p>${formatMoney(c.refundedAmount)} refunded</p>` : ''}</div><span class="amount">${formatMoney(c.amount)}</span></div>`,
      );
  else if (recordTab === 'payouts')
    rows = [...group.payoutHistory]
      .reverse()
      .map(
        (p) =>
          `<div class="record"><div><strong>${escape(p.memberName)}</strong><p>Round ${p.round + 1} · ${date(p.date)}</p><p>${escape(p.transferReference || 'Historical record — unverified')}</p>${badge(p.status)}</div><span class="amount">${formatMoney(p.amount)}</span></div>`,
      );
  else
    rows = group.auditEvents.map(
      (a) =>
        `<div class="record"><div><strong>${escape(a.action.replaceAll('.', ' '))}</strong><p>${date(a.createdAt)}</p><p>${escape(JSON.stringify(a.data))}</p></div></div>`,
    );
  $('records').innerHTML = rows.length ? rows.join('') : '<p class="empty">No records yet.</p>';
}
document.querySelectorAll('[data-record]').forEach(
  (button) =>
    (button.onclick = () => {
      recordTab = button.dataset.record;
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
    request('/paystack/banks')
      .then((banks) => {
        $('field-bankCode').innerHTML =
          '<option value="">Choose bank</option>' +
          banks.map((b) => `<option value="${escape(b.code)}">${escape(b.name)}</option>`).join('');
      })
      .catch((error) => {
        $('action-error').textContent = error.message;
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
(async () => {
  try {
    user = await request('/auth/me');
    await loadGroups();
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
