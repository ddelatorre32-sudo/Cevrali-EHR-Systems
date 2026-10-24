import { test, expect } from '@playwright/test';
import { exerciseTreatment } from '../treatment-browser';

test('actual treatment, revisions and billing discrepancies stay linked to the visit', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open clinician demo', exact: true })
    .click();
  await exerciseTreatment(page);
  expect(errors).toEqual([]);
});
