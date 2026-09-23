// script.js — Ajo Savings Tracker frontend (multi-user)
// Talks to the Node/Express + Postgres API via fetch, with httpOnly-cookie auth.

const API = '/api';
const fetchOpts = (opts = {}) => ({ credentials: 'include', ...opts });
const jsonHeaders = { 'Content-Type': 'application/json' };

// ---- state ----
let currentUser = null;
let currentGroupId = null;
let currentGroupData = null;
let pendingOrder = null;

// ---- element refs ----
const authView = document.getElementById('auth-view');
const groupsView = document.getElementById('groups-view');
const groupView = document.getElementById('group-view');

const tabLogin = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const loginError = document.getElementById('login-error');
const signupError = document.getElementById('signup-error');

const welcomeMsg = document.getElementById('welcome-msg');
const logoutBtn = document.getElementById('logout-btn');

const joinGroupBtn = document.getElementById('join-group-btn');
const joinGroupForm = document.getElementById('join-group-form');
const cancelJoinGroup = document.getElementById('cancel-join-group');
const joinCodeInput = document.getElementById('join-code-input');
const joinError = document.getElementById('join-error');

const newGroupBtn = document.getElementById('new-group-btn');
const newGroupForm = document.getElementById('new-group-form');
const cancelNewGroup = document.getElementById('cancel-new-group');
const groupNameInput = document.getElementById('group-name-input');
const groupAmountInput = document.getElementById('group-amount-input');
const groupFrequencyInput = document.getElementById('group-frequency-input');
const groupsGrid = document.getElementById('groups-grid');
const groupsEmpty = document.getElementById('groups-empty');

const backBtn = document.getElementById('back-btn');
const deleteGroupBtn = document.getElementById('delete-group-btn');
const groupTitle = document.getElementById('group-title');
const groupMeta = document.getElementById('group-meta');
const inviteBanner = document.getElementById('invite-banner');
const inviteCodeText = document.getElementById('invite-code-text');
const copyInviteBtn = document.getElementById('copy-invite-btn');

const bankSetupCard = document.getElementById('bank-setup-card');
const bankConfiguredText = document.getElementById('bank-configured-text');
const bankDetailsForm = document.getElementById('bank-details-form');
const bankSelect = document.getElementById('bank-select');
const accountNumberInput = document.getElementById('account-number-input');
const bankError = document.getElementById('bank-error');
const bankMissingBanner = document.getElementById('bank-missing-banner');
const contributionCard = document.getElementById('contribution-card');

let banksLoaded = false;

const metricPool = document.getElementById('metric-pool');
const metricMembers = document.getElementById('metric-members');
const metricRecipient = document.getElementById('metric-recipient');
const metricRound = document.getElementById('metric-round');

const membersList = document.getElementById('members-list');
const payoutOrderList = document.getElementById('payout-order-list');
const saveOrderBtn = document.getElementById('save-order-btn');

const contributionForm = document.getElementById('contribution-form');
const contributionAmountInput = document.getElementById('contribution-amount-input');

const payoutStatus = document.getElementById('payout-status');
const recordPayoutBtn = document.getElementById('record-payout-btn');

const ledgerList = document.getElementById('ledger-list');
const historyList = document.getElementById('history-list');

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str ?? ''; return div.innerHTML; }
function showView(view) {
  [authView, groupsView, groupView].forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

// =========================================================================
// AUTH
// =========================================================================

tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active');
  tabSignup.classList.remove('active');
  loginForm.classList.remove('hidden');
  signupForm.classList.add('hidden');
});
tabSignup.addEventListener('click', () => {
  tabSignup.classList.add('active');
  tabLogin.classList.remove('active');
  signupForm.classList.remove('hidden');
  loginForm.classList.add('hidden');
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const res = await fetch(`${API}/auth/login`, fetchOpts({
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email, password }),
  }));
  if (res.ok) {
    currentUser = await res.json();
    loginForm.reset();
    await enterApp();
  } else {
    const err = await res.json().catch(() => ({}));
    loginError.textContent = err.error || 'Could not log in.';
    loginError.classList.remove('hidden');
  }
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  signupError.classList.add('hidden');
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const res = await fetch(`${API}/auth/signup`, fetchOpts({
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name, email, password }),
  }));
  if (res.ok) {
    currentUser = await res.json();
    signupForm.reset();
    await enterApp();
  } else {
    const err = await res.json().catch(() => ({}));
    signupError.textContent = err.error || 'Could not create account.';
    signupError.classList.remove('hidden');
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch(`${API}/auth/logout`, fetchOpts({ method: 'POST' }));
  currentUser = null;
  showView(authView);
});

