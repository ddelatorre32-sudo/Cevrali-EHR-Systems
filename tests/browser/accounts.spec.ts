import { test, expect } from '@playwright/test';
import { exerciseAccounts } from '../accounts-browser';
test('practice signup, invitations, patient separation and staff access work end to end', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await exerciseAccounts(page);
  expect(errors).toEqual([]);
});

test('a stale browser tab rejects a changed practice session and clears its cached records', async ({
  page,
  context,
}) => {
  const suffix = Date.now();
  const password = 'SyntheticCrossTab2026!';
  const signup = async (name: string, email: string) => {
    const r = await context.request.post('/api/accounts/signup', {
      data: {
        owner_name: 'Synthetic Owner',
        email,
        password,
        clinical_access: true,
        practice: { name },
      },
    });
    expect(r.status()).toBe(201);
    return r.json();
  };
  const a = await signup('First Practice', `first-${suffix}@example.test`);
  const patient = await context.request.post('/api/patients', {
    data: {
      first_name: 'Synthetic',
      last_name: 'FirstPatient',
      dob: '1990-01-01',
      phone: '555-0100',
      sex: 'Unknown',
    },
  });
  expect(patient.status()).toBe(201);
  await page.goto('/#patients');
  await expect(
    page.getByRole('row').filter({ hasText: 'FirstPatient' }),
  ).toBeVisible();
  await signup('Second Practice', `second-${suffix}@example.test`);
  const other = await context.newPage();
  await other.goto('/#account');
  await expect(other.locator('.practice-selector')).toContainText(
    'Second Practice',
  );
  await expect(other.locator('.account-summary')).toContainText(
    '0 registered patients',
  );
  const rejected = page.waitForResponse(
    (r) => /\/api\/(overview|appointments)/.test(r.url()) && r.status() === 401,
  );
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await rejected;
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('FirstPatient', { exact: false })).toHaveCount(0);
  await page.getByLabel('Email address', { exact: true }).fill(a.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Patients', exact: true }).click();
  await expect(
    page.getByRole('row').filter({ hasText: 'FirstPatient' }),
  ).toBeVisible();
  await expect(page.locator('.practice-selector')).toContainText(
    'First Practice',
  );
});
