// server.js
// Ajo Savings Tracker — backend (Node.js + Express + PostgreSQL via Prisma)
// Multi-user: each member has their own account; groups are joined via an
// invite code; only group admins can manage payout order and record payouts.

require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const prisma = require('./src/prismaClient');
const {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
} = require('./src/auth');
const { generateInviteCode } = require('./src/inviteCode');
const paystack = require('./src/paystack');

const app = express();
const PORT = process.env.PORT || 8080;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ---- Paystack webhook -----------------------------------------------------
// Registered BEFORE express.json() because signature verification needs the
// exact raw request body — parsing it as JSON first would invalidate the hash.
app.post('/api/webhooks/paystack', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  if (!signature || !paystack.verifyWebhookSignature(req.body, signature)) {
    return res.status(401).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Bad payload');
  }

  if (event.event === 'charge.success') {
    const { reference } = event.data;
    try {
      const contribution = await prisma.contribution.findUnique({ where: { paymentReference: reference } });
      if (contribution && contribution.status !== 'success') {
        await prisma.contribution.update({ where: { id: contribution.id }, data: { status: 'success' } });
      }
    } catch (err) {
      console.error('Webhook processing error:', err);
    }
  }

  res.status(200).send('ok'); // Paystack retries on non-200, so always ack once handled.
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Prevents a single unexpected error (like a momentary database hiccup)
// from crashing the entire server for everyone using the app.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// =========================================================================
// Auth routes
// =========================================================================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    const user = await prisma.user.create({
      data: { name: name.trim(), email: email.toLowerCase(), password: await hashPassword(password) },
    });

    setAuthCookie(res, signToken(user.id));
    res.status(201).json({ id: user.id, name: user.name, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
    if (!user || !(await verifyPassword(password, user.password))) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    setAuthCookie(res, signToken(user.id));
    res.json({ id: user.id, name: user.name, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ id: user.id, name: user.name, email: user.email });
});

// =========================================================================
// Helpers
// =========================================================================

async function getMembership(userId, groupId) {
  return prisma.membership.findUnique({
    where: { userId_groupId: { userId, groupId } },
  });
}

// Loads a group with everything needed to render it, and shapes the response
// around the requesting user (their role, their own membership id, etc).
async function loadGroupForUser(groupId, userId) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      memberships: { include: { user: true }, orderBy: { joinedAt: 'asc' } },
      payoutOrder: { orderBy: { position: 'asc' }, include: { membership: { include: { user: true } } } },
      contributions: { orderBy: { date: 'asc' }, include: { membership: { include: { user: true } } } },
      payoutHistory: { orderBy: { date: 'asc' }, include: { membership: { include: { user: true } } } },
    },
  });
  if (!group) return null;

  const myMembership = group.memberships.find((m) => m.userId === userId);
  if (!myMembership) return null; // not a member — treat as not found for privacy

  // Only confirmed (webhook-verified) payments count toward the pool and
  // toward "who has paid this round" — a pending/failed Paystack charge
  // must never be mistaken for real money received.
  const successfulContributions = group.contributions.filter((c) => c.status === 'success');
  const totalPool = successfulContributions.reduce((s, c) => s + c.amount, 0);
  const totalPaidOut = group.payoutHistory.reduce((s, p) => s + p.amount, 0);

  const order = group.payoutOrder;
  const currentEntry = order.length ? order[group.currentRound % order.length] : null;
  const currentRecipient = currentEntry
    ? { membershipId: currentEntry.membershipId, name: currentEntry.membership.user.name }
    : null;

  const paidThisRound = new Set(
    successfulContributions.filter((c) => c.round === group.currentRound).map((c) => c.membershipId)
  );

  return {
    id: group.id,
    name: group.name,
    contributionAmount: group.contributionAmount,
    frequency: group.frequency,
    inviteCode: group.inviteCode,
    currentRound: group.currentRound,
    createdAt: group.createdAt,
    bankAccountConfigured: Boolean(group.subaccountCode),
    accountName: group.accountName,
    bankName: group.bankName,
    accountNumber: group.accountNumber,
    members: group.memberships.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      name: m.user.name,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    payoutOrder: order.map((e) => e.membershipId),
    contributions: group.contributions.map((c) => ({
      id: c.id,
      membershipId: c.membershipId,
      memberName: c.membership.user.name,
      amount: c.amount,
      round: c.round,
      date: c.date,
      status: c.status,
    })),
    payoutHistory: group.payoutHistory.map((p) => ({
      id: p.id,
      membershipId: p.membershipId,
      memberName: p.membership.user.name,
      amount: p.amount,
      round: p.round,
      date: p.date,
    })),
    totalPool,
    totalPaidOut,
    availableBalance: totalPool - totalPaidOut,
    currentRecipient,
    membersPaidThisRound: [...paidThisRound],
    allPaidThisRound:
      group.memberships.length > 0 && group.memberships.every((m) => paidThisRound.has(m.id)),
    currentUser: { membershipId: myMembership.id, role: myMembership.role },
  };
}

