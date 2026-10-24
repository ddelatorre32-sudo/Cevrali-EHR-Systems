import { expect, test } from '@playwright/test';
import { exerciseBookingRetry, exerciseFilteredScheduleActions } from '../booking-retry.browser';

test('schedule provider and status filters keep counts and actions consistent with selected-day rows', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Dr. Morgan/ })).toBeVisible();
  await exerciseFilteredScheduleActions(page);
  expect(errors).toEqual([]);
});

test('a successful appointment POST survives a failed schedule refresh and retries without another POST', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Dr. Morgan/ })).toBeVisible();
  await exerciseBookingRetry(page);
  expect(errors).toEqual([]);
});
