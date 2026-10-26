import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { exercisePrescribing, fillPrescriptionForm, recordPrescriptionReview } from '../prescribing-browser';
import type { PrescriptionView } from '../../server/prescribing-model';

const base = '/api/workflow/prescribing';
const password = 'SyntheticPrescribing2026!';
const fields = {
  medication_name: 'Synthetic controlled review fixture', strength: '5 example units', dose: '1 example unit',
  route: 'Synthetic route', frequency: 'Synthetic frequency',
  instructions: 'Synthetic workflow validation only; not clinical instructions.',
  quantity: 10, quantity_unit: 'example units', days_supply: 10, refills: 0,
  pharmacy: { name: 'Synthetic Pharmacy', address: '100 Synthetic Avenue', phone: '555-0109' },
  controlled_schedule: 'II',
};
// Reuse only the practice identity. Every case creates its own patient and
// prescriptions, keeping the whole suite below the real signup rate limit.
let testOwner: { id: string; email: string } | undefined;

async function prepare(context: BrowserContext, prefix: string) {
  if (!testOwner) {
    const signedUp = await context.request.post('/api/accounts/signup', { data: {
      owner_name: 'Synthetic Prescribing Owner', email: `rx-browser-${randomUUID()}@example.test`,
      password, clinical_access: true, practice: { name: 'Synthetic Prescribing Browser Practice' },
    } });
    expect(signedUp.status()).toBe(201);
    testOwner = await signedUp.json();
  } else {
    const signedIn = await context.request.post('/api/auth/login', { data: { email: testOwner.email, password } });
    expect(signedIn.status()).toBe(200);
  }
  const owner = testOwner!;
  const settings = await (await context.request.get(`${base}/settings`)).json();
  const grant = await context.request.patch(`${base}/settings`, { data: {
    revision: settings.revision,
    prescribers: [{ user_id: owner.id, can_prescribe_demo: true, can_prescribe_controlled_demo: true }],
  } });
  expect(grant.status()).toBe(200);
  const created = await context.request.post('/api/patients', { data: {
    first_name: prefix, last_name: 'Prescribing', dob: '1992-04-06', sex: 'Unknown', phone: '555-0101',
  } });
  expect(created.status()).toBe(201);
  const patientId = String((await created.json()).id);
  return { patientId, patientName: `${prefix} Prescribing`, owner };
}

async function readyPrescription(context: BrowserContext, prefix: string) {
  const setup = await prepare(context, prefix);
  const draft = await context.request.post(base, { data: {
    ...fields, medication_name: `Synthetic ${prefix} medicine`, patient_id: setup.patientId,
    encounter_id: null, billing_account_id: `pba-private-${setup.patientId}`, client_id: randomUUID(),
  } });
  expect(draft.status()).toBe(200);
  let prescription: PrescriptionView = await draft.json();
  const currentContext = await context.request.get(`${base}/${prescription.id}/review-context`);
  expect(currentContext.status()).toBe(200);
  const review = await context.request.post(`${base}/${prescription.id}/review`, { data: {
    revision: prescription.revision, context_fingerprint: (await currentContext.json()).context_fingerprint,
    allergies_reviewed: true, medications_reviewed: true, classification_confirmed: true, pdmp_reviewed: true,
    safety_note: 'Explicit synthetic review; no automated clinical or PDMP service queried.',
  } });
  expect(review.status()).toBe(200);
  prescription = await review.json();
  return { ...setup, prescription };
}

async function openReview(page: Page, name: string) {
  await page.goto('/#prescribing');
  await page.getByRole('article', { name: `Prescription: ${name}`, exact: true })
    .getByRole('button', { name: 'Review prescription', exact: true }).click();
  return page.getByRole('dialog', { name: 'Prescription review', exact: true });
}

