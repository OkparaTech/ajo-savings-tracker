'use strict';
// Serve the actual frontend and actual CSP. Playwright supplies synthetic API responses.
const { createApp } = require('../../src/app');
const app = createApp({
  prisma: {},
  paystack: {},
  appUrl: 'http://localhost:8089',
  logger: { error() {} },
});
app.listen(8089, '127.0.0.1', () => console.log('UI test server ready'));
