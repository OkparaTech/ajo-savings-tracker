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