async function fillAuthorization(page: Page, code?: string) {
  const dialog = page.getByRole('dialog', { name: 'Prescription review', exact: true });
  const value = code || (await dialog.getByLabel('Demo authorization code', { exact: true }).textContent())!.trim();
  await dialog.getByRole('textbox', { name: 'Authorization code', exact: true }).fill(value);
  await dialog.getByLabel('Your Cevrali password', { exact: true }).fill(password);
}

test('chart prescribing records ordinary and controlled simulations and routes staff refill requests for review', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const saved = await exercisePrescribing(page);
  const queue = await (await page.request.get(`${base}/queue`)).json() as PrescriptionView[];
  const ordinary = queue.find(item => item.medication_name === saved.ordinaryName)!;
  const controlled = queue.find(item => item.medication_name === saved.controlledName)!;
  expect(ordinary.status).toBe('Simulated — not sent');
  expect(controlled.status).toBe('Simulated — not sent');
  expect(ordinary.snapshot?.authentication).toBe('Demo review confirmation');
  expect(controlled.snapshot?.authentication).toBe('Demo password and displayed code');
  expect(controlled.snapshot?.pharmacy_transmitted).toBe(false);
  const chart = await (await page.request.get(`/api/patients/${ordinary.patient_id}`)).json();
  expect(chart.medications.some((item: { name: string }) => [saved.ordinaryName, saved.controlledName].includes(item.name))).toBe(false);
  const requests = await (await page.request.get(`${base}/refills`)).json();
  expect(requests.find((item: any) => item.medication_name === saved.refillName)?.status).toBe('Reviewed');
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/cevrali-prescribing-desktop.png', fullPage: true, animations: 'disabled' });
});

