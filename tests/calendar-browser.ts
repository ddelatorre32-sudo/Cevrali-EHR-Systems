import { expect, type Page, type Locator } from '@playwright/test';
export async function exerciseCalendar(page: Page) {
  page.setDefaultTimeout(12000);
  const date = '2030-03-11',
    nextDate = '2030-03-12',
    name = 'CalendarNew Patient';
  async function pick(select: Locator, pattern: RegExp) {
    const option = select.getByRole('option').filter({ hasText: pattern });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute('value'))!);
  }
  const schedule = () =>
    page.getByRole('dialog', { name: 'Schedule an appointment', exact: true });
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Week', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Schedule date', { exact: true }).fill(date);
  await pick(
    page.getByRole('combobox', { name: 'Calendar provider', exact: true }),
    /Dr. Nina Patel/,
  );
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await page
    .getByRole('button', { name: `Schedule ${date} at 09:00`, exact: true })
    .click();
  let d = schedule();
  await expect(d.getByLabel('Date', { exact: true })).toHaveValue(date);
  await expect(d.getByLabel('Time', { exact: true })).toHaveValue('09:00');
  await expect(
    d.getByRole('combobox', { name: 'Provider', exact: false }),
  ).toContainText('Dr. Nina Patel');
  await d
    .getByLabel('Reason for visit', { exact: true })
    .fill('Calendar registration workflow');
  await d
    .getByRole('button', { name: 'Register new patient', exact: true })
    .click();
  let registration = page.getByRole('dialog', {
    name: 'Register a patient',
    exact: true,
  });
  for (const [label, value] of [
    ['First name', 'CalendarNew'],
    ['Last name', 'Patient'],
    ['Date of birth', '1993-04-05'],
    ['Phone number', '555-0199'],
  ])
    await registration.getByLabel(label, { exact: true }).fill(value);
  await registration
    .getByLabel('Add workers compensation claim during registration', {
      exact: true,
    })
    .check();
  for (const [label, value] of [
    ['Workers comp claim number', 'CAL-WC-01'],
    ['Date of injury', '2020-01-01'],
    ['Employer', 'Calendar Synthetic Employer'],
    ['Workers comp carrier', 'Calendar Synthetic Carrier'],
  ])
    await registration.getByLabel(label, { exact: true }).fill(value);
  await registration
    .getByRole('combobox', { name: 'Claim acceptance status', exact: true })
    .selectOption('Accepted');
  await registration
    .getByLabel('Accepted body parts', { exact: true })
    .fill('Left shoulder');
  await registration
    .getByRole('button', {
      name: 'Register and continue scheduling',
      exact: true,
    })
    .click();
  await expect(registration).not.toBeVisible();
  d = schedule();
  await expect(d.getByLabel('Date', { exact: true })).toHaveValue(date);
  await expect(d.getByLabel('Time', { exact: true })).toHaveValue('09:00');
  await expect(d.getByLabel('Reason for visit', { exact: true })).toHaveValue(
    'Calendar registration workflow',
  );
  const providerId = await d
    .getByRole('combobox', { name: 'Provider', exact: false })
    .inputValue();
  await expect(
    d
      .getByRole('combobox', { name: 'Provider', exact: false })
      .locator('option:checked'),
  ).toHaveText('Dr. Nina Patel');
  await expect(
    d
      .getByRole('combobox', { name: 'Patient', exact: true })
      .locator('option:checked'),
  ).toContainText(name);
  await expect(
    d
      .getByRole('combobox', { name: 'Account for this visit', exact: true })
      .locator('option:checked'),
  ).toContainText('CAL-WC-01');
  await d
    .getByRole('button', { name: 'Schedule appointment', exact: true })
    .click();
  await expect(d).not.toBeVisible();
  let event = page.locator('.calendar-event').filter({ hasText: name });
  await expect(event).toHaveCount(1);
  await event.click();
  let detail = page.getByRole('dialog', {
    name: 'Appointment details',
    exact: true,
  });
  await expect(detail).toContainText('Dr. Nina Patel');
  await expect(detail).toContainText('Calendar registration workflow');
  await expect(detail).toContainText('CAL-WC-01');
  await detail
    .getByRole('button', { name: 'Check in patient', exact: true })
    .click();
  await expect(
    page.locator('.calendar-event').filter({ hasText: name }),
  ).toContainText('Checked in');
  await page
    .getByRole('button', { name: 'New appointment', exact: true })
    .click();
  d = schedule();
  await pick(
    d.getByRole('combobox', { name: 'Patient', exact: true }),
    /CalendarNew Patient/,
  );
  await pick(
    d.getByRole('combobox', { name: 'Account for this visit', exact: true }),
    /CAL-WC-01/,
  );
  await d.getByLabel('Time', { exact: true }).fill('09:00');
  await d
    .getByLabel('Reason for visit', { exact: true })
    .fill('Conflict protection and retry');
  await expect(
    d.getByRole('combobox', { name: 'Provider', exact: false }),
  ).toHaveValue(providerId);
  await d
    .getByRole('button', { name: 'Schedule appointment', exact: true })
    .click();
  await expect(d.getByRole('alert')).toContainText(
    'overlaps another appointment',
  );
  await d.getByLabel('Time', { exact: true }).fill('10:00');
  await d
    .getByRole('button', { name: 'Schedule appointment', exact: true })
    .click();
  await expect(d).not.toBeVisible();
  await expect(
    page.locator('.calendar-event').filter({ hasText: name }),
  ).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Register & schedule', exact: true })
    .click();
  registration = page.getByRole('dialog', {
    name: 'Register a patient',
    exact: true,
  });
  for (const [label, value] of [
    ['First name', 'CalendarNew'],
    ['Last name', 'Patient'],
    ['Date of birth', '1993-04-05'],
    ['Phone number', '555-0199'],
  ])
    await registration.getByLabel(label, { exact: true }).fill(value);
  await registration
    .getByRole('button', {
      name: 'Register and continue scheduling',
      exact: true,
    })
    .click();
  await expect(
    registration.getByRole('region', {
      name: 'Possible duplicate patients',
      exact: true,
    }),
  ).toBeVisible();
  await registration
    .getByRole('button', {
      name: 'Use existing patient for appointment',
      exact: true,
    })
    .click();
  d = schedule();
  await expect(
    d
      .getByRole('combobox', { name: 'Patient', exact: true })
      .locator('option:checked'),
  ).toContainText(name);
  await expect(d.getByLabel('Date', { exact: true })).toHaveValue(date);
  await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'March 2030', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Schedule for Tuesday, March 12, 2030',
      exact: true,
    })
    .click();
  d = schedule();
  await expect(d.getByLabel('Date', { exact: true })).toHaveValue(nextDate);
  await pick(
    d.getByRole('combobox', { name: 'Patient', exact: true }),
    /CalendarNew Patient/,
  );
  await d
    .getByLabel('Reason for visit', { exact: true })
    .fill('Calendar next-day review');
  await d
    .getByRole('button', { name: 'Schedule appointment', exact: true })
    .click();
  await expect(d).not.toBeVisible();
  await expect(
    page.locator('.calendar-month-event').filter({ hasText: name }),
  ).toHaveCount(3);
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'April 2030', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.calendar-month-event').filter({ hasText: name }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Previous month', exact: true })
    .click();
  await expect(
    page.locator('.calendar-month-event').filter({ hasText: name }),
  ).toHaveCount(3);
  await page.screenshot({
    path: '/tmp/cevrali-calendar-month.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(
    page.locator('.calendar-event').filter({ hasText: name }),
  ).toHaveCount(3);
  await pick(
    page.getByRole('combobox', { name: 'Calendar provider', exact: true }),
    /Dr. Alex Morgan/,
  );
  await expect(
    page.locator('.calendar-event').filter({ hasText: name }),
  ).toHaveCount(0);
  await pick(
    page.getByRole('combobox', { name: 'Calendar provider', exact: true }),
    /Dr. Nina Patel/,
  );
  await expect(
    page.locator('.calendar-event').filter({ hasText: name }),
  ).toHaveCount(3);
  await page.screenshot({
    path: '/tmp/cevrali-calendar-week.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('.calendar-time-grid')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(1);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page
    .getByRole('button', { name: 'Explore the front desk demo', exact: true })
    .click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByLabel('Schedule date', { exact: true }).fill(date);
  await page
    .locator('.calendar-event')
    .filter({ hasText: name })
    .filter({ hasText: 'Checked in' })
    .click();
  detail = page.getByRole('dialog', {
    name: 'Appointment details',
    exact: true,
  });
  await expect(
    detail.getByRole('button', { name: 'Start visit', exact: true }),
  ).toHaveCount(0);
  await detail
    .getByRole('button', { name: 'Open patient record', exact: true })
    .click();
  const record = page.getByRole('dialog', {
    name: 'Patient record',
    exact: true,
  });
  await expect(
    record.getByRole('heading', { name, exact: true, level: 2 }),
  ).toBeVisible();
  await record
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: '/tmp/cevrali-calendar-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    .toBe(true);
}
