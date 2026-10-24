import { test, expect } from '@playwright/test';
import { exerciseNoteAddenda } from '../note-addenda-browser';

test('signed source filing corrections retain originals until an author reviews and signs an addendum', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open clinician demo', exact: true })
    .click();
  await exerciseNoteAddenda(page);
  expect(errors).toEqual([]);
});