// =========================================================================
// Groups
// =========================================================================

// GET /api/groups — every group the logged-in user belongs to (summary)
app.get('/api/groups', requireAuth, async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { userId: req.userId },
    include: {
      group: {
        include: { memberships: true, contributions: true },
      },
    },
  });

  const groups = memberships.map(({ group, role }) => {
    const totalPool = group.contributions
      .filter((c) => c.status === 'success')
      .reduce((s, c) => s + c.amount, 0);
    return {
      id: group.id,
      name: group.name,
      contributionAmount: group.contributionAmount,
      frequency: group.frequency,
      currentRound: group.currentRound,
      memberCount: group.memberships.length,
      totalPool,
      myRole: role,
    };
  });
  res.json(groups);
});

// POST /api/groups — create a group; creator becomes admin, position 0 in payout order
app.post('/api/groups', requireAuth, async (req, res) => {
  const { name, contributionAmount, frequency } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required.' });
  const amount = Number(contributionAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'contributionAmount must be a positive number.' });
  }

  let inviteCode = generateInviteCode();
  // Extremely unlikely to collide, but guard anyway.
  while (await prisma.group.findUnique({ where: { inviteCode } })) {
    inviteCode = generateInviteCode();
  }

  const group = await prisma.group.create({
    data: {
      name: name.trim(),
      contributionAmount: amount,
      frequency: frequency && frequency.trim() ? frequency.trim() : 'monthly',
      inviteCode,
      memberships: { create: { userId: req.userId, role: 'admin' } },
    },
    include: { memberships: true },
  });

  await prisma.payoutOrderEntry.create({
    data: { groupId: group.id, membershipId: group.memberships[0].id, position: 0 },
  });

  res.status(201).json(await loadGroupForUser(group.id, req.userId));
});

// POST /api/groups/join — join a group via invite code
app.post('/api/groups/join', requireAuth, async (req, res) => {
  const { inviteCode } = req.body || {};
  if (!inviteCode || !inviteCode.trim()) {
    return res.status(400).json({ error: 'Invite code is required.' });
  }

  const group = await prisma.group.findUnique({
    where: { inviteCode: inviteCode.trim().toUpperCase() },
    include: { payoutOrder: true },
  });
  if (!group) return res.status(404).json({ error: 'No group found with that invite code.' });

  const existing = await getMembership(req.userId, group.id);
  if (existing) return res.status(409).json({ error: "You're already a member of this group." });

  const membership = await prisma.membership.create({
    data: { userId: req.userId, groupId: group.id, role: 'member' },
  });
  const nextPosition = group.payoutOrder.length;
  await prisma.payoutOrderEntry.create({
    data: { groupId: group.id, membershipId: membership.id, position: nextPosition },
  });

  res.status(201).json(await loadGroupForUser(group.id, req.userId));
});

// GET /api/groups/:id — full detail (member-only)
app.get('/api/groups/:id', requireAuth, async (req, res) => {
  const detail = await loadGroupForUser(req.params.id, req.userId);
  if (!detail) return res.status(404).json({ error: 'Group not found.' });
  res.json(detail);
});

