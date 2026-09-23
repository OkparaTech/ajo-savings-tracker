// src/paystack.js
// Thin wrapper around Paystack's REST API. Uses Node's built-in fetch
// (Node 18+), so no extra HTTP dependency is needed.

const crypto = require('crypto');

const BASE_URL = 'https://api.paystack.co';
const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!SECRET_KEY) {
  throw new Error('PAYSTACK_SECRET_KEY is not set. Add it to your .env file (see .env.example).');
}

async function paystackRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.status === false) {
    const err = new Error(data.message || 'Paystack request failed.');
    err.paystack = data;
    throw err;
  }
  return data.data;
}

// GET /bank — list of Nigerian banks with their codes, for a dropdown.
async function listBanks() {
  return paystackRequest('/bank?country=nigeria&currency=NGN');
}

// GET /bank/resolve — confirms an account number belongs to a real account
// and returns the account holder's name (used to show "Is this you?" before saving).
async function resolveAccountNumber(accountNumber, bankCode) {
  return paystackRequest(`/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
}

// POST /subaccount — creates a settlement destination so contributions to
// this specific group land in this specific bank account.
async function createSubaccount({ businessName, bankCode, accountNumber }) {
  return paystackRequest('/subaccount', {
    method: 'POST',
    body: {
      business_name: businessName,
      settlement_bank: bankCode,
      account_number: accountNumber,
      percentage_charge: 0, // 100% of each contribution goes to the group's account
    },
  });
}

// POST /transaction/initialize — starts a real payment; returns a checkout URL.
async function initializeTransaction({ email, amountKobo, reference, subaccountCode, callbackUrl, metadata }) {
  return paystackRequest('/transaction/initialize', {
    method: 'POST',
    body: {
      email,
      amount: amountKobo,
      reference,
      subaccount: subaccountCode,
      callback_url: callbackUrl,
      metadata,
    },
  });
}

// GET /transaction/verify/:reference — confirms whether a payment actually succeeded.
async function verifyTransaction(reference) {
  return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
}

// Validates the `x-paystack-signature` header on incoming webhooks so we
// only trust events that really came from Paystack.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto.createHmac('sha512', SECRET_KEY).update(rawBody).digest('hex');
  return hash === signatureHeader;
}

module.exports = {
  listBanks,
  resolveAccountNumber,
  createSubaccount,
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
};
