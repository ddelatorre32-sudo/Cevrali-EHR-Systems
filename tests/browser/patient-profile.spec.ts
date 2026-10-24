import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { exercisePatientProfile } from '../patient-profile-browser';

async function signIn(context: BrowserContext, frontdesk = false) {
  const login = await context.request.post('/api/auth/login', { data: {
    email: frontdesk ? 'frontdesk@cevrali.demo' : 'alex@cevrali.demo',
    password: 'CevraliDemo2026!',
  } });
  expect(login.status()).toBe(200);
}
async function createPatient(context: BrowserContext, prefix: string) {
  const firstName = `${prefix}${Date.now()}`;
  const created = await context.request.post('/api/patients', { data: {
    first_name: firstName, last_name: 'ProfileConcurrency', dob: '1989-03-04',
    sex: 'Unknown', phone: '555-0121',
  } });
  expect(created.status()).toBe(201);
  return { id: (await created.json()).id as string, firstName };
}
async function openChart(page: Page, firstName: string, frontdesk = false) {
  await page.goto('/#patients');
  const row = page.getByRole('row').filter({ hasText: firstName });
  await row.getByRole('button', {
    name: frontdesk ? 'Insurance & billing' : 'Open chart', exact: true,
  }).click();
  return page.getByRole('dialog', { name: frontdesk ? 'Patient record' : 'Patient chart', exact: true });
}

test('patient details and reviewed allergy records update charts without losing change history', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const saved = await exercisePatientProfile(page);
  const directory = await (await page.request.get('/api/patients')).json();
  const patient = directory.find((row: any) => row.first_name === saved.firstName);
  expect(patient).toMatchObject({ phone: saved.newPhone, state: 'MA', zip_code: '02108-1234' });
  const profile = await (await page.request.get(`/api/workflow/patient-profiles/${patient.id}`)).json();
  expect(profile.allergy.status).toBe('No known allergies');
  expect(profile.allergy.reviewed_at).toBeTruthy();
  expect(profile.allergy.reviewed_by).toBeTruthy();
  expect(profile.allergy.records).toHaveLength(1);
  expect(profile.allergy.records[0]).toMatchObject({
    name: 'Penicillin', reaction: 'Hives', severity: 'Severe', status: 'Inactive',
  });
  expect(profile.history).toHaveLength(3);
  expect(errors).toEqual([]);
});

