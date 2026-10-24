import { test, expect } from '@playwright/test';
import { exerciseOperations } from '../operations-browser';
test('readiness, claim workspace, service allowances and incoming PDF fax populate reviewed note results and alert front desk', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open clinician demo', exact: true })
    .click();
  await exerciseOperations(page);
  expect(errors).toEqual([]);
});
