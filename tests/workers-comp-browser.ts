import { expect, type Page, type Locator } from '@playwright/test';

export async function exerciseWorkersComp(page: Page) {
  const name = 'WorkCase Example';
  async function pick(select: Locator, pattern: RegExp) {
    const option = select.getByRole('option').filter({ hasText: pattern });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute('value'))!);
  }
  async function soap(note: Locator) {
    await note
      .locator('.soap-label')
      .filter({ hasText: 'Assessment' })
      .locator('textarea')
      .fill('Synthetic clinical assessment, reviewed by clinician');
    await note
      .locator('.soap-label')
      .filter({ hasText: 'Plan' })
      .locator('textarea')
      .fill('Reviewed treatment plan with follow-up');
  }
  async function sign(note: Locator) {
    await note.getByRole('button', { name: 'Sign note', exact: true }).click();
    await note
      .getByRole('button', { name: 'Confirm signature', exact: true })
      .click();
  }
  async function chart() {
    await page.getByRole('button', { name: 'Patients', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Filter patient directory', exact: true })
      .fill('WorkCase');
    await page
      .getByRole('row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'Open chart', exact: true })
      .click();
    return page.getByRole('dialog', { name: 'Patient chart', exact: true });
  }
  async function charges(bill: Locator, diagnosis = 'S43.402A') {
    await bill.getByLabel('Procedure code 1', { exact: true }).fill('99213');
    await bill.getByLabel('Diagnosis code 1', { exact: true }).fill(diagnosis);
    await bill
      .getByLabel('Charge description 1', { exact: true })
      .fill('Staff-reviewed visit');
    await bill.getByLabel('Unit fee 1', { exact: true }).fill('150');
  }
  async function newBill(c: Locator) {
    await c.getByRole('button', { name: 'Billing', exact: true }).click();
    await c
      .getByRole('button', { name: 'New charge sheet', exact: true })
      .click();
    const d = page.getByRole('dialog', {
      name: 'Create visit charge sheet',
      exact: true,
    });
    await d
      .getByRole('combobox', { name: 'Encounter', exact: true })
      .selectOption({ index: 1 });
    await d
      .getByRole('button', { name: 'Create charge sheet', exact: true })
      .click();
    return page.getByRole('dialog', { name: 'Visit billing', exact: true });
  }
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  const registration = page.getByRole('dialog', {
    name: 'Register a patient',
    exact: true,
  });
  await registration.getByLabel('First name', { exact: true }).fill('WorkCase');
  await registration.getByLabel('Last name', { exact: true }).fill('Example');
  await registration
    .getByLabel('Date of birth', { exact: true })
    .fill('1990-01-01');
  await registration
    .getByLabel('Phone number', { exact: true })
    .fill('555-0111');
  await registration
    .getByLabel('Add insurance during registration', { exact: true })
    .check();
  await registration
    .getByLabel('Payer name', { exact: true })
    .fill('Synthetic Private Plan');
  await registration
    .getByLabel('Plan name', { exact: true })
    .fill('Personal PPO');
  await registration
    .getByLabel('Member ID', { exact: true })
    .fill('PRIVATE-TEST');
  await registration
    .getByLabel('Run a demo coverage check now', { exact: true })
    .check();
  await registration
    .getByLabel('Add workers compensation claim during registration', {
      exact: true,
    })
    .check();
  await registration
    .getByLabel('Claim account name', { exact: true })
    .fill('Work injury · Left shoulder');
  await registration
    .getByLabel('Workers comp claim number', { exact: true })
    .fill('DEMO-WC-01');
  await registration
    .getByLabel('Date of injury', { exact: true })
    .fill('2020-01-02');
  await registration
    .getByLabel('Employer', { exact: true })
    .fill('Synthetic Employer');
  await registration
    .getByLabel('Workers comp carrier', { exact: true })
    .fill('Synthetic Work Carrier');
  await registration
    .getByRole('combobox', { name: 'Claim acceptance status', exact: true })
    .selectOption('Accepted');
  await registration
    .getByLabel('Accepted body parts', { exact: true })
    .fill('Left shoulder\nLeft wrist');
  await registration
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  const c = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  await expect(
    c.getByRole('heading', { name: 'Patient billing accounts', exact: true }),
  ).toBeVisible();
  await expect(c.locator('.patient-billing-account')).toHaveCount(2);
  await expect(
    c.getByText('DEMO-WC-01 · Synthetic Work Carrier', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/cevrali-workers-comp-accounts.png',
    fullPage: true,
  });
  await c.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page
    .getByRole('button', { name: 'New appointment', exact: true })
    .click();
  const schedule = page.getByRole('dialog', {
    name: 'Schedule an appointment',
    exact: true,
  });
  await pick(
    schedule.getByRole('combobox', { name: 'Patient', exact: true }),
    /WorkCase Example/,
  );
  await pick(
    schedule.getByRole('combobox', {
      name: 'Account for this visit',
      exact: true,
    }),
    /DEMO-WC-01/,
  );
  await schedule.getByLabel('Time', { exact: true }).fill('20:00');
  await schedule
    .getByLabel('Reason for visit', { exact: true })
    .fill('Work injury follow-up');
  await schedule
    .getByRole('button', { name: 'Schedule appointment', exact: true })
    .click();
  await expect(schedule).not.toBeVisible();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('Work injury · Left shoulder');
  for (const pattern of [/Private insurance/, /DEMO-WC-01/]) {
    await row
      .getByRole('button', { name: 'Visit insurance', exact: true })
      .click();
    const visit = page.getByRole('dialog', {
      name: 'Insurance for this visit',
      exact: true,
    });
    await pick(
      visit.getByRole('combobox', {
        name: 'Account for this visit',
        exact: true,
      }),
      pattern,
    );
    await visit
      .getByRole('button', { name: 'Save visit insurance', exact: true })
      .click();
    await expect(visit).not.toBeVisible();
  }
  await row.getByRole('button', { name: 'Check in', exact: true }).click();
  await row.getByRole('button', { name: 'Start visit', exact: true }).click();
  const note = page.getByRole('dialog', {
    name: 'Document encounter',
    exact: true,
  });
  await expect(
    note.getByRole('heading', {
      name: 'Workers compensation documentation',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    note.getByRole('combobox', { name: 'Account for this visit', exact: true }),
  ).toHaveValue(/pba-/);
  await soap(note);
  await sign(note);
  await expect(note.getByRole('alert')).toContainText('Review the claim');
  await note
    .getByLabel(
      'I reviewed the claim number and accepted body parts for this visit',
      { exact: true },
    )
    .check();
  await note.getByLabel('Left shoulder', { exact: true }).check();
  await note
    .getByLabel('Injury history and mechanism', { exact: true })
    .fill('Synthetic shoulder injury while lifting at work.');
  await note
    .getByLabel('Assessment of relationship to the work injury', {
      exact: true,
    })
    .fill(
      'Clinical assessment relates the documented shoulder symptoms to the reported work event.',
    );
  await note
    .getByRole('combobox', { name: 'Work status', exact: true })
    .selectOption('Modified duty');
  await note
    .getByLabel('Work restrictions and duration', { exact: true })
    .fill('No overhead lifting with the left arm for seven days.');
  await page.screenshot({
    path: '/tmp/cevrali-workers-comp-note.png',
    fullPage: true,
  });
  await sign(note);
  await expect(note).not.toBeVisible();
  const workerChart = await chart();
  await workerChart
    .getByRole('button', { name: 'Encounters', exact: true })
    .click();
  await expect(
    workerChart.getByText('Claim DEMO-WC-01', { exact: true }),
  ).toBeVisible();
  await expect(
    workerChart.getByRole('textbox', {
      name: 'Work restrictions and duration',
      exact: true,
    }),
  ).toHaveValue('No overhead lifting with the left arm for seven days.');
  await workerChart
    .getByRole('button', { name: 'Insurance', exact: true })
    .click();
  const wcPolicy = workerChart
    .locator('.finance-card')
    .filter({ hasText: 'Synthetic Work Carrier' });
  await wcPolicy
    .getByRole('button', { name: 'Check coverage', exact: true })
    .click();
  const verify = page.getByRole('dialog', {
    name: 'Run demo coverage check',
    exact: true,
  });
  await expect(verify).toContainText(
    'No copay, deductible, or coinsurance is applied',
  );
  await verify
    .getByRole('button', { name: 'Run demo check', exact: true })
    .click();
  await expect(verify).not.toBeVisible();
  await expect(wcPolicy).not.toContainText('Copay');
  const billing = await newBill(workerChart);
  await expect(billing.locator('.visit-account-banner')).toContainText(
    'DEMO-WC-01',
  );
  const policy = billing.getByRole('combobox', {
    name: 'Insurance policy',
    exact: true,
  });
  await expect(policy.getByRole('option')).toHaveCount(2);
  await expect(policy.getByRole('option').last()).toContainText(
    'Synthetic Work Carrier',
  );
  await charges(billing);
  await billing
    .getByRole('button', { name: 'Prepare demo claim', exact: true })
    .click();
  await expect(
    billing.getByText('Demo claim prepared. Charges are locked.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/cevrali-workers-comp-billing.png',
    fullPage: true,
  });
  await billing
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await workerChart
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
    /Private insurance/,
  );
  await start
    .getByLabel('Chief complaint', { exact: true })
    .fill('Unrelated personal-care follow-up');
  await start
    .getByRole('button', { name: 'Create encounter', exact: true })
    .click();
  const privateNote = page.getByRole('dialog', {
    name: 'Document encounter',
    exact: true,
  });
  await expect(
    privateNote.getByRole('heading', {
      name: 'Workers compensation documentation',
      exact: true,
    }),
  ).toHaveCount(0);
  await soap(privateNote);
  await sign(privateNote);
  await expect(privateNote).not.toBeVisible();
  const personalChart = await chart();
  const privateBilling = await newBill(personalChart);
  const personalPolicy = privateBilling.getByRole('combobox', {
    name: 'Insurance policy',
    exact: true,
  });
  await expect(personalPolicy.getByRole('option')).toHaveCount(2);
  await expect(personalPolicy.getByRole('option').last()).toContainText(
    'Synthetic Private Plan',
  );
  await personalPolicy.selectOption({ index: 1 });
  await charges(privateBilling, 'I10');
  await privateBilling
    .getByRole('button', { name: 'Prepare demo claim', exact: true })
    .click();
  await expect(
    privateBilling.getByText('Demo claim prepared. Charges are locked.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(privateBilling.locator('.visit-account-banner')).toContainText(
    'Private insurance / personal care',
  );
}
