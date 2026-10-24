import { expect, test } from '@playwright/test';
import { exerciseRegistrationRetry } from '../registration-retry.browser';

for (const scheduling of [false, true]) {
  test(scheduling
    ? 'saved patient registration retries scheduling without losing coverage or booking context'
    : 'registration failures keep unsaved fields editable and successful creation locks fields for record-opening retry',
  async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Dr. Morgan/ })).toBeVisible();
    await exerciseRegistrationRetry(page, { scheduling });
    expect(errors).toEqual([]);
  });
}
