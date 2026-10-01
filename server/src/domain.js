'use strict';
const MAX_KOBO = 2_000_000_000;
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function text(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new AppError(400, `${name} must contain 1–${max} characters.`);
  return value.trim();
}
function money(value, { allowZero = false } = {}) {
  // Accept decimal naira strings/numbers, but never silently round fractional kobo.
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value)))
    throw new AppError(400, 'Use a valid amount with at most two decimal places.');
  const [whole, fraction = ''] = String(value).split('.');
  const kobo = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(kobo) || kobo > MAX_KOBO || kobo < (allowZero ? 0 : 100))
    throw new AppError(400, 'Amount must be between ₦1 and ₦20,000,000.');
  return kobo;
}
function nextDue(frequency, from = new Date()) {
  const due = new Date(from);
  if (frequency === 'monthly') {
    const day = due.getUTCDate();
    due.setUTCDate(1);
    due.setUTCMonth(due.getUTCMonth() + 1);
    const last = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
    due.setUTCDate(Math.min(day, last));
  } else due.setUTCDate(due.getUTCDate() + (frequency === 'weekly' ? 7 : 1));
  return due;
}
function financials(group) {
  const members = group.memberships.filter((m) => m.active);
  const successful = group.contributions.filter((c) => c.status === 'success');
  const net = (c) => (c.disputed ? 0 : c.amountKobo - c.refundedKobo);
  const collectedKobo = successful.reduce((n, c) => n + net(c), 0);
  const paidOutKobo = group.payoutHistory
    .filter((p) => p.status === 'confirmed' || p.status === 'legacy')
    .reduce((n, p) => n + p.amountKobo, 0);
  const obligations = members.map((m) => {
    const paidKobo = successful
      .filter((c) => c.round === group.currentRound && c.membershipId === m.id)
      .reduce((n, c) => n + net(c), 0);
    return {
      membershipId: m.id,
      name: m.user.name,
      paidKobo,
      dueKobo: Math.max(0, group.contributionKobo - paidKobo),
    };
  });
  return {
    collectedKobo,
    paidOutKobo,
    ledgerBalanceKobo: collectedKobo - paidOutKobo,
    roundCollectedKobo: obligations.reduce((n, o) => n + o.paidKobo, 0),
    obligations,
    allPaid: members.length > 0 && obligations.every((o) => o.dueKobo === 0),
  };
}
function validatePayment(contribution, payment) {
  if (
    !payment ||
    payment.reference !== contribution.paymentReference ||
    payment.amount !== contribution.amountKobo ||
    payment.currency !== 'NGN' ||
    payment.domain !== contribution.environment
  )
    throw new AppError(409, 'Payment verification did not match the saved payment intent.');
  const code =
    typeof payment.subaccount === 'string'
      ? payment.subaccount
      : payment.subaccount?.subaccount_code;
  if (!contribution.subaccountCode || code !== contribution.subaccountCode)
    throw new AppError(
      409,
      'Payment settlement destination did not match the saved payment intent.',
    );
}
module.exports = { AppError, MAX_KOBO, text, money, nextDue, financials, validatePayment };
