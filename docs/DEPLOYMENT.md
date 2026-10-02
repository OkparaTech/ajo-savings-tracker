# Deployment and recovery runbook

## Upgrade an existing database

1. Pause the old application and every writer, including callbacks/webhooks. Keep downtime brief; provider retries must be available after restart.
2. Create a full PostgreSQL backup and **restore it into an isolated database**. Prove the restore works before touching production.
3. Against the OLD schema, run `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/preflight.sql` from the repository root. Investigate every anomaly. Unsafe amounts, fractional kobo, duplicate payout rounds, invalid states, cross-group records and inconsistent balances need documented reconciliation. Never delete financial evidence just to satisfy a constraint. If anomalous old records require a data-repair migration, preserve the originals in a restricted archive and record the correction rationale; do not improvise changes in the running app.
4. On the restored copy, install dependencies, apply `prisma migrate deploy` and run acceptance tests. Check row counts and amounts in kobo against the backup. The migration converts values using decimal rounding only after rejecting meaningful fractional kobo, preserves IDs and references, labels historical payouts `legacy`, and places financially active groups into `review`.
5. Use a separate migration role to apply the migration to production. Keep the old app stopped throughout this change. If the migration fails, its transaction rolls back; inspect the error and follow Prisma’s failed-migration recovery procedure after correcting the underlying issue. Do not bypass the preflight.
6. Deploy the matching version 3 application, then re-enable the webhook. Watch the durable inbox and run reconciliation to catch provider retries. All users log in again because old JWT cookies are no longer accepted.
7. Recover legacy pending payment destinations from the provider with `npm run reconcile:legacy -- REFERENCE`, using the correct test/live key. Historical failed attempts also need provider review if there is doubt about their outcome.
8. Reconcile old manual payouts against bank records. A historical payout is not retroactively recipient-confirmed. Record a matching bank balance; all active members approve the same financial-review attestation before new activity starts.

Do not roll an old app back against the migrated schema. Restore the reviewed backup and reconcile payments that arrived after the backup if rollback is required.

## Configuration

- Node.js 22 or later; start command `npm start` inside `server`.
- Build/install: `npm ci`. Run migrations as a controlled release step, not on every web process restart.
- Required: PostgreSQL `DATABASE_URL`, HTTPS `APP_URL`, `NODE_ENV=production`, and a valid Paystack key. Live payments additionally require SMTP host/from and appropriate SMTP authentication.
- `APP_URL` must be the exact browser origin; redirects and CSRF checks rely on it.
- Set `TRUST_PROXY_HOPS` only after confirming the number of trusted ingress proxies. Do not blindly trust arbitrary forwarded headers.
- Configure provider webhook at `APP_URL/api/webhooks/paystack`.
- Provider fees and settlement delays must be reconciled with the merchant account and bank. The app does not fabricate settlement confirmations or assert that gross charges equal settled funds.

## Render preview without email

Keep `NODE_ENV=production` and set `APP_URL=https://ajo-savings-tracker-3qh3.onrender.com` for this deployment. Use your actual Paystack **test** secret key (`sk_test_...`). Leave SMTP variables unset until you have an email provider. No database migration is needed for this configuration change.

The server starts without SMTP when using test payments. Registration, login and signed-in password changes remain available. Email verification, forgotten-password recovery and reminders are unavailable; accounts are not automatically marked verified. Keep your preview account password. Live-key startup still requires email configuration.

Before launch, configure all SMTP settings, redeploy and test actual verification/reset delivery and reminders. Then use the launch acceptance checklist below before enabling live payments.

## Database permissions

Use a migration owner and a separate restricted runtime role. Runtime needs SELECT/INSERT/UPDATE on mutable application tables, DELETE only for sessions/tokens/rate buckets/notification recovery and payout-order replacement. It must not own tables, disable triggers, execute arbitrary DDL, TRUNCATE financial tables, or UPDATE/DELETE audit events and bank reconciliations. PostgreSQL owner access can override protections; do not give it to the web application. Restrict operator access and keep a record of exceptional repairs.

Financial foreign keys use RESTRICT. Audit and bank-attestation triggers reject update/delete. Payment and payout identities must be treated as immutable by operator tooling as well.

## Background processing and monitoring

Run at least one always-on process or schedule `npm run reconcile` once per minute. Sleeping web services are unsuitable as the only worker. Multiple workers may repeat verification; locked, idempotent financial updates prevent double crediting. Monitor pending/attention inbox age, error counts, old unresolved intents, applying bank proposals, SMTP failures and database connection usage. The HTTP health endpoint checks database connectivity; it does not certify accounting health.

A signed webhook is acknowledged only after its inbox record is stored. Processing is retried separately. Unknown references and malformed reversals require operator review. Raw inbox records contain a reduced set of operational fields, excluding card authorizations and customer details. Set a retention policy for processed inbox events and expired sessions/tokens; keep financial history and audit evidence.

Checkout timeouts preserve an `unknown` intent. Do not blindly release its reserved amount: verify the provider reference first. If initialization was definitely rejected and no provider transaction exists, an operator may mark it failed in a locked, audited recovery transaction after recording provider evidence. Never create another charge based only on a browser error.

Interrupted bank application is retried after the proposal is returned to pending; an orphan provider subaccount may need cleanup by the operator. Never infer that a remote subaccount creation and a local database write are atomic.

## Refunds and disputes

Processed refund IDs are deduplicated and their total is subtracted from contributions. Pending refunds and dispute events pause the group. Dispute funds are conservatively excluded. Provider reversal verification also places funds on hold. Resolve the actual provider/bank outcome before releasing a hold; a recipient can acknowledge a previously disputed manual payout only once the funds arrive and the financial checks pass. No administrator endpoint can invent a successful provider payment.

Review approvals require a recent bank attestation matching the nonnegative ledger balance. Every active member must approve that same statement. Pending payments, disputed contribution holds and unconfirmed/disputed payouts block review completion. A refund of a previous round can make the ledger negative; it needs an operator-managed, evidenced correction and member agreement before collection resumes. Never silently shift that shortfall to another member.

## Launch acceptance

- Restored-backup migration and row/amount comparison succeed.
- All CI checks pass against real PostgreSQL with several connections.
- Provider sandbox tests cover actual split/subaccount payloads, webhook signatures, delayed callbacks, duplicate events, outages, pending/failed payments, refunds and disputes. Local mocked-provider tests do not replace these tests.
- SMTP verification/reset links and reminders arrive and expire correctly.
- HTTPS cookies, Origin/CSRF policy and proxy-derived client IP work behind the actual ingress.
- A two-member cycle runs end to end, including bank approval, partial payment, settled bank attestation, manual transfer, recipient confirmation and cycle completion.
- Operator alerting, reconciliation scheduling, retention, incident response and restore responsibility have named owners.
