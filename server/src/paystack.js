'use strict';
const crypto = require('crypto');
function createPaystack(secretKey, fetchImpl = fetch) {
  if (!/^sk_(test|live)_\S+$/.test(secretKey || ''))
    throw new Error('Set a valid PAYSTACK_SECRET_KEY.');
  const environment = secretKey.startsWith('sk_live_') ? 'live' : 'test';
  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`https://api.paystack.co${path}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok || data.status !== true) {
      const error = new Error(
        'Payment provider could not complete this request. Please try again.',
      );
      error.providerStatus = response.status;
      error.definitiveRejection =
        response.status >= 400 && response.status < 500 && data.status === false;
      throw error;
    }
    return data.data;
  }
  return {
    environment,
    listBanks: () => request('/bank?country=nigeria&currency=NGN&perPage=100'),
    resolveAccountNumber: (account, bank) =>
      request(
        `/bank/resolve?account_number=${encodeURIComponent(account)}&bank_code=${encodeURIComponent(bank)}`,
      ),
    createSubaccount: ({ businessName, bankCode, accountNumber }) =>
      request('/subaccount', {
        method: 'POST',
        body: {
          business_name: businessName,
          settlement_bank: bankCode,
          account_number: accountNumber,
          percentage_charge: 0,
        },
      }),
    initializeTransaction: ({
      email,
      amountKobo,
      reference,
      subaccountCode,
      callbackUrl,
      metadata,
    }) =>
      request('/transaction/initialize', {
        method: 'POST',
        body: {
          email,
          amount: amountKobo,
          currency: 'NGN',
          reference,
          subaccount: subaccountCode,
          callback_url: callbackUrl,
          metadata,
        },
      }),
    fetchTransaction: (id) => request(`/transaction/${encodeURIComponent(id)}`),
    fetchDispute: (id) => request(`/dispute/${encodeURIComponent(id)}`),
    verifyTransaction: (reference) =>
      request(`/transaction/verify/${encodeURIComponent(reference)}`),
    verifyWebhookSignature(raw, signature) {
      if (
        !Buffer.isBuffer(raw) ||
        typeof signature !== 'string' ||
        !/^[a-f0-9]{128}$/i.test(signature)
      )
        return false;
      const expected = crypto.createHmac('sha512', secretKey).update(raw).digest();
      return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
    },
  };
}
module.exports = { createPaystack };