async function checkAuth() {
  try {
    const res = await fetch(`${API}/auth/me`, fetchOpts());
    if (res.ok) {
      currentUser = await res.json();
      await enterApp();
    } else {
      showView(authView);
    }
  } catch (e) {
    showView(authView);
  }
}

async function enterApp() {
  welcomeMsg.textContent = `Hi, ${currentUser.name}`;
  showView(groupsView);
  await fetchGroups();
}

// =========================================================================
// GROUPS LIST
// =========================================================================

async function fetchGroups() {
  const res = await fetch(`${API}/groups`, fetchOpts());
  if (res.status === 401) { showView(authView); return; }
  const groups = await res.json();
  renderGroupsGrid(groups);
}

function renderGroupsGrid(groups) {
  groupsGrid.innerHTML = '';
  groupsEmpty.classList.toggle('hidden', groups.length > 0);
  groups.forEach((g) => {
    const div = document.createElement('div');
    div.className = 'group-card';
    div.innerHTML = `
      <h3>${escapeHtml(g.name)} ${g.myRole === 'admin' ? '<span class="badge current">Admin</span>' : ''}</h3>
      <p class="pool">${naira(g.totalPool)}</p>
      <p class="stat">${g.memberCount} member${g.memberCount === 1 ? '' : 's'} · ${escapeHtml(g.frequency)}</p>
      <p class="stat">${naira(g.contributionAmount)} per member · Round #${g.currentRound + 1}</p>
    `;
    div.addEventListener('click', () => openGroup(g.id));
    groupsGrid.appendChild(div);
  });
}

newGroupBtn.addEventListener('click', () => { newGroupForm.classList.toggle('hidden'); joinGroupForm.classList.add('hidden'); });
cancelNewGroup.addEventListener('click', () => { newGroupForm.reset(); newGroupForm.classList.add('hidden'); });
joinGroupBtn.addEventListener('click', () => { joinGroupForm.classList.toggle('hidden'); newGroupForm.classList.add('hidden'); });
cancelJoinGroup.addEventListener('click', () => { joinGroupForm.reset(); joinGroupForm.classList.add('hidden'); joinError.classList.add('hidden'); });

newGroupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: groupNameInput.value.trim(),
    contributionAmount: parseFloat(groupAmountInput.value),
    frequency: groupFrequencyInput.value,
  };
  const res = await fetch(`${API}/groups`, fetchOpts({ method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload) }));
  if (res.ok) {
    newGroupForm.reset();
    newGroupForm.classList.add('hidden');
    fetchGroups();
  } else {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Could not create group.');
  }
});

joinGroupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  joinError.classList.add('hidden');
  const res = await fetch(`${API}/groups/join`, fetchOpts({
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ inviteCode: joinCodeInput.value.trim() }),
  }));
  if (res.ok) {
    joinGroupForm.reset();
    joinGroupForm.classList.add('hidden');
    fetchGroups();
  } else {
    const err = await res.json().catch(() => ({}));
    joinError.textContent = err.error || 'Could not join that group.';
    joinError.classList.remove('hidden');
  }
});

backBtn.addEventListener('click', () => {
  currentGroupId = null;
  showView(groupsView);
  fetchGroups();
});

deleteGroupBtn.addEventListener('click', async () => {
  if (!currentGroupId) return;
  if (!confirm('Delete this group for everyone? This cannot be undone.')) return;
  const res = await fetch(`${API}/groups/${currentGroupId}`, fetchOpts({ method: 'DELETE' }));
  if (res.ok || res.status === 204) backBtn.click();
});

// =========================================================================
// GROUP DETAIL
// =========================================================================

async function openGroup(id) {
  currentGroupId = id;
  showView(groupView);
  await fetchGroupDetail();
}

async function fetchGroupDetail() {
  if (!currentGroupId) return;
  const res = await fetch(`${API}/groups/${currentGroupId}`, fetchOpts());
  if (!res.ok) { alert('Group not found.'); backBtn.click(); return; }
  currentGroupData = await res.json();
  pendingOrder = [...currentGroupData.payoutOrder];
  renderGroupDetail(currentGroupData);
}

function renderGroupDetail(g) {
  const isAdmin = g.currentUser.role === 'admin';

  groupTitle.textContent = g.name;
  groupMeta.textContent = `${naira(g.contributionAmount)} · ${g.frequency}`;
  deleteGroupBtn.classList.toggle('hidden', !isAdmin);

  inviteBanner.classList.remove('hidden');
  inviteCodeText.textContent = g.inviteCode;

  metricPool.textContent = naira(g.totalPool);
  metricMembers.textContent = g.members.length;
  metricRecipient.textContent = g.currentRecipient ? g.currentRecipient.name : '—';
  metricRound.textContent = `#${g.currentRound + 1}`;

  renderMembers(g, isAdmin);
  renderPayoutOrder(g, isAdmin);
  renderBankSetup(g, isAdmin);
  renderPayoutPanel(g, isAdmin);
  renderLedger(g);
  renderHistory(g);
}

