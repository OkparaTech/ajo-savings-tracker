'use strict';
const crypto = require('crypto');
const { AppError, financials, validatePayment } = require('./domain');
const includes = {
  memberships: {
    include: { user: { select: { id: true, name: true } } },
    orderBy: { joinedAt: 'asc' },
  },
  payoutOrder: { orderBy: { position: 'asc' } },
  contributions: { take: 100, orderBy: [{ date: 'desc' }, { id: 'desc' }] },
  payoutHistory: { take: 100, orderBy: [{ date: 'desc' }, { id: 'desc' }] },
};
async function audit(tx, groupId, actorUserId, action, data = {}) {
  await tx.auditEvent.create({ data: { groupId, actorUserId: actorUserId || null, action, data } });
}
async function locked(prisma, groupId, work) {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw`SELECT id FROM "Group" WHERE id = ${groupId} FOR UPDATE`;
      if (!rows.length) throw new AppError(404, 'Group not found.');
      return work(tx);
    },
    { timeout: 15000, maxWait: 10000 },
  );
}
async function membership(tx, userId, groupId, admin = false, allowArchived = false) {
  const member = await tx.membership.findUnique({
    where: { userId_groupId: { userId, groupId } },
    include: { group: true },
  });
  if (!member?.active) throw new AppError(404, 'Group not found.');
  if (admin && member.role !== 'admin')
    throw new AppError(403, 'Only an administrator can do this.');
  if (!allowArchived && member.group.status === 'archived')
    throw new AppError(409, 'This group is archived. Its history remains available.');
  return member;
}
function editable(group) {
  if (!['draft', 'completed'].includes(group.status))
    throw new AppError(
      409,
      'Membership, bank details and order are locked during active cycles or financial review.',
    );
}
async function databaseFinancials(tx, group) {
  const [collected, paidOut, current] = await Promise.all([
    tx.contribution.aggregate({
      where: { groupId: group.id, status: 'success', disputed: false },
      _sum: { amountKobo: true, refundedKobo: true },
    }),
    tx.payout.aggregate({
      where: { groupId: group.id, status: { in: ['confirmed', 'legacy'] } },
      _sum: { amountKobo: true },
    }),
    tx.contribution.groupBy({
      by: ['membershipId'],
      where: { groupId: group.id, round: group.currentRound, status: 'success', disputed: false },
      _sum: { amountKobo: true, refundedKobo: true },
    }),
  ]);
  const members = group.memberships.filter((m) => m.active);
  const obligations = members.map((m) => {
    const row = current.find((c) => c.membershipId === m.id);
    const paidKobo = (row?._sum.amountKobo || 0) - (row?._sum.refundedKobo || 0);
    return {
      membershipId: m.id,
      name: m.user.name,
      paidKobo,
      dueKobo: Math.max(0, group.contributionKobo - paidKobo),
    };
  });
  const collectedKobo = (collected._sum.amountKobo || 0) - (collected._sum.refundedKobo || 0),
    paidOutKobo = paidOut._sum.amountKobo || 0;
  return {
    collectedKobo,
    paidOutKobo,
    ledgerBalanceKobo: collectedKobo - paidOutKobo,
    obligations,
    roundCollectedKobo: obligations.reduce((n, o) => n + o.paidKobo, 0),
    allPaid: members.length > 0 && obligations.every((o) => o.dueKobo === 0),
  };
}
async function pendingRecords(tx, groupId, includeDisputes = true) {
  const [payments, payouts] = await Promise.all([
    tx.contribution.count({
      where: {
        groupId,
        OR: [
          { status: { in: ['initializing', 'pending', 'unknown'] } },
          ...(includeDisputes ? [{ disputed: true }] : []),
        ],
      },
    }),
    tx.payout.count({ where: { groupId, status: { in: ['awaiting_confirmation', 'disputed'] } } }),
  ]);
  return payments + payouts;
}
async function groupDetail(prisma, groupId, userId) {
  const myMembership = await membership(prisma, userId, groupId, false, true);
  const group = await prisma.group.findUnique({ where: { id: groupId }, include: includes });
  const finances = await databaseFinancials(prisma, group);
  const order = group.payoutOrder;
  const recipient =
    group.status === 'active' ? order[group.currentRound - group.cycleStartRound] : null;
  const members = group.memberships.filter((m) => m.active);
  const name = (id) => group.memberships.find((m) => m.id === id)?.user.name || 'Former member';
  const bankChanges = await prisma.bankChange.findMany({
    where: { groupId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });
  const events = await prisma.auditEvent.findMany({
    where: { groupId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return {
    id: group.id,
    name: group.name,
    frequency: group.frequency,
    status: group.status,
    contributionAmount: group.contributionKobo / 100,
    currentRound: group.currentRound,
    cycleStartRound: group.cycleStartRound,
    cycleSize: group.cycleSize,
    dueAt: group.dueAt,
    inviteCode: group.status === 'active' ? null : group.inviteCode,
    bankAccountConfigured: Boolean(group.subaccountCode),
    accountName: group.accountName,
    bankName: group.bankName,
    accountNumber: group.accountNumber ? `••••••${group.accountNumber.slice(-4)}` : null,
    members: members.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      name: m.user.name,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    payoutOrder: order.map((e) => e.membershipId),
    contributions: group.contributions
      .slice()
      .sort((a, b) => a.date - b.date)
      .slice(-100)
      .map((c) => ({
        id: c.id,
        membershipId: c.membershipId,
        memberName: name(c.membershipId),
        amount: c.amountKobo / 100,
        refundedAmount: c.refundedKobo / 100,
        disputed: c.disputed,
        round: c.round,
        date: c.date,
        status: c.status,
        paymentReference: c.paymentReference,
      })),
    payoutHistory: [...group.payoutHistory]
      .sort((a, b) => a.date - b.date)
      .map((p) => ({
        id: p.id,
        membershipId: p.membershipId,
        memberName: name(p.membershipId),
        amount: p.amountKobo / 100,
        round: p.round,
        date: p.date,
        status: p.status,
        transferReference: p.transferReference,
      })),
    totalPool: finances.collectedKobo / 100,
    totalPaidOut: finances.paidOutKobo / 100,
    availableBalance: finances.ledgerBalanceKobo / 100,
    roundCollected: finances.roundCollectedKobo / 100,
    outstandingAmount: finances.obligations.reduce((n, o) => n + o.dueKobo, 0) / 100,
    obligations: finances.obligations.map((o) => ({
      ...o,
      paid: o.paidKobo / 100,
      due: o.dueKobo / 100,
    })),
    currentRecipient: recipient
      ? { membershipId: recipient.membershipId, name: name(recipient.membershipId) }
      : null,
    membersPaidThisRound: finances.obligations.filter((o) => !o.dueKobo).map((o) => o.membershipId),
    allPaidThisRound: finances.allPaid,
    pendingPayout:
      group.payoutHistory.find((p) => ['awaiting_confirmation', 'disputed'].includes(p.status)) ||
      null,
    currentUser: { membershipId: myMembership.id, role: myMembership.role },
    bankChanges: bankChanges.map((b) => ({
      id: b.id,
      accountName: b.accountName,
      bankName: b.bankName,
      accountNumber: `••••••${b.accountNumber.slice(-4)}`,
      approvals: b.approvals,
      proposedBy: b.proposedBy,
    })),
    auditEvents: events,
  };
}
function createPaymentService(prisma, paystack) {
  async function verify(reference) {
    const contribution = await prisma.contribution.findUnique({
      where: { paymentReference: reference },
    });
    if (!contribution) return null;
    // Legacy intents have no trustworthy historical destination snapshot. They require migration review.
    if (!contribution.subaccountCode)
      throw new AppError(409, 'Legacy payment requires operator reconciliation.');
    const payment = await paystack.verifyTransaction(reference);
    if (
      payment &&
      !payment.subaccount?.subaccount_code &&
      typeof payment.subaccount !== 'string' &&
      payment.id
    ) {
      const full = await paystack.fetchTransaction(payment.id);
      if (full.reference !== contribution.paymentReference)
        throw new AppError(409, 'Provider transaction reference mismatch.');
      payment.subaccount = full.subaccount;
    }
    validatePayment(contribution, payment);
    return locked(prisma, contribution.groupId, async (tx) => {
      const current = await tx.contribution.findUnique({ where: { id: contribution.id } });
      const status =
        payment.status === 'success'
          ? 'success'
          : ['failed', 'abandoned', 'reversed'].includes(payment.status)
            ? 'failed'
            : 'pending';
      const data = { lastCheckedAt: new Date() };
      if (payment.status === 'reversed') {
        data.disputed = true;
        await tx.group.update({ where: { id: current.groupId }, data: { status: 'review' } });
        await audit(tx, current.groupId, null, 'payment.reversed', { reference });
      }
      if (current.status !== 'success') data.status = status;
      await tx.contribution.update({ where: { id: current.id }, data });
      if (status === 'success' && current.status !== 'success')
        await audit(tx, current.groupId, null, 'payment.confirmed', {
          reference,
          amountKobo: current.amountKobo,
        });
      return current.status === 'success' ? 'success' : status;
    });
  }
  async function processEvent(eventId) {
    const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
    if (!event || event.status === 'processed') return;
    const data = event.payload;
    try {
      if (event.event === 'charge.success') {
        const status = await verify(data.reference);
        if (!status) throw new AppError(409, 'Payment intent not found; operator review required.');
        if (status !== 'success')
          throw new AppError(409, 'Provider has not confirmed success yet.');
      } else if (event.event.startsWith('refund.') || event.event.startsWith('charge.dispute.')) {
        let reference =
          typeof data.transaction === 'object' ? data.transaction.reference : data.reference;
        if (!reference && (typeof data.transaction === 'number' || data.transaction?.id)) {
          const transaction = await paystack.fetchTransaction(
            typeof data.transaction === 'number' ? data.transaction : data.transaction.id,
          );
          reference = transaction.reference;
        }
        if (!reference)
          throw new AppError(
            409,
            'Reversal event has no transaction reference; operator review required.',
          );
        const c = await prisma.contribution.findUnique({ where: { paymentReference: reference } });
        if (!c)
          throw new AppError(409, 'Reversal has no payment intent; operator review required.');
        await locked(prisma, c.groupId, async (tx) => {
          const current = await tx.contribution.findUnique({ where: { id: c.id } });
          if (event.event === 'refund.processed') {
            if (
              !data.id ||
              !Number.isSafeInteger(data.amount) ||
              data.amount <= 0 ||
              data.currency !== 'NGN'
            )
              throw new AppError(409, 'Invalid refund event.');
            const id = String(data.id);
            const existing = await tx.refund.findUnique({ where: { id } });
            if (
              existing &&
              (existing.contributionId !== c.id || existing.amountKobo !== data.amount)
            )
              throw new AppError(409, 'Refund details changed.');
            await tx.refund.upsert({
              where: { id },
              create: { id, contributionId: c.id, amountKobo: data.amount, status: 'processed' },
              update: {},
            });
            const refunds = await tx.refund.aggregate({
              where: { contributionId: c.id, status: 'processed' },
              _sum: { amountKobo: true },
            });
            const total = refunds._sum.amountKobo || 0;
            if (total > current.amountKobo)
              throw new AppError(409, 'Refund total exceeds payment.');
            await tx.contribution.update({ where: { id: c.id }, data: { refundedKobo: total } });
          } else if (event.event.startsWith('charge.dispute.')) {
            // Conservative hold; resolving a dispute never silently reinstates funds.
            await tx.contribution.update({ where: { id: c.id }, data: { disputed: true } });
          }
          await tx.group.update({ where: { id: c.groupId }, data: { status: 'review' } });
          await audit(tx, c.groupId, null, event.event, { reference, providerEventId: eventId });
        });
      }
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: 'processed',
          processedAt: new Date(),
          lastError: null,
          attempts: { increment: 1 },
        },
      });
    } catch (error) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: event.attempts >= 9 ? 'attention' : 'pending',
          attempts: { increment: 1 },
          lastError:
            error instanceof AppError ? error.message : 'Processing failed; retry required.',
        },
      });
      throw error;
    }
  }
  async function reconcile() {
    const stale = await prisma.bankChange.findMany({
      where: { status: 'applying', createdAt: { lt: new Date(Date.now() - 15 * 60000) } },
    });
    for (const p of stale)
      await locked(prisma, p.groupId, async (tx) => {
        const pending = await tx.bankChange.findUnique({ where: { id: p.id } });
        if (pending.status === 'applying') {
          await tx.bankChange.update({ where: { id: p.id }, data: { status: 'pending' } });
          await audit(tx, p.groupId, null, 'bank.apply_retry_required', { proposalId: p.id });
        }
      });
    const events = await prisma.webhookEvent.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    const summary = { eventsProcessed: 0, paymentsChecked: 0, errors: 0 };
    for (const e of events) {
      try {
        await processEvent(e.id);
        summary.eventsProcessed++;
      } catch {
        summary.errors++;
      }
    }
    const payments = await prisma.contribution.findMany({
      where: {
        status: { in: ['initializing', 'pending', 'unknown'] },
        subaccountCode: { not: null },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(Date.now() - 60000) } }],
      },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: 25,
    });
    for (const c of payments) {
      try {
        await verify(c.paymentReference);
        summary.paymentsChecked++;
      } catch {
        summary.errors++;
        await prisma.contribution.update({
          where: { id: c.id },
          data: { lastCheckedAt: new Date() },
        });
      }
    }
    return summary;
  }
  async function receive(raw, signature) {
    if (!paystack.verifyWebhookSignature(raw, signature))
      throw new AppError(401, 'Invalid signature.');
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError(400, 'Invalid payload.');
    }
    if (typeof event.event !== 'string' || !event.data || typeof event.data !== 'object')
      throw new AppError(400, 'Invalid event.');
    const id = crypto.createHash('sha256').update(raw).digest('hex');
    // Store only operational fields; never persist card authorization or customer PII from the webhook.
    const payload = Object.fromEntries(
      ['id', 'reference', 'amount', 'currency', 'domain', 'status', 'transaction']
        .filter((k) => event.data[k] !== undefined)
        .map((k) => [
          k,
          k === 'transaction' && typeof event.data[k] === 'object'
            ? { id: event.data[k]?.id, reference: event.data[k]?.reference }
            : event.data[k],
        ]),
    );
    await prisma.webhookEvent.upsert({
      where: { id },
      create: { id, event: event.event, payload },
      update: {},
    });
    // Durable inbox commit is the acknowledgement boundary. The worker retries processing failures.
    return id;
  }
  return { verify, processEvent, receive, reconcile };
}
module.exports = {
  includes,
  audit,
  locked,
  membership,
  editable,
  groupDetail,
  createPaymentService,
  databaseFinancials,
  pendingRecords,
};
