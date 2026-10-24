import { expect, type Locator, type Page } from '@playwright/test';
import type { Policy } from '../server/finance-engine';
import type { PatientBillingAccount } from '../server/patient-accounts';
import type { Patient } from '../src/types';

async function fillRegistration(dialog: Locator, firstName: string, claim: string) {
  for (const [label, value] of [
    ['First name', firstName],
    ['Last name', 'RegistrationRetry'],
    ['Date of birth', '1991-02-03'],
    ['Phone number', '555-0140'],
    ['Address', 'Synthetic registration retry address'],
    ['Unit / Apt number', '4B'],
    ['City', 'San Francisco'],
    ['ZIP code', '94103-1234'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole('combobox', { name: 'State', exact: true }).selectOption('CA');
  await dialog.getByRole('combobox', { name: 'Known allergies', exact: true }).fill('Latex');
  await dialog.getByRole('option', { name: 'Latex', exact: true }).click();
  await dialog.getByLabel('Add insurance during registration', { exact: true }).check();
  for (const [label, value] of [
    ['Payer name', 'Synthetic retry private payer'],
    ['Plan name', 'Synthetic retry plan'],
    ['Member ID', `${claim}-PRIVATE`],
    ['Group number', 'RETRY-GROUP'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByLabel('Add workers compensation claim during registration', { exact: true }).check();
  for (const [label, value] of [
    ['Claim account name', 'Synthetic retry workers compensation'],
    ['Workers comp claim number', claim],
    ['Date of injury', '2020-01-02'],
    ['Employer', 'Synthetic retry employer'],
    ['Workers comp carrier', 'Synthetic retry comp carrier'],
    ['Accepted body parts', 'Left shoulder'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole('combobox', { name: 'Claim acceptance status', exact: true }).selectOption('Accepted');
}

export async function exerciseRegistrationRetry(
  page: Page,
  { scheduling = false }: { scheduling?: boolean } = {},
) {
  const firstName = scheduling ? 'ScheduleRetry' : 'RecordRetry';
  const name = `${firstName} RegistrationRetry`;
  const claim = scheduling ? 'REG-RETRY-SCHEDULE' : 'REG-RETRY-RECORD';
  const phone = '555-0141';
  const date = '2034-05-17';
  let rejectCreation = !scheduling;
  let rejectContinuation = false;
  let postRequests = 0;
  let committedPatients = 0;
  let savedId = '';
  let matchesRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/patients/matches') matchesRequests++;
  });
  await page.route('**/api/patients', async (route) => {
    if (route.request().method() === 'GET') {
      if (scheduling && rejectContinuation) {
        rejectContinuation = false;
        return route.fulfill({ status: 503, json: { error: 'Synthetic patient directory refresh unavailable' } });
      }
      return route.continue();
    }
    if (route.request().method() !== 'POST') return route.continue();
    postRequests++;
    if (rejectCreation) {
      rejectCreation = false;
      return route.fulfill({ status: 503, json: { error: 'Synthetic registration service unavailable' } });
    }
    const response = await route.fetch();
    if (response.status() === 201) {
      committedPatients++;
      savedId = (await response.json()).id;
      rejectContinuation = true;
    }
    await route.fulfill({ response });
  });
  await page.route('**/api/overview', async (route) => {
    if (scheduling || !rejectContinuation) return route.continue();
    rejectContinuation = false;
    await route.fulfill({ status: 503, json: { error: 'Synthetic patient record refresh unavailable' } });
  });

  if (scheduling) {
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.getByLabel('Schedule date', { exact: true }).fill(date);
    await page.getByRole('button', { name: 'New appointment', exact: true }).click();
    const appointment = page.getByRole('dialog', { name: 'Schedule an appointment', exact: true });
    await appointment.getByLabel('Time', { exact: true }).fill('10:45');
    await appointment.getByLabel('Reason for visit', { exact: true }).fill('Registration retry retains booking context');
    await appointment.getByRole('button', { name: 'Register new patient', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Patients', exact: true }).click();
    await page.getByRole('button', { name: 'Register patient', exact: true }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Register a patient', exact: true });
  await fillRegistration(dialog, firstName, claim);
  const createLabel = scheduling ? 'Register and continue scheduling' : 'Register patient';
  if (!scheduling) {
    await dialog.getByRole('button', { name: createLabel, exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Synthetic registration service unavailable');
    for (const label of ['First name', 'Phone number', 'Member ID', 'Workers comp claim number'])
      await expect(dialog.getByLabel(label, { exact: true })).toBeEnabled();
  }
  await dialog.getByLabel('Phone number', { exact: true }).fill(phone);
  await dialog.getByRole('button', { name: createLabel, exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    scheduling ? 'Patient saved. Please retry continuing scheduling:' : 'Patient saved. Please retry opening the record:',
  );
  await expect(dialog.getByRole('status').filter({ hasText: 'Patient saved. Registration details are locked.' })).toBeVisible();
  for (const label of ['First name', 'Date of birth', 'Phone number', 'Unit / Apt number', 'City', 'ZIP code', 'Member ID', 'Workers comp claim number', 'Accepted body parts'])
    await expect(dialog.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('combobox', { name: 'State', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('combobox', { name: 'Known allergies', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Remove allergy Latex', exact: true })).toBeDisabled();
  for (const label of ['Add insurance during registration', 'Add workers compensation claim during registration'])
    await expect(dialog.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: createLabel, exact: true })).toHaveCount(0);
  expect(committedPatients).toBe(1);
  const postsBeforeRetry = postRequests;
  const matchesBeforeRetry = matchesRequests;

  // Disabled required fields cannot prevent retrying a continuation of an already saved record.
  await dialog.getByLabel('First name', { exact: true }).evaluate((element) => {
    (element as HTMLInputElement).value = '';
  });
  expect(await dialog.locator('form').evaluate((element) => (element as HTMLFormElement).checkValidity())).toBe(true);
  await dialog.getByRole('button', {
    name: scheduling ? 'Continue scheduling saved patient' : 'Retry opening patient record', exact: true,
  }).click();
  await expect(dialog).not.toBeVisible();
  expect(postRequests).toBe(postsBeforeRetry);
  expect(matchesRequests).toBe(matchesBeforeRetry);
  expect(committedPatients).toBe(1);

  if (scheduling) {
    const appointment = page.getByRole('dialog', { name: 'Schedule an appointment', exact: true });
    await expect(appointment.getByRole('combobox', { name: 'Patient', exact: true })).toHaveValue(savedId);
    await expect(appointment.getByRole('combobox', { name: 'Account for this visit', exact: true }).locator('option:checked')).toContainText(claim);
    await expect(appointment.getByLabel('Date', { exact: true })).toHaveValue(date);
    await expect(appointment.getByLabel('Time', { exact: true })).toHaveValue('10:45');
    await expect(appointment.getByLabel('Reason for visit', { exact: true })).toHaveValue('Registration retry retains booking context');
    await appointment.getByRole('button', { name: 'Cancel', exact: true }).click();
  } else {
    const chart = page.getByRole('dialog', { name: 'Patient chart', exact: true });
    await expect(chart.getByRole('heading', { name, exact: true, level: 2 })).toBeVisible();
    await expect(chart.locator('.chart-tabs').getByRole('button', { name: 'Billing accounts', exact: true })).toHaveClass('active');
    await expect(chart.locator('.patient-billing-account').filter({ hasText: claim })).toContainText('Left shoulder');
    await chart.getByRole('button', { name: 'Close dialog', exact: true }).click();
  }
  const directory: Patient[] = await (await page.request.get('/api/patients')).json();
  expect(directory.filter((patient) => patient.first_name === firstName && patient.last_name === 'RegistrationRetry')).toHaveLength(1);
  const saved = directory.find((patient) => patient.id === savedId)!;
  expect({ first: saved.first_name, dob: saved.dob, phone: saved.phone }).toEqual({ first: firstName, dob: '1991-02-03', phone });
  expect(saved).toMatchObject({ address_unit: '4B', city: 'San Francisco', state: 'CA', zip_code: '94103-1234' });
  const clinicalPatient = await (await page.request.get(`/api/patients/${savedId}`)).json();
  expect(clinicalPatient.allergies).toEqual(['Latex']);
  const accounts: PatientBillingAccount[] = await (await page.request.get(`/api/workflow/finance/accounts?patient_id=${savedId}`)).json();
  expect(accounts).toHaveLength(2);
  expect(accounts.find((account) => account.kind === 'Workers compensation')?.workers_comp).toMatchObject({
    claim_number: claim, carrier: 'Synthetic retry comp carrier', claim_status: 'Accepted', accepted_body_parts: ['Left shoulder'],
  });
  const policies: Policy[] = await (await page.request.get(`/api/workflow/finance/policies?patient_id=${savedId}`)).json();
  expect(policies.find((policy) => policy.member_id === `${claim}-PRIVATE`)).toMatchObject({
    payer: 'Synthetic retry private payer', plan: 'Synthetic retry plan', subscriber_name: name,
    subscriber_dob: '1991-02-03', relationship: 'Self',
  });
}
