import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  completePatientRegistration, exerciseDigitalCheckIn, registrationRegion,
} from '../digital-checkin-browser';
import type { CheckInPacketView } from '../../server/digital-checkin-model';

async function preparePacket(context: BrowserContext, prefix: string) {
  const signup = await context.request.post('/api/accounts/signup', { data: {
    owner_name: 'Synthetic Registration Owner',
    email: `checkin-${prefix}-${randomUUID()}@example.test`,
    password: 'SyntheticRegistration2026!', clinical_access: true,
    practice: { name: `Synthetic ${prefix} Practice` },
  } });
  expect(signup.status()).toBe(201);
  const owner = await signup.json();
  const patientName = `${prefix} Registration`;
  const created = await context.request.post('/api/patients', { data: {
    first_name: prefix, last_name: 'Registration', dob: '1991-03-04',
    sex: 'Unknown', phone: '555-0101',
  } });
  expect(created.status()).toBe(201);
  const patientId: string = (await created.json()).id;
  const appointment = await context.request.post('/api/appointments', { data: {
    patient_id: patientId, provider_id: owner.id, date: '2037-04-01', time: '10:00',
    duration: 30, type: 'Consultation', reason: 'Synthetic check-in browser validation',
  } });
  expect(appointment.status()).toBe(201);
  const link = await context.request.post('/api/workflow/intake-links', { data: {
    appointment_id: (await appointment.json()).id,
  } });
  expect(link.status()).toBe(200);
  const { token, id } = await link.json();
  const publicPath = `/api/intake-links/${token}/registration`;
  const packet = await context.request.get(publicPath);
  expect(packet.status()).toBe(200);
  return { token: String(token), id: String(id), publicPath, patientId, patientName,
    packet: await packet.json() as CheckInPacketView };
}

async function submittedPacket(context: BrowserContext, prefix: string) {
  const setup = await preparePacket(context, prefix);
  let packet = setup.packet;
  async function save(suffix: string, data: Record<string, unknown>) {
    const response = await context.request.post(setup.publicPath + suffix, { data: {
      revision: packet.revision, ...data,
    } });
    expect(response.status()).toBe(200);
    packet = await response.json();
  }
  await save('', { contact: { phone: '555-0188', email: '', address: '210 Synthetic Avenue',
    address_unit: '', city: 'Boston', state: 'MA', zip_code: '02108' } });
  for (const consent of packet.consents) await save(`/consents/${consent.id}`, {
    signer_name: setup.patientName, signer_role: 'Patient', relationship: '', agree: true,
    client_id: randomUUID(),
  });
  await save('/submit', { client_id: randomUUID(), no_card_reason: 'Will bring synthetic card.' });
  return { ...setup, packet };
}

async function openReview(page: Page, patientName: string) {
  await page.goto('/#digital-checkin');
  const row = page.locator('.checkin-queue-item').filter({ hasText: patientName });
  await row.getByRole('button', { name: 'Review registration', exact: true }).click();
  return page.getByRole('dialog', { name: 'Registration review', exact: true });
}

test('digital registration uploads insurance, records consent, and reaches front-desk review without checking the patient in', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const saved = await exerciseDigitalCheckIn(page);
  const directory = await (await page.request.get('/api/patients')).json();
  const patient = directory.find((row: any) => `${row.first_name} ${row.last_name}` === saved.patientName);
  expect(patient).toMatchObject({ phone: '555-0188', address: '210 Synthetic Avenue',
    address_unit: 'APT 4', city: 'Boston', state: 'MA', zip_code: '02108-1234' });
  const packets = await (await page.request.get('/api/workflow/digital-checkin')).json();
  const packet = packets.find((item: any) => item.patient_id === patient.id);
  expect(packet.status).toBe('Reviewed');
  expect(packet.card_count).toBe(1);
  expect(packet.signed_consent_count).toBe(packet.consent_count);
  expect(packet.intake_status).toBe('Requested');
  const details = await (await page.request.get(`/api/workflow/digital-checkin/${packet.id}`)).json();
  expect(details.consents[0].signature.signer_name).toBe(saved.patientName);
  expect(details.consents[0].signature.signed_at).toBeTruthy();
  expect(details.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(details).not.toHaveProperty('answers');
  expect(errors).toEqual([]);
  await page.getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Digital check-in', exact: true }).click();
  await page.screenshot({ path: '/tmp/cevrali-digital-checkin-desktop.png', fullPage: true, animations: 'disabled' });
});

