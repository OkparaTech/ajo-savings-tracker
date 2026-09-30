'use strict';
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const auth = require('./auth');
const { sendAccountLink } = require('./mail');
const { AppError, text, money, nextDue, financials, MAX_KOBO } = require('./domain');
const { generateInviteCode } = require('./inviteCode');
const {
  includes,
  audit,
  locked,
  membership,
  editable,
  groupDetail,
  createPaymentService,
  databaseFinancials,
  pendingRecords,
} = require('./services');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function createApp({ prisma, paystack, appUrl, mailer = null, logger = console, rateLimits = {} }) {
  const origin = new URL(appUrl).origin;
  const app = express();
  app.disable('x-powered-by');
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 3)
    throw new Error('Invalid TRUST_PROXY_HOPS.');
  app.set('trust proxy', proxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  const payments = createPaymentService(prisma, paystack);
  app.locals.payments = payments;
  app.post(
    '/api/webhooks/paystack',
    express.raw({ type: 'application/json', limit: '256kb' }),
    wrap(async (req, res) => {
      await payments.receive(req.body, req.get('x-paystack-signature'));
      res.status(200).send('ok');
    }),
  );
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') !== origin || !req.is('application/json'))
        return next(new AppError(403, 'Use the application page to make changes.'));
    }
    next();
  });
  const rate = (scope, limit, windowMs = 60000, key = (req) => req.ip) =>
    wrap(async (req, res, next) => {
      const bucket = Math.floor(Date.now() / windowMs);
      const id = crypto
        .createHash('sha256')
        .update(`${scope}:${key(req)}:${bucket}`)
        .digest('hex');
      const row = await prisma.rateBucket.upsert({
        where: { id },
        create: { id, count: 1, expiresAt: new Date((bucket + 1) * windowMs) },
        update: { count: { increment: 1 } },
      });
      if (row.count > limit) {
        res.set('Retry-After', String(Math.ceil(((bucket + 1) * windowMs - Date.now()) / 1000)));
        throw new AppError(429, 'Too many attempts. Please wait before trying again.');
      }
      next();
    });
  app.use('/api', rate('api', 180));
  const authLimit = rate('auth-ip', 15, 15 * 60000);
  const emailLimit = rate('auth-email', 15, 15 * 60000, (req) =>
    String(req.body?.email || '')
      .trim()
      .toLowerCase(),
  );
  const authenticated = auth.requireAuth(prisma);
  const sensitive = rate('sensitive', rateLimits.sensitive || 10);
  function userJson(user, session) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      csrfToken: session.csrfToken,
      paymentEnvironment: paystack.environment,
      emailVerified: user.emailVerified,
      emailDeliveryEnabled: Boolean(mailer),
    };
  }
  const passwordValue = (value) => {
    if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 72)
      throw new AppError(400, 'Password must have at least 12 characters and at most 72 bytes.');
    return value;
  };
  const emailValue = (value) => {
    const email = text(value, 'Email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Enter a valid email.');
    return email;
  };
  app.post(
    '/api/auth/signup',
    authLimit,
    emailLimit,
    wrap(async (req, res) => {
      const name = text(req.body?.name, 'Name', 80),
        email = emailValue(req.body?.email),
        password = passwordValue(req.body?.password);
      const user = await prisma.user.create({
        data: { name, email, password: await auth.hashPassword(password) },
      });
      await sendAccountLink(prisma, mailer, user, 'verify', origin);
      const session = await auth.createSession(prisma, res, user.id);
      res.status(201).json(userJson(user, session));
    }),
  );
  app.post(
    '/api/auth/login',
    authLimit,
    emailLimit,
    wrap(async (req, res) => {
      const email = emailValue(req.body?.email),
        password = req.body?.password;
      if (typeof password !== 'string' || Buffer.byteLength(password) > 72)
        throw new AppError(400, 'Invalid password.');
      const user = await prisma.user.findUnique({ where: { email } });
      // Equalize password-hash work for unknown users without exposing account existence.
      const valid = await auth.verifyPassword(
        password,
        user?.password || '$2a$12$0n98mlfnRDfyPKZR/UakU.YTHHRFdWjWAnIQACVNL.1XwARvX9cz2',
      );
      if (!user || !valid) throw new AppError(401, 'Incorrect email or password.');
      const session = await auth.createSession(prisma, res, user.id);
      res.json(userJson(user, session));
    }),
  );
  app.get(
    '/api/auth/me',
    authenticated,
    wrap(async (req, res) => res.json(userJson(req.user, req.session))),
  );
  app.post(
    '/api/auth/logout',
    authenticated,
    wrap(async (req, res) => {
      await prisma.session.deleteMany({ where: { id: req.session.id } });
      res.clearCookie(auth.COOKIE_NAME, auth.cookieOptions());
      res.status(204).end();
    }),
  );
  app.post(
    '/api/auth/password',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      const password = await auth.hashPassword(passwordValue(req.body.newPassword));
      await prisma.$transaction([
        prisma.user.update({ where: { id: req.userId }, data: { password } }),
        prisma.session.deleteMany({ where: { userId: req.userId } }),
      ]);
      res.clearCookie(auth.COOKIE_NAME, auth.cookieOptions());
      res.status(204).end();
    }),
  );
  app.post(
    '/api/auth/forgot-password',
    authLimit,
    emailLimit,
    wrap(async (req, res) => {
      const email = emailValue(req.body?.email);
      const user = await prisma.user.findUnique({ where: { email } });
      if (user) await sendAccountLink(prisma, mailer, user, 'reset', origin);
      res.json({
        message:
          'If that account exists and email delivery is configured, a reset link will arrive shortly.',
      });
    }),
  );
  app.post(
    '/api/auth/send-verification',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      if (!mailer)
        throw new AppError(503, 'Email delivery is not configured. Contact the operator.');
      if (
        !req.user.emailVerified &&
        !(await sendAccountLink(prisma, mailer, req.user, 'verify', origin))
      )
        throw new AppError(503, 'Email could not be sent. Try again later.');
      res.json({ message: 'Check your email for the verification link.' });
    }),
  );
  for (const kind of ['verify', 'reset'])
    app.post(
      `/api/auth/${kind}`,
      authLimit,
      wrap(async (req, res) => {
        const token = req.body?.token;
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
          throw new AppError(400, 'Invalid or expired link.');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const newPassword =
          kind === 'reset' ? await auth.hashPassword(passwordValue(req.body?.newPassword)) : null;
        await prisma.$transaction(async (tx) => {
          const rows =
            await tx.$queryRaw`SELECT id FROM "AccountToken" WHERE "tokenHash"=${tokenHash} FOR UPDATE`;
          if (!rows.length) throw new AppError(400, 'Invalid or expired link.');
          const row = await tx.accountToken.findUnique({ where: { tokenHash } });
          if (row.kind !== kind || row.expiresAt <= new Date())
            throw new AppError(400, 'Invalid or expired link.');
          await tx.user.update({
            where: { id: row.userId },
            data: kind === 'verify' ? { emailVerified: true } : { password: newPassword },
          });
          if (kind === 'reset') await tx.session.deleteMany({ where: { userId: row.userId } });
          await tx.accountToken.deleteMany({ where: { userId: row.userId, kind } });
        });
        res.json({
          message:
            kind === 'verify'
              ? 'Email verified.'
              : 'Password reset. Log in with your new password.',
        });
      }),
    );
  app.get(
    '/api/groups',
    authenticated,
    wrap(async (req, res) => {
      const memberships = await prisma.membership.findMany({
        where: { userId: req.userId, active: true },
        include: {
          group: { include: { _count: { select: { memberships: { where: { active: true } } } } } },
        },
        take: 100,
        orderBy: { joinedAt: 'desc' },
      });
      const groupIds = memberships.map((m) => m.groupId);
      const [contributions, payouts] = await Promise.all([
        prisma.contribution.groupBy({
          by: ['groupId'],
          where: { groupId: { in: groupIds }, status: 'success', disputed: false },
          _sum: { amountKobo: true, refundedKobo: true },
        }),
        prisma.payout.groupBy({
          by: ['groupId'],
          where: { groupId: { in: groupIds }, status: { in: ['confirmed', 'legacy'] } },
          _sum: { amountKobo: true },
        }),
      ]);
      res.json(
        memberships.map(({ group, role }) => {
          const c = contributions.find((c) => c.groupId === group.id),
            p = payouts.find((p) => p.groupId === group.id),
            collected = (c?._sum.amountKobo || 0) - (c?._sum.refundedKobo || 0);
          return {
            id: group.id,
            name: group.name,
            status: group.status,
            frequency: group.frequency,
            currentRound: group.currentRound,
            contributionAmount: group.contributionKobo / 100,
            memberCount: group._count.memberships,
            totalPool: collected / 100,
            availableBalance: (collected - (p?._sum.amountKobo || 0)) / 100,
            myRole: role,
          };
        }),
      );
    }),
  );
  app.post(
    '/api/groups',
    authenticated,
    wrap(async (req, res) => {
      const name = text(req.body?.name, 'Group name', 80),
        contributionKobo = money(req.body?.contributionAmount);
      const frequency = req.body?.frequency || 'monthly';
      if (!['daily', 'weekly', 'monthly'].includes(frequency))
        throw new AppError(400, 'Choose daily, weekly or monthly.');
      if ((await prisma.membership.count({ where: { userId: req.userId, active: true } })) >= 100)
        throw new AppError(409, 'Group limit reached.');
      const group = await prisma.$transaction(async (tx) => {
        const g = await tx.group.create({
          data: {
            name,
            contributionKobo,
            frequency,
            inviteCode: generateInviteCode(),
            memberships: { create: { userId: req.userId, role: 'admin' } },
          },
          include: { memberships: true },
        });
        await tx.payoutOrderEntry.create({
          data: { groupId: g.id, membershipId: g.memberships[0].id, position: 0 },
        });
        await audit(tx, g.id, req.userId, 'group.created');
        return g;
      });
      res.status(201).json(await groupDetail(prisma, group.id, req.userId));
    }),
  );
  app.post(
    '/api/groups/join',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      const inviteCode = text(req.body?.inviteCode, 'Invite code', 10).toUpperCase();
      const group = await prisma.group.findUnique({ where: { inviteCode } });
      if (!group) throw new AppError(404, 'No group found with this code.');
      await locked(prisma, group.id, async (tx) => {
        const g = await tx.group.findUnique({ where: { id: group.id } });
        editable(g);
        const members = await tx.membership.findMany({ where: { groupId: g.id, active: true } });
        if (members.length >= 50 || (members.length + 1) * g.contributionKobo > MAX_KOBO)
          throw new AppError(409, 'Group contribution or member limit reached.');
        if (
          await tx.bankChange.count({
            where: { groupId: g.id, status: { in: ['pending', 'applying'] } },
          })
        )
          throw new AppError(409, 'Wait until the bank proposal is resolved before joining.');
        const existing = await tx.membership.findUnique({
          where: { userId_groupId: { userId: req.userId, groupId: g.id } },
        });
        if (existing)
          throw new AppError(
            409,
            existing.active
              ? 'You are already a member.'
              : 'Ask the administrator to restore your membership.',
          );
        const m = existing
          ? await tx.membership.update({
              where: { id: existing.id },
              data: { active: true, joinedAt: new Date() },
            })
          : await tx.membership.create({ data: { userId: req.userId, groupId: g.id } });
        await tx.payoutOrderEntry.create({
          data: { groupId: g.id, membershipId: m.id, position: members.length },
        });
        await audit(tx, g.id, req.userId, 'member.joined', { membershipId: m.id });
      });
      res.status(201).json(await groupDetail(prisma, group.id, req.userId));
    }),
  );
  app.get(
    '/api/groups/:id',
    authenticated,
    wrap(async (req, res) => res.json(await groupDetail(prisma, req.params.id, req.userId))),
  );
  app.delete(
    '/api/groups/:id',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id, true);
        editable(m.group);
        if (
          await tx.contribution.count({
            where: { groupId: m.groupId, status: { in: ['initializing', 'pending', 'unknown'] } },
          })
        )
          throw new AppError(409, 'Resolve pending payments before archiving.');
        await tx.group.update({ where: { id: m.groupId }, data: { status: 'archived' } });
        await audit(tx, m.groupId, req.userId, 'group.archived');
      });
      res.status(204).end();
    }),
  );
  app.delete(
    '/api/groups/:id/members/:membershipId',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      await locked(prisma, req.params.id, async (tx) => {
        const requester = await membership(tx, req.userId, req.params.id, true);
        editable(requester.group);
        const target = await tx.membership.findUnique({ where: { id: req.params.membershipId } });
        if (!target?.active || target.groupId !== req.params.id)
          throw new AppError(404, 'Member not found.');
        if (target.role === 'admin')
          throw new AppError(
            409,
            'Transfer administrator responsibility before removing an administrator.',
          );
        if (
          await tx.contribution.count({
            where: {
              membershipId: target.id,
              status: { in: ['initializing', 'pending', 'unknown'] },
            },
          })
        )
          throw new AppError(409, 'Resolve this member’s pending payments first.');
        await tx.membership.update({ where: { id: target.id }, data: { active: false } });
        await tx.group.update({
          where: { id: target.groupId },
          data: { inviteCode: generateInviteCode() },
        });
        const order = await tx.payoutOrderEntry.findMany({
          where: { groupId: target.groupId, membershipId: { not: target.id } },
          orderBy: { position: 'asc' },
        });
        await tx.payoutOrderEntry.deleteMany({ where: { groupId: target.groupId } });
        await tx.payoutOrderEntry.createMany({
          data: order.map((e, position) => ({
            groupId: e.groupId,
            membershipId: e.membershipId,
            position,
          })),
        });
        await tx.bankChange.updateMany({
          where: { groupId: target.groupId, status: 'pending' },
          data: { status: 'cancelled' },
        });
        await audit(tx, target.groupId, req.userId, 'member.deactivated', {
          membershipId: target.id,
        });
      });
      res.json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.post(
    '/api/groups/:id/administrator',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      const membershipId = text(req.body?.membershipId, 'Member', 80);
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id, true);
        editable(m.group);
        const target = await tx.membership.findUnique({ where: { id: membershipId } });
        if (!target?.active || target.groupId !== m.groupId || target.id === m.id)
          throw new AppError(400, 'Choose another active member.');
        if (
          await tx.bankChange.count({
            where: { groupId: m.groupId, status: { in: ['pending', 'applying'] } },
          })
        )
          throw new AppError(409, 'Resolve the bank proposal first.');
        await tx.membership.update({ where: { id: target.id }, data: { role: 'admin' } });
        await tx.membership.update({ where: { id: m.id }, data: { role: 'member' } });
        await audit(tx, m.groupId, req.userId, 'administrator.transferred', { membershipId });
      });
      res.json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.put(
    '/api/groups/:id/payout-order',
    authenticated,
    wrap(async (req, res) => {
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id, true);
        editable(m.group);
        const members = await tx.membership.findMany({
          where: { groupId: m.groupId, active: true },
        });
        const order = req.body?.order;
        if (
          !Array.isArray(order) ||
          order.length !== members.length ||
          new Set(order).size !== order.length ||
          !order.every((id) => members.some((m) => m.id === id))
        )
          throw new AppError(400, 'Include every active member exactly once.');
        await tx.payoutOrderEntry.deleteMany({ where: { groupId: m.groupId } });
        await tx.payoutOrderEntry.createMany({
          data: order.map((membershipId, position) => ({
            groupId: m.groupId,
            membershipId,
            position,
          })),
        });
        await audit(tx, m.groupId, req.userId, 'order.changed', { order });
      });
      res.json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.post(
    '/api/groups/:id/start',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id, true);
        editable(m.group);
        const group = await tx.group.findUnique({ where: { id: m.groupId }, include: includes });
        const members = group.memberships.filter((m) => m.active);
        if (
          members.length < 2 ||
          !group.subaccountCode ||
          group.payoutOrder.length !== members.length
        )
          throw new AppError(
            409,
            'Set up a bank account and at least two members with a complete order.',
          );
        if (
          await tx.bankChange.count({
            where: { groupId: group.id, status: { in: ['pending', 'applying'] } },
          })
        )
          throw new AppError(409, 'Resolve the bank proposal first.');
        if (await pendingRecords(tx, group.id, false))
          throw new AppError(409, 'Resolve outstanding payments and payouts first.');
        if (
          (await tx.contribution.count({ where: { groupId: group.id, disputed: true } })) ||
          (await databaseFinancials(tx, group)).ledgerBalanceKobo < 0
        )
          throw new AppError(409, 'Financial review is required.');
        await tx.group.update({
          where: { id: group.id },
          data: {
            status: 'active',
            cycleStartRound: group.currentRound,
            cycleSize: members.length,
            dueAt: nextDue(group.frequency),
          },
        });
        await audit(tx, group.id, req.userId, 'cycle.started', {
          startRound: group.currentRound,
          roster: members.map((m) => m.id),
          order: group.payoutOrder.map((e) => e.membershipId),
          contributionKobo: group.contributionKobo,
        });
      });
      res.json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.get(
    '/api/paystack/banks',
    authenticated,
    sensitive,
    wrap(async (req, res) =>
      res.json((await paystack.listBanks()).map((b) => ({ name: b.name, code: b.code }))),
    ),
  );
  app.post(
    '/api/groups/:id/bank-details',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      const bankCode = text(req.body?.bankCode, 'Bank code', 20),
        accountNumber = text(req.body?.accountNumber, 'Account number', 10);
      if (!/^\d{10}$/.test(accountNumber) || !/^\d+$/.test(bankCode))
        throw new AppError(400, 'Enter a valid bank and 10-digit account number.');
      await membership(prisma, req.userId, req.params.id, true);
      const resolved = await paystack.resolveAccountNumber(accountNumber, bankCode);
      const bank = (await paystack.listBanks()).find((b) => b.code === bankCode);
      if (!bank || !resolved?.account_name || resolved.account_number !== accountNumber)
        throw new AppError(400, 'Could not verify this account.');
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id, true);
        editable(m.group);
        if (
          await tx.contribution.count({
            where: { groupId: m.groupId, status: { in: ['initializing', 'pending', 'unknown'] } },
          })
        )
          throw new AppError(409, 'Resolve pending payments before changing the bank account.');
        if (await tx.bankChange.count({ where: { groupId: m.groupId, status: 'applying' } }))
          throw new AppError(409, 'An account change is being applied.');
        await tx.bankChange.updateMany({
          where: { groupId: m.groupId, status: 'pending' },
          data: { status: 'cancelled' },
        });
        const proposal = await tx.bankChange.create({
          data: {
            groupId: m.groupId,
            proposedBy: req.userId,
            bankCode,
            bankName: bank.name,
            accountNumber,
            accountName: resolved.account_name,
            approvals: [req.userId],
          },
        });
        await audit(tx, m.groupId, req.userId, 'bank.proposed', {
          proposalId: proposal.id,
          accountName: proposal.accountName,
          last4: accountNumber.slice(-4),
        });
      });
      res.status(201).json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.post(
    '/api/groups/:id/bank-changes/:proposalId/approve',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      const proposal = await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id);
        editable(m.group);
        const p = await tx.bankChange.findUnique({ where: { id: req.params.proposalId } });
        if (!p || p.groupId !== m.groupId || p.status !== 'pending')
          throw new AppError(409, 'Proposal is no longer pending.');
        const approvals = [...new Set([...p.approvals, req.userId])];
        const members = await tx.membership.findMany({
          where: { groupId: m.groupId, active: true },
        });
        const ready = members.every((member) => approvals.includes(member.userId));
        await tx.bankChange.update({
          where: { id: p.id },
          data: { approvals, status: ready ? 'applying' : 'pending' },
        });
        await audit(tx, m.groupId, req.userId, 'bank.approved', { proposalId: p.id });
        return ready ? p : null;
      });
      if (proposal) {
        try {
          const subaccount = await paystack.createSubaccount({
            businessName: 'Ajo savings group',
            bankCode: proposal.bankCode,
            accountNumber: proposal.accountNumber,
          });
          if (!subaccount?.subaccount_code) throw new Error('Missing subaccount code');
          await locked(prisma, req.params.id, async (tx) => {
            const p = await tx.bankChange.findUnique({ where: { id: proposal.id } });
            if (p.status !== 'applying') throw new AppError(409, 'Bank change state changed.');
            const group = await tx.group.findUnique({ where: { id: p.groupId } });
            editable(group);
            await tx.group.update({
              where: { id: p.groupId },
              data: {
                bankCode: p.bankCode,
                bankName: p.bankName,
                accountNumber: p.accountNumber,
                accountName: p.accountName,
                subaccountCode: subaccount.subaccount_code,
              },
            });
            await tx.bankChange.update({ where: { id: p.id }, data: { status: 'applied' } });
            await audit(tx, p.groupId, req.userId, 'bank.changed', {
              proposalId: p.id,
              last4: p.accountNumber.slice(-4),
            });
          });
        } catch (error) {
          await prisma.bankChange.updateMany({
            where: { id: proposal.id, status: 'applying' },
            data: { status: 'pending' },
          });
          throw error;
        }
      }
      res.json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.post(
    '/api/groups/:id/contributions/initiate',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      if (paystack.environment === 'live' && !req.user.emailVerified)
        throw new AppError(403, 'Verify your email before making a live payment.');
      const key = text(req.get('idempotency-key'), 'Idempotency key', 80);
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(key)) throw new AppError(400, 'Invalid idempotency key.');
      const scopedKey = `${req.userId}:${key}`;
      const intent = await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id);
        if (m.group.status !== 'active')
          throw new AppError(409, 'Contributions open only during an active cycle.');
        const existing = await tx.contribution.findUnique({ where: { idempotencyKey: scopedKey } });
        if (existing) {
          if (
            existing.groupId !== m.groupId ||
            (req.body.amount !== undefined && money(req.body.amount) !== existing.amountKobo)
          )
            throw new AppError(409, 'Idempotency key was used for a different payment.');
          return { contribution: existing, fresh: false };
        }
        const contributions = await tx.contribution.findMany({
          where: { membershipId: m.id, round: m.group.currentRound },
        });
        if (await tx.payout.count({ where: { groupId: m.groupId, round: m.group.currentRound } }))
          throw new AppError(409, 'A payout is already awaiting confirmation.');
        const reserved = contributions
          .filter((c) => c.status !== 'failed')
          .reduce(
            (n, c) =>
              n +
              (c.status === 'success'
                ? c.disputed
                  ? 0
                  : c.amountKobo - c.refundedKobo
                : c.amountKobo),
            0,
          );
        const remaining = m.group.contributionKobo - reserved;
        if (remaining <= 0)
          throw new AppError(
            409,
            'Your contribution is paid or has a payment awaiting verification.',
          );
        const amountKobo = req.body?.amount === undefined ? remaining : money(req.body.amount);
        if (amountKobo > remaining)
          throw new AppError(400, 'Payment exceeds your outstanding contribution.');
        const contribution = await tx.contribution.create({
          data: {
            groupId: m.groupId,
            membershipId: m.id,
            amountKobo,
            round: m.group.currentRound,
            paymentReference: `ajo-${crypto.randomUUID()}`,
            idempotencyKey: scopedKey,
            status: 'initializing',
            environment: paystack.environment,
            subaccountCode: m.group.subaccountCode,
          },
        });
        await audit(tx, m.groupId, req.userId, 'payment.intent_created', {
          reference: contribution.paymentReference,
          amountKobo,
        });
        return { contribution, fresh: true };
      });
      const c = intent.contribution;
      if (!intent.fresh) {
        if (c.authorizationUrl && !['failed', 'success'].includes(c.status))
          return res.json({ authorizationUrl: c.authorizationUrl, reference: c.paymentReference });
        throw new AppError(
          409,
          c.status === 'success'
            ? 'Payment is already confirmed.'
            : 'Payment is being reconciled. Do not pay again.',
        );
      }
      try {
        const checkout = await paystack.initializeTransaction({
          email: req.user.email,
          amountKobo: c.amountKobo,
          reference: c.paymentReference,
          subaccountCode: c.subaccountCode,
          callbackUrl: `${origin}/api/payments/callback`,
          metadata: { groupId: c.groupId, membershipId: c.membershipId },
        });
        const checkoutUrl = new URL(checkout.authorization_url);
        if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.paystack.com')
          throw new Error('Unexpected checkout origin');
        await prisma.contribution.updateMany({
          where: { id: c.id, status: { in: ['initializing', 'unknown', 'pending'] } },
          data: { authorizationUrl: checkoutUrl.href, status: 'pending' },
        });
        res.json({ authorizationUrl: checkoutUrl.href, reference: c.paymentReference });
      } catch (error) {
        await prisma.contribution.updateMany({
          where: { id: c.id, status: 'initializing' },
          data: { status: error.definitiveRejection ? 'failed' : 'unknown' },
        });
        throw new AppError(
          502,
          'Checkout could not be confirmed. Your saved payment intent will be reconciled; do not pay again yet.',
        );
      }
    }),
  );
  app.get(
    '/api/payments/callback',
    wrap(async (req, res) => {
      const reference = req.query.reference || req.query.trxref;
      if (typeof reference !== 'string' || reference.length > 100)
        return res.redirect('/?payment=pending');
      try {
        const status = await payments.verify(reference);
        res.redirect(
          `/?payment=${status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending'}`,
        );
      } catch {
        res.redirect('/?payment=pending');
      }
    }),
  );
  app.post(
    '/api/groups/:id/payments/:reference/verify',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await membership(prisma, req.userId, req.params.id);
      const c = await prisma.contribution.findUnique({
        where: { paymentReference: req.params.reference },
      });
      if (!c || c.groupId !== req.params.id) throw new AppError(404, 'Payment not found.');
      res.json({ status: await payments.verify(c.paymentReference) });
    }),
  );
  app.post(
    '/api/groups/:id/reconcile',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      const balanceKobo = money(req.body?.balance, { allowZero: true }),
        statementReference = text(req.body?.statementReference, 'Bank statement reference', 120);
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id, true);
        await tx.bankReconciliation.create({
          data: {
            groupId: m.groupId,
            round: m.group.currentRound,
            balanceKobo,
            statementReference,
            actorUserId: req.userId,
          },
        });
        await audit(tx, m.groupId, req.userId, 'bank.reconciled', {
          balanceKobo,
          statementReference,
        });
      });
      res.status(201).json({
        message: 'Bank balance attestation recorded. This is not an automatic bank verification.',
      });
    }),
  );
  app.post(
    '/api/groups/:id/payout',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      const expectedRound = req.body?.expectedRound;
      if (!Number.isInteger(expectedRound) || expectedRound < 0)
        throw new AppError(400, 'Specify the expected round.');
      const transferReference = text(req.body?.transferReference, 'Transfer reference', 120);
      const key = text(req.get('idempotency-key'), 'Idempotency key', 80);
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(key)) throw new AppError(400, 'Invalid idempotency key.');
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id, true);
        const existing = await tx.payout.findUnique({
          where: { idempotencyKey: `${req.userId}:${key}` },
        });
        if (existing) {
          if (
            existing.groupId !== m.groupId ||
            existing.round !== expectedRound ||
            existing.transferReference !== transferReference
          )
            throw new AppError(409, 'Idempotency key was used for a different payout.');
          return;
        }
        const group = await tx.group.findUnique({ where: { id: m.groupId }, include: includes });
        if (group.status !== 'active' || group.currentRound !== expectedRound)
          throw new AppError(409, 'The round changed. Refresh before recording a payout.');
        const finances = await databaseFinancials(tx, group),
          amountKobo = group.contributionKobo * group.cycleSize;
        if (req.body.amount !== undefined && money(req.body.amount) !== amountKobo)
          throw new AppError(400, 'Payout must match the round obligation.');
        if (
          !finances.allPaid ||
          finances.ledgerBalanceKobo < amountKobo ||
          (await tx.contribution.count({
            where: { groupId: group.id, status: { in: ['initializing', 'pending', 'unknown'] } },
          }))
        )
          throw new AppError(
            409,
            'All contributions must be confirmed and sufficient before recording a payout.',
          );
        if (group.payoutHistory.some((p) => p.round === expectedRound))
          throw new AppError(409, 'This round already has a payout.');
        const bank = await tx.bankReconciliation.findFirst({
          where: {
            groupId: group.id,
            round: expectedRound,
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60000) },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (!bank || bank.balanceKobo < amountKobo)
          throw new AppError(
            409,
            'Record a recent settled bank balance sufficient for this payout first.',
          );
        const recipient = group.payoutOrder[expectedRound - group.cycleStartRound];
        if (!recipient) throw new AppError(409, 'Invalid cycle recipient.');
        await tx.payout.create({
          data: {
            groupId: group.id,
            membershipId: recipient.membershipId,
            round: expectedRound,
            amountKobo,
            transferReference,
            idempotencyKey: `${req.userId}:${key}`,
          },
        });
        await audit(tx, group.id, req.userId, 'payout.recorded', {
          round: expectedRound,
          amountKobo,
          transferReference,
        });
      });
      res.status(201).json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.post(
    '/api/groups/:id/payouts/:payoutId/confirm',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id);
        const p = await tx.payout.findUnique({ where: { id: req.params.payoutId } });
        if (!p || p.groupId !== m.groupId || p.membershipId !== m.id)
          throw new AppError(403, 'Only the payout recipient can confirm receipt.');
        if (p.status === 'confirmed') return;
        if (
          !['awaiting_confirmation', 'disputed'].includes(p.status) ||
          !['active', 'review'].includes(m.group.status) ||
          p.round !== m.group.currentRound
        )
          throw new AppError(409, 'This payout requires review.');
        const snapshot = await tx.group.findUnique({ where: { id: m.groupId }, include: includes });
        if (
          (await tx.contribution.count({ where: { groupId: snapshot.id, disputed: true } })) ||
          !(await databaseFinancials(tx, snapshot)).allPaid ||
          (await databaseFinancials(tx, snapshot)).ledgerBalanceKobo < p.amountKobo
        )
          throw new AppError(
            409,
            'Payment reversal or insufficient funds requires operator review.',
          );
        await tx.payout.update({
          where: { id: p.id },
          data: { status: 'confirmed', confirmedAt: new Date() },
        });
        const nextRound = m.group.currentRound + 1;
        const complete = nextRound - m.group.cycleStartRound >= m.group.cycleSize;
        await tx.group.update({
          where: { id: m.groupId },
          data: {
            currentRound: nextRound,
            status: complete ? 'completed' : 'active',
            dueAt: complete ? null : nextDue(m.group.frequency),
          },
        });
        await audit(tx, m.groupId, req.userId, 'payout.confirmed', {
          payoutId: p.id,
          round: p.round,
        });
      });
      res.json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.post(
    '/api/groups/:id/payouts/:payoutId/dispute',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      const reason = text(req.body?.reason, 'Reason', 500);
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id);
        const p = await tx.payout.findUnique({ where: { id: req.params.payoutId } });
        if (
          !p ||
          p.groupId !== m.groupId ||
          p.membershipId !== m.id ||
          p.status !== 'awaiting_confirmation'
        )
          throw new AppError(409, 'Only the recipient can dispute an unconfirmed payout.');
        await tx.payout.update({ where: { id: p.id }, data: { status: 'disputed' } });
        await tx.group.update({ where: { id: m.groupId }, data: { status: 'review' } });
        await audit(tx, m.groupId, req.userId, 'payout.disputed', { payoutId: p.id, reason });
      });
      res.json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.post(
    '/api/groups/:id/review/approve',
    authenticated,
    sensitive,
    wrap(async (req, res) => {
      await auth.reauthenticate(req);
      await locked(prisma, req.params.id, async (tx) => {
        const m = await membership(tx, req.userId, req.params.id);
        if (m.group.status !== 'review')
          throw new AppError(409, 'This group is not awaiting review.');
        const group = await tx.group.findUnique({ where: { id: m.groupId }, include: includes });
        if (await pendingRecords(tx, group.id, true))
          throw new AppError(
            409,
            'Resolve disputed and pending financial records with the operator first.',
          );
        const finances = await databaseFinancials(tx, group);
        const bank = await tx.bankReconciliation.findFirst({
          where: {
            groupId: group.id,
            round: group.currentRound,
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60000) },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (
          finances.ledgerBalanceKobo < 0 ||
          !bank ||
          bank.balanceKobo !== finances.ledgerBalanceKobo
        )
          throw new AppError(
            409,
            'A recent bank attestation must match the nonnegative ledger balance before review approval.',
          );
        await audit(tx, group.id, req.userId, 'review.approved', { reconciliationId: bank.id });
        const events = await tx.auditEvent.findMany({
          where: { groupId: group.id, action: 'review.approved' },
        });
        const approvals = new Set(
          events.filter((e) => e.data.reconciliationId === bank.id).map((e) => e.actorUserId),
        );
        if (group.memberships.filter((m) => m.active).every((m) => approvals.has(m.userId))) {
          const active =
            group.cycleSize > 0 && group.currentRound < group.cycleStartRound + group.cycleSize;
          await tx.group.update({
            where: { id: group.id },
            data: {
              status: active ? 'active' : 'completed',
              dueAt: active ? nextDue(group.frequency) : null,
            },
          });
          await audit(tx, group.id, req.userId, 'review.completed', { reconciliationId: bank.id });
        }
      });
      res.json(await groupDetail(prisma, req.params.id, req.userId));
    }),
  );
  app.get(
    '/api/groups/:id/export',
    authenticated,
    wrap(async (req, res) => {
      await membership(prisma, req.userId, req.params.id, false, true);
      const group = await prisma.group.findUnique({
        where: { id: req.params.id },
        include: { ...includes, contributions: true, payoutHistory: true },
      });
      const quote = (value) =>
        `"${String(value ?? '')
          .replace(/^[=+@\-\t\r]/, "'$&")
          .replace(/"/g, '""')}"`;
      const rows = [['type', 'date', 'member', 'round', 'amount_ngn', 'status', 'reference']];
      const name = (id) => group.memberships.find((m) => m.id === id)?.user.name || 'Former member';
      for (const c of group.contributions)
        rows.push([
          'contribution',
          c.date.toISOString(),
          name(c.membershipId),
          c.round + 1,
          (c.amountKobo - c.refundedKobo) / 100,
          c.disputed ? 'disputed' : c.status,
          c.paymentReference,
        ]);
      for (const p of group.payoutHistory)
        rows.push([
          'manual_payout',
          p.date.toISOString(),
          name(p.membershipId),
          p.round + 1,
          p.amountKobo / 100,
          p.status,
          p.transferReference,
        ]);
      res
        .set('Content-Disposition', 'attachment; filename="ajo-ledger.csv"')
        .type('text/csv')
        .send(rows.map((row) => row.map(quote).join(',')).join('\r\n'));
    }),
  );
  app.get(
    '/api/health',
    wrap(async (req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    }),
  );
  app.use('/api', (req, res, next) => next(new AppError(404, 'Endpoint not found.')));
  app.use(express.static(path.join(__dirname, '../../public')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status =
      error.status ||
      (error.code === 'P2002' ? 409 : error.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500)
      logger.error({
        event: 'request.failed',
        method: req.method,
        path: req.path,
        code: error.code || 'INTERNAL',
      });
    res.status(status).json({
      error:
        status >= 500
          ? 'The service could not complete this request. Please try again.'
          : error.code === 'P2002'
            ? 'This record already exists. Refresh before retrying.'
            : error.message,
    });
  });
  return app;
}
module.exports = { createApp };
