const { test } = require('node:test');
const assert = require('node:assert/strict');
const { money, nextDue, financials, validatePayment } = require('../src/domain');
test('money accepts exact kobo and rejects unsafe, fractional and coercible values', () => {
  assert.equal(money('10000.01'), 1000001);
  assert.equal(money(0, { allowZero: true }), 0);
  for (const value of [-1, 0, 0.01, 1.001, '1e3', NaN, Infinity, true, null, {}, '20000000.01'])
    assert.throws(() => money(value));
});
test('a small contribution does not satisfy the full obligation; disputes and refunds reduce paid value', () => {
  const g = {
    contributionKobo: 1000000,
    currentRound: 0,
    memberships: [{ id: 'm', active: true, user: { name: 'M' } }],
    contributions: [
      {
        membershipId: 'm',
        round: 0,
        status: 'success',
        amountKobo: 100,
        refundedKobo: 0,
        disputed: false,
      },
    ],
    payoutHistory: [],
  };
  assert.equal(financials(g).allPaid, false);
  assert.equal(financials(g).obligations[0].dueKobo, 999900);
  g.contributions[0].amountKobo = 1000000;
  assert.equal(financials(g).allPaid, true);
  g.contributions[0].refundedKobo = 100;
  assert.equal(financials(g).allPaid, false);
  g.contributions[0].disputed = true;
  assert.equal(financials(g).collectedKobo, 0);
});
test('only confirmed or historical payouts reduce ledger balance', () => {
  const g = {
    contributionKobo: 100,
    currentRound: 0,
    memberships: [],
    contributions: [],
    payoutHistory: [
      { status: 'awaiting_confirmation', amountKobo: 100 },
      { status: 'confirmed', amountKobo: 100 },
      { status: 'legacy', amountKobo: 200 },
    ],
  };
  assert.equal(financials(g).paidOutKobo, 300);
});
test('payment verification checks every saved financial dimension', () => {
  const c = {
    paymentReference: 'ref',
    amountKobo: 100,
    environment: 'test',
    subaccountCode: 'ACCT_group',
  };
  const good = {
    reference: 'ref',
    amount: 100,
    currency: 'NGN',
    domain: 'test',
    subaccount: { subaccount_code: 'ACCT_group' },
  };
  validatePayment(c, good);
  for (const patch of [
    { reference: 'other' },
    { amount: 1 },
    { currency: 'USD' },
    { domain: 'live' },
    { subaccount: {} },
  ])
    assert.throws(() => validatePayment(c, { ...good, ...patch }));
});
test('monthly due dates clamp end-of-month instead of skipping February', () => {
  assert.equal(
    nextDue('monthly', new Date('2027-01-31T10:00:00Z')).toISOString(),
    '2027-02-28T10:00:00.000Z',
  );
});