// ---- Bank account setup (Paystack) ----
async function loadBanksIfNeeded() {
  if (banksLoaded) return;
  const res = await fetch(`${API}/paystack/banks`, fetchOpts());
  if (!res.ok) return;
  const banks = await res.json();
  bankSelect.innerHTML = banks.map((b) => `<option value="${b.code}">${escapeHtml(b.name)}</option>`).join('');
  banksLoaded = true;
}

function renderBankSetup(g, isAdmin) {
  bankSetupCard.classList.toggle('hidden', !isAdmin);
  bankMissingBanner.classList.toggle('hidden', g.bankAccountConfigured || isAdmin);
  contributionCard.classList.toggle('hidden', !g.bankAccountConfigured);

  if (isAdmin) {
    loadBanksIfNeeded();
    if (g.bankAccountConfigured) {
      bankConfiguredText.textContent = `Contributions settle into: ${g.accountName} — ${g.bankName} (${g.accountNumber})`;
      bankConfiguredText.classList.remove('hidden');
    } else {
      bankConfiguredText.classList.add('hidden');
    }
  }
}

bankDetailsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  bankError.classList.add('hidden');
  const res = await fetch(`${API}/groups/${currentGroupId}/bank-details`, fetchOpts({
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ bankCode: bankSelect.value, accountNumber: accountNumberInput.value.trim() }),
  }));
  if (res.ok) {
    accountNumberInput.value = '';
    fetchGroupDetail();
  } else {
    const err = await res.json().catch(() => ({}));
    bankError.textContent = err.error || 'Could not verify that account.';
    bankError.classList.remove('hidden');
  }
});

copyInviteBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(inviteCodeText.textContent).then(() => {
    copyInviteBtn.textContent = 'Copied!';
    setTimeout(() => (copyInviteBtn.textContent = 'Copy'), 1500);
  });
});

// ---- Members ----
function renderMembers(g, isAdmin) {
  membersList.innerHTML = '';
  if (!g.members.length) { membersList.innerHTML = '<li class="stat">No members yet.</li>'; return; }
  g.members.forEach((m) => {
    const li = document.createElement('li');
    const isCurrent = g.currentRecipient && g.currentRecipient.membershipId === m.membershipId;
    const isMe = m.userId === currentUser.id;
    li.innerHTML = `
      <span>${escapeHtml(m.name)}${isMe ? ' (you)' : ''} ${m.role === 'admin' ? '<span class="badge">Admin</span>' : ''}</span>
      <span class="row-actions">
        ${isCurrent ? '<span class="badge current">Up next</span>' : ''}
        ${isAdmin && !isMe ? `<button class="icon-btn" title="Remove member" data-remove="${m.membershipId}">✕</button>` : ''}
      </span>`;
    membersList.appendChild(li);
  });
  membersList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this member from the group?')) return;
      const res = await fetch(`${API}/groups/${currentGroupId}/members/${btn.dataset.remove}`, fetchOpts({ method: 'DELETE' }));
      if (res.ok) fetchGroupDetail();
    });
  });
}

