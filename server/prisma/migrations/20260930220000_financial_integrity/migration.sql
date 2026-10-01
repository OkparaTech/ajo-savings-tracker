-- This migration is transactional and never discards financial rows.
-- Pause all writers and run the preflight script before deploying.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Group" WHERE "contributionAmount" < 1 OR "contributionAmount" > 20000000 OR NOT ("contributionAmount" BETWEEN 1 AND 20000000))
     OR EXISTS (SELECT 1 FROM "Contribution" WHERE "amount" < 1 OR "amount" > 20000000 OR NOT ("amount" BETWEEN 1 AND 20000000))
     OR EXISTS (SELECT 1 FROM "Payout" WHERE "amount" < 1 OR "amount" > 20000000 OR NOT ("amount" BETWEEN 1 AND 20000000)) THEN
    RAISE EXCEPTION 'Unsafe historical amount. Run migration preflight and reconcile records; do not delete history.';
  END IF;
  IF EXISTS (SELECT 1 FROM "Payout" GROUP BY "groupId", "round" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate historical payout rounds. Run migration preflight and reconcile records.';
  END IF;
  IF EXISTS (SELECT 1 FROM "Contribution" c JOIN "Membership" m ON m.id=c."membershipId" WHERE c."groupId"<>m."groupId")
     OR EXISTS (SELECT 1 FROM "Payout" p JOIN "Membership" m ON m.id=p."membershipId" WHERE p."groupId"<>m."groupId") THEN
    RAISE EXCEPTION 'Cross-group historical financial records found.';
  END IF;
  IF EXISTS (SELECT 1 FROM "Contribution" WHERE abs("amount"*100-round("amount"*100)) > 0.000001)
     OR EXISTS (SELECT 1 FROM "Payout" WHERE abs("amount"*100-round("amount"*100)) > 0.000001)
     OR EXISTS (SELECT 1 FROM "Group" WHERE abs("contributionAmount"*100-round("contributionAmount"*100)) > 0.000001) THEN
    RAISE EXCEPTION 'Historical amounts contain fractional kobo. Reconcile before conversion.';
  END IF;
END $$;
-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_userId_fkey";

-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_groupId_fkey";

-- DropForeignKey
ALTER TABLE "PayoutOrderEntry" DROP CONSTRAINT "PayoutOrderEntry_groupId_fkey";

-- DropForeignKey
ALTER TABLE "PayoutOrderEntry" DROP CONSTRAINT "PayoutOrderEntry_membershipId_fkey";

-- DropForeignKey
ALTER TABLE "Contribution" DROP CONSTRAINT "Contribution_groupId_fkey";

-- DropForeignKey
ALTER TABLE "Contribution" DROP CONSTRAINT "Contribution_membershipId_fkey";

-- DropForeignKey
ALTER TABLE "Payout" DROP CONSTRAINT "Payout_groupId_fkey";

-- DropForeignKey
ALTER TABLE "Payout" DROP CONSTRAINT "Payout_membershipId_fkey";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Group" RENAME COLUMN "contributionAmount" TO "contributionKobo";
ALTER TABLE "Group" ALTER COLUMN "contributionKobo" TYPE INTEGER USING round("contributionKobo"::numeric * 100)::integer;
ALTER TABLE "Group"
ADD COLUMN     "cycleSize" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cycleStartRound" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'draft';

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Contribution" RENAME COLUMN "amount" TO "amountKobo";
ALTER TABLE "Contribution" ALTER COLUMN "amountKobo" TYPE INTEGER USING round("amountKobo"::numeric * 100)::integer;
ALTER TABLE "Contribution"
ADD COLUMN     "authorizationUrl" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'NGN',
ADD COLUMN     "disputed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'test',
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "refundedKobo" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "subaccountCode" TEXT;

-- AlterTable
ALTER TABLE "Payout" RENAME COLUMN "amount" TO "amountKobo";
ALTER TABLE "Payout" ALTER COLUMN "amountKobo" TYPE INTEGER USING round("amountKobo"::numeric * 100)::integer;
ALTER TABLE "Payout"
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'awaiting_confirmation',
ADD COLUMN     "transferReference" TEXT;

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankChange" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "approvals" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankReconciliation" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "balanceKobo" INTEGER NOT NULL,
    "statementReference" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateBucket" (
    "id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditEvent_groupId_createdAt_idx" ON "AuditEvent"("groupId", "createdAt");

-- CreateIndex
CREATE INDEX "BankChange_groupId_status_idx" ON "BankChange"("groupId", "status");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_createdAt_idx" ON "WebhookEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RateBucket_expiresAt_idx" ON "RateBucket"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountToken_tokenHash_key" ON "AccountToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AccountToken_expiresAt_idx" ON "AccountToken"("expiresAt");

-- CreateIndex
CREATE INDEX "Membership_groupId_active_idx" ON "Membership"("groupId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_id_groupId_key" ON "Membership"("id", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutOrderEntry_membershipId_groupId_key" ON "PayoutOrderEntry"("membershipId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Contribution_idempotencyKey_key" ON "Contribution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Contribution_groupId_round_status_idx" ON "Contribution"("groupId", "round", "status");

-- CreateIndex
CREATE INDEX "Contribution_status_lastCheckedAt_idx" ON "Contribution"("status", "lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_groupId_round_key" ON "Payout"("groupId", "round");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutOrderEntry" ADD CONSTRAINT "PayoutOrderEntry_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutOrderEntry" ADD CONSTRAINT "PayoutOrderEntry_membershipId_groupId_fkey" FOREIGN KEY ("membershipId", "groupId") REFERENCES "Membership"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_membershipId_groupId_fkey" FOREIGN KEY ("membershipId", "groupId") REFERENCES "Membership"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_membershipId_groupId_fkey" FOREIGN KEY ("membershipId", "groupId") REFERENCES "Membership"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankChange" ADD CONSTRAINT "BankChange_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReconciliation" ADD CONSTRAINT "BankReconciliation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Historical payouts are imported as unverified legacy records, never recipient-confirmed.
UPDATE "Payout" SET status='legacy';
UPDATE "Group" g SET status='review', "cycleStartRound"="currentRound"
WHERE EXISTS (SELECT 1 FROM "Contribution" c WHERE c."groupId"=g.id)
   OR EXISTS (SELECT 1 FROM "Payout" p WHERE p."groupId"=g.id);
-- Never assume that the currently configured bank is the destination of an old checkout.
-- Legacy payment intents intentionally retain a NULL destination snapshot.
INSERT INTO "AuditEvent" (id,"groupId",action,data)
SELECT 'migration-' || id, id, 'migration.imported', jsonb_build_object('requiresReview',status='review') FROM "Group";
ALTER TABLE "Group" ADD CONSTRAINT "Group_money_check" CHECK ("contributionKobo" BETWEEN 100 AND 2000000000),
  ADD CONSTRAINT "Group_frequency_check" CHECK (frequency IN ('daily','weekly','monthly')),
  ADD CONSTRAINT "Group_round_check" CHECK ("currentRound">=0 AND "cycleStartRound">=0 AND "cycleSize" BETWEEN 0 AND 50),
  ADD CONSTRAINT "Group_status_check" CHECK (status IN ('draft','active','completed','review','archived'));
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_role_check" CHECK (role IN ('admin','member'));
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_money_check" CHECK ("amountKobo" BETWEEN 100 AND 2000000000 AND "refundedKobo" BETWEEN 0 AND "amountKobo"),
  ADD CONSTRAINT "Contribution_round_check" CHECK (round>=0),
  ADD CONSTRAINT "Contribution_status_check" CHECK (status IN ('initializing','pending','unknown','success','failed')),
  ADD CONSTRAINT "Contribution_currency_check" CHECK (currency='NGN' AND environment IN ('test','live'));
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_money_check" CHECK ("amountKobo" BETWEEN 100 AND 2000000000),
  ADD CONSTRAINT "Payout_round_check" CHECK (round>=0),
  ADD CONSTRAINT "Payout_status_check" CHECK (status IN ('awaiting_confirmation','confirmed','disputed','legacy'));
ALTER TABLE "PayoutOrderEntry" ADD CONSTRAINT "PayoutOrder_position_check" CHECK (position>=0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_money_check" CHECK ("amountKobo">0);
ALTER TABLE "BankReconciliation" ADD CONSTRAINT "BankReconciliation_balance_check" CHECK ("balanceKobo" BETWEEN 0 AND 2000000000);
-- Evidence cannot be rewritten or removed by the application role.
CREATE FUNCTION ajo_immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit records are immutable'; END $$;
CREATE TRIGGER "AuditEvent_immutable" BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION ajo_immutable_audit();
CREATE TRIGGER "BankReconciliation_immutable" BEFORE UPDATE OR DELETE ON "BankReconciliation" FOR EACH ROW EXECUTE FUNCTION ajo_immutable_audit();
-- Immutable payment identity and amount; status/refund/verification fields remain mutable.
CREATE FUNCTION ajo_payment_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW."groupId"<>OLD."groupId" OR NEW."membershipId"<>OLD."membershipId"
    OR NEW."amountKobo"<>OLD."amountKobo" OR NEW.round<>OLD.round
    OR NEW."paymentReference"<>OLD."paymentReference" OR NEW.currency<>OLD.currency
    OR (OLD."subaccountCode" IS NOT NULL AND (NEW."subaccountCode" IS DISTINCT FROM OLD."subaccountCode" OR NEW.environment<>OLD.environment)) THEN
   RAISE EXCEPTION 'Payment identity and amount are immutable';
 END IF;
 IF OLD.status='success' AND NEW.status<>'success' THEN RAISE EXCEPTION 'Confirmed success cannot regress'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Contribution_identity_immutable" BEFORE UPDATE ON "Contribution" FOR EACH ROW EXECUTE FUNCTION ajo_payment_identity_immutable();
CREATE FUNCTION ajo_payout_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW."groupId"<>OLD."groupId" OR NEW."membershipId"<>OLD."membershipId"
    OR NEW."amountKobo"<>OLD."amountKobo" OR NEW.round<>OLD.round
    OR NEW."transferReference" IS DISTINCT FROM OLD."transferReference" THEN
   RAISE EXCEPTION 'Payout identity and amount are immutable';
 END IF;
 IF OLD.status IN ('confirmed','legacy') AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Finalized payout cannot regress'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Payout_identity_immutable" BEFORE UPDATE ON "Payout" FOR EACH ROW EXECUTE FUNCTION ajo_payout_identity_immutable();
COMMIT;
