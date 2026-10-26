import { expect, type Page } from '@playwright/test';

export const prescriptionReview = (page: Page) => page.getByRole('dialog', {
  name: 'Prescription review', exact: true,
});

/** Populate the structured form with synthetic workflow values, never dosing advice. */
export async function fillPrescriptionForm(page: Page, name: string, controlled = false) {
  const form = page.getByRole('form', { name: 'New prescription draft', exact: true });
  await expect(form).toBeVisible();
  for (const [label, value] of [
    ['Medication name', name], ['Strength', 'Synthetic strength'], ['Dose', 'Synthetic dose'],
    ['Route', 'Synthetic route'], ['Frequency', 'Synthetic frequency'],
    ['Directions for the patient', 'Synthetic workflow example only; this is not a clinical instruction.'],
    ['Quantity unit', 'synthetic units'], ['Pharmacy name', 'Synthetic Demo Pharmacy'],
    ['Pharmacy address', '100 Synthetic Avenue, Boston MA 02108'], ['Pharmacy phone', '555-0109'],
  ]) await form.getByRole('textbox', { name: label, exact: true }).fill(value);
  await form.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('10');
  await form.getByRole('spinbutton', { name: 'Days supply', exact: true }).fill('10');
  await form.getByRole('combobox', { name: 'Controlled-substance schedule', exact: true })
    .selectOption(controlled ? 'II' : 'Non-controlled');
  await form.getByRole('spinbutton', { name: 'Refills', exact: true }).fill('0');
  await form.getByRole('button', { name: 'Save prescription draft', exact: true }).click();
  await expect(prescriptionReview(page)).toContainText(name);
}

export async function recordPrescriptionReview(page: Page, controlled = false) {
  const review = prescriptionReview(page);
  await review.getByRole('checkbox', { name: 'I reviewed the patient’s recorded allergies and allergy status.', exact: true }).check();
  await review.getByRole('checkbox', { name: 'I reviewed recorded medications and considered interactions and dosing using appropriate clinical resources.', exact: true }).check();
  await review.getByRole('checkbox', { name: 'I confirmed the medication, directions, pharmacy, quantity, refills, and controlled-substance classification.', exact: true }).check();
  if (controlled) await review.getByRole('checkbox', { name: /For this demo, I acknowledge that applicable PDMP/ }).check();
  await review.getByRole('textbox', { name: 'Review notes', exact: true })
    .fill('Reviewed the synthetic patient and medication example. No automated interaction or PDMP service was queried.');
  await review.getByRole('button', { name: 'Record prescription review', exact: true }).click();
  await expect(review).toContainText('Ready for demo signing');
}

export async function enterDemoAuthorization(page: Page, password = 'CevraliDemo2026!') {
  const review = prescriptionReview(page);
  await review.getByRole('button', { name: 'Request demo authorization code', exact: true }).click();
  const output = review.locator('output[aria-label="Demo authorization code"]');
  await expect(output).toHaveText(/^\d{6}$/);
  await review.getByLabel('Your Cevrali password', { exact: true }).fill(password);
  await review.getByRole('textbox', { name: 'Authorization code', exact: true }).fill((await output.textContent())!);
}