// ---- Payout order ----
function renderPayoutOrder(g, isAdmin) {
  payoutOrderList.innerHTML = '';
  saveOrderBtn.classList.toggle('hidden', !isAdmin);
  if (!pendingOrder.length) { payoutOrderList.innerHTML = '<li class="stat">No payout order yet.</li>'; return; }

  pendingOrder.forEach((membershipId, idx) => {
    const member = g.members.find((m) => m.membershipId === membershipId);
    if (!member) return;
    const isCurrent = idx === g.currentRound % pendingOrder.length;
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${idx + 1}. ${escapeHtml(member.name)} ${isCurrent ? '<span class="badge current">Now</span>' : ''}</span>
      <span class="row-actions">
        ${isAdmin ? `
          <button class="icon-btn" data-up="${idx}" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-down="${idx}" ${idx === pendingOrder.length - 1 ? 'disabled' : ''}>↓</button>
        ` : ''}
      </span>`;
    payoutOrderList.appendChild(li);
  });

  if (!isAdmin) return;
  payoutOrderList.querySelectorAll('[data-up]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.up);
      [pendingOrder[i - 1], pendingOrder[i]] = [pendingOrder[i], pendingOrder[i - 1]];
      renderPayoutOrder(currentGroupData, isAdmin);
    });
  });
  payoutOrderList.querySelectorAll('[data-down]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.down);
      [pendingOrder[i + 1], pendingOrder[i]] = [pendingOrder[i], pendingOrder[i + 1]];
      renderPayoutOrder(currentGroupData, isAdmin);
    });
  });
}

saveOrderBtn.addEventListener('click', async () => {
  const res = await fetch(`${API}/groups/${currentGroupId}/payout-order`, fetchOpts({
    method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ order: pendingOrder }),
  }));
  if (res.ok) {
    fetchGroupDetail();
  } else {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Could not save payout order.');
  }
});

// ---- Contributions — real payment via Paystack, always for the logged-in user's own membership ----
contributionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  if (contributionAmountInput.value) body.amount = parseFloat(contributionAmountInput.value);
  const res = await fetch(`${API}/groups/${currentGroupId}/contributions/initiate`, fetchOpts({
    method: 'POST', headers: jsonHeaders, body: JSON.stringify(body),
  }));
  if (res.ok) {
    const { authorizationUrl } = await res.json();
    window.location.href = authorizationUrl; // hand off to Paystack's real checkout
  } else {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Could not start the payment.');
  }
});

// ---- Payout ----
function renderPayoutPanel(g, isAdmin) {
  recordPayoutBtn.classList.toggle('hidden', !isAdmin);
  if (!g.currentRecipient) {
    payoutStatus.textContent = 'Set a payout order to enable payouts.';
    recordPayoutBtn.disabled = true;
    return;
  }
  const suggested = g.contributionAmount * g.members.length;
  payoutStatus.innerHTML = `Next up: <strong>${escapeHtml(g.currentRecipient.name)}</strong> — suggested payout ${naira(suggested)} (${g.membersPaidThisRound.length}/${g.members.length} members have paid in this round).`;
  recordPayoutBtn.disabled = false;
}

recordPayoutBtn.addEventListener('click', async () => {
  if (!currentGroupData || !currentGroupData.currentRecipient) return;
  if (!confirm(`Record payout to ${currentGroupData.currentRecipient.name} and move to the next round?`)) return;
  const res = await fetch(`${API}/groups/${currentGroupId}/payout`, fetchOpts({
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({}),
  }));
  if (res.ok) {
    fetchGroupDetail();
  } else {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Could not record payout.');
  }
});

// ---- Ledger & history ----
function renderLedger(g) {
  ledgerList.innerHTML = '';
  // Failed/abandoned Paystack attempts aren't shown — they're not part of the group's real history.
  const visible = g.contributions.filter((c) => c.status !== 'failed');
  if (!visible.length) { ledgerList.innerHTML = '<li class="stat">No contributions yet.</li>'; return; }
  [...visible].reverse().forEach((c) => {
    const li = document.createElement('li');
    const statusBadge = c.status === 'pending' ? '<span class="badge pending">Pending</span>' : '';
    li.innerHTML = `<span>${escapeHtml(c.memberName)} <span class="badge">Round ${c.round + 1}</span> ${statusBadge}</span><span class="amount-income">+ ${naira(c.amount)}</span>`;
    ledgerList.appendChild(li);
  });
}

function renderHistory(g) {
  historyList.innerHTML = '';
  if (!g.payoutHistory.length) { historyList.innerHTML = '<li class="stat">No payouts recorded yet.</li>'; return; }
  [...g.payoutHistory].reverse().forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.memberName)} <span class="badge paid">Round ${p.round + 1}</span></span><span class="amount-out">- ${naira(p.amount)}</span>`;
    historyList.appendChild(li);
  });
}

// ---- payment return handling ----
// Paystack redirects back to "/" with these query params after checkout.
function consumePaymentRedirect() {
  const params = new URLSearchParams(window.location.search);
  const payment = params.get('payment');
  const groupId = params.get('groupId');
  if (!payment) return null;
  window.history.replaceState({}, '', window.location.pathname); // strip params from the URL
  return { payment, groupId };
}

function showBanner(msg, kind) {
  const banner = document.createElement('div');
  banner.className = `payment-banner ${kind}`;
  banner.textContent = msg;
  document.body.prepend(banner);
  setTimeout(() => banner.remove(), 4000);
}

// ---- boot ----
document.addEventListener('DOMContentLoaded', async () => {
  const redirect = consumePaymentRedirect();
  await checkAuth();
  if (redirect && currentUser) {
    if (redirect.payment === 'success') showBanner('Payment confirmed — contribution added! 🎉', 'success');
    else showBanner('Payment did not go through — nothing was added. Please try again.', 'error');
    if (redirect.groupId) openGroup(redirect.groupId);
  }
});
