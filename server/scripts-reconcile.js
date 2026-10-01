'use strict';
require('dotenv').config();
const prisma = require('./src/prismaClient');
const { createPaystack } = require('./src/paystack');
const { createPaymentService } = require('./src/services');
(async () => {
  const result = await createPaymentService(
    prisma,
    createPaystack(process.env.PAYSTACK_SECRET_KEY),
  ).reconcile();
  console.log(JSON.stringify(result));
  if (result.errors) process.exitCode = 1;
})()
  .catch(() => {
    console.error('Reconciliation failed. Inspect pending inbox records.');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
