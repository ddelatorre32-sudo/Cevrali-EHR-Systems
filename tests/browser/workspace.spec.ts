import { test, expect } from '@playwright/test';

test('clinical workflow: register, schedule, check in, document, sign, and reload', async ({
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
  await expect(
    page.getByRole('heading', { name: 'Today’s appointments' }),
  ).toBeVisible();
  await page.screenshot({ path: '/tmp/cevrali-dashboard.png', fullPage: true });
  await page.getByRole('button', { name: 'Patients', exact: true }).click();
  await page
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('First name').fill('Maya');
  await dialog.getByLabel('Last name').fill('Rivera');
  await dialog.getByLabel('Date of birth').fill('1994-05-16');
  await dialog.getByLabel('Phone number').fill('(415) 555-0123');
  await dialog.getByRole('combobox', { name: 'Known allergies', exact: true }).fill('Penicillin');
  await dialog.getByRole('option', { name: 'Penicillin', exact: true }).click();
  await dialog.getByRole('button', { name: 'Register patient' }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole('textbox', { name: 'Filter patient directory' })
    .fill('Maya');
  await page.getByRole('button', { name: 'Open chart' }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Maya Rivera' }),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog').getByText('Penicillin', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByRole('button', { name: 'New appointment' }).click();
  const patientSelect = dialog.getByRole('combobox', {
    name: 'Patient',
    exact: true,
  });
  await expect(
    patientSelect.getByRole('option', { name: /Maya Rivera/ }),
  ).toHaveCount(1);
  const patientValue = await patientSelect
    .getByRole('option', { name: /Maya Rivera/ })
    .getAttribute('value');
  await patientSelect.selectOption(patientValue!);
  await dialog.getByLabel('Time', { exact: true }).fill('14:00');
  await dialog
    .getByLabel('Reason for visit')
    .fill('Preventive health consultation');
  await dialog.getByRole('button', { name: 'Schedule appointment' }).click();
  await expect(dialog).not.toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Maya Rivera' });
  await row.getByRole('button', { name: 'Check in' }).click();
  await expect(row.getByText('Checked in', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Start visit' }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Document encounter' }),
  ).toBeVisible();
  await dialog
    .getByLabel('Subjective')
    .fill('No acute symptoms. Here for preventive care.');
  await dialog
    .getByLabel('Objective')
    .fill('Well appearing. Normal examination.');
  await dialog
    .getByLabel('Assessment', { exact: false })
    .fill('Routine preventive health visit.');
  await dialog
    .getByLabel('Plan', { exact: false })
    .fill('Discussed preventive care. Follow up in one year.');
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await expect(dialog.getByText('All changes saved')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Encounters', exact: true }).click();
  const noteRow = page.getByRole('row').filter({ hasText: 'Maya Rivera' });
  await noteRow.getByRole('button', { name: 'Continue note' }).click();
  await expect(dialog.getByLabel('Plan', { exact: false })).toHaveValue(
    'Discussed preventive care. Follow up in one year.',
  );
  await dialog.getByRole('button', { name: 'Sign note' }).click();
  await dialog.getByRole('button', { name: 'Confirm signature' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(noteRow.getByText('Signed', { exact: true })).toBeVisible();
  await page.reload();
  await noteRow.getByRole('button', { name: 'View note' }).click();
  await expect(dialog.getByLabel('Subjective')).toBeDisabled();
  await expect(dialog.getByLabel('Plan', { exact: false })).toHaveValue(
    'Discussed preventive care. Follow up in one year.',
  );
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page
    .getByRole('button', { name: 'Complete Maya Rivera’s visit' })
    .click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Maya Rivera' })
      .getByText('Completed', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Activity log' }).click();
  await expect(
    page.getByRole('cell', { name: 'Signed encounter', exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /Care inbox/, exact: false })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Complete Review HbA1c results', exact: true })
    .click();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Reopen Review HbA1c results' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome to Cevrali' }),
  ).toBeVisible();
  expect((await page.request.get('/api/patients')).status()).toBe(401);
  expect(errors).toEqual([]);
});

test('front desk can open finance records while clinical endpoints stay restricted', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Explore the front desk demo' })
    .click();
  await expect(
    page.getByRole('heading', {
      name: /Good (morning|afternoon|evening), Jamie/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Encounters', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Patients', exact: true }).click();
  await expect(
    page
      .getByRole('button', { name: 'Insurance & billing', exact: true })
      .first(),
  ).toBeVisible();
  expect((await page.request.get('/api/patients/pat-001')).status()).toBe(403);
  expect((await page.request.get('/api/labs')).status()).toBe(403);
});

test('mobile workspace supports navigation without page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open clinician demo' }).click();
  await expect(
    page.getByRole('heading', {
      name: /Good (morning|afternoon|evening), Dr. Morgan/,
    }),
  ).toBeVisible();
  await page.screenshot({ path: '/tmp/cevrali-mobile.png', fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Patients', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Patient directory' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
