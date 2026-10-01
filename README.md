# Ajo Savings Tracker

A shared savings ledger with fixed rotation cycles, Paystack contributions, and recipient-confirmed **manual** payouts.

Contributions settle to the group’s nominated bank account. This application does not hold savings, execute payouts, verify bank statements automatically, or guarantee that an administrator will transfer funds. A displayed ledger balance is an estimate, not a live bank balance.

## What changed in version 3

- Integer kobo throughout the financial model; positive-value, currency, round and role constraints in PostgreSQL.
- Draft → active → completed cycles. Roster, bank account and payout order are fixed during an active cycle.
- Partial contributions track the actual remaining obligation. Pending intents reserve their amount to prevent duplicate checkout.
- Payment intents are committed before provider checkout. Reference, amount, currency, environment and subaccount are checked before crediting a payment.
- Durable signed webhook inbox, retries, operator reconciliation, refund tracking and dispute holds.
- Group-row locking, idempotent payments and payouts, and one payout record per group round.
- Manual payout evidence, a recent settled-bank-balance attestation, and recipient acknowledgement before the next round.
- Group archive and member deactivation preserve all financial history. Database triggers protect audit events and bank attestations from update/delete.
- Bank account changes require every active member’s approval and administrator password confirmation.
- Opaque, hashed, revocable 12-hour sessions; secure cookies in production; CSRF and Origin checks; shared database-backed request limits.
- Email verification, password reset, password change, overdue contribution reminders, CSV export and activity history.
- Responsive, accessible interface with exact obligations, clear state labels, network errors and guarded submission buttons.

## Stack

Node.js 22+, Express 4, PostgreSQL, Prisma 5, Paystack, Nodemailer SMTP, plain HTML/CSS/JavaScript. There is no frontend build step.

## Local setup

```sh
cd server
cp .env.example .env
npm ci
npm run prisma:deploy
npm start
```

Fill in the database URL and Paystack test key first. Open the origin configured in `APP_URL`; using a different origin will correctly reject mutations. SMTP is optional for local test mode, but verification/recovery emails are unavailable until configured. Production startup requires SMTP configuration and an HTTPS `APP_URL`.

## Group workflow

1. Create a draft group. Invite at least one other member.
2. Administrator proposes the bank account. Every active member approves; the last approval applies the agreed Paystack subaccount. With one member, the administrator explicitly approves/applies the proposal.
3. Agree on payout order and start the cycle. Contributions are closed outside an active cycle.
4. Each member pays their outstanding contribution through Paystack. Partial payments leave a remaining amount due. Check a pending payment before trying another checkout.
5. Administrator checks the settled bank funds and records a statement/evidence reference. This is an attestation, not an automatic verification.
6. After making the actual bank transfer, administrator records the transfer reference. The app requires all current contributions, sufficient ledger funds and a recent sufficient bank attestation.
7. Only the recipient confirms receipt. The round advances once. An unreceived payout can be disputed, pausing the group for review.
8. After every member’s turn, the cycle completes. Change roster/order or transfer administrator responsibility before starting another cycle.

Member removal rotates the invite code and blocks self-rejoining by that former member. Financial history remains in the ledger and CSV export. Membership cannot change during a cycle.

## Validation

```sh
cd server
npm run check
npx prisma validate
npm test
# Use an empty/disposable PostgreSQL database ending in _test:
DATABASE_URL="$TEST_DATABASE_URL" npm run prisma:deploy
npm run test:integration
npm audit --omit=dev
```

Integration tests exercise actual Prisma queries and constraints, account sessions, CSRF, permissions, account approvals, queue swapping, checkout and payout concurrency, partial payments, webhook persistence/retries, refunds, exports, recovery links and reminders. Provider and SMTP calls are mocked; no real funds move. GitHub Actions runs against PostgreSQL 16 with multiple connections.

## Deployment and existing data

Read [the deployment runbook](docs/DEPLOYMENT.md) before upgrading an existing installation. **Do not deploy the new application before its migration.** The migration is transactional, preserves rows, checks legacy anomalies and puts groups with financial history into review. Existing login cookies are invalidated; users must log in again.

## Operations

The server checks pending inbox events and payment intents every minute while running. Run a dedicated scheduled worker if the hosting service sleeps:

```sh
cd server
npm run reconcile
```

The worker processes up to 25 inbox items and 25 payment intents per pass. Failed inbox items move to `attention` after ten attempts so one malformed event cannot starve all later events. Monitor and resolve these records; do not simply mark them processed.

Historical intents have no trustworthy destination snapshot and are not guessed. An operator can recover the snapshot from the provider:

```sh
npm run reconcile:legacy -- PAYMENT_REFERENCE
```

After pending/disputed items are resolved, the administrator records a matching recent bank balance and all active members approve financial review. Imported payouts remain explicitly labelled historical/unverified.

## Boundaries

A ledger cannot eliminate administrator fraud or member default. Fixed rotation and evidence improve accountability; they do not insure savings. Payment charge confirmation does not mean bank settlement has completed. Operator access, database ownership, provider reconciliation, backups, mail deliverability and dispute handling remain operational responsibilities. Use a limited database role and review the launch checklist before collecting live payments.

### Interface design and browser checks

The frontend uses the **shared ledger** design system: a searchable circle directory, a state-aware next step, and separate round, ledger and group-detail views. Keyboard tabs, recovery flows, payment handoff, reduced motion and small-screen layouts are covered by browser tests. The audit, design direction and preserved contracts are recorded in [docs/DESIGN.md](docs/DESIGN.md).

```bash
cd server
npx playwright install --with-deps chromium
npm run test:ui
```

Browser tests serve the actual application assets and security headers with synthetic API fixtures; they do not contact Paystack or send email. The existing PostgreSQL integration suite validates the financial backend separately. CI runs both suites. Screenshots and traces are written to `server/test-results/`; failed CI runs upload that directory for inspection.
