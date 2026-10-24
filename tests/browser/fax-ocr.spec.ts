import { test, expect } from '@playwright/test';
import { exerciseFaxOcr } from '../fax-ocr-browser';

test('a real image-only fax uses local OCR and requires clinician value review before chart filing and note inclusion', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  await exerciseFaxOcr(page);
  expect(errors).toEqual([]);
});
