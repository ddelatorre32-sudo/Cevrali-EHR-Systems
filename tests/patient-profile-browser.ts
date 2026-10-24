import { expect, type Page } from '@playwright/test';

/** This journey uses only the UI so it also runs in the network-blocked preview. */
export async function exercisePatientProfile(page: Page) {
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signout.or(page.getByRole('button', {
    name: 'Open clinician demo', exact: true,
  }))).toBeVisible();
  if (!(await signout.isVisible()))
    await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();

  const firstName = `Profile${Date.now()}`;
  const lastName = 'ReviewedHistory';
  const oldPhone = '555-0168';
  const newPhone = '555-0186';
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  const registration = page.getByRole('dialog', { name: 'Register a patient', exact: true });
  for (const [label, value] of [
    ['First name', firstName], ['Last name', lastName],
    ['Date of birth', '1990-02-03'], ['Phone number', oldPhone],
  ]) await registration.getByLabel(label, { exact: true }).fill(value);
  await registration.getByRole('checkbox', {
    name: 'Open patient record after registration', exact: true,
  }).check();
  await registration.getByRole('button', { name: 'Register patient', exact: true }).click();

  const chart = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  await expect(chart.getByRole('heading', { name: `${firstName} ${lastName}`, exact: true }))
    .toBeVisible();
  await chart.getByRole('button', { name: 'Edit patient details', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit patient details', exact: true });
  const demographicReason = 'Patient confirmed corrected contact and mailing details';
  for (const [label, value] of [
    ['Phone number', newPhone], ['Address', '300 Synthetic Profile Street'],
    ['Unit / Apt number', 'Suite 12'], ['City', 'Boston'], ['ZIP code', '02108-1234'],
    ['Change reason', demographicReason],
  ]) await editor.getByRole('textbox', { name: label, exact: true }).fill(value);
  await editor.getByRole('combobox', { name: 'State', exact: true }).selectOption('MA');
  await editor.getByRole('button', { name: 'Save patient details', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await chart.getByRole('button', { name: 'Summary', exact: true }).click();
  const details = chart.locator('.mini-card').filter({ hasText: 'Patient details' });
  for (const text of [newPhone, '300 Synthetic Profile Street', 'Suite 12', 'Boston', 'MA', '02108-1234'])
    await expect(details).toContainText(text);

  await chart.getByRole('button', { name: 'Change history', exact: true }).click();
  await expect(chart.getByRole('heading', { name: 'Patient profile change history', exact: true }))
    .toBeVisible();
  await expect(chart).toContainText(demographicReason);
  await expect(chart).toContainText('Dr. Alex Morgan');
  const changes = chart.getByText('View changes', { exact: true });
  for (let index = 0; index < await changes.count(); index++) await changes.nth(index).click();
  await expect(chart).toContainText(oldPhone);
  await expect(chart).toContainText(newPhone);

  await chart.getByRole('button', { name: 'Allergies', exact: true }).click();
  const form = chart.getByRole('form', { name: 'Detailed allergy record', exact: true });
  const reviewStatus = form.getByRole('combobox', { name: 'Allergy review status', exact: true });
  await expect(reviewStatus).toHaveValue('Not reviewed');
  await expect(chart.locator('.allergy-strip')).not.toContainText('No known allergies');
  const search = form.getByRole('combobox', { name: 'Known allergies', exact: true });
  await search.fill('Unlisted synthetic pending allergen');
  await form.getByRole('listbox', { name: 'Allergy choices', exact: true })
    .getByRole('option', { name: 'Other', exact: true }).click();
  const pendingAllergy = form.getByRole('textbox', { name: 'Other allergy name', exact: true });
  await pendingAllergy.fill('Uncommitted synthetic allergy name');
  let dismissedPending = false;
  page.once('dialog', async confirmation => {
    dismissedPending = true;
    await confirmation.dismiss();
  });
  await chart.getByRole('button', { name: 'Summary', exact: true }).click();
  expect(dismissedPending).toBe(true);
  await expect(form).toBeVisible();
  await expect(pendingAllergy).toHaveValue('Uncommitted synthetic allergy name');
  await form.getByRole('button', { name: 'Cancel other allergy', exact: true }).click();
  await search.fill('Penicillin');
  await form.getByRole('listbox', { name: 'Allergy choices', exact: true })
    .getByRole('option', { name: 'Penicillin', exact: true }).click();
  const penicillin = form.getByRole('group', { name: 'Penicillin', exact: true });
  await penicillin.getByRole('textbox', { name: 'Reaction', exact: true }).fill('Hives');
  let dismissedChanges = 0;
  page.once('dialog', async confirmation => {
    dismissedChanges++;
    await confirmation.dismiss();
  });
  await chart.getByRole('button', { name: 'Summary', exact: true }).click();
  expect(dismissedChanges).toBe(1);
  await expect(form).toBeVisible();
  await expect(penicillin.getByRole('textbox', { name: 'Reaction', exact: true })).toHaveValue('Hives');
  page.once('dialog', async confirmation => {
    dismissedChanges++;
    await confirmation.dismiss();
  });
  await chart.getByRole('button', { name: 'Close dialog', exact: true }).click();
  expect(dismissedChanges).toBe(2);
  await expect(chart).toBeVisible();
  await expect(form).toBeVisible();
  await expect(penicillin.getByRole('textbox', { name: 'Reaction', exact: true })).toHaveValue('Hives');
  await penicillin.getByRole('combobox', { name: 'Severity', exact: true }).selectOption('Severe');
  await penicillin.getByRole('combobox', { name: 'Allergy type', exact: true }).selectOption('Allergy');
  await penicillin.getByRole('combobox', { name: 'Information source', exact: true })
    .selectOption('Patient reported');
  await penicillin.getByLabel('Onset date', { exact: true }).fill('2020-02-01');
  await penicillin.getByRole('textbox', { name: 'Notes', exact: true })
    .fill('Synthetic patient history reviewed with the treating clinician.');
  await reviewStatus.selectOption('Allergies recorded');
  await form.getByRole('checkbox', { name: 'I reviewed this allergy information', exact: true }).check();
  await form.getByRole('textbox', { name: 'Allergy change reason', exact: true })
    .fill('Detailed synthetic allergy history reviewed with patient');
  await form.getByRole('button', { name: 'Save allergy record', exact: true }).click();
  await expect(chart.getByText('Allergy record saved', { exact: true })).toBeVisible();
  const strip = chart.locator('.allergy-strip');
  for (const text of ['Penicillin', 'Severe', 'Hives']) await expect(strip).toContainText(text);

  // Removing the last active item retains its history and never infers an NKA review.
  await form.getByRole('button', { name: 'Remove allergy Penicillin', exact: true }).click();
  await expect(reviewStatus).toHaveValue('Not reviewed');
  await expect(form.getByRole('checkbox', { name: 'I reviewed this allergy information', exact: true }))
    .not.toBeChecked();
  await form.getByRole('checkbox', { name: 'Show inactive allergy entries', exact: true }).check();
  await expect(penicillin.getByRole('textbox', { name: 'Reaction', exact: true })).toHaveValue('Hives');
  await expect(penicillin.getByRole('combobox', { name: 'Entry status', exact: true })).toHaveValue('Inactive');
  await reviewStatus.selectOption('No known allergies');
  await form.getByRole('checkbox', { name: 'I reviewed this allergy information', exact: true }).check();
  const allergyReason = 'Prior synthetic report was corrected after clinician review';
  await form.getByRole('textbox', { name: 'Allergy change reason', exact: true }).fill(allergyReason);
  await form.getByRole('button', { name: 'Save allergy record', exact: true }).click();
  await expect(chart.getByText('Allergy record saved', { exact: true })).toBeVisible();
  await expect(strip).toContainText('No known allergies');
  await expect(strip).not.toContainText('Penicillin');
  await chart.getByRole('button', { name: 'Change history', exact: true }).click();
  await expect(chart).toContainText(allergyReason);
  await expect(chart).toContainText('Detailed synthetic allergy history reviewed with patient');
  await chart.getByRole('button', { name: 'Close dialog', exact: true }).click();
  return { firstName, lastName, oldPhone, newPhone, demographicReason, allergyReason };
}
