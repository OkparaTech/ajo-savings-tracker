const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createPaystack } = require('../src/paystack');
test('webhook signature rejects missing, malformed and altered signatures', () => {
  const key = 'sk_test_mock',
    p = createPaystack(key),
    raw = Buffer.from('{"event":"charge.success"}');
  const sig = crypto.createHmac('sha512', key).update(raw).digest('hex');
  assert.equal(p.verifyWebhookSignature(raw, sig), true);
  for (const signature of [undefined, '', 'x'.repeat(128), sig.slice(1), '0'.repeat(128)])
    assert.equal(p.verifyWebhookSignature(raw, signature), false);
  assert.equal(p.verifyWebhookSignature(Buffer.from('different'), sig), false);
});
test('provider URLs encode untrusted parameters and request timeouts are set', async () => {
  let called;
  const p = createPaystack('sk_test_mock', async (url, opts) => {
    called = { url, opts };
    return { ok: true, json: async () => ({ status: true, data: {} }) };
  });
  await p.resolveAccountNumber('123&bank_code=evil', '001');
  assert.match(called.url, /123%26bank_code%3Devil/);
  assert.ok(called.opts.signal);
  await p.initializeTransaction({
    email: 'test@example.com',
    amountKobo: 100,
    reference: 'ref',
    subaccountCode: 'ACCT_g',
    callbackUrl: 'https://example.com',
    metadata: {},
  });
  assert.equal(JSON.parse(called.opts.body).currency, 'NGN');
});
test('provider errors do not expose internal provider payloads to users', async () => {
  const p = createPaystack('sk_test_mock', async () => ({
    ok: false,
    status: 400,
    json: async () => ({ status: false, message: 'secret provider details' }),
  }));
  await assert.rejects(p.listBanks(), (error) => !error.message.includes('secret'));
});

// Exercise the real entry point without opening sockets or scheduling workers.
function bootPreview(overrides = {}, mailer = null) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  let options;
  const warnings = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../server'), 'utf8'), {
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === './src/prismaClient') return {};
      if (name === './src/paystack') return { createPaystack };
      if (name === './src/mail') return { createMailer: () => mailer };
      if (name === './src/app')
        return {
          createApp(value) {
            options = value;
            return {
              listen() {
                return {};
              },
            };
          },
        };
      throw Error(`Unexpected dependency: ${name}`);
    },
    process: {
      env: {
        NODE_ENV: 'production',
        APP_URL: 'https://preview.example.com',
        PAYSTACK_SECRET_KEY: 'sk_test_fixture',
        ...overrides,
      },
      on() {},
    },
    URL,
    console: {
      warn(message) {
        warnings.push(message);
      },
    },
    setInterval() {
      return { unref() {} };
    },
  });
  return { options, warnings };
}
test('production HTTPS preview starts without SMTP using test payments', () => {
  const { options, warnings } = bootPreview();
  assert.equal(options.mailer, null);
  assert.equal(options.paystack.environment, 'test');
  assert.equal(warnings.length, 1);
});
test('live payments still require SMTP, including outside production mode', () => {
  for (const mode of ['production', 'development']) {
    assert.throws(
      () => bootPreview({ NODE_ENV: mode, PAYSTACK_SECRET_KEY: 'sk_live_fixture' }),
      /before using live payments/,
    );
  }
});
test('configuring email later permits live startup', () => {
  const mailer = { send() {} };
  const { options, warnings } = bootPreview({ PAYSTACK_SECRET_KEY: 'sk_live_fixture' }, mailer);
  assert.equal(options.mailer, mailer);
  assert.equal(warnings.length, 0);
});
test('email-free previews retain HTTPS and payment-key validation', () => {
  assert.throws(
    () => bootPreview({ APP_URL: 'http://preview.example.com' }),
    /production HTTPS origin/,
  );
  assert.throws(() => bootPreview({ PAYSTACK_SECRET_KEY: '' }), /valid PAYSTACK_SECRET_KEY/);
});
test('password reset without email reports unavailable without looking up an account', async () => {
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp({
    prisma: { rateBucket: { upsert: async () => ({ count: 1 }) } },
    paystack: createPaystack('sk_test_fixture'),
    appUrl: 'https://preview.example.com',
    logger: { error() {} },
  });
  const response = await request(app)
    .post('/api/auth/forgot-password')
    .set('Origin', 'https://preview.example.com')
    .send({ email: 'person@example.com' });
  assert.equal(response.status, 503);
  assert.match(JSON.stringify(response.body), /Password reset is unavailable/);
});
