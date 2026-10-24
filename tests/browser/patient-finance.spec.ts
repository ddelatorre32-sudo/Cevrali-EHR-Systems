import { test, expect } from '@playwright/test';
import { exercisePatientFinance } from '../patient-finance-browser';

test('register insured patient and complete verification and billing inside the chart', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open clinician demo', exact: true })
    .click();
  await exercisePatientFinance(page);
  expect(errors).toEqual([]);
});
test('front desk registers coverage and uses the financial patient record on mobile without clinical data', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Explore the front desk demo', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Open navigation', exact: true })
    .click();
  await exercisePatientFinance(page, { frontdesk: true });
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect((await page.request.get('/api/patients/pat-001')).status()).toBe(403);
});
