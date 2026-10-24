import { test, expect } from '@playwright/test';
import {
  exerciseRegistrationDetails,
  expectRegisteredAddress,
  fillRegistrationAddress,
  registrationAddress,
} from '../registration-details-browser';
import type { Patient } from '../../src/types';

test('structured addresses and searched/custom allergies save to the patient chart', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const saved = await exerciseRegistrationDetails(page);
  const directory = await page.request.get('/api/patients');
  expect(directory.status()).toBe(200);
  const patient = (await directory.json() as Patient[]).find((row) =>
    row.first_name === saved.firstName && row.last_name === saved.lastName);
  expect(patient).toBeDefined();
  expect(patient).toMatchObject(registrationAddress);
  const response = await page.request.get(`/api/patients/${patient!.id}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    ...registrationAddress,
    allergies: saved.allergies,
  });
  expect(errors).toEqual([]);
});

test('front desk can register a structured address on mobile while clinical allergy entry stays restricted', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore the front desk demo', exact: true }).click();
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Register a patient', exact: true });
  const firstName = `MobileAddress${Date.now()}`;
  for (const [label, value] of [
    ['First name', firstName], ['Last name', 'FrontDeskRegistration'],
    ['Date of birth', '1991-05-06'], ['Phone number', '555-0191'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await fillRegistrationAddress(dialog);
  await expect(dialog.getByRole('combobox', { name: 'Known allergies', exact: true }))
    .toHaveCount(0);
  await dialog.getByRole('checkbox', {
    name: 'Open patient record after registration', exact: true,
  }).check();
  await dialog.getByRole('button', { name: 'Register patient', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Patient record', exact: true });
  await expect(chart.getByRole('heading', {
    name: `${firstName} FrontDeskRegistration`, exact: true,
  })).toBeVisible();
  await expectRegisteredAddress(chart);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
  const directory = await page.request.get('/api/patients');
  const patient = (await directory.json() as Patient[]).find((row) => row.first_name === firstName);
  expect(patient).toMatchObject(registrationAddress);
  expect(patient).not.toHaveProperty('allergies');
  expect((await page.request.get(`/api/patients/${patient!.id}`)).status()).toBe(403);
});
