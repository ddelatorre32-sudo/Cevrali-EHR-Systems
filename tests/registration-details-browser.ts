import { expect, type Locator, type Page } from '@playwright/test';

export const registrationAddress = {
  address: '125 Synthetic Care Avenue',
  address_unit: 'Apt 4B',
  city: 'San Francisco',
  state: 'CA',
  zip_code: '94107-1234',
};

export async function fillRegistrationAddress(dialog: Locator) {
  for (const [label, value] of [
    ['Address', registrationAddress.address],
    ['Unit / Apt number', registrationAddress.address_unit],
    ['City', registrationAddress.city],
    ['ZIP code', registrationAddress.zip_code],
  ]) await dialog.getByRole('textbox', { name: label, exact: true }).fill(value);
  await dialog.getByRole('combobox', { name: 'State', exact: true })
    .selectOption(registrationAddress.state);
}

export async function expectRegisteredAddress(chart: Locator) {
  await chart.getByRole('button', { name: 'Summary', exact: true }).click();
  const details = chart.locator('.mini-card').filter({ hasText: 'Patient details' });
  for (const value of Object.values(registrationAddress))
    await expect(details).toContainText(value);
}

/** UI-only journey, also executed with every network request blocked offline. */
export async function exerciseRegistrationDetails(page: Page) {
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signout.or(page.getByRole('button', {
    name: 'Open clinician demo', exact: true,
  }))).toBeVisible();
  if (!(await signout.isVisible()))
    await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();

  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Register a patient', exact: true });
  const firstName = `Structured${Date.now()}`;
  const lastName = 'RegistrationDetails';
  for (const [label, value] of [
    ['First name', firstName], ['Last name', lastName],
    ['Date of birth', '1991-03-04'], ['Phone number', '555-0190'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await fillRegistrationAddress(dialog);
  const zip = dialog.getByRole('textbox', { name: 'ZIP code', exact: true });
  await zip.fill('9410');
  expect(await zip.evaluate((input) => (input as HTMLInputElement).validity.valid))
    .toBe(false);
  await zip.fill(registrationAddress.zip_code);

  const search = dialog.getByRole('combobox', { name: 'Known allergies', exact: true });
  const choices = dialog.getByRole('listbox', { name: 'Allergy choices', exact: true });
  await search.fill('penicillin');
  await choices.getByRole('option', { name: 'Penicillin', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove allergy Penicillin', exact: true }))
    .toBeVisible();

  await search.fill('latex');
  await expect(dialog.getByRole('listbox')).toBeVisible();
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Remove allergy Latex', exact: true }))
    .toBeVisible();
  await expect(dialog).toBeVisible();
  await search.fill('unlisted search text');
  await search.press('Escape');
  await expect(dialog.getByRole('listbox')).not.toBeVisible();
  await expect(dialog).toBeVisible();

  await search.fill('amox');
  await choices.getByRole('option', { name: 'Amoxicillin', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Remove allergy / })).toHaveCount(3);

  // A duplicate custom entry must not add another copy of a selected allergen.
  await search.fill('unlisted synthetic allergen');
  await choices.getByRole('option', { name: 'Other', exact: true }).click();
  const custom = dialog.getByRole('textbox', { name: 'Other allergy name', exact: true });
  await custom.fill('  penicillin  ');
  expect(await dialog.locator('form').evaluate((form) =>
    (form as HTMLFormElement).checkValidity())).toBe(false);
  await dialog.getByRole('button', { name: 'Add allergy', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Remove allergy / })).toHaveCount(3);

  await search.fill('unlisted synthetic allergen');
  await choices.getByRole('option', { name: 'Other', exact: true }).click();
  const customAllergy = 'Synthetic custom contact compound';
  await custom.fill(`  ${customAllergy}  `);
  // Staff must add a manually entered allergy before submitting registration.
  expect(await dialog.locator('form').evaluate((form) =>
    (form as HTMLFormElement).checkValidity())).toBe(false);
  await dialog.getByRole('button', { name: 'Add allergy', exact: true }).click();
  await expect(dialog.getByRole('button', {
    name: `Remove allergy ${customAllergy}`, exact: true,
  })).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove allergy Latex', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove allergy Latex', exact: true }))
    .toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Remove allergy / })).toHaveCount(3);
  await dialog.getByRole('checkbox', {
    name: 'Open patient record after registration', exact: true,
  }).check();
  expect(await dialog.locator('form').evaluate((form) =>
    (form as HTMLFormElement).checkValidity())).toBe(true);
  await dialog.getByRole('button', { name: 'Register patient', exact: true }).click();

  const chart = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  await expect(chart.getByRole('heading', { name: `${firstName} ${lastName}`, exact: true }))
    .toBeVisible();
  await expectRegisteredAddress(chart);
  const allergyStrip = chart.locator('.allergy-strip');
  for (const name of ['Penicillin', 'Amoxicillin', customAllergy])
    await expect(allergyStrip).toContainText(name);
  await expect(allergyStrip).not.toContainText('Latex');
  await chart.getByRole('button', { name: 'Close dialog', exact: true }).click();
  return { firstName, lastName, allergies: ['Penicillin', 'Amoxicillin', customAllergy] };
}
