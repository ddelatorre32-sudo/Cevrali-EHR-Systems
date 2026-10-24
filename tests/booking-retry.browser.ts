import { expect, type Page } from '@playwright/test';
import type { Appointment } from '../src/types';

export async function exerciseBookingRetry(page: Page) {
  const date = '2032-07-14';
  const reason = 'Saved appointment refresh retry regression';
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByLabel('Schedule date', { exact: true }).fill(date);
  const panel = page.locator('section.panel').filter({ has: page.getByLabel('Calendar provider', { exact: true }) });
  await expect(panel.locator('.panel-toolbar .subtle-label')).toHaveText('0 appointments');

  let rejectCreation = true;
  let rejectRefresh = false;
  let postRequests = 0;
  let committedAppointments = 0;
  let savedId = '';
  await page.route('**/api/appointments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    postRequests++;
    if (rejectCreation) {
      rejectCreation = false;
      return route.fulfill({ status: 503, json: { error: 'Synthetic scheduling service unavailable' } });
    }
    const response = await route.fetch();
    if (response.status() === 201) {
      committedAppointments++;
      savedId = (await response.json()).id;
      rejectRefresh = true;
    }
    await route.fulfill({ response });
  });
  await page.route('**/api/overview', async (route) => {
    if (!rejectRefresh) return route.continue();
    rejectRefresh = false;
    await route.fulfill({ status: 503, json: { error: 'Synthetic schedule refresh unavailable' } });
  });

  await page.getByRole('button', { name: 'New appointment', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule an appointment', exact: true });
  await dialog.getByRole('combobox', { name: 'Patient', exact: true }).selectOption('pat-001');
  await expect(dialog.getByRole('combobox', { name: 'Account for this visit', exact: true })).not.toHaveValue('');
  await dialog.getByLabel('Time', { exact: true }).fill('11:00');
  await dialog.getByLabel('Reason for visit', { exact: true }).fill('Creation failure remains editable');
  await dialog.getByRole('button', { name: 'Schedule appointment', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic scheduling service unavailable');
  await expect(dialog.getByLabel('Reason for visit', { exact: true })).toBeEnabled();
  await dialog.getByLabel('Reason for visit', { exact: true }).fill(reason);

  await dialog.getByRole('button', { name: 'Schedule appointment', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('The appointment is saved, but the schedule could not refresh.');
  await expect(dialog.getByRole('status')).toContainText('Appointment saved. Retry the schedule refresh to finish.');
  for (const name of ['Patient', 'Account for this visit'])
    await expect(dialog.getByRole('combobox', { name, exact: true })).toBeDisabled();
  for (const name of ['Date', 'Time', 'Reason for visit'])
    await expect(dialog.getByLabel(name, { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Register new patient', exact: true })).toBeDisabled();
  expect(postRequests).toBe(2);
  expect(committedAppointments).toBe(1);

  await dialog.getByRole('button', { name: 'Retry schedule refresh', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(postRequests).toBe(2);
  expect(committedAppointments).toBe(1);
  const response = await page.request.get(`/api/appointments?date=${date}`);
  expect(response.ok()).toBe(true);
  const saved: Appointment[] = await response.json();
  expect(saved.filter((appointment) => appointment.reason === reason)).toHaveLength(1);
  expect(saved.find((appointment) => appointment.id === savedId)?.reason).toBe(reason);
  await expect(panel.locator('.appointment-table tbody tr').filter({ hasText: 'Olivia Bennett' })).toHaveCount(1);
}

export async function exerciseFilteredScheduleActions(page: Page) {
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  const provider = page.getByRole('combobox', { name: 'Calendar provider', exact: true });
  const panel = page.locator('section.panel').filter({ has: provider });
  const day = await page.getByLabel('Schedule date', { exact: true }).inputValue();
  const response = await page.request.get(`/api/appointments?date=${day}`);
  expect(response.ok()).toBe(true);
  const appointments: Appointment[] = await response.json();
  const nina = await provider.getByRole('option', { name: 'Dr. Nina Patel', exact: true }).getAttribute('value');
  expect(nina).toBeTruthy();
  expect(appointments.filter((appointment) => appointment.provider_id === nina)).toHaveLength(0);

  await provider.selectOption(nina!);
  await expect(panel.locator('.panel-toolbar .subtle-label')).toHaveText('0 appointments');
  await expect(panel.locator('.appointment-table tbody tr')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Complete .+’s visit$/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Cancel .+ · / })).toHaveCount(0);

  await provider.selectOption('all');
  await expect(panel.locator('.panel-toolbar .subtle-label')).toHaveText(`${appointments.length} appointments`);
  await expect(panel.locator('.appointment-table tbody tr')).toHaveCount(appointments.length);
  await expect(panel.getByRole('button', { name: /^Complete .+’s visit$/ })).toHaveCount(appointments.filter((appointment) => appointment.status === 'In progress').length);
  await expect(panel.getByRole('button', { name: /^Cancel .+ · / })).toHaveCount(appointments.filter((appointment) => ['Scheduled', 'Checked in'].includes(appointment.status)).length);

  await panel.getByRole('button', { name: 'Completed', exact: true }).click();
  const completed = appointments.filter((appointment) => appointment.status === 'Completed').length;
  await expect(panel.locator('.panel-toolbar .subtle-label')).toHaveText(`${completed} appointments`);
  await expect(panel.locator('.appointment-table tbody tr')).toHaveCount(completed);
  await expect(panel.locator('.appointment-actions button')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Upcoming', exact: true }).click();
  const upcoming = appointments.filter((appointment) => ['Scheduled', 'Checked in', 'In progress'].includes(appointment.status)).length;
  await expect(panel.locator('.panel-toolbar .subtle-label')).toHaveText(`${upcoming} appointments`);
  await expect(panel.locator('.appointment-table tbody tr')).toHaveCount(upcoming);
  await panel.getByRole('button', { name: 'All appointments', exact: true }).click();
}