// DELETE /api/groups/:id — admin only
app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  const membership = await getMembership(req.userId, req.params.id);
  if (!membership) return res.status(404).json({ error: 'Group not found.' });
  if (membership.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can delete the group.' });

  await prisma.group.delete({ where: { id: req.params.id } }); // cascades via schema relations
  res.status(204).end();
});

// DELETE /api/groups/:id/members/:membershipId — admin only, and repositions the queue
app.delete('/api/groups/:id/members/:membershipId', requireAuth, async (req, res) => {
  const requester = await getMembership(req.userId, req.params.id);
  if (!requester) return res.status(404).json({ error: 'Group not found.' });
  if (requester.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can remove members.' });

  const target = await prisma.membership.findUnique({ where: { id: req.params.membershipId } });
  if (!target || target.groupId !== req.params.id) return res.status(404).json({ error: 'Member not found.' });

  await prisma.membership.delete({ where: { id: target.id } }); // cascades payout order entry
  // Re-pack positions so there are no gaps.
  const remaining = await prisma.payoutOrderEntry.findMany({
    where: { groupId: req.params.id },
    orderBy: { position: 'asc' },
  });
  await prisma.$transaction(
    remaining.map((entry, idx) =>
      prisma.payoutOrderEntry.update({ where: { id: entry.id }, data: { position: idx } })
    )
  );

  res.json(await loadGroupForUser(req.params.id, req.userId));
});

// PUT /api/groups/:id/payout-order — admin only
// body: { order: [membershipId, ...] }
app.put('/api/groups/:id/payout-order', requireAuth, async (req, res) => {
  const requester = await getMembership(req.userId, req.params.id);
  if (!requester) return res.status(404).json({ error: 'Group not found.' });
  if (requester.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can reorder the payout queue.' });

  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of membership ids.' });

  const memberships = await prisma.membership.findMany({ where: { groupId: req.params.id } });
  const validIds = new Set(memberships.map((m) => m.id));
  const valid = order.length === memberships.length && order.every((id) => validIds.has(id)) && new Set(order).size === order.length;
  if (!valid) return res.status(400).json({ error: 'order must contain every group member exactly once.' });

  await prisma.$transaction(
    order.map((membershipId, idx) =>
      prisma.payoutOrderEntry.update({ where: { membershipId }, data: { position: idx } })
    )
  );

  res.json(await loadGroupForUser(req.params.id, req.userId));
});

// =========================================================================
// Bank account setup (Paystack) — admin only
// =========================================================================

// GET /api/paystack/banks — list of Nigerian banks for the dropdown
app.get('/api/paystack/banks', requireAuth, async (req, res) => {
  try {
    const banks = await paystack.listBanks();
    res.json(banks.map((b) => ({ name: b.name, code: b.code })));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not reach Paystack to list banks.' });
  }
});

// POST /api/groups/:id/bank-details — admin only
// body: { bankCode, accountNumber }
// Resolves the account (confirms it's real and gets the holder's name), then
// creates a Paystack subaccount so contributions settle straight into it.
app.post('/api/groups/:id/bank-details', requireAuth, async (req, res) => {
  const membership = await getMembership(req.userId, req.params.id);
  if (!membership) return res.status(404).json({ error: 'Group not found.' });
  if (membership.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can set the payout bank account.' });

  const { bankCode, accountNumber } = req.body || {};
  if (!bankCode || !accountNumber) return res.status(400).json({ error: 'bankCode and accountNumber are required.' });

  try {
    const resolved = await paystack.resolveAccountNumber(accountNumber, bankCode);
    const group = await prisma.group.findUnique({ where: { id: req.params.id } });
    const banks = await paystack.listBanks();
    const bank = banks.find((b) => b.code === bankCode);

    const subaccount = await paystack.createSubaccount({
      businessName: `${group.name} (Ajo Savings Tracker)`,
      bankCode,
      accountNumber,
    });

    const updated = await prisma.group.update({
      where: { id: req.params.id },
      data: {
        bankCode,
        bankName: bank ? bank.name : null,
        accountNumber,
        accountName: resolved.account_name,
        subaccountCode: subaccount.subaccount_code,
      },
    });

    res.json(await loadGroupForUser(updated.id, req.userId));
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not verify or save that bank account.' });
  }
});

// =========================================================================
// Contributions — real payments via Paystack
// =========================================================================

// POST /api/groups/:id/contributions/initiate
// body: { amount } — defaults to the group's standard contribution amount.
// Returns a Paystack checkout URL; the frontend redirects the member there.
app.post('/api/groups/:id/contributions/initiate', requireAuth, async (req, res) => {
  const membership = await getMembership(req.userId, req.params.id);
  if (!membership) return res.status(404).json({ error: 'Group not found.' });

  const group = await prisma.group.findUnique({ where: { id: req.params.id } });
  if (!group.subaccountCode) {
    return res.status(400).json({ error: "The group admin hasn't set up a payout bank account yet — ask them to add one first." });
  }

  const amount = req.body && Number.isFinite(Number(req.body.amount)) ? Number(req.body.amount) : group.contributionAmount;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number.' });

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  const reference = `ajo_${crypto.randomUUID()}`;

  try {
    const tx = await paystack.initializeTransaction({
      email: user.email,
      amountKobo: Math.round(amount * 100),
      reference,
      subaccountCode: group.subaccountCode,
      callbackUrl: `${APP_URL}/api/payments/callback`,
      metadata: { groupId: group.id, membershipId: membership.id },
    });

    await prisma.contribution.create({
      data: {
        groupId: group.id,
        membershipId: membership.id,
        amount,
        round: group.currentRound,
        paymentReference: reference,
        status: 'pending',
      },
    });

    res.json({ authorizationUrl: tx.authorization_url });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || 'Could not start the payment.' });
  }
});

// GET /api/payments/callback — Paystack redirects the member's browser here
// after checkout. The webhook is the source of truth for marking a payment
// successful; this verifies too as a same-instant fallback, then redirects
// back into the app with a status the frontend can show as a toast.
app.get('/api/payments/callback', async (req, res) => {
  const reference = req.query.reference || req.query.trxref;
  if (!reference) return res.redirect('/?payment=failed');

  try {
    const contribution = await prisma.contribution.findUnique({ where: { paymentReference: String(reference) } });
    if (!contribution) return res.redirect('/?payment=failed');

    if (contribution.status !== 'success') {
      const tx = await paystack.verifyTransaction(String(reference));
      if (tx.status === 'success') {
        await prisma.contribution.update({ where: { id: contribution.id }, data: { status: 'success' } });
      } else {
        await prisma.contribution.update({ where: { id: contribution.id }, data: { status: 'failed' } });
        return res.redirect(`/?payment=failed&groupId=${contribution.groupId}`);
      }
    }
    res.redirect(`/?payment=success&groupId=${contribution.groupId}`);
  } catch (err) {
    console.error(err);
    res.redirect('/?payment=failed');
  }
});

// =========================================================================
// Payouts — admin only, advances the round
// =========================================================================

app.post('/api/groups/:id/payout', requireAuth, async (req, res) => {
  const requester = await getMembership(req.userId, req.params.id);
  if (!requester) return res.status(404).json({ error: 'Group not found.' });
  if (requester.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can record a payout.' });

  const detail = await loadGroupForUser(req.params.id, req.userId);
  if (!detail.currentRecipient) return res.status(400).json({ error: 'Set a payout order before recording a payout.' });

  const suggested = detail.contributionAmount * detail.members.length;
  const amount = req.body && Number.isFinite(Number(req.body.amount)) ? Number(req.body.amount) : suggested;

  await prisma.$transaction([
    prisma.payout.create({
      data: {
        groupId: req.params.id,
        membershipId: detail.currentRecipient.membershipId,
        amount,
        round: detail.currentRound,
      },
    }),
    prisma.group.update({ where: { id: req.params.id }, data: { currentRound: { increment: 1 } } }),
  ]);

  res.status(201).json(await loadGroupForUser(req.params.id, req.userId));
});

// Health check (used by Render's deploy checks)
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`🚀 Ajo Savings Tracker API running at http://localhost:${PORT}`);
});
