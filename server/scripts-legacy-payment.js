'use strict';
// Operator-only recovery of a legacy intent. No secrets or provider PII are printed.
require('dotenv').config();
const prisma = require('./src/prismaClient');
const { createPaystack } = require('./src/paystack');
const { locked, audit, createPaymentService } = require('./src/services');
(async () => {
  const reference = process.argv[2];
  if (!reference) throw Error('Supply a legacy payment reference.');
  const paystack = createPaystack(process.env.PAYSTACK_SECRET_KEY);
  const c = await prisma.contribution.findUnique({ where: { paymentReference: reference } });
  if (!c || c.subaccountCode) throw Error('Not a legacy intent.');
  const provider = await paystack.verifyTransaction(reference);
  const destination =
    typeof provider.subaccount === 'string'
      ? provider.subaccount
      : provider.subaccount?.subaccount_code;
  if (
    provider.reference !== reference ||
    provider.amount !== c.amountKobo ||
    provider.currency !== 'NGN' ||
    provider.domain !== paystack.environment ||
    !destination
  )
    throw Error('Provider details do not match. Keep group in review.');
  await locked(prisma, c.groupId, async (tx) => {
    await tx.contribution.update({
      where: { id: c.id },
      data: { subaccountCode: destination, environment: provider.domain },
    });
    await audit(tx, c.groupId, null, 'legacy.payment_destination_recovered', {
      reference,
      destination,
      environment: provider.domain,
    });
  });
  await createPaymentService(prisma, paystack).verify(reference);
  console.log('Legacy payment reconciled. Group remains in review pending member approvals.');
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
