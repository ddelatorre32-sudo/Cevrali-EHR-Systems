import { expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

export async function exerciseRfa(page: Page) {
  async function pick(select: Locator, pattern: RegExp) {
    const option = select.getByRole('option').filter({ hasText: pattern });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute('value'))!);
  }
  async function openChart() {
    await page.getByRole('button', { name: 'Patients', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Filter patient directory', exact: true })
      .fill('RfaExample');
    await page
      .getByRole('row')
      .filter({ hasText: 'RfaExample Patient' })
      .getByRole('button', { name: 'Open chart', exact: true })
      .click();
    return page.getByRole('dialog', { name: 'Patient chart', exact: true });
  }
  await page
    .getByRole('button', { name: 'Account setup', exact: true })
    .click();
  await page
    .getByLabel('Preferred fax provider', { exact: true })
    .fill('Demo fax preference');
  await page
    .getByLabel('Practice fax sender number', { exact: true })
    .fill('+14155550123');
  await page
    .getByRole('button', { name: 'Save practice details', exact: true })
    .click();
  await expect(
    page.getByText('Practice details saved', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  const registration = page.getByRole('dialog', {
    name: 'Register a patient',
    exact: true,
  });
  await registration
    .getByLabel('First name', { exact: true })
    .fill('RfaExample');
  await registration.getByLabel('Last name', { exact: true }).fill('Patient');
  await registration
    .getByLabel('Date of birth', { exact: true })
    .fill('1990-01-01');
  await registration
    .getByLabel('Phone number', { exact: true })
    .fill('555-0100');
  await registration
    .getByLabel('Add workers compensation claim during registration', {
      exact: true,
    })
    .check();
  await registration
    .getByLabel('Workers comp claim number', { exact: true })
    .fill('DEMO-RFA-02');
  await registration
    .getByLabel('Date of injury', { exact: true })
    .fill('2020-01-02');
  await registration
    .getByLabel('Employer', { exact: true })
    .fill('Synthetic Employer');
  await registration
    .getByLabel('Workers comp carrier', { exact: true })
    .fill('Synthetic RFA Administrator');
  await registration
    .getByRole('combobox', { name: 'Claim acceptance status', exact: true })
    .selectOption('Accepted');
  await registration
    .getByLabel('Accepted body parts', { exact: true })
    .fill('Left shoulder');
  await registration
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  const chart = page.getByRole('dialog', {
    name: 'Patient chart',
    exact: true,
  });
  await chart
    .getByRole('button', { name: 'New encounter', exact: true })
    .click();
  const start = page.getByRole('dialog', {
    name: 'Start an encounter',
    exact: true,
  });
  await pick(
    start.getByRole('combobox', {
      name: 'Account for this visit',
      exact: true,
    }),
    /DEMO-RFA-02/,
  );
  await start
    .getByLabel('Chief complaint', { exact: true })
    .fill('Synthetic shoulder follow-up and treatment request');
  await start
    .getByRole('button', { name: 'Create encounter', exact: true })
    .click();
  const note = page.getByRole('dialog', {
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
    .fill('Synthetic lifting injury at work.');
  await note
    .getByLabel('Assessment of relationship to the work injury', {
      exact: true,
    })
    .fill(
      'Clinician reviewed the relation of shoulder symptoms to the work event.',
    );
  await note
    .getByRole('combobox', { name: 'Work status', exact: true })
    .selectOption('Modified duty');
  await note
    .getByLabel('Work restrictions and duration', { exact: true })
    .fill('No overhead lifting for seven days.');
  await note
    .locator('.soap-label')
    .filter({ hasText: 'Assessment' })
    .locator('textarea')
    .fill('Synthetic left shoulder injury requiring further evaluation.');
  await note
    .locator('.soap-label')
    .filter({ hasText: 'Plan' })
    .locator('textarea')
    .fill(
      'Request follow-up office visits, acupuncture, and shoulder MRI; rationale reviewed by clinician.',
    );
  await note.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(
    note.getByText('All changes saved', { exact: true }),
  ).toBeVisible();
  await note.getByRole('button', { name: 'Cancel', exact: true }).click();
  const c = await openChart();
  await c.getByRole('button', { name: 'Authorizations', exact: true }).click();
  await c
    .getByRole('button', { name: 'New authorization', exact: true })
    .click();
  const authorization = page.getByRole('dialog', {
    name: 'New prior authorization',
    exact: true,
  });
  await pick(
    authorization.getByRole('combobox', {
      name: 'Insurance policy',
      exact: true,
    }),
    /DEMO-RFA-02/,
  );
  await authorization
    .getByLabel('Service description', { exact: true })
    .fill('Office visits, acupuncture and shoulder MRI');
  await authorization
    .getByLabel('Procedure codes', { exact: false })
    .fill('99213, 97810, 73221');
  await authorization.getByLabel('Requested visits', { exact: true }).fill('6');
  await pick(
    authorization.getByRole('combobox', {
      name: 'Supporting workers’ comp encounter',
      exact: true,
    }),
    /Draft/,
  );
  await authorization
    .getByRole('button', { name: 'Save authorization draft', exact: true })
    .click();
  await expect(authorization).not.toBeVisible();
  await expect(
    c.getByText(
      'A linked supporting note must be signed before the form autofills.',
      { exact: false },
    ),
  ).toBeVisible();
  await c.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Encounters', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'RfaExample Patient' })
    .getByRole('button', { name: 'Continue note', exact: true })
    .click();
  await note.getByRole('button', { name: 'Sign note', exact: true }).click();
  await note
    .getByRole('button', { name: 'Confirm signature', exact: true })
    .click();
  await expect(note).not.toBeVisible();
  const ready = await openChart();
  await ready
    .getByRole('button', { name: 'Authorizations', exact: true })
    .click();
  await ready
    .getByRole('button', { name: 'Review RFA packet', exact: true })
    .click();
  const rfa = page.getByRole('dialog', {
    name: 'California DWC request for authorization',
    exact: true,
  });
  await expect(rfa).toContainText('DEMO-RFA-02');
  await expect(
    rfa.getByLabel('Physician Fax number', { exact: true }),
  ).toHaveValue('+14155550123');
  await expect(
    rfa.getByLabel('Treating physician NPI', { exact: false }),
  ).toHaveValue('');
  for (const [label, value] of [
    ['Physician Contact name', 'Synthetic Coordinator'],
    ['Physician Street address', '100 Synthetic Street'],
    ['Physician City', 'Sacramento'],
    ['Physician State', 'CA'],
    ['Physician ZIP code', '95814'],
    ['Physician Phone', '555-0100'],
    ['Treating physician NPI', '1234567890'],
    ['Administrator Contact name', 'Synthetic Adjuster'],
    ['Administrator Street address', '200 Synthetic Avenue'],
    ['Administrator City', 'Sacramento'],
    ['Administrator State', 'CA'],
    ['Administrator ZIP code', '95814'],
    ['Administrator Phone', '555-0200'],
    ['Administrator Fax number', '+14155550234'],
    ['Administrator Email', 'adjuster@example.test'],
  ])
    await rfa.getByRole('textbox', { name: label, exact: true }).fill(value);
  for (let i = 1; i <= 3; i++) {
    await rfa
      .getByRole('combobox', { name: `Service category ${i}`, exact: true })
      .selectOption(['Office visit', 'Acupuncture', 'Radiology'][i - 1]);
    await rfa
      .getByLabel(`Diagnosis ${i}`, { exact: true })
      .fill('Left shoulder injury');
    await rfa
      .getByLabel(`ICD-10-CM code ${i}`, { exact: true })
      .fill('S43.402A');
    await rfa
      .getByLabel(`Specific service requested ${i}`, { exact: true })
      .fill(
        [
          'Follow-up office visit',
          'Acupuncture treatment',
          'MRI of left shoulder',
        ][i - 1],
      );
    await rfa
      .getByLabel(`Frequency ${i}`, { exact: true })
      .fill('Two times weekly');
    await rfa.getByLabel(`Duration ${i}`, { exact: true }).fill('Three weeks');
  }
  await rfa
    .getByLabel('Physician signature name', { exact: true })
    .fill('Dr. Alex Morgan');
  await rfa
    .getByLabel(
      'I reviewed the treatment request, supporting documentation and designated claims administrator recipient, and I electronically sign this RFA.',
      { exact: true },
    )
    .check();
  await rfa
    .getByRole('button', { name: 'Review and sign RFA', exact: true })
    .click();
  await expect(
    rfa.getByText('Provider signed RFA. It has not been faxed.', {
      exact: true,
    }),
  ).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await rfa
    .getByRole('button', { name: 'Download reviewed RFA PDF', exact: true })
    .click();
  const download = await downloaded;
  const path = '/tmp/cevrali-rfa-browser-reviewed.pdf';
  await download.saveAs(path);
  const pdf = await PDFDocument.load(readFileSync(path));
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(4);
  expect(pdf.getForm().getFields()).toHaveLength(0);
  await page.screenshot({
    path: '/tmp/cevrali-rfa-review.png',
    fullPage: true,
  });
  await rfa.getByRole('button', { name: 'Close RFA', exact: true }).click();
  await ready
    .getByLabel(
      'I verified this claims administrator and fax number for the claim',
      { exact: true },
    )
    .check();
  await ready
    .getByRole('button', { name: 'Queue demo fax', exact: true })
    .click();
  await expect(
    ready.getByText('Demo queued', { exact: true }).first(),
  ).toBeVisible();
  await ready
    .getByRole('button', { name: 'Simulate fax failure', exact: true })
    .click();
  await expect(
    ready.getByText('Demo failed', { exact: true }).first(),
  ).toBeVisible();
  await ready
    .getByRole('button', { name: 'Retry demo fax', exact: true })
    .click();
  await expect(ready.getByText(/Attempt 2/)).toBeVisible();
  await ready
    .getByRole('button', { name: 'Simulate fax delivery', exact: true })
    .click();
  await expect(
    ready.getByText('Demo delivery simulated', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    ready.getByRole('button', { name: 'Record demo decision', exact: true }),
  ).toBeVisible();
  await expect(ready.locator('.finance-card-header .badge')).toHaveText(
    'Demo submitted',
  );
  await page.screenshot({
    path: '/tmp/cevrali-rfa-fax-outbox.png',
    fullPage: true,
  });
  if (/^https?:/.test(page.url())) {
    const rows = await (
      await page.request.get('/api/workflow/finance/rfa')
    ).json();
    const p = rows.find((p: any) => p.claim_number === 'DEMO-RFA-02');
    expect((await page.request.get(`/api/rfa/${p.id}/pdf`)).status()).toBe(200);
  }
}
