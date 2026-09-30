'use strict';
const crypto = require('crypto');
const nodemailer = require('nodemailer');
function createMailer(env = process.env) {
  if (!env.SMTP_HOST || !env.SMTP_FROM) return null;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000,
    socketTimeout: 15000,
    tls: { minVersion: 'TLSv1.2' },
  });
  return {
    send: ({ to, subject, text, messageId }) =>
      transport.sendMail({ from: env.SMTP_FROM, to, subject, text, messageId }),
  };
}
async function sendAccountLink(prisma, mailer, user, kind, origin) {
  if (!mailer) return false;
  const token = crypto.randomBytes(32).toString('hex');
  const row = await prisma.accountToken.create({
    data: {
      userId: user.id,
      kind,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + (kind === 'reset' ? 30 : 1440) * 60000),
    },
  });
  try {
    await mailer.send({
      to: user.email,
      subject: kind === 'reset' ? 'Reset your Ajo password' : 'Verify your Ajo email',
      text: `${kind === 'reset' ? 'Reset your password' : 'Verify your email address'} using this link:\n${origin}/#${kind}=${token}\n\nIf you did not request this, ignore this email.`,
    });
    return true;
  } catch {
    await prisma.accountToken.deleteMany({ where: { id: row.id } });
    return false;
  }
}
async function sendReminders(prisma, mailer) {
  if (!mailer) return { sent: 0, errors: 0 };
  const groups = await prisma.group.findMany({
    where: { status: 'active', dueAt: { lte: new Date() } },
    include: {
      memberships: { where: { active: true }, include: { user: true } },
      contributions: { where: { status: 'success' } },
    },
    take: 100,
  });
  const result = { sent: 0, errors: 0 },
    day = new Date().toISOString().slice(0, 10);
  for (const g of groups)
    for (const m of g.memberships) {
      if (!m.user.emailVerified) continue;
      const paid = g.contributions
        .filter((c) => c.round === g.currentRound && c.membershipId === m.id && !c.disputed)
        .reduce((n, c) => n + c.amountKobo - c.refundedKobo, 0);
      const due = g.contributionKobo - paid;
      if (due <= 0) continue;
      const id = crypto
        .createHash('sha256')
        .update(`${g.id}:${m.id}:${g.currentRound}:${day}`)
        .digest('hex');
      const claim = await prisma.notification.createMany({ data: [{ id }], skipDuplicates: true });
      if (!claim.count) continue;
      try {
        await mailer.send({
          to: m.user.email,
          subject: `Contribution reminder: ${g.name}`,
          text: `Your contribution for round ${g.currentRound + 1} is due. Outstanding: NGN ${(due / 100).toFixed(2)}. Log in to Ajo to review and pay. If a payment is pending, check its status before paying again.`,
          messageId: `<${id}@ajo.local>`,
        });
        await prisma.notification.update({ where: { id }, data: { sentAt: new Date() } });
        result.sent++;
      } catch {
        result.errors++;
        await prisma.notification.deleteMany({ where: { id, sentAt: null } });
      }
    }
  return result;
}
module.exports = { createMailer, sendAccountLink, sendReminders };
