import { test, expect } from '@playwright/test';
import { exerciseEfficiency } from '../efficiency-browser';

test('connected efficiency workflow: patient intake, queue, visit, orders, tasks, reminders, and navigation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open clinician demo' }).click();
  await expect(
    page.getByRole('heading', {
      name: /Good (morning|afternoon|evening), Dr. Morgan/,
    }),
  ).toBeVisible();
  await exerciseEfficiency(page);
  expect(errors).toEqual([]);
});
