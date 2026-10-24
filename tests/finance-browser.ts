import { expect, type Page } from '@playwright/test';

export async function exerciseFinance(page: Page) {
  await page.getByRole('button', { name: 'Insurance', exact: true }).click();
  await expect(
    page.getByText('Demo eligibility · payer disconnected', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add coverage' }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('combobox', { name: 'Patient', exact: true })
    .selectOption('pat-001');
  await dialog.getByLabel('Payer name').fill('Demo Health Plan');
  await dialog.getByLabel('Plan name').fill('Demo PPO');
  await dialog.getByLabel('Member ID').fill('DEMO-OLIVIA-001');
  await dialog.getByLabel('Group number').fill('DEMO-100');
  await dialog.getByLabel('Subscriber name').fill('Olivia Bennett');
  await dialog.getByLabel('Subscriber date of birth').fill('1985-03-14');
  await dialog.getByRole('button', { name: 'Save coverage' }).click();
  await expect(dialog).not.toBeVisible();
  const coverage = page
    .locator('.finance-card')
    .filter({ hasText: 'Olivia Bennett' });
  await coverage.getByRole('button', { name: 'Check coverage' }).click();
  await dialog.getByRole('button', { name: 'Run demo check' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    coverage.locator('.badge').getByText('Demo Active', { exact: true }),
  ).toBeVisible();
  await expect(coverage.getByText(/Copay \$25.00/)).toBeVisible();
  await page.screenshot({ path: '/tmp/cevrali-insurance.png', fullPage: true });
  await page.getByRole('button', { name: 'Billing', exact: true }).click();
  await page.getByRole('button', { name: 'New charge sheet' }).click();
  await dialog
    .getByRole('combobox', { name: 'Encounter', exact: true })
    .selectOption('enc-001');
  await dialog.getByRole('button', { name: 'Create charge sheet' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Visit billing' }),
  ).toBeVisible();
  const policy = dialog.getByRole('combobox', {
    name: 'Insurance policy',
    exact: true,
  });
  await expect(
    policy.getByRole('option', { name: /Primary · Demo Health Plan/ }),
  ).toHaveCount(1);
  await policy.selectOption({
    label: 'Primary · Demo Health Plan · DEMO-OLIVIA-001',
  });
  await dialog
    .getByRole('textbox', { name: 'Procedure code 1', exact: true })
    .fill('99213');
  await dialog
    .getByRole('textbox', { name: 'Diagnosis code 1', exact: true })
    .fill('I10');
  await dialog
    .getByRole('textbox', { name: 'Charge description 1', exact: true })
    .fill('Office visit — staff reviewed');
  await dialog
    .getByRole('spinbutton', { name: 'Unit fee 1', exact: true })
    .fill('150.00');
  await dialog
    .getByRole('button', { name: 'Prepare demo claim', exact: true })
    .click();
  await expect(dialog.getByRole('status')).toContainText('Demo claim prepared');
  await expect(
    dialog.getByRole('textbox', { name: 'Procedure code 1', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Simulate submission' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'Nothing was transmitted',
  );
  await dialog
    .getByRole('button', { name: 'Record demo payer response' })
    .click();
  await dialog
    .getByRole('textbox', { name: 'Response reference', exact: true })
    .fill('DEMO-REMIT-DENIED');
  await dialog
    .getByRole('combobox', { name: 'Outcome', exact: true })
    .selectOption('Denied');
  await dialog
    .getByLabel('Denial reason')
    .fill('Subscriber details need confirmation');
  await dialog.getByRole('button', { name: 'Post demo response' }).click();
  await expect(dialog.getByText('Demo denied', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Resolve & resubmit demo' }).click();
  await dialog
    .getByRole('textbox', { name: 'Correction / follow-up note', exact: true })
    .fill('Confirmed subscriber details with patient for demo');
  await dialog.getByRole('button', { name: 'Resubmit demo claim' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'Demo claim resubmitted',
  );
  await dialog
    .getByRole('button', { name: 'Record demo payer response' })
    .click();
  await dialog
    .getByRole('textbox', { name: 'Response reference', exact: true })
    .fill('DEMO-REMIT-APPROVED');
  await dialog
    .getByRole('spinbutton', { name: 'Insurer payment ($)', exact: true })
    .fill('100.00');
  await dialog
    .getByRole('spinbutton', {
      name: 'Contractual adjustment ($)',
      exact: true,
    })
    .fill('25.00');
  await dialog
    .getByRole('spinbutton', {
      name: 'Patient responsibility ($)',
      exact: true,
    })
    .fill('25.00');
  await dialog.getByRole('button', { name: 'Post demo response' }).click();
  await expect(
    dialog.getByText('Demo adjudicated', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.locator('.finance-totals').getByText('$25.00', { exact: true }),
  ).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Record patient payment' }).click();
  await dialog
    .getByRole('spinbutton', { name: 'Payment amount ($)', exact: true })
    .fill('25.00');
  await dialog
    .getByRole('textbox', { name: 'Payment reference', exact: true })
    .fill('DEMO-PATIENT-RECEIPT');
  await dialog.getByRole('button', { name: 'Save payment entry' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'No payment was processed',
  );
  await expect(
    dialog.locator('.finance-totals').getByText('$0.00', { exact: true }),
  ).toHaveCount(2);
  await page.screenshot({
    path: '/tmp/cevrali-visit-billing.png',
    fullPage: true,
  });
  page.once('dialog', (d) =>
    d.accept('Correction of manual demo payment entry'),
  );
  await dialog
    .getByRole('button', { name: 'Reverse entry', exact: true })
    .click();
  await expect(dialog.getByRole('status')).toContainText(
    'No refund was issued',
  );
  await expect(
    dialog.getByText('Payment reversal', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close billing' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Olivia Bennett' });
  await expect(
    row.getByRole('cell', { name: '$25.00', exact: true }),
  ).toHaveCount(2);
  await page.screenshot({ path: '/tmp/cevrali-billing.png', fullPage: true });
  // Reload the connected app or remount this view offline to verify persisted state.
  await page.getByRole('button', { name: 'Insurance', exact: true }).click();
  await page.getByRole('button', { name: 'Billing', exact: true }).click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Olivia Bennett' })
      .getByText('Demo adjudicated', { exact: true }),
  ).toBeVisible();
}
