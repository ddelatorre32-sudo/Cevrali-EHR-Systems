import { expect, type Locator, type Page } from '@playwright/test';

export async function exerciseTreatment(
  page: Page,
  fixture: { patientPrefix?: string; claimNumber?: string; appointmentTime?: string } = {},
) {
  page.setDefaultTimeout(12000);
  async function pick(select: Locator, pattern: RegExp) {
    const option = select.getByRole('option').filter({ hasText: pattern });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute('value'))!);
  }
  const patientPrefix = fixture.patientPrefix || 'TreatmentActual';
  const name = `${patientPrefix} Patient`;
  const claimNumber = fixture.claimNumber || 'ACTUAL-WC-01';
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  let d = page.getByRole('dialog', { name: 'Register a patient', exact: true });
  for (const [label, value] of [
    ['First name', patientPrefix],
    ['Last name', 'Patient'],
    ['Date of birth', '1990-05-06'],
    ['Phone number', '555-0188'],
  ])
    await d.getByLabel(label, { exact: true }).fill(value);
  await d
    .getByLabel('Add workers compensation claim during registration', {
      exact: true,
    })
    .check();
  for (const [label, value] of [
    ['Workers comp claim number', claimNumber],
    ['Date of injury', '2020-01-01'],
    ['Employer', 'Synthetic Employer'],
    ['Workers comp carrier', 'Synthetic Treatment Carrier'],
  ])
    await d.getByLabel(label, { exact: true }).fill(value);
  await d
    .getByRole('combobox', { name: 'Claim acceptance status', exact: true })
    .selectOption('Accepted');
  await d
    .getByLabel('Accepted body parts', { exact: true })
    .fill('Left shoulder');
  await d
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  const chart = page.getByRole('dialog', {
    name: 'Patient chart',
    exact: true,
  });
  await chart
    .getByRole('button', { name: 'Authorizations', exact: true })
    .click();
  await chart
    .getByRole('button', { name: 'New authorization', exact: true })
    .click();
  d = page.getByRole('dialog', {
    name: 'New prior authorization',
    exact: true,
  });
  await pick(
    d.getByRole('combobox', { name: 'Insurance policy', exact: true }),
    /Synthetic Treatment Carrier/,
  );
  await d
    .getByLabel('Service description', { exact: true })
    .fill('Three planned office treatment units');
  await d.getByLabel('Procedure codes', { exact: false }).fill('99213');
  await d.getByLabel('Requested visits', { exact: true }).fill('6');
  await d
    .getByRole('button', { name: 'Save authorization draft', exact: true })
    .click();
  await chart
    .getByRole('button', {
      name: 'Simulate authorization submission',
      exact: true,
    })
    .click();
  await chart
    .getByRole('button', { name: 'Record demo decision', exact: true })
    .click();
  d = page.getByRole('dialog', {
    name: 'Record demo authorization decision',
    exact: true,
  });
  await d
    .getByLabel('Approval number', { exact: true })
    .fill('ACTUAL-APPROVED');
  await d
    .getByLabel('Decision note', { exact: true })
    .fill('Synthetic service allowance approved');
  await d
    .getByRole('button', { name: 'Save demo decision', exact: true })
    .click();
  await chart
    .getByRole('button', { name: 'Record service allowance', exact: true })
    .click();
  d = page.getByRole('dialog', {
    name: 'Record demo service allowance',
    exact: true,
  });
  await d
    .getByRole('combobox', { name: 'Procedure code', exact: true })
    .selectOption('99213');
  await d
    .getByRole('combobox', { name: 'Service category', exact: true })
    .selectOption('Office visit');
  await d
    .getByLabel('Treatment description', { exact: true })
    .fill('Synthetic actual treatment review');
  await d.getByLabel('Approved quantity', { exact: true }).fill('6');
  await d
    .getByRole('combobox', { name: 'Counting unit', exact: true })
    .selectOption('Units');
  await d
    .getByLabel('Approval / change note', { exact: true })
    .fill('Synthetic allowance recorded');
  await d
    .getByRole('button', { name: 'Save service allowance', exact: true })
    .click();
  await expect(d).not.toBeVisible();
  await chart
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page
    .getByRole('button', { name: 'New appointment', exact: true })
    .click();
  d = page.getByRole('dialog', {
    name: 'Schedule an appointment',
    exact: true,
  });
  await pick(
    d.getByRole('combobox', { name: 'Patient', exact: true }),
    new RegExp(name),
  );
  await pick(
    d.getByRole('combobox', { name: 'Account for this visit', exact: true }),
    new RegExp(claimNumber),
  );
  await d.getByLabel('Time', { exact: true }).fill(fixture.appointmentTime || '03:30');
  await d
    .getByLabel('Reason for visit', { exact: true })
    .fill('Review actual performed and deferred treatment');
  await d
    .getByRole('combobox', { name: 'Authorization review', exact: true })
    .selectOption('required');
  await pick(
    d.getByRole('combobox', { name: 'Service approval 1', exact: true }),
    /Office visit.*6 units remaining/,
  );
  await d.getByLabel('Quantity for visit 1', { exact: true }).fill('3');
  await d
    .getByRole('button', { name: 'Schedule appointment', exact: true })
    .click();
  await expect(d).not.toBeVisible();
  // List mode exposes the same visit actions as the calendar detail dialog.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const visit = page.getByRole('row').filter({ hasText: name });
  await visit.getByRole('button', { name: /Check in/ }).click();
  await visit.getByRole('button', { name: /Start visit/ }).click();
  const note = page.getByRole('dialog', {
    name: 'Document encounter',
    exact: true,
  });
  await expect(
    note.getByRole('heading', {
      name: 'Actual treatment and billing',
      exact: true,
    }),
  ).toBeVisible();
  for (const [kind, value] of [
    ['performed', '1'],
    ['deferred', '1'],
    ['cancelled', '1'],
  ])
    await note.getByLabel(`99213 ${kind} units`, { exact: true }).fill(value);
  await note
    .getByLabel('Review or correction reason', { exact: true })
    .fill('One unit delivered, one deferred and one cancelled after review');
  await note
    .getByRole('button', { name: 'Confirm actual treatment', exact: true })
    .click();
  await expect(
    note.getByText('Reviewed · revision 1', { exact: true }),
  ).toBeVisible();
  await note.getByLabel('99213 performed units', { exact: true }).fill('2');
  await note.getByLabel('99213 deferred units', { exact: true }).fill('0');
  await note
    .getByLabel('Review or correction reason', { exact: true })
    .fill('Clinician corrected performed quantity after source review');
  await note
    .getByRole('button', { name: 'Save treatment correction', exact: true })
    .click();
  await expect(
    note.getByText('Reviewed · revision 2', { exact: true }),
  ).toBeVisible();
  await note.getByText('Treatment review history (2)', { exact: true }).click();
  await expect(
    note.getByText('99213: 1 performed, 1 deferred, 1 cancelled', {
      exact: true,
    }),
  ).toBeVisible();
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page
    .getByRole('button', { name: 'Treatment reconciliation', exact: true })
    .click();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('2 performed / 0 charged');
  await row
    .getByRole('button', { name: 'Review treatment', exact: true })
    .click();
  d = page.getByRole('dialog', {
    name: 'Actual treatment review',
    exact: true,
  });
  await expect(
    d.getByLabel('99213 performed units', { exact: true }),
  ).toHaveValue('2');
  await d.getByRole('button', { name: 'Close dialog', exact: true }).click();
}
