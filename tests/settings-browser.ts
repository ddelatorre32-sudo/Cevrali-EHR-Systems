import { expect, type Page } from '@playwright/test';

/** UI-only journey shared by the connected app and isolated offline preview. */
export async function exerciseSettings(page: Page) {
  page.setDefaultTimeout(12000);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const openSettings = async () => {
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  };
  const category = (name: string) =>
    page.getByRole('button', { name, exact: true });
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(
    signout.or(page.getByRole('button', { name: 'Open clinician demo', exact: true })),
  ).toBeVisible();
  if (!(await signout.isVisible()))
    await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();

  await openSettings();
  await category('Personal preferences').click();
  await page.getByRole('combobox', { name: 'Start page', exact: true }).selectOption('schedule');
  await page.getByRole('combobox', { name: 'Default calendar view', exact: true }).selectOption('month');
  await page.getByRole('combobox', { name: 'Display density', exact: true }).selectOption('compact');
  await page.getByLabel('Reduce interface motion', { exact: true }).check();
  await page.getByRole('button', { name: 'Save personal preferences', exact: true }).click();
  await expect(page.getByText('Personal preferences saved', { exact: true })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-reduced-motion', 'true');

  await nav.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Calendar view' }).getByRole('button', {
    name: 'Month', exact: true,
  })).toHaveAttribute('aria-pressed', 'true');
  await openSettings();
  await category('Connections').click();
  await expect(page.getByLabel('Lab provider name', { exact: true })).toBeEditable();
  await page.getByRole('button', { name: 'Save demo preferences', exact: true }).click();
  await expect(page.getByText(
    'Demo integration preferences saved. Live delivery remains disconnected.',
    { exact: true },
  )).toBeVisible();

  await category('Templates & phrases').click();
  await page.getByRole('tab', { name: 'SOAP templates', exact: true }).click();
  const suffix = Date.now().toString();
  const templateName = `Settings provider template ${suffix}`;
  const originalPlan = 'Discuss [[treatment options]] and document agreed follow-up.';
  await page.getByRole('textbox', { name: 'Template name', exact: true }).fill(templateName);
  await page.getByRole('textbox', { name: 'Subjective', exact: true }).fill('Review [[patient-reported history]].');
  await page.getByRole('textbox', { name: 'Objective', exact: true }).fill('Record [[examination actually performed]].');
  await page.getByRole('textbox', { name: 'Assessment', exact: true }).fill('Assess [[clinical findings]].');
  await page.getByRole('textbox', { name: 'Plan', exact: true }).fill(originalPlan);
  await page.getByRole('combobox', { name: 'Template visibility', exact: true }).selectOption('personal');
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByText('Template saved', { exact: true })).toBeVisible();
  const template = page.getByRole('article', { name: `Template: ${templateName}`, exact: true });
  await expect(template).toBeVisible();

  // A dedicated patient/draft keeps this journey independent of other browser tests.
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Register a patient', exact: true });
  const firstName = `Settings${suffix}`;
  for (const [label, value] of [
    ['First name', firstName], ['Last name', 'TemplatePatient'],
    ['Date of birth', '1992-02-03'], ['Phone number', '555-0188'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole('button', { name: 'Register patient', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  await chart.getByRole('button', { name: 'New encounter', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Start an encounter', exact: true });
  await dialog.getByLabel('Chief complaint', { exact: true }).fill('Provider template workflow');
  await dialog.getByRole('button', { name: 'Create encounter', exact: true }).click();
  let note = page.getByRole('dialog', { name: 'Document encounter', exact: true });
  await note.getByRole('combobox', { name: 'Visit template', exact: true }).selectOption({ label: templateName });
  page.once('dialog', (confirmation) => confirmation.accept());
  await note.getByRole('button', { name: 'Apply template', exact: true }).click();
  await expect(note.getByLabel('Plan', { exact: false })).toHaveValue(originalPlan);
  await expect(note.getByLabel('Subjective', { exact: false })).toHaveValue('Review [[patient-reported history]].');
  await note.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(note.getByText('All changes saved', { exact: true })).toBeVisible();
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await openSettings();
  await category('Templates & phrases').click();
  await template.getByRole('button', { name: 'Edit template', exact: true }).click();
  await page.getByRole('textbox', { name: 'Plan', exact: true }).fill('Updated template for future visits only.');
  await page.getByRole('button', { name: 'Save template changes', exact: true }).click();
  await expect(page.getByText('Template changes saved', { exact: true })).toBeVisible();
  await template.getByRole('button', { name: 'Archive template', exact: true }).click();
  await expect(template).not.toBeVisible();

  // Changing or archiving a template must never rewrite an already saved note.
  await nav.getByRole('button', { name: 'Encounters', exact: true }).click();
  await page.getByRole('row').filter({ hasText: `${firstName} TemplatePatient` })
    .getByRole('button', { name: 'Continue note', exact: true }).click();
  note = page.getByRole('dialog', { name: 'Document encounter', exact: true });
  await expect(note.getByLabel('Plan', { exact: false })).toHaveValue(originalPlan);
  await expect(note.getByRole('combobox', { name: 'Visit template', exact: true })
    .getByRole('option', { name: templateName, exact: true })).toHaveCount(0);
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await signout.click();
  await page.getByRole('button', { name: 'Explore the front desk demo', exact: true }).click();
  await openSettings();
  await expect(category('Templates & phrases')).toHaveCount(0);
  await expect(category('Team & access')).toHaveCount(0);
  await category('Personal preferences').click();
  await expect(page.getByRole('combobox', { name: 'Start page', exact: true })).toHaveValue('overview');
  await expect(page.getByRole('combobox', { name: 'Default calendar view', exact: true })).toHaveValue('week');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-density', 'comfortable');
  await expect(page.getByLabel('Reduce interface motion', { exact: true })).not.toBeChecked();
  await category('Connections').click();
  await expect(page.getByLabel('Lab provider name', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save demo preferences', exact: true })).toHaveCount(0);

  // Reauthentication restores the provider's own settings; clean up demo defaults.
  await signout.click();
  await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  await openSettings();
  await category('Personal preferences').click();
  await expect(page.getByRole('combobox', { name: 'Start page', exact: true })).toHaveValue('schedule');
  await expect(page.getByRole('combobox', { name: 'Default calendar view', exact: true })).toHaveValue('month');
  await expect(page.getByRole('combobox', { name: 'Display density', exact: true })).toHaveValue('compact');
  await page.getByRole('combobox', { name: 'Start page', exact: true }).selectOption('overview');
  await page.getByRole('combobox', { name: 'Default calendar view', exact: true }).selectOption('week');
  await page.getByRole('combobox', { name: 'Display density', exact: true }).selectOption('comfortable');
  await page.getByLabel('Reduce interface motion', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save personal preferences', exact: true }).click();
  await expect(page.getByText('Personal preferences saved', { exact: true })).toBeVisible();
}
