import { test, expect } from '@playwright/test';
import { exerciseFinance } from '../finance-browser';

test('insurance to billing: coverage, charges, denial follow-up, remittance, payment and reversal', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open clinician demo' }).click();
  await exerciseFinance(page);
  await page.reload();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Olivia Bennett' })
      .getByText('Demo adjudicated', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Olivia Bennett' })
      .getByRole('cell', { name: '$25.00', exact: true }),
  ).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('front desk can open insurance and billing on a mobile screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Explore the front desk demo' })
    .click();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Insurance', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Coverage & eligibility' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Billing', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Billing worklist' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Encounters', exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
