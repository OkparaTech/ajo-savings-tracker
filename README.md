# 🤝 Ajo Savings Tracker (SD-04)

A real, multi-user web app for tracking group savings ("Ajo" / "thrift" / "esusu").
Each member has their own account; groups are joined with an invite code; only the
group admin manages the payout order and records payouts. Contributions and
payouts are permanent, stored in a real Postgres database — this is meant to be
used for real, ongoing rounds, not just a demo.

> Originally a personal "Finance Tracker" (Go + vanilla JS). Rebuilt for SD-04:
> backend rewritten from Go → Node.js/Express, storage moved from a JSON file →
> PostgreSQL (via Prisma), and accounts/authentication were added so a real
> group can use it together.

---

## Tech Stack

| Layer     | Tech                                                        |
|-----------|--------------------------------------------------------------|
| Frontend  | Vanilla HTML / CSS / JavaScript (no build step)               |
| Backend   | Node.js + Express                                             |
| Database  | PostgreSQL, hosted on [Neon](https://neon.tech)                |
| ORM       | Prisma                                                          |
| Auth      | Email + password, bcrypt-hashed, JWT in an httpOnly cookie      |
| Payments  | [Paystack](https://paystack.com) — real contributions, not self-reported |
| Hosting   | [Render](https://render.com)                                    |

---

## Project Structure

```
ajo-savings-tracker/
├── public/                    # Frontend (served statically by Express)
│   ├── index.html
│   ├── style.css
│   └── script.js
├── server/
│   ├── server.js               # Express app + all API routes
│   ├── src/
│   │   ├── prismaClient.js     # Shared Prisma client instance
│   │   ├── auth.js             # Password hashing, JWT, auth middleware
│   │   └── inviteCode.js       # Invite code generator
│   ├── prisma/
│   │   └── schema.prisma       # Database schema (Users, Groups, Memberships, ...)
│   ├── package.json
│   └── .env.example
├── .gitignore
└── README.md
```

---

## How Money Actually Moves

Contributions are **real payments**, not self-reported entries:

1. The group admin adds the group's real bank account (bank + account number). The app verifies it's a real, named account via Paystack, then creates a **Paystack Subaccount** so payments route straight there.
2. When a member contributes, the app starts a real Paystack transaction and redirects them to Paystack's checkout (card, bank transfer, or USSD).
3. Paystack settles the money directly into the group's bank account (subaccount settlement, usually next business day) — it never passes through or sits inside this app.
4. Paystack calls this app's webhook (`/api/webhooks/paystack`) to confirm the payment; only then is the contribution marked `success` and counted toward the pool. A signature check on the webhook (`PAYSTACK_SECRET_KEY`-based HMAC) makes sure only real Paystack events are trusted.

**Payouts remain a manual step by design.** Because contributions settle straight into the group's own bank account (not a balance this app holds), there's no pool of funds inside the app to programmatically transfer out. When it's someone's turn, the admin sends the money from their own bank/mobile banking app, then clicks "Record Payout" here just to log it and advance the round. Automating that side too — via Paystack Transfers, with each recipient's own bank details on file — is a reasonable next step, but was left out here since it adds another layer of financial-compliance surface area worth deciding on deliberately rather than defaulting into.

**On going live for real:** Paystack's test keys work for development end-to-end (see below), but taking real money from real people requires switching to **live** keys, which needs my Paystack business account fully verified (business/ID documents). Read [Paystack's Nigeria docs](https://paystack.com/docs).
It will be going live for real after I am done testing that the app actually works well.

### Testing payments locally
Paystack test keys accept these details on the checkout page — no real money moves:
- **Card:** `4084084084084081`, any future expiry, CVV `408`, PIN `0000`, OTP `123456`
- Full list of test cards: https://paystack.com/docs/payments/test-payments

Paystack also needs to reach your webhook. Locally, use a tunnel like `ngrok http 8080`
and set the resulting URL + `/api/webhooks/paystack` as your webhook URL in the
Paystack dashboard (Settings → API Keys & Webhooks) while testing. In production,
use your Render URL.

## Data Model

- **User** — an account (email, hashed password, name).
- **Group** — a savings group (name, contribution amount, frequency, invite code, current round, plus the real bank account/Paystack subaccount contributions settle into).
- **Membership** — links a User to a Group, with a `role` of `admin` or `member`. This is what makes the app multi-user: every group action is scoped to a membership, not just a group.
- **PayoutOrderEntry** — the rotation queue: one row per membership, with a `position`.
- **Contribution** — a logged payment, tied to a membership and a round number.
- **Payout** — a recorded payout to a membership for a given round.

---

## Running Locally

**Requirements:** Node.js 18+, npm, and a Neon Postgres database.

### 1. Get your Neon connection string
In your Neon project dashboard → **Connection Details** → copy the **pooled
connection** string. It looks like:
```
postgresql://<user>:<password>@<host>/<dbname>?sslmode=require
```

### 2. Configure environment variables
```bash
cd server
cp .env.example .env
```
Open `.env` and paste your Neon string into `DATABASE_URL`. Generate a
`JWT_SECRET` with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
and paste that into `JWT_SECRET`. Then grab your **test** API keys from your
Paystack dashboard (Settings → API Keys & Webhooks) and paste them into
`PAYSTACK_SECRET_KEY` and `PAYSTACK_PUBLIC_KEY`.

### 3. Install dependencies and create the database tables
```bash
npm install
npx prisma migrate dev --name init
```
This reads `prisma/schema.prisma` and creates the tables on your Neon database.
`postinstall` also runs `prisma generate` automatically after `npm install`.

### 4. Start the server
```bash
npm start
```
Open **http://localhost:8080** — sign up, create a group, and try the invite
code flow by signing up a second account in a private/incognito window.

Use `npm run dev` for auto-restart on file changes.

---

## API Reference

All endpoints are prefixed with `/api`. Every route except `/auth/signup`,
`/auth/login`, and `/health` requires a valid session cookie.

| Method | Route                                   | Who              | Description                                   |
|--------|-------------------------------------------|------------------|-------------------------------------------------|
| POST   | `/auth/signup`                            | anyone           | Create an account `{ name, email, password }`     |
| POST   | `/auth/login`                             | anyone           | Log in `{ email, password }`                      |
| POST   | `/auth/logout`                            | logged in        | Clear the session                                  |
| GET    | `/auth/me`                                | logged in        | Current user info                                  |
| GET    | `/groups`                                 | logged in        | Groups the user belongs to (summary)               |
| POST   | `/groups`                                 | logged in        | Create a group `{ name, contributionAmount, frequency }` — creator becomes admin |
| POST   | `/groups/join`                            | logged in        | Join a group `{ inviteCode }`                      |
| GET    | `/groups/:id`                             | member           | Full group detail                                  |
| DELETE | `/groups/:id`                             | admin            | Delete the group                                    |
| DELETE | `/groups/:id/members/:membershipId`       | admin            | Remove a member                                     |
| PUT    | `/groups/:id/payout-order`                | admin            | Reorder the rotation `{ order: [membershipId, ...] }` |
| GET    | `/paystack/banks`                         | logged in        | List of Nigerian banks for the bank-details dropdown |
| POST   | `/groups/:id/bank-details`                | admin            | Verify & save the group's real payout account `{ bankCode, accountNumber }` |
| POST   | `/groups/:id/contributions/initiate`      | member           | Start a real payment for **your own** contribution `{ amount? }` — returns a Paystack checkout URL |
| GET    | `/payments/callback`                      | anyone (redirect)| Where Paystack sends the member back after checkout   |
| POST   | `/webhooks/paystack`                      | Paystack only     | Confirms payment success server-to-server (signature-verified) |
| POST   | `/groups/:id/payout`                      | admin            | Record that the current recipient was paid (manual bank transfer) & advance the round |
| GET    | `/health`                                 | anyone           | Health check                                         |

---

## Deploying to Render

1. Push this repo to GitHub.
2. On [render.com](https://render.com) → **New +** → **Web Service** → connect the repo.
3. Set:
   - **Root Directory:** `server`
   - **Build Command:** `npm install && npx prisma migrate deploy`
   - **Start Command:** `npm start`
4. Under **Environment**, add:
   - `DATABASE_URL` — your Neon connection string
   - `JWT_SECRET` — the same random string you generated locally (or a new one — just don't rotate it while people have active sessions)
   - `NODE_ENV` — `production`
5. Deploy. Render gives you a public URL — that's the live link to share with your group.

Because the database lives on Neon (not on Render's disk), your data survives
redeploys, restarts, and free-tier spin-downs — this is what makes the app
safe to actually rely on long-term.

---

## Demo Video

A 2–3 minute walkthrough should cover:
1. Signing up and creating a group (note the invite code).
2. As the admin, adding the group's real bank account (Paystack verifies it live).
3. Signing up as a second user and joining with that code.
4. Reordering the payout queue as the admin.
5. Making a real contribution as a regular member (Paystack test card checkout) and seeing it land in the ledger as confirmed.
6. Recording a payout as the admin and seeing the round advance.

---

## Possible Next Steps

- Email verification and "forgot password" flow.
- Reminders/notifications for members who haven't contributed this round.
- Export ledger to CSV/PDF.
- Let a member leave a group voluntarily (not just admin-removed).
- Transfer admin role to another member.
