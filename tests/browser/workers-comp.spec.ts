import { test, expect } from '@playwright/test';
import { exerciseWorkersComp } from '../workers-comp-browser';
test('one patient uses workers compensation and private insurance with visit-specific notes and billing', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open clinician demo', exact: true })
    .click();
  await exerciseWorkersComp(page);
  expect(errors).toEqual([]);
});