test('a lost successful submission response retries the same registration once', async ({ page, context }) => {
  const setup = await preparePacket(context, 'LostResponse');
  await page.goto(`/#intake/${setup.token}`);
  const clientIds: string[] = [];
  await completePatientRegistration(page, setup.patientName, { upload: false, beforeSubmit: async () => {
    await page.route(`**${setup.publicPath}/submit`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      clientIds.push(route.request().postDataJSON().client_id);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (clientIds.length === 1) return route.fulfill({ status: 503,
        contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic lost registration response' }) });
      return route.fulfill({ response });
    });
  } });
  const registration = registrationRegion(page);
  await expect(registration.getByRole('alert')).toContainText('Synthetic lost registration response');
  await registration.getByRole('button', { name: 'Submit registration', exact: true }).click();
  await expect(registration.getByText('Your registration has been submitted for front-desk review.', { exact: true })).toBeVisible();
  expect(clientIds).toHaveLength(2);
  expect(clientIds[1]).toBe(clientIds[0]);
  const saved = await (await context.request.get(`/api/workflow/digital-checkin/${setup.id}`)).json();
  expect(saved.status).toBe('Submitted');
  expect(saved.consents.filter((form: any) => form.signature)).toHaveLength(setup.packet.consents.length);
  const profile = await (await context.request.get(`/api/workflow/patient-profiles/${setup.patientId}`)).json();
  expect(profile.patient.phone).toBe('555-0101');
});

test('a stale front-desk review retains its notes and cannot overwrite a newer chart correction', async ({ page, context }) => {
  const setup = await submittedPacket(context, 'StaleReview');
  const review = await openReview(page, setup.patientName);
  await review.getByRole('combobox', { name: 'Contact update decision', exact: true }).selectOption('apply');
  const notes = 'Retain these staff review notes while resolving a concurrent contact correction.';
  await review.getByRole('textbox', { name: 'Review notes', exact: true }).fill(notes);
  const profilePath = `/api/workflow/patient-profiles/${setup.patientId}`;
  const profile = await (await context.request.get(profilePath)).json();
  const corrected = await context.request.patch(`${profilePath}/demographics`, { data: {
    revision: profile.demographics_revision, phone: '555-0199', reason: 'Another staff member verified this current number.',
  } });
  expect(corrected.status()).toBe(200);
  const rejection = page.waitForResponse(response => response.url().endsWith(`/api/workflow/digital-checkin/${setup.id}/review`) && response.status() === 409);
  await review.getByRole('button', { name: 'Complete registration review', exact: true }).click();
  await rejection;
  await expect(review.getByRole('alert')).toBeVisible();
  await expect(review.getByRole('textbox', { name: 'Review notes', exact: true })).toHaveValue(notes);
  const current = await (await context.request.get(profilePath)).json();
  expect(current.patient.phone).toBe('555-0199');
  expect((await (await context.request.get(`/api/workflow/digital-checkin/${setup.id}`)).json()).status).toBe('Submitted');
  await review.getByRole('button', { name: 'Reload current details', exact: true }).click();
  await expect(review.getByRole('combobox', { name: 'Contact update decision', exact: true })).toHaveValue('keep');
  await review.getByRole('button', { name: 'Complete registration review', exact: true }).click();
  await expect(review.getByText('Registration reviewed and saved.', { exact: true })).toBeVisible();
  expect((await (await context.request.get(profilePath)).json()).patient.phone).toBe('555-0199');
});

test('patient registration and staff review fit a narrow mobile screen', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const setup = await preparePacket(context, 'MobileRegistration');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#intake/${setup.token}`);
  await completePatientRegistration(page, setup.patientName);
  await expect(registrationRegion(page).getByText('Your registration has been submitted for front-desk review.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/cevrali-digital-checkin-patient-mobile.png', fullPage: true, animations: 'disabled' });
  const review = await openReview(page, setup.patientName);
  await expect(review.getByRole('textbox', { name: 'Review notes', exact: true })).toBeVisible();
  expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/cevrali-digital-checkin-review-mobile.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});