/** The same UI-only journey runs against the website and with all HTTP blocked. */
export async function exercisePrescribing(page: Page) {
  page.setDefaultTimeout(12000);
  const suffix = String(Date.now());
  const ordinaryName = `Synthetic ordinary medication ${suffix}`;
  const controlledName = `Synthetic controlled medication ${suffix}`;
  const refillName = `Synthetic refill request ${suffix}`;
  const navigate = (name: string) => page.getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true }).click();
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signout.or(page.getByRole('button', { name: 'Open clinician demo', exact: true }))).toBeVisible();
  if (!(await signout.isVisible())) await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  await navigate('Patients');
  await page.getByRole('textbox', { name: 'Filter patient directory', exact: true }).fill('Emma Thompson');
  await page.getByRole('row').filter({ hasText: 'Emma Thompson' })
    .getByRole('button', { name: 'Open chart', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  const recordedBefore = await chart.locator('.mini-card').filter({ hasText: 'Medication history' }).innerText();
  await chart.getByRole('button', { name: 'Medications & prescribing', exact: true }).click();
  await expect(chart.getByRole('complementary', { name: 'Medication safety context', exact: true })).toContainText('Emma Thompson');
  await chart.getByRole('button', { name: 'New prescription', exact: true }).click();
  await fillPrescriptionForm(page, ordinaryName);
  await recordPrescriptionReview(page);
  let review = prescriptionReview(page);
  await review.getByRole('button', { name: 'Authorize demo prescription', exact: true }).click();
  await expect(review).toContainText('Simulated — not sent');
  await expect(review.getByRole('button', { name: 'Edit prescription draft', exact: true })).toHaveCount(0);
  await review.getByText(/^Prescription history \(/).click();
  await expect(review).toContainText('Finalized demo prescription; not transmitted');
  await review.getByRole('button', { name: 'Close review', exact: true }).click();
  await chart.getByRole('button', { name: 'New prescription', exact: true }).click();
  await fillPrescriptionForm(page, controlledName, true);
  await recordPrescriptionReview(page, true);
  await enterDemoAuthorization(page);
  review = prescriptionReview(page);
  await expect(review).toContainText('Demo code — not real two-factor authentication');
  await review.getByRole('button', { name: 'Authorize demo prescription', exact: true }).click();
  await expect(review).toContainText('Simulated — not sent');
  await expect(review).toContainText('Demo password and displayed code');
  await review.getByRole('button', { name: 'Close review', exact: true }).click();
  await expect(chart.getByRole('article', { name: `Prescription: ${ordinaryName}`, exact: true })).toContainText('Simulated — not sent');
  await expect(chart.getByRole('article', { name: `Prescription: ${controlledName}`, exact: true })).toContainText('Simulated — not sent');
  await chart.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect.poll(() => chart.locator('.mini-card').filter({ hasText: 'Medication history' }).innerText()).toBe(recordedBefore);
  await chart.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await signout.click();
  await page.getByRole('button', { name: 'Explore the front desk demo', exact: true }).click();
  await navigate('Prescriptions & refills');
  await expect(page.getByRole('tab', { name: 'Prescription queue', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'New refill request', exact: true }).click();
  await page.getByRole('combobox', { name: 'Refill request patient', exact: true }).selectOption({ label: 'Emma Thompson' });
  await page.getByRole('textbox', { name: 'Requested medication name', exact: true }).fill(refillName);
  await page.getByRole('textbox', { name: 'Patient request details', exact: true }).fill('Synthetic patient-reported request for clinician review.');
  await page.getByRole('button', { name: 'Submit refill request', exact: true }).click();
  await expect(page.getByRole('article', { name: `Refill request: ${refillName}`, exact: true })).toContainText('Requested');
  await signout.click();
  await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  await navigate('Prescriptions & refills');
  await page.getByRole('tab', { name: 'Refill requests', exact: true }).click();
  await page.getByRole('article', { name: `Refill request: ${refillName}`, exact: true })
    .getByRole('button', { name: 'Review refill request', exact: true }).click();
  const requestReview = page.getByRole('form', { name: 'Refill request review', exact: true });
  await requestReview.getByRole('combobox', { name: 'Refill request decision', exact: true }).selectOption('Reviewed');
  await requestReview.getByRole('textbox', { name: 'Refill review notes', exact: true }).fill('Reviewed this synthetic request; no prescription was issued by marking it reviewed.');
  await requestReview.getByRole('button', { name: 'Save refill review', exact: true }).click();
  await expect(page.getByRole('article', { name: `Refill request: ${refillName}`, exact: true })).toContainText('Reviewed');
  return { ordinaryName, controlledName, refillName };
}
