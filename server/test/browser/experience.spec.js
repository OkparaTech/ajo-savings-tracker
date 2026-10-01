'use strict';
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { fixture, circle } = require('./fixtures');
async function openGroup(page, options = {}) {
  const state = await fixture(page, options);
  await page.goto('/#group=circle-1&view=round');
  await expect(page.locator('#group-view')).toBeVisible();
  return state;
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function accessible(page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual(
    [],
  );
}
test('authentication works with keyboard tabs, password reveal, loading and useful errors', async ({
  page,
}) => {
  await fixture(page, { authenticated: false, loginError: true, delay: 100 });
  await page.goto('/');
  await expect(page.locator('#boot-state')).toBeVisible();
  await expect(page.locator('#auth-view')).toBeVisible();
  await page.locator('#login-tab').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#auth-name')).toBeVisible();
  await expect(page.locator('#signup-tab')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.locator('#auth-email').fill('amara@example.com');
  await page.locator('#auth-password').fill('correct horse battery staple');
  await page.locator('#show-password').click();
  await expect(page.locator('#auth-password')).toHaveAttribute('type', 'text');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-submit')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#auth-error')).toContainText('incorrect');
  await accessible(page);
});
test('sign in, create a circle, and preserve CSRF and request fields', async ({ page }) => {
  const state = await fixture(page, { authenticated: false });
  await page.goto('/');
  await page.locator('#auth-email').fill('amara@example.com');
  await page.locator('#auth-password').fill('correct horse battery staple');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#groups-view')).toBeVisible();
  await page.locator('#create-button').click();
  await page.getByLabel('Group name', { exact: true }).fill('The New Circle');
  await page.getByLabel('Contribution per member (₦)').fill('15000');
  await page.locator('#action-submit').click();
  await expect(page.locator('#group-heading')).toContainText('The New Circle');
  const req = state.requests.find((r) => r.path === '/api/groups' && r.method === 'POST');
  expect(req.body).toEqual({
    name: 'The New Circle',
    contributionAmount: '15000',
    frequency: 'monthly',
  });
  expect(req.headers['x-csrf-token']).toBe('fixture-csrf');
});
test('directory filters, clear filters, and empty onboarding', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  await page.locator('#group-search').fill('December');
  await expect(page.locator('.group-row')).toHaveCount(1);
  await page.locator('#group-filter').selectOption('active');
  await expect(page.getByText('No matching circles.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.group-row')).toHaveCount(2);
});
test('empty circle directory has working create and join actions', async ({ page }) => {
  await fixture(page, { groups: [] });
  await page.goto('/');
  await expect(page.getByText('Your first circle starts here.')).toBeVisible();
  await page.locator('[data-directory="join"]').click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Join a group');
});
test('failed directory can retry without reloading the page', async ({ page }) => {
  const state = await fixture(page, { groupsError: true });
  await page.goto('/');
  await expect(page.getByText('Your circles couldn’t load.')).toBeVisible();
  state.setGroupsError(false);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.group-row')).toHaveCount(2);
});
test('workspace deep links, arrow keys, browser back and refresh preserve navigation', async ({
  page,
}) => {
  await openGroup(page);
  await page.locator('#tab-round').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-ledger')).toBeVisible();
  await expect(page).toHaveURL(/view=ledger/);
  await page.keyboard.press('End');
  await expect(page.locator('#view-details')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#view-ledger')).toBeVisible();
  await page.reload();
  await expect(page.locator('#view-ledger')).toBeVisible();
  await page.locator('#refresh-group').click();
  await expect(page.locator('#view-ledger')).toBeVisible();
});
test('payment dialog uses the actual remaining obligation and retains idempotency', async ({
  page,
}) => {
  const state = await openGroup(page);
  await page.route('https://checkout.paystack.com/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: 'Test checkout' }),
  );
  await page.locator('#pay-button').click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Make your contribution');
  await expect(page.getByLabel('Amount (₦)', { exact: true })).toHaveValue('25000');
  await page.locator('#action-submit').click();
  await expect(page).toHaveURL('https://checkout.paystack.com/fixture');
  expect(
    state.requests.find((r) => r.path.endsWith('/contributions/initiate')).headers[
      'idempotency-key'
    ],
  ).toBeTruthy();
});
test('pending payment directs the member to its reference before retrying', async ({ page }) => {
  const g = circle();
  g.contributions.push({
    id: 'pending',
    membershipId: 'm0',
    memberName: 'Amara Okafor',
    amount: 25000,
    round: 1,
    date: '2026-10-01',
    status: 'pending',
    paymentReference: 'ajo-pending-001',
  });
  await openGroup(page, { group: g });
  await expect(page.locator('#next-step-title')).toHaveText('Your payment is being checked.');
  await expect(page.locator('#pay-button')).toBeHidden();
  await page.locator('#next-step-button').click();
  await expect(page.getByRole('button', { name: 'Check payment', exact: true })).toBeVisible();
});
test('recipient can reach payout confirmation; transfer remains gated for admin', async ({
  page,
}) => {
  const state = await openGroup(page);
  await expect(page.locator('[data-action="payout"]')).toBeDisabled();
  state.setGroup({
    pendingPayout: {
      id: 'p1',
      membershipId: 'm0',
      amountKobo: 10000000,
      status: 'awaiting_confirmation',
      transferReference: 'BANK002',
    },
    payoutHistory: [
      {
        id: 'p1',
        membershipId: 'm0',
        memberName: 'Amara Okafor',
        amount: 100000,
        round: 1,
        date: '2026-10-01',
        status: 'awaiting_confirmation',
        transferReference: 'BANK002',
      },
    ],
  });
  await page.reload();
  await expect(page.locator('#next-step-title')).toHaveText('Has your payout arrived?');
  await page.locator('#next-step-button').click();
  await expect(page.locator('#payout-panel')).toBeFocused();
  await page.getByRole('button', { name: 'Confirm money received' }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Confirm payout received');
  await accessible(page);
});
test('ledger search, payout tab and human-readable activity preserve record detail', async ({
  page,
}) => {
  await openGroup(page);
  await page.locator('#tab-ledger').click();
  await page.locator('#record-search').fill('Zainab');
  await expect(page.locator('.record')).toHaveCount(1);
  await page.locator('#record-search').fill('missing');
  await expect(page.getByText('No matching records.')).toBeVisible();
  await page.locator('#record-payouts').click();
  await expect(page.locator('.record')).toHaveCount(1);
  await page.locator('#record-audit').click();
  await expect(page.getByText('Contribution confirmed', { exact: true })).toBeVisible();
  await page.getByText('Record details', { exact: true }).first().click();
  await expect(page.locator('pre').first()).toContainText('ajo-fixture');
  await accessible(page);
});
test('draft order keyboard focus survives reordering and saving', async ({ page }) => {
  const state = await openGroup(page, {
    group: { status: 'draft', inviteCode: 'ABC1234567', currentRecipient: null },
  });
  await page.getByRole('button', { name: 'Move Tunde Adeyemi up', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Move Tunde Adeyemi down', exact: true }),
  ).toBeFocused();
  await page.locator('#save-order').click();
  expect(state.requests.find((r) => r.path.endsWith('/payout-order')).body.order).toEqual([
    'm1',
    'm0',
    'm2',
    'm3',
  ]);
});
test('bank proposal loads selectable banks and reports action failure inside the dialog', async ({
  page,
}) => {
  await openGroup(page, { group: { status: 'draft' }, actionError: true });
  await page.locator('#tab-details').click();
  await page.getByRole('button', { name: 'Propose bank account' }).click();
  await page.getByLabel('Bank', { exact: true }).selectOption('001');
  await page.getByLabel('10-digit account number').fill('0123456789');
  await page.getByLabel('Confirm your current password').fill('correct horse battery staple');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-error')).toContainText('record changed');
  await accessible(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Propose bank account' })).toBeFocused();
});
test('recovery and reset remain usable without signing in', async ({ page }) => {
  await fixture(page, { authenticated: false });
  await page.goto('/');
  await page.locator('#forgot-password-button').click();
  await page.locator('#field-email').fill('amara@example.com');
  await page.locator('#action-submit').click();
  await expect(page.locator('#notice')).toContainText('reset link');
  await page.goto('/#reset=fixture-token');
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Set a new password');
});
for (const status of ['draft', 'review', 'completed', 'archived'])
  test(`${status} has an appropriate next step and accessible workspace`, async ({ page }) => {
    await openGroup(page, {
      group: { status, currentRecipient: null, obligations: [], inviteCode: 'ABC1234567' },
    });
    await expect(page.locator('#pay-button')).toBeHidden();
    await accessible(page);
    await page.locator('#tab-details').click();
    await accessible(page);
  });
test('long names, references and large balances fit a small phone', async ({ page }) => {
  const g = circle({
    name: 'A deliberately long circle name for a group saving together across several communities',
    availableBalance: 20000000,
  });
  g.members[0].name = 'A'.repeat(80);
  g.obligations[0].name = 'A'.repeat(80);
  g.contributions[0].paymentReference = 'r'.repeat(150);
  await page.setViewportSize({ width: 320, height: 780 });
  await openGroup(page, { group: g });
  await noOverflow(page);
  await page.locator('#tab-ledger').click();
  await noOverflow(page);
  await page.locator('#tab-details').click();
  await noOverflow(page);
});
for (const width of [320, 390, 768, 1024, 1440, 1920])
  test(`responsive views and screenshots at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text());
    });
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await fixture(page);
    await page.goto('/');
    await expect(page.locator('.group-row')).toHaveCount(2);
    await noOverflow(page);
    await page.screenshot({ path: `test-results/directory-${width}.png`, fullPage: true });
    await page.locator('.group-row').first().click();
    await expect(page.locator('#group-view')).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `test-results/round-${width}.png`, fullPage: true });
    for (const tab of ['ledger', 'details']) {
      await page.locator(`#tab-${tab}`).click();
      await noOverflow(page);
      await page.screenshot({ path: `test-results/${tab}-${width}.png`, fullPage: true });
    }
    await page.locator('#account-menu summary').click();
    await page.locator('#logout-button').click();
    await expect(page.locator('#auth-view')).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `test-results/auth-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
test('reduced motion removes movement and remains fully usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openGroup(page);
  await page.locator('#pay-button').click();
  expect(
    await page.locator('#action-dialog').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await accessible(page);
});