test('an older open editor rejects another tab’s patient update and retains the unsaved draft', async ({ page, context }) => {
  await signIn(context);
  const patient = await createPatient(context, 'StaleProfile');
  const chart = await openChart(page, patient.firstName);
  await chart.getByRole('button', { name: 'Edit patient details', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit patient details', exact: true });
  await editor.getByRole('textbox', { name: 'Phone number', exact: true }).fill('555-0144');
  await editor.getByRole('textbox', { name: 'Change reason', exact: true }).fill('Unsaved first-tab change');
  const other = await context.newPage();
  try {
    const otherChart = await openChart(other, patient.firstName);
    await otherChart.getByRole('button', { name: 'Edit patient details', exact: true }).click();
    const otherEditor = other.getByRole('dialog', { name: 'Edit patient details', exact: true });
    await otherEditor.getByRole('textbox', { name: 'Phone number', exact: true }).fill('555-0199');
    await otherEditor.getByRole('textbox', { name: 'Change reason', exact: true }).fill('Saved second-tab correction');
    await otherEditor.getByRole('button', { name: 'Save patient details', exact: true }).click();
    await expect(otherEditor).not.toBeVisible();
    await page.bringToFront();
    const rejected = page.waitForResponse(response =>
      response.url().endsWith(`/api/workflow/patient-profiles/${patient.id}/demographics`) &&
      response.request().method() === 'PATCH' && response.status() === 409);
    await editor.getByRole('button', { name: 'Save patient details', exact: true }).click();
    await rejected;
    await expect(editor.getByRole('alert')).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Phone number', exact: true })).toHaveValue('555-0144');
    const response = await context.request.get(`/api/workflow/patient-profiles/${patient.id}`);
    const latest = await response.json();
    expect(latest.patient.phone).toBe('555-0199');
    expect(latest.history.filter((entry: any) => entry.section === 'Demographics')).toHaveLength(1);
    expect(latest.history[0].reason).toBe('Saved second-tab correction');
  } finally { await other.close(); }
});

test('front desk can update demographics while allergy details and clinical change history stay restricted', async ({ page, context }) => {
  await signIn(context);
  const patient = await createPatient(context, 'FrontProfile');
  const initial = await (await context.request.get(`/api/workflow/patient-profiles/${patient.id}`)).json();
  const clinical = await context.request.patch(`/api/workflow/patient-profiles/${patient.id}/allergies`, { data: {
    revision: initial.allergy.revision, reason: 'Sensitive synthetic allergy provenance',
    status: 'Allergies recorded', reviewed: true,
    records: [{ id: `allergy-${Date.now()}`, name: 'Penicillin', type: 'Allergy',
      reaction: 'Hives', severity: 'Severe', source: 'Patient reported',
      onset_date: '2020-02-01', notes: 'Synthetic sensitive clinician history', status: 'Active' }],
  } });
  expect(clinical.status()).toBe(200);
  await context.request.post('/api/auth/logout', { data: {} });
  await signIn(context, true);
  const chart = await openChart(page, patient.firstName, true);
  await expect(chart.getByRole('button', { name: 'Allergies', exact: true })).toHaveCount(0);
  await chart.getByRole('button', { name: 'Edit patient details', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit patient details', exact: true });
  await editor.getByRole('textbox', { name: 'Phone number', exact: true }).fill('555-0180');
  await editor.getByRole('textbox', { name: 'Change reason', exact: true }).fill('Front desk verified current phone');
  await editor.getByRole('button', { name: 'Save patient details', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await chart.getByRole('button', { name: 'Change history', exact: true }).click();
  await expect(chart).toContainText('Front desk verified current phone');
  await expect(chart).not.toContainText('Sensitive synthetic allergy provenance');
  await expect(chart).not.toContainText('Synthetic sensitive clinician history');
  const response = await context.request.get(`/api/workflow/patient-profiles/${patient.id}`);
  expect(response.status()).toBe(200);
  const safe = await response.json();
  expect(safe).not.toHaveProperty('allergy');
  expect(safe.history.every((entry: any) => entry.section === 'Demographics')).toBe(true);
  expect(safe.patient).not.toHaveProperty('allergies');
  expect(safe.patient.phone).toBe('555-0180');
  for (const text of ['Penicillin', 'Hives', 'Synthetic sensitive clinician history', 'Sensitive synthetic allergy provenance'])
    expect(JSON.stringify(safe)).not.toContain(text);
  const denied = await context.request.patch(`/api/workflow/patient-profiles/${patient.id}/allergies`, { data: {
    revision: 1, reason: 'Unauthorized clinical change', status: 'No known allergies', records: [], reviewed: true,
  } });
  expect(denied.status()).toBe(403);
});

test('a saved patient update retries a failed chart refresh without repeating the change', async ({ page, context }) => {
  await signIn(context);
  const patient = await createPatient(context, 'RefreshProfile');
  const chart = await openChart(page, patient.firstName);
  await chart.getByRole('button', { name: 'Edit patient details', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit patient details', exact: true });
  await editor.getByRole('textbox', { name: 'Phone number', exact: true }).fill('555-0177');
  await editor.getByRole('textbox', { name: 'Change reason', exact: true })
    .fill('Saved correction must not repeat after chart refresh failure');
  let patches = 0;
  let failRefresh = true;
  await page.route(`**/api/workflow/patient-profiles/${patient.id}/demographics`, async route => {
    if (route.request().method() === 'PATCH') patches++;
    await route.continue();
  });
  await page.route(`**/api/patients/${patient.id}`, async route => {
    if (route.request().method() === 'GET' && failRefresh) {
      failRefresh = false;
      await route.fulfill({ status: 500, json: { error: 'Synthetic chart refresh failure' } });
    } else await route.continue();
  });
  await editor.getByRole('button', { name: 'Save patient details', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Patient details saved. Chart refresh failed:');
  await expect(editor.getByRole('textbox', { name: 'Phone number', exact: true })).toBeDisabled();
  expect(patches).toBe(1);
  await editor.getByRole('button', { name: 'Retry refreshing chart', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(patches).toBe(1);
  await chart.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(chart.locator('.mini-card').filter({ hasText: 'Patient details' })).toContainText('555-0177');
  const latest = await (await context.request.get(`/api/workflow/patient-profiles/${patient.id}`)).json();
  expect(latest.patient.phone).toBe('555-0177');
  expect(latest.history.filter((event: any) => event.section === 'Demographics')).toHaveLength(1);
});

test('adding another allergen preserves a current entry when an older inactive record has the same name', async ({ page, context }) => {
  await signIn(context);
  const patient = await createPatient(context, 'ReintroducedAllergy');
  const initial = await (await context.request.get(`/api/workflow/patient-profiles/${patient.id}`)).json();
  const inactiveId = `allergy-old-${Date.now()}`;
  const activeId = `allergy-current-${Date.now()}`;
  const common = { name: 'Penicillin', onset_date: '2020-02-01', notes: '' };
  const seeded = await context.request.patch(`/api/workflow/patient-profiles/${patient.id}/allergies`, { data: {
    revision: initial.allergy.revision, status: 'Allergies recorded', reviewed: true,
    reason: 'Synthetic old and current reports retained for reconciliation',
    records: [
      { ...common, id: inactiveId, type: 'Unconfirmed', reaction: 'Older reported rash',
        severity: 'Mild', source: 'Outside record', status: 'Inactive' },
      { ...common, id: activeId, type: 'Allergy', reaction: 'Hives and facial swelling',
        severity: 'Severe', source: 'Patient reported', status: 'Active' },
    ],
  } });
  expect(seeded.status()).toBe(200);
  const chart = await openChart(page, patient.firstName);
  await chart.getByRole('button', { name: 'Allergies', exact: true }).click();
  const form = chart.getByRole('form', { name: 'Detailed allergy record', exact: true });
  const penicillin = form.getByRole('group', { name: 'Penicillin', exact: true });
  await expect(penicillin.getByRole('textbox', { name: 'Reaction', exact: true }))
    .toHaveValue('Hives and facial swelling');
  await form.getByRole('combobox', { name: 'Known allergies', exact: true }).fill('Latex');
  await form.getByRole('listbox', { name: 'Allergy choices', exact: true })
    .getByRole('option', { name: 'Latex', exact: true }).click();
  await expect(penicillin).toHaveCount(1);
  await expect(penicillin.getByRole('textbox', { name: 'Reaction', exact: true }))
    .toHaveValue('Hives and facial swelling');
  await expect(penicillin.getByRole('combobox', { name: 'Severity', exact: true }))
    .toHaveValue('Severe');
  await form.getByRole('textbox', { name: 'Allergy change reason', exact: true })
    .fill('Added Latex while retaining the current Penicillin report');
  await form.getByRole('checkbox', { name: 'I reviewed this allergy information', exact: true }).check();
  await form.getByRole('button', { name: 'Save allergy record', exact: true }).click();
  await expect(chart.getByText('Allergy record saved', { exact: true })).toBeVisible();
  const latest = await (await context.request.get(`/api/workflow/patient-profiles/${patient.id}`)).json();
  expect(latest.allergy.records.find((record: any) => record.id === activeId)).toMatchObject({
    name: 'Penicillin', status: 'Active', reaction: 'Hives and facial swelling', severity: 'Severe',
  });
  expect(latest.allergy.records.find((record: any) => record.id === inactiveId)).toMatchObject({
    name: 'Penicillin', status: 'Inactive', reaction: 'Older reported rash', severity: 'Mild',
  });
  const activeNames = latest.allergy.records.filter((record: any) => record.status === 'Active')
    .map((record: any) => record.name);
  expect(activeNames.sort()).toEqual(['Latex', 'Penicillin']);
});

test('contact-only corrections do not require a new acknowledgment for intentionally separate matching identities', async ({ page, context }) => {
  await signIn(context);
  const first = await createPatient(context, 'SeparateIdentity');
  const secondResponse = await context.request.post('/api/patients', { data: {
    first_name: first.firstName, last_name: 'ProfileConcurrency', dob: '1989-03-04',
    sex: 'Unknown', phone: '555-0192', duplicate_acknowledged: true,
  } });
  expect(secondResponse.status()).toBe(201);
  const secondId = (await secondResponse.json()).id;
  await page.goto('/#patients');
  const row = page.getByRole('row').filter({ hasText: first.firstName })
    .filter({ hasText: '555-0121' });
  await row.getByRole('button', { name: 'Open chart', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Patient chart', exact: true });
  await chart.getByRole('button', { name: 'Edit patient details', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit patient details', exact: true });
  await editor.getByRole('textbox', { name: 'Phone number', exact: true }).fill('555-0172');
  await editor.getByRole('textbox', { name: 'Change reason', exact: true })
    .fill('Corrected contact information for the existing separate patient');
  await editor.getByRole('button', { name: 'Save patient details', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(chart.locator('.mini-card').filter({ hasText: 'Patient details' })).toContainText('555-0172');
  const latest = await (await context.request.get(`/api/workflow/patient-profiles/${first.id}`)).json();
  expect(latest.patient.phone).toBe('555-0172');
  expect(latest.demographics_revision).toBe(2);
  expect(latest.history).toHaveLength(1);
  expect(latest.history[0]).toMatchObject({
    section: 'Demographics',
    before: { phone: '555-0121' }, after: { phone: '555-0172' },
  });
  const separate = await (await context.request.get(`/api/workflow/patient-profiles/${secondId}`)).json();
  expect(separate.patient.phone).toBe('555-0192');
  expect(separate.demographics_revision).toBe(1);
  expect(separate.history).toHaveLength(0);
});
