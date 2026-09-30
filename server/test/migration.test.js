const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const old = fs.readFileSync(
  path.join(__dirname, '../prisma/migrations/20260910120205_init/migration.sql'),
  'utf8',
);
const upgrade = fs.readFileSync(
  path.join(__dirname, '../prisma/migrations/20260930220000_financial_integrity/migration.sql'),
  'utf8',
);
async function database() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.waitReady;
  await db.exec(old);
  return db;
}
const seed = `INSERT INTO "User" (id,email,password,name) VALUES ('u','test@example.com','hashed','Member');
INSERT INTO "Group" (id,name,"contributionAmount","inviteCode") VALUES ('g','Legacy group',10000.01,'LEGACYCODE');
INSERT INTO "Membership" (id,"userId","groupId",role) VALUES ('m','u','g','admin');
INSERT INTO "Contribution" (id,"groupId","membershipId",amount,round,"paymentReference",status) VALUES ('c','g','m',10000.01,0,'legacy-ref','success');
INSERT INTO "Payout" (id,"groupId","membershipId",amount,round) VALUES ('p','g','m',10000.01,0);`;
test('migration preserves IDs, exact kobo and financial rows; historical groups require review', async () => {
  const db = await database();
  try {
    await db.exec(seed);
    await db.exec(upgrade);
    const group = (await db.query('SELECT * FROM "Group"')).rows[0];
    assert.equal(group.id, 'g');
    assert.equal(group.contributionKobo, 1000001);
    assert.equal(group.status, 'review');
    const contribution = (await db.query('SELECT * FROM "Contribution"')).rows[0];
    assert.equal(contribution.id, 'c');
    assert.equal(contribution.amountKobo, 1000001);
    assert.equal(contribution.paymentReference, 'legacy-ref');
    assert.equal(contribution.subaccountCode, null);
    const payout = (await db.query('SELECT * FROM "Payout"')).rows[0];
    assert.equal(payout.amountKobo, 1000001);
    assert.equal(payout.status, 'legacy');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM "AuditEvent"')).rows[0].n, 1);
  } finally {
    await db.close();
  }
});
test('unsafe old money aborts transaction without dropping original records', async () => {
  const db = await database();
  try {
    await db.exec(seed);
    await db.exec('UPDATE "Payout" SET amount=-100');
    await assert.rejects(db.exec(upgrade), /Unsafe historical amount/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT amount FROM "Payout"')).rows[0].amount, -100);
    assert.equal(
      (await db.query('SELECT "contributionAmount" FROM "Group"')).rows[0].contributionAmount,
      10000.01,
    );
  } finally {
    await db.close();
  }
});
test('duplicate legacy payout rounds abort instead of erasing history', async () => {
  const db = await database();
  try {
    await db.exec(seed);
    await db.exec(
      `INSERT INTO "Payout" (id,"groupId","membershipId",amount,round) VALUES ('p2','g','m',10000.01,0)`,
    );
    await assert.rejects(db.exec(upgrade), /Duplicate historical payout/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM "Payout"')).rows[0].n, 2);
  } finally {
    await db.close();
  }
});
