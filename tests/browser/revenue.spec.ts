import { test, expect } from '@playwright/test';
import { exerciseRevenue, exerciseNewPatient } from '../revenue-browser';
test('authorized visit, replacement and void preserve history, credits and visit allowance', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open clinician demo', exact: true })
    .click();
  await exerciseRevenue(page);
  expect(errors).toEqual([]);
});
test('global new-patient creation reviews duplicates and opens the new or existing record', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open clinician demo', exact: true })
    .click();
  await exerciseNewPatient(page);
  expect(errors).toEqual([]);
});
