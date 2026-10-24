import { expect, type Page } from '@playwright/test';

export async function exerciseRevenue(page: Page) {
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  const registration = page.getByRole('dialog', {
    name: 'Register a patient',
    exact: true,
  });
  await registration.getByLabel('First name', { exact: true }).fill('Revenue');
  await registration.getByLabel('Last name', { exact: true }).fill('Workflow');
  await registration
    .getByLabel('Date of birth', { exact: true })
    .fill('1992-03-04');
  await registration
    .getByLabel('Phone number', { exact: true })
    .fill('555-0177');
  await expect(
    registration.getByRole('checkbox', {
      name: 'Open patient record after registration',
      exact: true,
    }),
  ).toBeChecked();
  await registration
    .getByRole('checkbox', {
      name: 'Add insurance during registration',
      exact: true,
    })
    .check();
  await registration
    .getByLabel('Payer name', { exact: true })
    .fill('Revenue Demo Payer');
  await registration
    .getByLabel('Plan name', { exact: true })
    .fill('Revenue PPO');
  await registration
    .getByLabel('Member ID', { exact: true })
    .fill('REVENUE-DEMO');
  await registration
    .getByRole('checkbox', {
      name: 'Run a demo coverage check now',
      exact: true,
    })
    .check();
  await registration
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  const chart = page.getByRole('dialog', {
    name: 'Patient chart',
    exact: true,
  });
  await expect(chart).toBeVisible();
  await chart
    .getByRole('button', { name: 'Authorizations', exact: true })
    .click();
  await chart
    .getByRole('button', { name: 'New authorization', exact: true })
    .click();
  const auth = page.getByRole('dialog', {
    name: 'New prior authorization',
    exact: true,
  });
  const policy = auth.getByRole('combobox', {
    name: 'Insurance policy',
    exact: true,
  });
  await expect(policy.getByRole('option')).toHaveCount(2);
  await policy.selectOption({ index: 1 });
  await auth
    .getByLabel('Service description', { exact: true })
    .fill('Authorized office visit');
  await auth.getByLabel('Procedure codes', { exact: false }).fill('99213');
  await auth.getByLabel('Requested visits', { exact: true }).fill('1');
  await auth
    .getByRole('button', { name: 'Save authorization draft', exact: true })
    .click();
  await expect(auth).not.toBeVisible();
  await chart
    .getByRole('button', {
      name: 'Simulate authorization submission',
      exact: true,
    })
    .click();
  await chart
    .getByRole('button', { name: 'Record demo decision', exact: true })
    .click();
  const decision = page.getByRole('dialog', {
    name: 'Record demo authorization decision',
    exact: true,
  });
  await decision
    .getByLabel('Approval number', { exact: true })
    .fill('DEMO-AUTH-REVENUE');
  await decision
    .getByLabel('Decision note', { exact: true })
    .fill('Demo approval reviewed for office visit');
  await decision
    .getByRole('button', { name: 'Save demo decision', exact: true })
    .click();
  await expect(decision).not.toBeVisible();
  await expect(
    chart.getByText('0 reserved / 1 approved · 1 remaining', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/cevrali-authorizations.png',
    fullPage: true,
  });
  await chart
    .getByRole('button', { name: 'New encounter', exact: true })
    .click();
  const start = page.getByRole('dialog', {
    name: 'Start an encounter',
    exact: true,
  });
  await start
    .getByLabel('Chief complaint', { exact: true })
    .fill('Synthetic authorized visit');
  await start
    .getByRole('button', { name: 'Create encounter', exact: true })
    .click();
  const note = page.getByRole('dialog', {
    name: 'Document encounter',
    exact: true,
  });
  await note
    .getByLabel('Subjective', { exact: false })
    .fill('Synthetic visit for authorization workflow.');
  await note
    .getByLabel('Assessment', { exact: false })
    .fill('Staff-reviewed synthetic condition');
  await note
    .getByLabel('Plan', { exact: false })
    .fill('Follow-up as documented.');
  await note.getByRole('button', { name: 'Sign note', exact: true }).click();
  await note
    .getByRole('button', { name: 'Confirm signature', exact: true })
    .click();
  await expect(note).not.toBeVisible();
  await page.getByRole('button', { name: 'Patients', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Filter patient directory', exact: true })
    .fill('Revenue Workflow');
  await page.getByRole('button', { name: 'Open chart', exact: true }).click();
  await chart.getByRole('button', { name: 'Billing', exact: true }).click();
  await chart
    .getByRole('button', { name: 'New charge sheet', exact: true })
    .click();
  const newBill = page.getByRole('dialog', {
    name: 'Create visit charge sheet',
    exact: true,
  });
  await expect(
    newBill
      .getByRole('combobox', { name: 'Encounter', exact: true })
      .getByRole('option'),
  ).toHaveCount(2);
  await newBill
    .getByRole('combobox', { name: 'Encounter', exact: true })
    .selectOption({ index: 1 });
  await newBill
    .getByRole('button', { name: 'Create charge sheet', exact: true })
    .click();
  const bill = page.getByRole('dialog', { name: 'Visit billing', exact: true });
  const billPolicy = bill.getByRole('combobox', {
    name: 'Insurance policy',
    exact: true,
  });
  await expect(billPolicy.getByRole('option')).toHaveCount(2);
  await billPolicy.selectOption({ index: 1 });
  await bill
    .getByRole('textbox', { name: 'Procedure code 1', exact: true })
    .fill('99213');
  await bill
    .getByRole('textbox', { name: 'Diagnosis code 1', exact: true })
    .fill('I10');
  await bill
    .getByRole('textbox', { name: 'Charge description 1', exact: true })
    .fill('Reviewed office visit');
  await bill
    .getByRole('spinbutton', { name: 'Unit fee 1', exact: true })
    .fill('120');
  await bill
    .getByRole('checkbox', {
      name: 'Prior authorization required for these services',
      exact: true,
    })
    .check();
  const approved = bill.getByRole('combobox', {
    name: 'Approved authorization',
    exact: true,
  });
  await expect(approved.getByRole('option')).toHaveCount(2);
  await approved.selectOption({ index: 1 });
  await bill
    .getByRole('button', { name: 'Prepare demo claim', exact: true })
    .click();
  await expect(bill.locator('.finance-editor > .inline-success')).toContainText('Demo claim prepared');
  await bill
    .getByRole('button', { name: 'Close billing', exact: true })
    .click();
  await chart
    .getByRole('button', { name: 'Authorizations', exact: true })
    .click();
  await expect(
    chart.getByText('1 reserved / 1 approved · 0 remaining', { exact: true }),
  ).toBeVisible();
  await chart.getByRole('button', { name: 'Billing', exact: true }).click();
  await chart
    .getByRole('button', { name: 'Manage billing', exact: true })
    .click();
  await bill
    .getByRole('button', { name: 'Simulate submission', exact: true })
    .click();
  async function remit(
    reference: string,
    payer: string,
    adjustment: string,
    patient: string,
  ) {
    await bill
      .getByRole('button', { name: 'Record demo payer response', exact: true })
      .click();
    await bill
      .getByLabel('Response reference', { exact: true })
      .fill(reference);
    await bill
      .getByRole('spinbutton', { name: 'Insurer payment ($)', exact: true })
      .fill(payer);
    await bill
      .getByRole('spinbutton', {
        name: 'Contractual adjustment ($)',
        exact: true,
      })
      .fill(adjustment);
    await bill
      .getByRole('spinbutton', {
        name: 'Patient responsibility ($)',
        exact: true,
      })
      .fill(patient);
    await bill
      .getByRole('button', { name: 'Post demo response', exact: true })
      .click();
    await expect(bill.locator('.finance-editor > .inline-success')).toContainText(
      'Demo response recorded',
    );
  }
  await remit('REVENUE-ORIGINAL', '80', '20', '20');
  await bill
    .getByRole('button', { name: 'Record patient payment', exact: true })
    .click();
  await bill
    .getByRole('spinbutton', { name: 'Payment amount ($)', exact: true })
    .fill('20');
  await bill
    .getByLabel('Payment reference', { exact: true })
    .fill('REVENUE-RECEIPT');
  await bill
    .getByRole('button', { name: 'Save payment entry', exact: true })
    .click();
  await expect(bill.locator('.finance-editor > .inline-success')).toContainText(
    'No payment was processed',
  );
  await bill
    .getByRole('button', { name: 'Correct claim', exact: true })
    .click();
  await bill
    .getByLabel('Reason for correction', { exact: true })
    .fill('Reviewed fee corrected from 120 to 100 dollars');
  await bill
    .getByRole('spinbutton', { name: 'Corrected fee 1', exact: true })
    .fill('100');
  await bill
    .getByRole('button', { name: 'Prepare correction', exact: true })
    .click();
  await expect(
    bill.locator('.correction-tools').getByRole('status'),
  ).toContainText('Original billing is unchanged');
  await expect(
    bill.locator('.finance-totals').getByText('$120.00', { exact: true }),
  ).toHaveCount(1);
  await bill
    .getByRole('button', {
      name: 'Simulate correction submission',
      exact: true,
    })
    .click();
  await bill
    .getByRole('button', { name: 'Record correction response', exact: true })
    .click();
  await bill
    .getByLabel('Correction response reference', { exact: true })
    .fill('REVENUE-REPLACEMENT');
  await bill
    .getByLabel('Correction response note', { exact: true })
    .fill('Demo replacement accepted after reviewed correction');
  await bill
    .getByRole('button', { name: 'Save correction response', exact: true })
    .click();
  await expect(
    bill.locator('.correction-tools').getByRole('status'),
  ).toContainText('Demo correction response recorded');
  await expect(
    bill.getByRole('spinbutton', { name: 'Unit fee 1', exact: true }),
  ).toHaveValue('100');
  await expect(
    bill.getByText('Unapplied patient payments:', { exact: false }),
  ).toContainText('$20.00');
  await remit('REVENUE-CORRECTED', '70', '20', '10');
  await expect(
    bill.getByText('Credit balance:', { exact: false }),
  ).toContainText('$10.00');
  await page.screenshot({
    path: '/tmp/cevrali-claim-corrections.png',
    fullPage: true,
  });
  await bill
    .getByRole('button', { name: 'Correct claim', exact: true })
    .click();
  await bill
    .getByRole('combobox', { name: 'Correction type', exact: true })
    .selectOption('Void');
  await bill
    .getByLabel('Reason for correction', { exact: true })
    .fill('Demo service charge voided after staff review');
  await bill
    .getByRole('button', { name: 'Prepare correction', exact: true })
    .click();
  await bill
    .getByRole('button', {
      name: 'Simulate correction submission',
      exact: true,
    })
    .click();
  await bill
    .getByRole('button', { name: 'Record correction response', exact: true })
    .click();
  await bill
    .getByLabel('Correction response reference', { exact: true })
    .fill('REVENUE-VOID');
  await bill
    .getByLabel('Correction response note', { exact: true })
    .fill('Demo void accepted and patient credit retained');
  await bill
    .getByRole('button', { name: 'Save correction response', exact: true })
    .click();
  await expect(
    bill
      .locator('.finance-card-header')
      .first()
      .getByText('Demo voided', { exact: true }),
  ).toBeVisible();
  await expect(
    bill.getByText('Credit balance:', { exact: false }),
  ).toContainText('$20.00');
  await expect(
    bill.getByRole('button', { name: 'Correct claim', exact: true }),
  ).toHaveCount(0);
  await bill
    .getByRole('button', { name: 'Close billing', exact: true })
    .click();
  await chart
    .getByRole('button', { name: 'Authorizations', exact: true })
    .click();
  await expect(
    chart.getByText('0 reserved / 1 approved · 1 remaining', { exact: true }),
  ).toBeVisible();
}

export async function exerciseNewPatient(page: Page) {
  async function form() {
    await page
      .getByRole('button', { name: 'New patient', exact: true })
      .click();
    const d = page.getByRole('dialog', {
      name: 'Register a patient',
      exact: true,
    });
    await d.getByLabel('First name', { exact: true }).fill('Creation');
    await d.getByLabel('Last name', { exact: true }).fill('DuplicateReview');
    await d.getByLabel('Date of birth', { exact: true }).fill('1991-02-03');
    await d.getByLabel('Phone number', { exact: true }).fill('555-0166');
    return d;
  }
  const initial = await form();
  await initial
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  const chart = page.getByRole('dialog', {
    name: 'Patient chart',
    exact: true,
  });
  await expect(
    chart.getByRole('heading', {
      name: 'Creation DuplicateReview',
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  await chart
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  const duplicate = await form();
  await duplicate
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  await expect(
    duplicate.getByRole('region', {
      name: 'Possible duplicate patients',
      exact: true,
    }),
  ).toBeVisible();
  await duplicate
    .getByRole('button', { name: 'Open existing patient', exact: true })
    .click();
  await expect(chart).toBeVisible();
  await chart
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  const separate = await form();
  await separate
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  await separate
    .getByRole('checkbox', {
      name: 'I reviewed the matches and need a separate patient record',
      exact: true,
    })
    .check();
  await separate
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  await expect(chart).toBeVisible();
  await chart
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await page.getByRole('button', { name: 'Patients', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Filter patient directory', exact: true })
    .fill('Creation DuplicateReview');
  await expect(
    page.getByRole('row').filter({ hasText: 'Creation DuplicateReview' }),
  ).toHaveCount(2);
}
