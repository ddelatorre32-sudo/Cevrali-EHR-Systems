import { test, expect } from '@playwright/test';
import { exerciseRfa } from '../rfa-browser';
test('signed workers compensation documentation autofills the uploaded RFA and supports reviewed PDF and demo fax retries', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open clinician demo', exact: true })
    .click();
  await exerciseRfa(page);
  expect(errors).toEqual([]);
});