test('controlled authorization records a failed code and retries a lost successful response without duplicate finalization', async ({ page, context }) => {
  const setup = await readyPrescription(context, 'ControlledRetry');
  const review = await openReview(page, setup.prescription.medication_name);
  await review.getByRole('button', { name: 'Request demo authorization code', exact: true }).click();
  const code = (await review.getByLabel('Demo authorization code', { exact: true }).textContent())!.trim();
  await fillAuthorization(page, code === '000000' ? '111111' : '000000');
  await review.getByRole('button', { name: 'Authorize demo prescription', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('4 attempts remaining');
  await expect(review.getByLabel('Your Cevrali password', { exact: true })).toHaveValue('');
  const clientIds: string[] = [];
  await page.route(`**${base}/${setup.prescription.id}/sign`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    clientIds.push(route.request().postDataJSON().client_id);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.ok).toBe(true);
    if (clientIds.length === 1) return route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic lost prescription authorization response' }) });
    return route.fulfill({ response });
  });
  await fillAuthorization(page, code);
  await review.getByRole('button', { name: 'Authorize demo prescription', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('Synthetic lost prescription authorization response');
  await fillAuthorization(page, code);
  await review.getByRole('button', { name: 'Authorize demo prescription', exact: true }).click();
  await expect(review.getByText('Demo authorization completed · Not sent to pharmacy', { exact: true })).toBeVisible();
  expect(clientIds).toHaveLength(2);
  expect(clientIds[1]).toBe(clientIds[0]);
  const committed = await (await context.request.get(`${base}/${setup.prescription.id}`)).json() as PrescriptionView;
  expect(committed.history.filter(item => item.action === 'Finalized demo prescription; not transmitted')).toHaveLength(1);
  expect(committed.snapshot?.pharmacy_transmitted).toBe(false);
  expect(committed.status).toBe('Simulated — not sent');
});

test('a changed chart invalidates an existing controlled authorization and requires the provider to review current context', async ({ page, context }) => {
  const setup = await readyPrescription(context, 'ChangedContext');
  const review = await openReview(page, setup.prescription.medication_name);
  await review.getByRole('button', { name: 'Request demo authorization code', exact: true }).click();
  const profilePath = `/api/workflow/patient-profiles/${setup.patientId}`;
  const profile = await (await context.request.get(profilePath)).json();
  const changed = await context.request.patch(`${profilePath}/demographics`, { data: {
    revision: profile.demographics_revision, phone: '555-0199', reason: 'Synthetic concurrent chart verification.',
  } });
  expect(changed.status()).toBe(200);
  await fillAuthorization(page);
  await review.getByRole('button', { name: 'Authorize demo prescription', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('changed');
  expect((await (await context.request.get(`${base}/${setup.prescription.id}`)).json()).snapshot).toBeUndefined();
  await review.getByRole('button', { name: 'Reload prescription', exact: true }).click();
  await expect(review.getByRole('button', { name: 'Record prescription review', exact: true })).toBeVisible();
  await recordPrescriptionReview(page, true);
  await expect(review.getByRole('button', { name: 'Request demo authorization code', exact: true })).toBeVisible();
  expect((await (await context.request.get(profilePath)).json()).patient.phone).toBe('555-0199');
});

test('prescribing forms and controlled authorization fit a mobile viewport', async ({ page, context }) => {
  const setup = await prepare(context, 'Mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#prescribing');
  await page.getByRole('combobox', { name: 'Open patient prescribing', exact: true }).selectOption(setup.patientId);
  const workspace = page.getByRole('dialog', { name: 'Patient prescribing', exact: true });
  await workspace.getByRole('button', { name: 'New prescription', exact: true }).click();
  await fillPrescriptionForm(page, 'Synthetic mobile medicine', true);
  const review = page.getByRole('dialog', { name: 'Prescription review', exact: true });
  await recordPrescriptionReview(page, true);
  await review.getByRole('button', { name: 'Request demo authorization code', exact: true }).click();
  await fillAuthorization(page);
  expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/cevrali-prescribing-mobile.png', fullPage: true, animations: 'disabled' });
  await review.getByRole('button', { name: 'Authorize demo prescription', exact: true }).click();
  await expect(review.getByText('Demo authorization completed · Not sent to pharmacy', { exact: true })).toBeVisible();
});

test('the encounter prescribing shortcut preserves unsaved notes and uses the saved visit account', async ({ page, context }) => {
  const setup = await prepare(context, 'EncounterScope');
  const created = await context.request.post('/api/encounters', { data: {
    patient_id: setup.patientId, chief_complaint: 'Synthetic encounter prescribing scope review',
  } });
  expect(created.status()).toBe(201);
  const encounter = await created.json();
  const extraAccount = await context.request.post('/api/workflow/finance/accounts', { data: {
    patient_id: setup.patientId, name: 'Synthetic alternate private account', kind: 'Private insurance', status: 'Active',
  } });
  expect(extraAccount.status()).toBe(200);
  const alternateId = String((await extraAccount.json()).id);
  await page.goto('/#encounters');
  await page.getByRole('row').filter({ hasText: setup.patientName }).getByRole('button', { name: 'Continue note', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Document encounter', exact: true });
  const unsaved = 'Synthetic unsaved plan retained while preparing a separate prescription.';
  await editor.getByLabel('Plan', { exact: false }).fill(unsaved);
  const launch = editor.locator('.prescribing-encounter-launch').getByRole('button', { name: 'Prescribe medication', exact: true });
  await launch.click();
  const prescribing = page.getByRole('dialog', { name: 'Prescribe medication', exact: true });
  await expect(prescribing.getByRole('combobox', { name: 'Visit insurance account', exact: true })).toHaveValue(`pba-private-${setup.patientId}`);
  await expect(prescribing.getByRole('combobox', { name: 'Visit insurance account', exact: true })).toBeDisabled();
  await prescribing.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(editor.getByLabel('Plan', { exact: false })).toHaveValue(unsaved);
  await editor.getByRole('combobox', { name: 'Account for this visit', exact: true }).selectOption(alternateId);
  await expect(launch).toBeDisabled();
  await expect(editor.getByText('Save the visit insurance account before preparing a prescription.', { exact: true })).toBeVisible();
  const savedEncounters = await (await context.request.get('/api/encounters')).json();
  expect(savedEncounters.find((item: { id: string }) => item.id === encounter.id).plan).not.toBe(unsaved);
});
