'use strict';
const user = {
  id: 'user-1',
  name: 'Amara Okafor',
  email: 'amara@example.com',
  csrfToken: 'fixture-csrf',
  emailVerified: true,
  paymentEnvironment: 'test',
};
function circle(overrides = {}) {
  const names = ['Amara Okafor', 'Tunde Adeyemi', 'Zainab Musa', 'Chidi Nwosu'];
  return {
    id: 'circle-1',
    name: 'The Saturday Circle',
    frequency: 'monthly',
    status: 'active',
    contributionAmount: 25000,
    currentRound: 1,
    cycleStartRound: 0,
    cycleSize: 4,
    dueAt: '2026-10-15T12:00:00Z',
    inviteCode: null,
    bankAccountConfigured: true,
    accountName: 'SATURDAY SAVINGS',
    bankName: 'Example Bank',
    accountNumber: '••••••4210',
    members: names.map((name, i) => ({
      membershipId: `m${i}`,
      userId: `user-${i + 1}`,
      name,
      role: i ? 'member' : 'admin',
      joinedAt: '2026-09-01',
    })),
    payoutOrder: ['m0', 'm1', 'm2', 'm3'],
    contributions: names
      .slice(1, 3)
      .map((name, i) => ({
        id: `c${i}`,
        membershipId: `m${i + 1}`,
        memberName: name,
        amount: 25000,
        refundedAmount: 0,
        disputed: false,
        round: 1,
        date: '2026-10-01T12:00:00Z',
        status: 'success',
        paymentReference: `ajo-fixture-reference-${i}`,
      })),
    payoutHistory: [
      {
        id: 'p0',
        membershipId: 'm0',
        memberName: names[0],
        amount: 100000,
        round: 0,
        date: '2026-09-20',
        status: 'confirmed',
        transferReference: 'BANK-REFERENCE-001',
      },
    ],
    totalPool: 150000,
    totalPaidOut: 100000,
    availableBalance: 50000,
    roundCollected: 50000,
    outstandingAmount: 50000,
    obligations: names.map((name, i) => ({
      membershipId: `m${i}`,
      name,
      paid: [1, 2].includes(i) ? 25000 : 0,
      due: [1, 2].includes(i) ? 0 : 25000,
    })),
    currentRecipient: { membershipId: 'm1', name: names[1] },
    membersPaidThisRound: ['m1', 'm2'],
    allPaidThisRound: false,
    pendingPayout: null,
    currentUser: { membershipId: 'm0', role: 'admin' },
    bankChanges: [],
    auditEvents: [
      {
        id: 'a1',
        action: 'payment.confirmed',
        createdAt: '2026-10-01',
        data: { reference: 'ajo-fixture-reference-1' },
      },
      { id: 'a2', action: 'cycle.started', createdAt: '2026-09-20', data: { round: 0 } },
    ],
    ...overrides,
  };
}
async function fixture(page, options = {}) {
  let authenticated = options.authenticated !== false;
  let g = circle(options.group);
  const requests = [];
  const summaries = options.groups || [
    g,
    circle({
      id: 'circle-2',
      name: 'The December Plan',
      status: 'draft',
      availableBalance: 0,
      contributionAmount: 10000,
    }),
  ];
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    let body;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    requests.push({ path, method: request.method(), body, headers: request.headers() });
    const send = (data, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (options.delay) await new Promise((r) => setTimeout(r, options.delay));
    if (path === '/api/auth/me')
      return authenticated ? send(user) : send({ error: 'Please log in.' }, 401);
    if (path === '/api/auth/login' || path === '/api/auth/signup') {
      if (options.loginError) return send({ error: 'Email or password is incorrect.' }, 401);
      authenticated = true;
      return send(user);
    }
    if (path === '/api/auth/logout') {
      authenticated = false;
      return send({ ok: true });
    }
    if (path === '/api/auth/forgot-password')
      return send({ message: 'If your account exists, a reset link has been sent.' });
    if (path === '/api/auth/reset')
      return send({ message: 'Password reset. Log in with your new password.' });
    if (path === '/api/auth/verify') return send({ message: 'Email verified.' });
    if (path === '/api/groups' && request.method() === 'GET') {
      if (options.groupsError) return send({ error: 'Service temporarily unavailable.' }, 503);
      return send(summaries.map((x) => ({ ...x, memberCount: x.members?.length || 4 })));
    }
    if (path === '/api/groups' && request.method() === 'POST') {
      g = circle({
        name: body.name,
        status: 'draft',
        inviteCode: 'ABC1234567',
        contributionAmount: Number(body.contributionAmount),
        currentRecipient: null,
        bankAccountConfigured: false,
        obligations: [],
      });
      return send(g, 201);
    }
    if (path === '/api/groups/join') return send(g);
    if (path === '/api/paystack/banks') return send([{ name: 'Example Bank', code: '001' }]);
    if (/^\/api\/groups\/[^/]+$/.test(path) && request.method() === 'GET') return send(g);
    if (path.endsWith('/contributions/initiate'))
      return send({ authorizationUrl: 'https://checkout.paystack.com/fixture' });
    if (options.actionError)
      return send({ error: 'The record changed. Refresh the circle before continuing.' }, 409);
    return send({ status: 'success', message: 'Saved.' });
  });
  return {
    requests,
    setGroup(value) {
      g = circle(value);
    },
    setGroupsError(value) {
      options.groupsError = value;
    },
  };
}
module.exports = { fixture, circle, user };
