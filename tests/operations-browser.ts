import { expect, type Page, type Locator } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
export async function exerciseOperations(page: Page) {
  page.setDefaultTimeout(10000);
  const name = 'OpsEfficiency Patient';
  async function pick(select: Locator, pattern: RegExp) {
    const option = select.getByRole('option').filter({ hasText: pattern });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute('value'))!);
  }
  async function chart() {
    await page.getByRole('button', { name: 'Patients', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Filter patient directory', exact: true })
      .fill('OpsEfficiency');
    await page
      .getByRole('row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'Open chart', exact: true })
      .click();
    return page.getByRole('dialog', { name: 'Patient chart', exact: true });
  }
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  const registration = page.getByRole('dialog', {
    name: 'Register a patient',
    exact: true,
  });
  for (const [label, value] of [
    ['First name', 'OpsEfficiency'],
    ['Last name', 'Patient'],
    ['Date of birth', '1990-05-06'],
    ['Phone number', '555-0188'],
  ])
    await registration.getByLabel(label, { exact: true }).fill(value);
  await registration
    .getByLabel('Add workers compensation claim during registration', {
      exact: true,
    })
    .check();
  for (const [label, value] of [
    ['Workers comp claim number', 'OPS-BROWSER-01'],
    ['Date of injury', '2020-01-01'],
    ['Employer', 'Synthetic Employer'],
    ['Workers comp carrier', 'Synthetic Ops Carrier'],
  ])
    await registration.getByLabel(label, { exact: true }).fill(value);
  await registration
    .getByRole('combobox', { name: 'Claim acceptance status', exact: true })
    .selectOption('Accepted');
  await registration
    .getByLabel('Accepted body parts', { exact: true })
    .fill('Left shoulder');
  await registration
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  let c = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  await c.getByRole('button', { name: 'Authorizations', exact: true }).click();
  await c
    .getByRole('button', { name: 'New authorization', exact: true })
    .click();
  let d = page.getByRole('dialog', {
    name: 'New prior authorization',
    exact: true,
  });
  await pick(
    d.getByRole('combobox', { name: 'Insurance policy', exact: true }),
    /Synthetic Ops Carrier/,
  );
  await d
    .getByLabel('Service description', { exact: true })
    .fill('Office review and shoulder imaging');
  await d.getByLabel('Procedure codes', { exact: false }).fill('99213, 73221');
  await d.getByLabel('Requested visits', { exact: true }).fill('4');
  await d
    .getByRole('button', { name: 'Save authorization draft', exact: true })
    .click();
  await c
    .getByRole('button', {
      name: 'Simulate authorization submission',
      exact: true,
    })
    .click();
  await c
    .getByRole('button', { name: 'Record demo decision', exact: true })
    .click();
  d = page.getByRole('dialog', {
    name: 'Record demo authorization decision',
    exact: true,
  });
  await d
    .getByLabel('Approval number', { exact: true })
    .fill('OPS-BROWSER-APPROVAL');
  await d
    .getByLabel('Decision note', { exact: true })
    .fill('Synthetic office and radiology approval reviewed');
  await d
    .getByRole('button', { name: 'Save demo decision', exact: true })
    .click();
  for (const [code, category, quantity, unit] of [
    ['99213', 'Office visit', '2', 'Visits'],
    ['73221', 'Radiology', '1', 'Studies'],
  ]) {
    await c
      .getByRole('button', { name: 'Record service allowance', exact: true })
      .click();
    d = page.getByRole('dialog', {
      name: 'Record demo service allowance',
      exact: true,
    });
    await d
      .getByRole('combobox', { name: 'Procedure code', exact: true })
      .selectOption(code);
    await d
      .getByRole('combobox', { name: 'Service category', exact: true })
      .selectOption(category);
    await d
      .getByLabel('Treatment description', { exact: true })
      .fill(category + ' synthetic treatment');
    await d.getByLabel('Approved quantity', { exact: true }).fill(quantity);
    await d
      .getByRole('combobox', { name: 'Counting unit', exact: true })
      .selectOption(unit);
    await d
      .getByLabel('Approval / change note', { exact: true })
      .fill('Synthetic allowance reviewed from demo decision');
    await d
      .getByRole('button', { name: 'Save service allowance', exact: true })
      .click();
    await expect(d).not.toBeVisible();
  }
  await c.getByRole('button', { name: 'Close dialog', exact: true }).click();
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
    /OpsEfficiency Patient/,
  );
  await pick(
    d.getByLabel('Account for this visit', { exact: true }),
    /OPS-BROWSER-01/,
  );
  await d.getByLabel('Time', { exact: true }).fill('02:30');
  await d
    .getByLabel('Reason for visit', { exact: true })
    .fill('Synthetic authorized review');
  await d
    .getByRole('combobox', { name: 'Authorization review', exact: true })
    .selectOption('required');
  await pick(
    d.getByRole('combobox', { name: 'Service approval 1', exact: true }),
    /Office visit.*2 visits remaining/,
  );
  await d.getByLabel('Quantity for visit 1', { exact: true }).fill('1');
  await d
    .getByRole('button', { name: 'Schedule appointment', exact: true })
    .click();
  await expect(d).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Pre-visit readiness', exact: true })
    .click();
  const ready = page.locator('.finance-card').filter({ hasText: name });
  await expect(ready).toContainText('Pre-visit intake not submitted');
  await ready
    .getByRole('button', { name: 'Review visit services', exact: true })
    .click();
  d = page.getByRole('dialog', { name: 'Review visit services', exact: true });
  await expect(d.getByLabel('Procedure code 1', { exact: true })).toHaveValue(
    '99213',
  );
  await d.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.screenshot({ path: '/tmp/cevrali-readiness.png', fullPage: true });
  c = await chart();
  await c.getByRole('button', { name: 'Claim workspace', exact: true }).click();
  await expect(
    c.getByRole('heading', { name: 'Claim OPS-BROWSER-01', exact: true }),
  ).toBeVisible();
  await expect(
    c.getByText('1 visits remaining', { exact: true }),
  ).toBeVisible();
  await expect(
    c.getByText('1 studies remaining', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/cevrali-claim-workspace.png',
    fullPage: true,
  });
  await c.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await row.getByRole('button', { name: 'Check in', exact: false }).click();
  await row.getByRole('button', { name: 'Start visit', exact: false }).click();
  let note = page.getByRole('dialog', {
    name: 'Document encounter',
    exact: true,
  });
  await note
    .getByLabel(
      'I reviewed the claim number and accepted body parts for this visit',
      { exact: true },
    )
    .check();
  await note.getByLabel('Left shoulder', { exact: true }).check();
  await note
    .getByLabel('Injury history and mechanism', { exact: true })
    .fill('Synthetic injury history');
  await note
    .getByLabel('Assessment of relationship to the work injury', {
      exact: true,
    })
    .fill('Provider documented relationship to synthetic work injury');
  await note
    .getByRole('combobox', { name: 'Work status', exact: true })
    .selectOption('Full duty');
  await note
    .locator('.soap-label')
    .filter({ hasText: 'Assessment' })
    .locator('textarea')
    .fill('Provider assessment remains independently documented');
  await note
    .locator('.soap-label')
    .filter({ hasText: 'Plan' })
    .locator('textarea')
    .fill('Provider follow-up plan remains independently documented');
  await note.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(
    note.getByText('All changes saved', { exact: true }),
  ).toBeVisible();
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const lines = [
    'Patient Name: OpsEfficiency Patient',
    'DOB: 1990-05-06',
    'Claim Number: OPS-BROWSER-01',
    'Document Type: Radiology report',
    '',
    'Synthetic MRI report: source text for provider review.',
    'No clinical interpretation generated by the EHR.',
  ];
  const pdf = await PDFDocument.create();
  const p = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, i) =>
    p.drawText(line, { x: 30, y: 760 - i * 20, size: 11, font }),
  );
  const buffer = Buffer.from(await pdf.save());
  await page.getByRole('button', { name: 'Fax inbox', exact: true }).click();
  await page
    .getByRole('button', { name: 'Receive demo fax', exact: true })
    .click();
  d = page.getByRole('dialog', { name: 'Receive a demo fax', exact: true });
  await d
    .getByLabel('Sending facility', { exact: true })
    .fill('Synthetic Ops Imaging');
  await d
    .getByLabel('Facility fax reference', { exact: true })
    .fill('OPS-PDF-01');
  await d
    .getByLabel('Attach received PDF (optional, up to 2 MB)', { exact: true })
    .setInputFiles({
      name: 'synthetic-report.pdf',
      mimeType: 'application/pdf',
      buffer,
    });
  await d
    .getByRole('button', { name: 'Process demo fax', exact: true })
    .click();
  await expect(d).not.toBeVisible();
  const fax = page.locator('.finance-card').filter({ hasText: 'OPS-PDF-01' });
  await expect(fax).toContainText('Saved to chart');
  await expect(fax).toContainText(name);
  await expect(
    page.getByRole('button', { name: /Fax alerts, [1-9]/ }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/cevrali-incoming-fax.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Encounters', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Continue note', exact: true })
    .click();
  note = page.getByRole('dialog', { name: 'Document encounter', exact: true });
  await expect(
    note.getByText('Synthetic MRI report: source text for provider review.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(note.locator('.received-note-results')).toContainText(
    'Pending review',
  );
  await note
    .getByRole('button', { name: 'Review and include report', exact: true })
    .click();
  await expect(
    note
      .locator('.received-note-results')
      .getByText('Included', { exact: true }),
  ).toBeVisible();
  await expect(
    note
      .locator('.soap-label')
      .filter({ hasText: 'Assessment' })
      .locator('textarea'),
  ).toHaveValue('Provider assessment remains independently documented');
  await page.screenshot({
    path: '/tmp/cevrali-received-results-note.png',
    fullPage: true,
  });
  await note.getByRole('button', { name: 'Sign note', exact: true }).click();
  await note
    .getByRole('button', { name: 'Confirm signature', exact: true })
    .click();
  await expect(note).not.toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page
    .getByRole('button', { name: 'Explore the front desk demo', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /Fax alerts, [1-9]/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Fax inbox', exact: true }).click();
  await expect(
    page.locator('.ops-notice').filter({ hasText: name }),
  ).toContainText('Incoming fax saved to patient chart');
  await page
    .locator('.ops-notice')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Acknowledge alert', exact: true })
    .click();
  await expect(
    page.locator('.ops-notice').filter({ hasText: name }),
  ).toHaveCount(0);
  await page
    .locator('.finance-card')
    .filter({ hasText: 'OPS-PDF-01' })
    .getByRole('button', { name: 'View receipt details', exact: true })
    .click();
  d = page.getByRole('dialog', { name: 'Received fax document', exact: true });
  await expect(
    d.getByText('Front desk can track receipt and filing status.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    d.getByText('Synthetic MRI report: source text for provider review.', {
      exact: false,
    }),
  ).toHaveCount(0);
  await d.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    .toBe(true);
}
