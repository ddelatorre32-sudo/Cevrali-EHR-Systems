import { test, expect } from '@playwright/test';
import { exerciseInsuranceSwitchGuard } from '../insurance-switch-guard-browser';

test('reviewed treatment keeps its visit insurance, performed usage and stored documentation after a rejected switch', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  await exerciseInsuranceSwitchGuard(page);
  expect(errors).toEqual([]);
});
