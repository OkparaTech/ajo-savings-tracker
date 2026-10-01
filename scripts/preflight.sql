-- Run against the OLD database before applying the financial-integrity migration.
-- Any returned row requires investigation. Never delete evidence to make a migration pass.
SELECT 'invalid_group_amount' AS issue,id FROM "Group" WHERE NOT ("contributionAmount" BETWEEN 1 AND 20000000) OR abs("contributionAmount"*100-round("contributionAmount"*100))>0.000001;
SELECT 'invalid_contribution_amount' AS issue,id FROM "Contribution" WHERE NOT (amount BETWEEN 1 AND 20000000) OR abs(amount*100-round(amount*100))>0.000001;
SELECT 'invalid_payout_amount' AS issue,id FROM "Payout" WHERE NOT (amount BETWEEN 1 AND 20000000) OR abs(amount*100-round(amount*100))>0.000001;
SELECT 'duplicate_payout_round' AS issue,"groupId",round,count(*) FROM "Payout" GROUP BY "groupId",round HAVING count(*)>1;
SELECT 'invalid_group_state' AS issue,id FROM "Group" WHERE frequency NOT IN ('daily','weekly','monthly') OR "currentRound"<0;
SELECT 'cross_group_contribution' AS issue,c.id FROM "Contribution" c JOIN "Membership" m ON m.id=c."membershipId" WHERE c."groupId"<>m."groupId";
SELECT 'cross_group_payout' AS issue,p.id FROM "Payout" p JOIN "Membership" m ON m.id=p."membershipId" WHERE p."groupId"<>m."groupId";
SELECT 'cross_group_queue' AS issue,p.id FROM "PayoutOrderEntry" p JOIN "Membership" m ON m.id=p."membershipId" WHERE p."groupId"<>m."groupId";
SELECT 'negative_ledger_balance' AS issue,g.id FROM "Group" g WHERE COALESCE((SELECT sum(amount) FROM "Contribution" c WHERE c."groupId"=g.id AND c.status='success'),0)-COALESCE((SELECT sum(amount) FROM "Payout" p WHERE p."groupId"=g.id),0)<0;
SELECT 'legacy_payment_needs_provider_review' AS issue,id,"paymentReference",status FROM "Contribution" WHERE status IN ('pending','failed');
SELECT 'legacy_payout_unverified' AS issue,id,"groupId",round,amount FROM "Payout";
