import { expect, type Page } from '@playwright/test';

export async function exercisePatientFinance(
  page: Page,
  { frontdesk = false }: { frontdesk?: boolean } = {},
) {
  const firstName = frontdesk ? 'Frontdesk' : 'Chart';
  const name = `${firstName} InsuranceExample`;
  await page.getByRole('button', { name: 'Patients', exact: true }).click();
  await page
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  const registration = page.getByRole('dialog', {
    name: 'Register a patient',
    exact: true,
  });
  await registration.getByLabel('First name', { exact: true }).fill(firstName);
  await registration
    .getByLabel('Last name', { exact: true })
    .fill('InsuranceExample');
  await registration
    .getByLabel('Date of birth', { exact: true })
    .fill('1992-03-04');
  await registration
    .getByLabel('Phone number', { exact: true })
    .fill('555-0155');
  await registration
    .getByRole('checkbox', {
      name: 'Add insurance during registration',
      exact: true,
    })
    .check();
  await registration
    .getByLabel('Payer name', { exact: true })
    .fill('Chart Demo Payer');
  await registration.getByLabel('Plan name', { exact: true }).fill('Chart PPO');
  await registration
    .getByLabel('Member ID', { exact: true })
    .fill('CHART-DEMO-MEMBER');
  await expect(
    registration.getByRole('textbox', { name: 'Subscriber name', exact: true }),
  ).toHaveCount(0);
  await registration
    .getByRole('checkbox', {
      name: 'Run a demo coverage check now',
      exact: true,
    })
    .check();
  await registration
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  await expect(registration).not.toBeVisible();
  const chart = page.getByRole('dialog', {
    name: frontdesk ? 'Patient record' : 'Patient chart',
    exact: true,
  });
  await expect(chart).toBeVisible();
  await expect(
    chart.getByRole('heading', { name, exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    chart
      .locator('.finance-card .badge')
      .getByText('Demo Active', { exact: true }),
  ).toBeVisible();
  await expect(
    chart.getByText(`${name} · Self`, { exact: true }),
  ).toBeVisible();
  await expect(
    chart.getByRole('combobox', { name: 'Filter by patient', exact: true }),
  ).toHaveCount(0);
  await chart
    .getByRole('button', { name: 'Edit coverage', exact: true })
    .click();
  const edit = page.getByRole('dialog', {
    name: 'Edit insurance coverage',
    exact: true,
  });
  await expect(
    edit.getByRole('combobox', { name: 'Patient', exact: true }),
  ).toBeDisabled();
  await edit.getByLabel('Group number', { exact: true }).fill('CHART-GROUP');
  await edit
    .getByRole('button', { name: 'Save coverage', exact: true })
    .click();
  await expect(edit).not.toBeVisible();
  await expect(
    chart
      .locator('.finance-card .badge')
      .getByText('Check needed', { exact: true }),
  ).toBeVisible();
  await chart
    .getByRole('button', { name: 'Check coverage', exact: true })
    .click();
  const check = page.getByRole('dialog', {
    name: 'Run demo coverage check',
    exact: true,
  });
  await expect(check).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(check).not.toBeVisible();
  await expect(chart).toBeVisible();
  await chart
    .getByRole('button', { name: 'Check coverage', exact: true })
    .click();
  await check
    .getByRole('button', { name: 'Run demo check', exact: true })
    .click();
  await expect(check).not.toBeVisible();
  await expect(
    chart
      .locator('.finance-card .badge')
      .getByText('Demo Active', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: frontdesk
      ? '/tmp/cevrali-frontdesk-chart.png'
      : '/tmp/cevrali-chart-insurance.png',
    fullPage: true,
  });
  await chart.getByRole('button', { name: 'Billing', exact: true }).click();
  await expect(
    chart
      .locator('.finance-metrics > div')
      .filter({ hasText: 'Charges' })
      .getByText('$0.00', { exact: true }),
  ).toBeVisible();
  await expect(
    chart.getByRole('combobox', { name: 'Billing patient', exact: true }),
  ).toHaveCount(0);
  await chart
    .getByRole('button', { name: 'New charge sheet', exact: true })
    .click();
  const createBill = page.getByRole('dialog', {
    name: 'Create visit charge sheet',
    exact: true,
  });
  await expect(createBill.getByRole('status')).toContainText(
    'No unbilled encounters',
  );
  await expect(
    createBill
      .getByRole('combobox', { name: 'Encounter', exact: true })
      .getByRole('option'),
  ).toHaveCount(1);
  await expect(
    createBill.getByRole('button', {
      name: 'Create charge sheet',
      exact: true,
    }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(createBill).not.toBeVisible();
  if (frontdesk) {
    await chart.getByRole('button', { name: 'Summary', exact: true }).click();
    await expect(
      chart.getByRole('heading', { name: 'Patient details', exact: true }),
    ).toBeVisible();
    for (const button of ['New encounter', 'Encounters', 'Lab results'])
      await expect(
        chart.getByRole('button', { name: button, exact: true }),
      ).toHaveCount(0);
    await expect(
      chart.getByRole('heading', { name: 'Medication history', exact: false }),
    ).toHaveCount(0);
    await chart
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Filter patient directory', exact: true })
      .fill(name);
    await page
      .getByRole('button', { name: 'Insurance & billing', exact: true })
      .click();
    await expect(chart).toBeVisible();
    await expect(
      chart
        .locator('.finance-card .badge')
        .getByText('Demo Active', { exact: true }),
    ).toBeVisible();
    return;
  }
  await chart
    .getByRole('button', { name: 'New encounter', exact: true })
    .click();
  const start = page.getByRole('dialog', {
    name: 'Start an encounter',
    exact: true,
  });
  await expect(
    start
      .getByRole('combobox', { name: 'Patient', exact: true })
      .locator('option:checked'),
  ).toContainText(name);
  await start
    .getByLabel('Chief complaint', { exact: true })
    .fill('Synthetic chart billing example');
  await start
    .getByRole('button', { name: 'Create encounter', exact: true })
    .click();
  const note = page.getByRole('dialog', {
    name: 'Document encounter',
    exact: true,
  });
  await note
    .getByLabel('Subjective', { exact: false })
    .fill('Synthetic patient-reported visit for chart billing test.');
  await note
    .getByLabel('Assessment', { exact: false })
    .fill('Synthetic condition reviewed by clinician.');
  await note
    .getByLabel('Plan', { exact: false })
    .fill('Review care plan at follow-up.');
  await note.getByRole('button', { name: 'Sign note', exact: true }).click();
  await note
    .getByRole('button', { name: 'Confirm signature', exact: true })
    .click();
  await expect(note).not.toBeVisible();
  await page
    .getByRole('textbox', { name: 'Filter patient directory', exact: true })
    .fill(name);
  await page.getByRole('button', { name: 'Open chart', exact: true }).click();
  await chart.getByRole('button', { name: 'Billing', exact: true }).click();
  await chart
    .getByRole('button', { name: 'New charge sheet', exact: true })
    .click();
  const encounter = createBill.getByRole('combobox', {
    name: 'Encounter',
    exact: true,
  });
  await expect(encounter.getByRole('option')).toHaveCount(2);
  await encounter.selectOption({ index: 1 });
  await createBill
    .getByRole('button', { name: 'Create charge sheet', exact: true })
    .click();
  const bill = page.getByRole('dialog', { name: 'Visit billing', exact: true });
  await expect(bill).toBeVisible();
  await bill
    .getByRole('combobox', { name: 'Insurance policy', exact: true })
    .selectOption({ index: 1 });
  await bill
    .getByRole('textbox', { name: 'Procedure code 1', exact: true })
    .fill('99213');
  await bill
    .getByRole('textbox', { name: 'Diagnosis code 1', exact: true })
    .fill('I10');
  await bill
    .getByRole('textbox', { name: 'Charge description 1', exact: true })
    .fill('Staff reviewed chart visit');
  await bill
    .getByRole('spinbutton', { name: 'Unit fee 1', exact: true })
    .fill('120');
  await bill
    .getByRole('button', { name: 'Prepare demo claim', exact: true })
    .click();
  await expect(bill.getByRole('status')).toContainText('Demo claim prepared');
  await bill
    .getByRole('button', { name: 'Simulate submission', exact: true })
    .click();
  await bill
    .getByRole('button', { name: 'Record demo payer response', exact: true })
    .click();
  await bill
    .getByLabel('Response reference', { exact: true })
    .fill('CHART-REMIT');
  await bill
    .getByRole('spinbutton', { name: 'Insurer payment ($)', exact: true })
    .fill('80');
  await bill
    .getByRole('spinbutton', {
      name: 'Contractual adjustment ($)',
      exact: true,
    })
    .fill('20');
  await bill
    .getByRole('spinbutton', {
      name: 'Patient responsibility ($)',
      exact: true,
    })
    .fill('20');
  await bill
    .getByRole('button', { name: 'Post demo response', exact: true })
    .click();
  await bill
    .getByRole('button', { name: 'Record patient payment', exact: true })
    .click();
  await bill
    .getByRole('spinbutton', { name: 'Payment amount ($)', exact: true })
    .fill('20');
  await bill
    .getByLabel('Payment reference', { exact: true })
    .fill('CHART-RECEIPT');
  await bill
    .getByRole('button', { name: 'Save payment entry', exact: true })
    .click();
  await expect(bill.getByRole('status')).toContainText(
    'No payment was processed',
  );
  await bill
    .getByRole('button', { name: 'Close billing', exact: true })
    .click();
  await expect(chart).toBeVisible();
  await expect(
    chart
      .locator('.finance-metrics > div')
      .filter({ hasText: 'Charges' })
      .getByText('$120.00', { exact: true }),
  ).toBeVisible();
  await expect(
    chart
      .locator('.finance-metrics > div')
      .filter({ hasText: 'Patient due' })
      .getByText('$0.00', { exact: true }),
  ).toBeVisible();
  await expect(
    chart
      .getByRole('row')
      .filter({ hasText: name })
      .getByText('Demo adjudicated', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/cevrali-chart-billing.png',
    fullPage: true,
  });
  await chart
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await page.getByRole('button', { name: 'Billing', exact: true }).click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: name })
      .getByText('Demo adjudicated', { exact: true }),
  ).toBeVisible();
}
