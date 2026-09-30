'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { createApp } = require('../src/app');
const { createPaystack } = require('../src/paystack');
const { sendReminders } = require('../src/mail');
if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw Error('TEST_DATABASE_URL must name a disposable database ending in _test.');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
const origin = 'http://localhost:8080',
  password = 'correct horse battery staple';
const providerPayments = new Map(),
  sent = [];
let initializeCount = 0;
const actual = createPaystack('sk_test_mock');
const paystack = {
  environment: 'test',
  verifyWebhookSignature: actual.verifyWebhookSignature,
  listBanks: async () => [{ name: 'Test Bank', code: '001' }],
  resolveAccountNumber: async (account) => ({
    account_name: 'Group Account',
    account_number: account,
  }),
  createSubaccount: async () => ({ subaccount_code: 'ACCT_group' }),
  initializeTransaction: async (input) => {
    initializeCount++;
    providerPayments.set(input.reference, {
      reference: input.reference,
      amount: input.amountKobo,
      currency: 'NGN',
      domain: 'test',
      status: 'pending',
      subaccount: { subaccount_code: input.subaccountCode },
    });
    return { authorization_url: `https://checkout.paystack.com/${input.reference}` };
  },
  verifyTransaction: async (reference) => {
    const payment = providerPayments.get(reference);
    if (!payment) throw Error('Provider temporarily unavailable');
    return structuredClone(payment);
  },
};
const mailer = { send: async (mail) => sent.push(mail) };
const app = createApp({
  prisma,
  paystack,
  appUrl: origin,
  mailer,
  rateLimits: { sensitive: 1000 },
  logger: { error() {} },
});
let admin, member, outsider, groupId, memberId, adminId;
function call(actor, method, path, body = {}, key) {
  let r = actor.agent[method](path).set('Origin', origin).set('x-csrf-token', actor.csrf);
  if (key) r = r.set('Idempotency-Key', key);
  return ['get', 'head'].includes(method) ? r : r.send(body);
}
async function signup(name) {
  const agent = request.agent(app);
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  const r = await agent
    .post('/api/auth/signup')
    .set('Origin', origin)
    .send({ name, email, password });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { agent, csrf: r.body.csrfToken, id: r.body.id, email: r.body.email };
}
async function detail(actor = admin) {
  const r = await call(actor, 'get', `/api/groups/${groupId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function initiate(actor, amount, key = crypto.randomUUID()) {
  return call(
    actor,
    'post',
    `/api/groups/${groupId}/contributions/initiate`,
    amount === undefined ? {} : { amount },
    key,
  );
}
async function confirm(reference) {
  providerPayments.get(reference).status = 'success';
  const r = await call(admin, 'post', `/api/groups/${groupId}/payments/${reference}/verify`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
async function webhook(event, data) {
  const raw = JSON.stringify({ event, data });
  const sig = crypto.createHmac('sha512', 'sk_test_mock').update(raw).digest('hex');
  return request(app)
    .post('/api/webhooks/paystack')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', sig)
    .send(raw);
}
before(async () => {
  await prisma.$connect();
  admin = await signup('Admin');
  member = await signup('Member');
  outsider = await signup('Outsider');
  const r = await call(admin, 'post', '/api/groups', {
    name: 'Integration savings',
    contributionAmount: '10000.00',
    frequency: 'monthly',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  groupId = r.body.id;
  adminId = r.body.currentUser.membershipId;
  const joined = await call(member, 'post', '/api/groups/join', { inviteCode: r.body.inviteCode });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  memberId = joined.body.currentUser.membershipId;
});
after(() => prisma.$disconnect());
test('unauthorized users cannot see group records or manage the group', async () => {
  assert.equal((await call(outsider, 'get', `/api/groups/${groupId}`)).status, 404);
  assert.equal((await call(member, 'delete', `/api/groups/${groupId}`, { password })).status, 403);
  assert.equal(
    (await call(member, 'post', `/api/groups/${groupId}/start`, { password })).status,
    403,
  );
});
test('CSRF and cross-origin mutations are rejected', async () => {
  assert.equal(
    (
      await admin.agent
        .post('/api/groups')
        .set('Origin', origin)
        .send({ name: 'bad', contributionAmount: 1 })
    ).status,
    403,
  );
  assert.equal(
    (await call(admin, 'post', '/api/groups', { name: [], contributionAmount: 1 })).status,
    400,
  );
  assert.equal(
    (
      await admin.agent
        .post('/api/groups')
        .set('Origin', 'https://evil.example')
        .set('x-csrf-token', admin.csrf)
        .send({ name: 'bad', contributionAmount: 1 })
    ).status,
    403,
  );
});
test('bank changes require unanimous member approval; initial proposal is not applied', async () => {
  let r = await call(admin, 'post', `/api/groups/${groupId}/bank-details`, {
    bankCode: '001',
    accountNumber: '1234567890',
    password,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.bankAccountConfigured, false);
  const id = r.body.bankChanges[0].id;
  r = await call(member, 'post', `/api/groups/${groupId}/bank-changes/${id}/approve`, { password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bankAccountConfigured, true);
  assert.equal(r.body.accountNumber, '••••••7890');
});
test('queue swapping is atomic and avoids unique-position conflicts', async () => {
  const r = await call(admin, 'put', `/api/groups/${groupId}/payout-order`, {
    order: [memberId, adminId],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.payoutOrder, [memberId, adminId]);
});
test('starting a cycle freezes roster, queue and settlement account', async () => {
  let r = await call(admin, 'post', `/api/groups/${groupId}/start`, { password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'active');
  assert.equal(r.body.cycleSize, 2);
  const invite = (await prisma.group.findUnique({ where: { id: groupId } })).inviteCode;
  assert.equal(
    (await call(outsider, 'post', '/api/groups/join', { inviteCode: invite })).status,
    409,
  );
  assert.equal(
    (
      await call(admin, 'put', `/api/groups/${groupId}/payout-order`, {
        order: [adminId, memberId],
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(admin, 'delete', `/api/groups/${groupId}/members/${memberId}`, { password }))
      .status,
    409,
  );
  assert.equal((await call(admin, 'delete', `/api/groups/${groupId}`, { password })).status, 409);
});
test('empty pool, negative and excessive payouts are rejected without round advancement', async () => {
  for (const amount of [-100, 0, 1000000])
    assert.notEqual(
      (
        await call(
          admin,
          'post',
          `/api/groups/${groupId}/payout`,
          { password, expectedRound: 0, transferReference: 'bank-ref', amount },
          crypto.randomUUID(),
        )
      ).status,
      201,
    );
  assert.equal((await detail()).currentRound, 0);
  assert.equal(await prisma.payout.count({ where: { groupId } }), 0);
});
test('concurrent initiation with same idempotency key creates one provider transaction', async () => {
  const key = crypto.randomUUID(),
    before = initializeCount;
  const responses = await Promise.all([initiate(admin, 1, key), initiate(admin, 1, key)]);
  assert.ok(responses.some((r) => r.status === 200));
  assert.ok(responses.every((r) => [200, 409].includes(r.status)));
  assert.equal(initializeCount - before, 1);
  const successful = responses.find((r) => r.status === 200);
  await confirm(successful.body.reference);
  const g = await detail();
  assert.equal(g.membersPaidThisRound.includes(adminId), false);
  assert.equal(g.obligations.find((o) => o.membershipId === adminId).due, 9999);
});
test('remaining obligation is enforced and pending payments prevent duplicate checkout', async () => {
  assert.equal((await initiate(admin, 10000)).status, 400);
  const r = await initiate(admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await initiate(admin)).status, 409);
  await confirm(r.body.reference);
  const m = await initiate(member);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  await confirm(m.body.reference);
  assert.equal((await detail()).allPaidThisRound, true);
});
test('verification refuses mismatched payment amount, currency and destination', async () => {
  const c = await prisma.contribution.findFirst({ where: { groupId, membershipId: memberId } });
  const original = providerPayments.get(c.paymentReference);
  for (const patch of [
    { amount: 1 },
    { currency: 'USD' },
    { subaccount: { subaccount_code: 'ACCT_evil' } },
  ]) {
    providerPayments.set(c.paymentReference, { ...original, ...patch });
    assert.equal(
      (await call(admin, 'post', `/api/groups/${groupId}/payments/${c.paymentReference}/verify`))
        .status,
      409,
    );
  }
  providerPayments.set(c.paymentReference, original);
  assert.equal((await prisma.contribution.findUnique({ where: { id: c.id } })).status, 'success');
});
test('success is monotonic even when later verification reports failed', async () => {
  const c = await prisma.contribution.findFirst({ where: { groupId } });
  const original = providerPayments.get(c.paymentReference);
  providerPayments.set(c.paymentReference, { ...original, status: 'failed' });
  assert.equal(
    (await call(admin, 'post', `/api/groups/${groupId}/payments/${c.paymentReference}/verify`)).body
      .status,
    'success',
  );
  providerPayments.set(c.paymentReference, original);
});
test('payout requires bank attestation, is unique per round and advances only on recipient confirmation', async () => {
  const body = { password, expectedRound: 0, transferReference: 'bank-round-one' };
  assert.equal(
    (await call(admin, 'post', `/api/groups/${groupId}/payout`, body, crypto.randomUUID())).status,
    409,
  );
  assert.equal(
    (
      await call(admin, 'post', `/api/groups/${groupId}/reconcile`, {
        password,
        balance: 20000,
        statementReference: 'statement-one',
      })
    ).status,
    201,
  );
  // Clear sensitive buckets so this test concerns concurrency, not a prior request quota.
  await prisma.rateBucket.deleteMany({});
  const results = await Promise.all([
    call(admin, 'post', `/api/groups/${groupId}/payout`, body, crypto.randomUUID()),
    call(admin, 'post', `/api/groups/${groupId}/payout`, body, crypto.randomUUID()),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await prisma.payout.count({ where: { groupId, round: 0 } }), 1);
  let g = await detail();
  assert.equal(g.currentRound, 0);
  const payout = g.pendingPayout;
  assert.equal(
    (await call(admin, 'post', `/api/groups/${groupId}/payouts/${payout.id}/confirm`, { password }))
      .status,
    403,
  );
  assert.equal(
    (
      await call(member, 'post', `/api/groups/${groupId}/payouts/${payout.id}/confirm`, {
        password,
      })
    ).status,
    200,
  );
  g = await detail();
  assert.equal(g.currentRound, 1);
  assert.equal(g.availableBalance, 0);
  assert.equal(
    (
      await call(member, 'post', `/api/groups/${groupId}/payouts/${payout.id}/confirm`, {
        password,
      })
    ).status,
    200,
  );
  assert.equal((await detail()).currentRound, 1);
});
test('signed webhooks are durable and retried after temporary provider errors', async () => {
  await prisma.rateBucket.deleteMany({});
  const r = await initiate(admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ref = r.body.reference;
  const payment = providerPayments.get(ref);
  providerPayments.delete(ref);
  const response = await webhook('charge.success', {
    reference: ref,
    amount: payment.amount,
    currency: 'NGN',
    domain: 'test',
  });
  assert.equal(response.status, 200);
  const event = await prisma.webhookEvent.findFirst({
    where: { event: 'charge.success', status: 'pending' },
  });
  assert.ok(event);
  await assert.rejects(app.locals.payments.processEvent(event.id));
  assert.equal(
    (await prisma.webhookEvent.findUnique({ where: { id: event.id } })).status,
    'pending',
  );
  providerPayments.set(ref, { ...payment, status: 'success' });
  await app.locals.payments.reconcile();
  assert.equal(
    (await prisma.webhookEvent.findUnique({ where: { id: event.id } })).status,
    'processed',
  );
  assert.equal(
    (
      await webhook('charge.success', {
        reference: ref,
        amount: payment.amount,
        currency: 'NGN',
        domain: 'test',
      })
    ).status,
    200,
  );
  await app.locals.payments.reconcile();
  assert.equal(
    await prisma.contribution.count({ where: { paymentReference: ref, status: 'success' } }),
    1,
  );
  const bad = await request(app)
    .post('/api/webhooks/paystack')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', 'bad')
    .send('{}');
  assert.equal(bad.status, 401);
});
test('webhook persistence failure does not acknowledge receipt', async () => {
  const badDb = {
    webhookEvent: {
      upsert: async () => {
        throw Error('database unavailable');
      },
    },
  };
  const failApp = createApp({ prisma: badDb, paystack, appUrl: origin, logger: { error() {} } });
  const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref' } });
  const sig = crypto.createHmac('sha512', 'sk_test_mock').update(raw).digest('hex');
  const r = await request(failApp)
    .post('/api/webhooks/paystack')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', sig)
    .send(raw);
  assert.equal(r.status, 500);
});
test('refund events are idempotent, reduce obligations, and pause the group for review', async () => {
  const c = await prisma.contribution.findFirst({
    where: { groupId, round: 1, status: 'success' },
  });
  const data = {
    id: 9123,
    transaction: { reference: c.paymentReference },
    amount: 100,
    currency: 'NGN',
  };
  assert.equal((await webhook('refund.processed', data)).status, 200);
  await app.locals.payments.reconcile();
  assert.equal((await webhook('refund.processed', data)).status, 200);
  await app.locals.payments.reconcile();
  const saved = await prisma.contribution.findUnique({ where: { id: c.id } });
  assert.equal(saved.refundedKobo, 100);
  assert.equal((await detail()).status, 'review');
});
test('unanimous financial review resumes a refunded round and a complete cycle preserves removed-member history', async () => {
  await prisma.rateBucket.deleteMany({});
  let r = await call(admin, 'post', `/api/groups/${groupId}/reconcile`, {
    password,
    balance: 9999,
    statementReference: 'reviewed-refund-statement',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await call(admin, 'post', `/api/groups/${groupId}/review/approve`, { password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'review');
  r = await call(member, 'post', `/api/groups/${groupId}/review/approve`, { password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'active');
  r = await initiate(admin, 1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await confirm(r.body.reference);
  r = await initiate(member);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await confirm(r.body.reference);
  assert.equal(
    (
      await call(admin, 'post', `/api/groups/${groupId}/reconcile`, {
        password,
        balance: 20000,
        statementReference: 'second-round-settled',
      })
    ).status,
    201,
  );
  r = await call(
    admin,
    'post',
    `/api/groups/${groupId}/payout`,
    { password, expectedRound: 1, transferReference: 'bank-round-two' },
    crypto.randomUUID(),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await call(
    admin,
    'post',
    `/api/groups/${groupId}/payouts/${r.body.pendingPayout.id}/confirm`,
    { password },
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.availableBalance, 0);
  const contributions = await prisma.contribution.count({ where: { membershipId: memberId } }),
    payouts = await prisma.payout.count({ where: { membershipId: memberId } }),
    oldCode = r.body.inviteCode;
  r = await call(admin, 'delete', `/api/groups/${groupId}/members/${memberId}`, { password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.inviteCode, oldCode);
  assert.equal(
    await prisma.contribution.count({ where: { membershipId: memberId } }),
    contributions,
  );
  assert.equal(await prisma.payout.count({ where: { membershipId: memberId } }), payouts);
  assert.equal((await prisma.membership.findUnique({ where: { id: memberId } })).active, false);
  assert.equal(
    (await call(member, 'post', '/api/groups/join', { inviteCode: r.body.inviteCode })).status,
    409,
  );
});

test('CSV export escapes formula injection and includes payment references', async () => {
  await prisma.user.update({ where: { id: admin.id }, data: { name: '=DANGEROUS()' } });
  const r = await call(admin, 'get', `/api/groups/${groupId}/export`);
  assert.equal(r.status, 200);
  assert.match(r.text, /'=DANGEROUS\(\)/);
  assert.match(r.text, /ajo-/);
});
test('email verification and reset links are single-use and reset revokes all sessions', async () => {
  const actor = await signup('Recovery');
  const verifyMail = sent.find((m) => m.to === actor.email && m.subject.includes('Verify'));
  const token = verifyMail.text.match(/#verify=([a-f0-9]+)/)[1];
  assert.equal((await call(actor, 'post', '/api/auth/verify', { token })).status, 200);
  assert.equal((await call(actor, 'post', '/api/auth/verify', { token })).status, 400);
  assert.equal(
    (await call(actor, 'post', '/api/auth/forgot-password', { email: actor.email })).status,
    200,
  );
  const resetMail = sent.find((m) => m.to === actor.email && m.subject.includes('Reset'));
  const resetToken = resetMail.text.match(/#reset=([a-f0-9]+)/)[1];
  assert.equal(
    (
      await call(actor, 'post', '/api/auth/reset', {
        token: resetToken,
        newPassword: 'new correct horse battery',
      })
    ).status,
    200,
  );
  assert.equal((await call(actor, 'get', '/api/auth/me')).status, 401);
  assert.equal(
    (
      await call(actor, 'post', '/api/auth/reset', {
        token: resetToken,
        newPassword: 'new correct horse battery',
      })
    ).status,
    400,
  );
});
test('overdue reminders are sent once per member per day', async () => {
  await prisma.user.update({ where: { id: member.id }, data: { emailVerified: true } });
  await prisma.group.create({
    data: {
      name: 'Reminder fixture',
      contributionKobo: 100,
      frequency: 'daily',
      inviteCode: crypto.randomUUID(),
      status: 'active',
      dueAt: new Date(Date.now() - 86400000),
      memberships: { create: { userId: member.id } },
    },
  });
  const before = sent.length;
  await sendReminders(prisma, mailer);
  await sendReminders(prisma, mailer);
  assert.equal(sent.length - before, 1);
});

test('logout revokes the stored session, including replay of the old cookie', async () => {
  const actor = await signup('Logout');
  const response = await call(actor, 'get', '/api/auth/me');
  assert.equal(response.status, 200);
  const cookie = actor.agent.jar
    .getCookies({ domain: '127.0.0.1', path: '/', secure: false })
    .toValueString();
  assert.equal((await call(actor, 'post', '/api/auth/logout')).status, 204);
  assert.equal((await call(actor, 'get', '/api/auth/me')).status, 401);
  if (cookie)
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).status, 401);
});
test('bounded previews still calculate balances across the complete history', async () => {
  const g = await prisma.group.create({
    data: {
      name: 'Long history fixture',
      contributionKobo: 100,
      frequency: 'daily',
      inviteCode: crypto.randomUUID(),
      currentRound: 105,
      memberships: { create: { userId: admin.id, role: 'admin' } },
    },
    include: { memberships: true },
  });
  await prisma.contribution.createMany({
    data: Array.from({ length: 105 }, (_, round) => ({
      groupId: g.id,
      membershipId: g.memberships[0].id,
      amountKobo: 100,
      round,
      paymentReference: crypto.randomUUID(),
      status: 'success',
    })),
  });
  const r = await call(admin, 'get', `/api/groups/${g.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.contributions.length, 100);
  assert.equal(r.body.availableBalance, 105);
  const csv = await call(admin, 'get', `/api/groups/${g.id}/export`);
  assert.equal(csv.status, 200);
  assert.equal(csv.text.split('\r\n').length, 106);
});

test('shared database rate limits reject repeated login attempts', async () => {
  const actor = await signup('Throttled');
  await prisma.rateBucket.deleteMany({});
  let last;
  for (let i = 0; i < 16; i++)
    last = await call(actor, 'post', '/api/auth/login', {
      email: actor.email,
      password: 'incorrect',
    });
  assert.equal(last.status, 429);
});

test('financial records cannot be hard deleted and audit records cannot be rewritten', async () => {
  await assert.rejects(prisma.group.delete({ where: { id: groupId } }));
  await assert.rejects(prisma.membership.delete({ where: { id: adminId } }));
  const event = await prisma.auditEvent.findFirst({ where: { groupId } });
  await assert.rejects(
    prisma.auditEvent.update({ where: { id: event.id }, data: { action: 'rewritten' } }),
  );
  await assert.rejects(
    prisma.payout.updateMany({ where: { groupId }, data: { amountKobo: -100 } }),
  );
});
