import { test, expect } from '@playwright/test';
import { exerciseCalendar } from '../calendar-browser';
test('calendar scheduling supports date navigation, provider filters, new-patient registration, duplicate review and front-desk access', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open clinician demo', exact: true })
    .click();
  await exerciseCalendar(page);
  expect(errors).toEqual([]);
});
