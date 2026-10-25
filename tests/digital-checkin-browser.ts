import { expect, type Page, type Locator } from '@playwright/test';

// A complete, UI-only registration journey, also used with all HTTP requests blocked.
export const insuranceCardPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=',
  'base64',
);
export const registrationRegion = (page: Page) => page.getByRole('region', {
  name: 'Digital check-in', exact: true,
});

async function viewInsuranceCard(page: Page, source: Locator) {
  await source.getByRole('button', { name: 'View front insurance card', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Front insurance card', exact: true });
  const image = preview.getByRole('img', { name: 'Front of insurance card', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
  await preview.getByRole('button', { name: 'Close card preview', exact: true }).click();
  await expect(preview).not.toBeVisible();
}

export async function completePatientRegistration(page: Page, signerName: string, options: {
  upload?: boolean;
  beforeSubmit?: () => Promise<void>;
} = {}) {
  const registration = registrationRegion(page);
  await expect(registration.getByRole('button', { name: 'Save contact details', exact: true })).toBeVisible();
  for (const [label, value] of [
    ['Phone number', '555-0188'], ['Email address', 'synthetic-checkin@example.test'],
    ['Street address', '210 Synthetic Avenue'], ['Unit / APT number', 'APT 4'],
    ['City', 'Boston'], ['ZIP code', '02108-1234'],
  ]) await registration.getByLabel(label, { exact: true }).fill(value);
  await registration.getByRole('combobox', { name: 'State', exact: true }).selectOption('MA');
  await registration.getByRole('button', { name: 'Save contact details', exact: true }).click();
  await expect(registration.getByText('Contact details saved.', { exact: true })).toBeVisible();
  if (options.upload !== false) {
    await registration.getByLabel('Front of insurance card', { exact: true }).setInputFiles({
      name: 'synthetic-insurance-front.png', mimeType: 'image/png', buffer: insuranceCardPng,
    });
    await expect(registration.getByText('Front of insurance card uploaded.', { exact: true })).toBeVisible();
    await expect(registration.getByRole('button', { name: 'Download front insurance card', exact: true })).toBeVisible();
    await viewInsuranceCard(page, registration);
  } else {
    await registration.getByLabel('If you do not have a card, tell the front desk why', { exact: true })
      .fill('I will bring my synthetic card to the visit.');
  }
  const forms = registration.locator('.checkin-consent');
  const formCount = await forms.count();
  expect(formCount).toBeGreaterThan(0);
  for (let index = 0; index < formCount; index++) {
    const consent = forms.nth(index);
    await expect(consent.locator('.checkin-consent-text')).toBeVisible();
    await consent.getByLabel('Full name for electronic signature', { exact: true }).fill(signerName);
    await consent.getByRole('combobox', { name: 'Signing as', exact: true }).selectOption('Patient');
    await consent.getByRole('checkbox', { name: 'I have read this form and agree to sign it electronically using the name entered above.', exact: true }).check();
    await consent.getByRole('button', { name: 'Sign this form', exact: true }).click();
    await expect(consent.getByText(`Signed by ${signerName}`, { exact: true })).toBeVisible();
  }
  await options.beforeSubmit?.();
  await registration.getByRole('button', { name: 'Submit registration', exact: true }).click();
}

export async function exerciseDigitalCheckIn(page: Page) {
  page.setDefaultTimeout(12000);
  const firstName = `Checkin${Date.now()}`;
  const patientName = `${firstName} Synthetic`;
  const visitDate = '2036-04-01';
  const nav = (name: string) => page.getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true });
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signout.or(page.getByRole('button', { name: 'Open clinician demo', exact: true }))).toBeVisible();
  if (!(await signout.isVisible())) await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();

  await nav('Schedule').click();
  await page.getByRole('button', { name: 'Register & schedule', exact: true }).click();
  const patientForm = page.getByRole('dialog', { name: 'Register a patient', exact: true });
  for (const [label, value] of [
    ['First name', firstName], ['Last name', 'Synthetic'], ['Date of birth', '1991-03-04'], ['Phone number', '555-0101'],
  ]) await patientForm.getByLabel(label, { exact: true }).fill(value);
  await patientForm.getByRole('button', { name: 'Register and continue scheduling', exact: true }).click();
  await expect(patientForm).not.toBeVisible();
  const appointment = page.getByRole('dialog', { name: 'Schedule an appointment', exact: true });
  await appointment.getByLabel('Date', { exact: true }).fill(visitDate);
  await appointment.getByLabel('Time', { exact: true }).fill('11:30');
  await appointment.getByLabel('Reason for visit', { exact: true }).fill('Synthetic electronic registration visit');
  await appointment.getByRole('button', { name: 'Schedule appointment', exact: true }).click();
  await expect(appointment).not.toBeVisible();

  await nav('Patient queue').click();
  await page.getByLabel('Queue date', { exact: true }).fill(visitDate);
  const queueCard = page.locator('.queue-card').filter({ hasText: patientName });
  await queueCard.getByRole('button', { name: 'Create intake link', exact: true }).click();
  await page.getByRole('dialog', { name: 'Patient intake link', exact: true })
    .getByRole('button', { name: 'Open patient view', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Hello, ${firstName}.`, exact: true })).toBeVisible();
  const token = await page.evaluate(() => location.hash.slice('#intake/'.length));
  await completePatientRegistration(page, patientName);
  await expect(registrationRegion(page).getByText('Your registration has been submitted for front-desk review.', { exact: true })).toBeVisible();
  await expect(registrationRegion(page).getByLabel('Phone number', { exact: true })).toBeDisabled();
  // The separate clinical form remains available after administrative submission.
  await expect(page.getByLabel('Main concern', { exact: true })).toBeEnabled();

  await page.evaluate(() => { location.hash = 'patients'; });
  await page.getByLabel('Filter patient directory', { exact: true }).fill(patientName);
  await page.getByRole('row').filter({ hasText: patientName }).getByRole('button', { name: 'Open chart', exact: true }).click();
  let chart = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  await expect(chart.locator('.mini-card').filter({ hasText: 'Patient details' })).toContainText('555-0101');
  await expect(chart.locator('.mini-card').filter({ hasText: 'Patient details' })).not.toContainText('555-0188');
  await chart.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await signout.click();
  await page.getByRole('button', { name: 'Explore the front desk demo', exact: true }).click();
  await nav('Digital check-in').click();
  // The administrative view must work for staff without clinical access.
  const row = page.getByRole('article').filter({ hasText: patientName });
  await expect(row).toContainText('Submitted');
  await row.getByRole('button', { name: 'Review registration', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Registration review', exact: true });
  await expect(review).toContainText(patientName);
  await review.locator('.checkin-consent-record').first().locator('summary').click();
  await expect(review.locator('.checkin-consent-record').first()).toContainText(`Signed by ${patientName}`);
  await expect(review.getByRole('button', { name: 'Download front insurance card', exact: true })).toBeVisible();
  await viewInsuranceCard(page, review);
  await review.getByRole('combobox', { name: 'Contact update decision', exact: true }).selectOption('apply');
  await review.getByRole('textbox', { name: 'Review notes', exact: true }).fill('Front desk confirmed the synthetic registration and contact updates.');
  await review.getByRole('button', { name: 'Complete registration review', exact: true }).click();
  await expect(review).toContainText('Reviewed');
  await review.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await nav('Patients').click();
  await page.getByLabel('Filter patient directory', { exact: true }).fill(patientName);
  await page.getByRole('row').filter({ hasText: patientName }).getByRole('button', { name: 'Insurance & billing', exact: true }).click();
  chart = page.getByRole('dialog', { name: 'Patient record', exact: true });
  await chart.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(chart.locator('.mini-card').filter({ hasText: 'Patient details' })).toContainText('555-0188');
  await chart.getByRole('button', { name: 'Digital check-in', exact: true }).click();
  await expect(chart).toContainText('Reviewed');
  await expect(chart).not.toContainText('Main concern');
  await chart.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await nav('Patient queue').click();
  await page.getByLabel('Queue date', { exact: true }).fill(visitDate);
  // Remote paperwork completion never records physical arrival.
  await expect(queueCard.getByRole('button', { name: 'Check in', exact: true })).toBeVisible();
  return { firstName, patientName, token, visitDate };
}
