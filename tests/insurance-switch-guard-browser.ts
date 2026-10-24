import { expect, type Page } from '@playwright/test';
import { exerciseTreatment } from './treatment-browser';

/** The same pure UI flow checks the persisted app and staged offline preview. */
export async function exerciseInsuranceSwitchGuard(page: Page) {
  const patientPrefix = 'InsuranceSwitch';
  const name = `${patientPrefix} Patient`;
  const claimNumber = 'SWITCH-GUARD-01';
  await exerciseTreatment(page, { patientPrefix, claimNumber, appointmentTime: '04:00' });
  await page.getByRole('button', { name: 'Encounters', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await row.getByRole('button', { name: 'Continue note', exact: true }).click();
  let note = page.getByRole('dialog', {
    name: 'Document encounter',
    exact: true,
  });
  const account = () => note.getByRole('combobox', {
    name: 'Account for this visit',
    exact: true,
  });
  const subjective = () => note.locator('.soap-label')
    .filter({ hasText: 'Subjective' }).locator('textarea');
  const originalSubjective = await subjective().inputValue();
  const originalAccount = await account().inputValue();
  await expect(account().locator('option:checked')).toContainText(claimNumber);
  const privateOption = account().getByRole('option')
    .filter({ hasText: 'Private insurance / personal care' });
  await expect(privateOption).toHaveCount(1);
  await account().selectOption((await privateOption.getAttribute('value'))!);
  await subjective().fill('Rejected insurance switch must not persist this narrative.');
  await note.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(note.getByRole('alert')).toContainText(
    'Insurance cannot change after a planned treatment visit starts',
  );
  await expect(note.getByLabel('99213 performed units', { exact: true }))
    .toHaveValue('2');
  await expect(note.getByText('Reviewed · revision 2', { exact: true }))
    .toBeVisible();

  // Discard the proposed local edit, then fetch the stored encounter again.
  page.once('dialog', (dialog) => void dialog.accept());
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await row.getByRole('button', { name: 'Continue note', exact: true }).click();
  note = page.getByRole('dialog', { name: 'Document encounter', exact: true });
  await expect(account()).toHaveValue(originalAccount);
  await expect(subjective()).toHaveValue(originalSubjective);
  await expect(note.getByLabel('99213 performed units', { exact: true }))
    .toHaveValue('2');
  await subjective().fill('Same-account documentation remains editable.');
  await note.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(note.getByText('All changes saved', { exact: true })).toBeVisible();
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('button', { name: 'Patients', exact: true }).click();
  await page.getByRole('textbox', { name: 'Filter patient directory', exact: true })
    .fill(patientPrefix);
  await page.getByRole('row').filter({ hasText: name })
    .getByRole('button', { name: 'Open chart', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  await chart.getByRole('button', { name: 'Authorizations', exact: true }).click();
  const allowance = chart.locator('.ops-allowance').filter({ hasText: '99213' });
  await expect(allowance).toContainText('0 scheduled · 2 completed · 6 approved units');
  await expect(allowance).toContainText('4 remaining');
}
