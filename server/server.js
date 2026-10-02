'use strict';
require('dotenv').config();
const prisma = require('./src/prismaClient');
const { createPaystack } = require('./src/paystack');
const { createApp } = require('./src/app');
const { createMailer, sendReminders } = require('./src/mail');
const PORT = Number(process.env.PORT || 8080);
const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.APP_URL || new URL(appUrl).protocol !== 'https:')
)
  throw new Error('Set APP_URL to the production HTTPS origin.');
const mailer = createMailer();
const paystack = createPaystack(process.env.PAYSTACK_SECRET_KEY);
if (paystack.environment === 'live' && !mailer)
  throw new Error(
    'Configure SMTP_HOST and SMTP_FROM before using live payments. Use a Paystack test key for previews without email.',
  );
if (!mailer)
  console.warn(
    'Email is unavailable in this preview: verification, password reset and reminders are disabled.',
  );
const app = createApp({
  prisma,
  paystack,
  appUrl,
  mailer,
});
const server = app.listen(PORT, () => console.log(`Ajo Savings Tracker listening on ${PORT}`));
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const result = await app.locals.payments.reconcile();
    if (result.errors) console.error({ event: 'reconciliation.needs_attention', ...result });
    await sendReminders(prisma, mailer);
    await prisma.accountToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await prisma.rateBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch {
    console.error({ event: 'reconciliation.failed' });
  } finally {
    busy = false;
  }
}, 60000);
timer.unref();
async function shutdown(code = 0) {
  clearInterval(timer);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(code);
  });
  setTimeout(() => process.exit(code || 1), 10000).unref();
}
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('uncaughtException', () => {
  console.error({ event: 'process.uncaught_exception' });
  shutdown(1);
});
process.on('unhandledRejection', () => {
  console.error({ event: 'process.unhandled_rejection' });
  shutdown(1);
});
