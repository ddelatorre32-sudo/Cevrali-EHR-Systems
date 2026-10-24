import { expect, type Locator, type Page } from '@playwright/test';

/** Exercise the same staff workflow in the connected app and the offline preview. */
export async function exerciseScheduleManagement(page: Page) {
  page.setDefaultTimeout(12000);
  const patient = 'Olivia Bennett';
  const seriesReason = 'Synthetic recurring scheduling efficiency review';
  const rescheduleReason = 'Patient requested the following afternoon';
  const tools = page.getByRole('region', {
    name: 'Recurring visits and cancellation waitlist',
    exact: true,
  });
  async function pick(select: Locator, pattern: RegExp) {
    const option = select.getByRole('option').filter({ hasText: pattern });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute('value'))!);
  }
  const detail = () =>
    page.getByRole('dialog', { name: 'Appointment details', exact: true });
  const event = () =>
    page.locator('.calendar-event').filter({ hasText: patient });
  async function showDate(date: string) {
    await page.getByLabel('Schedule date', { exact: true }).fill(date);
    await expect(page.getByLabel('Schedule date', { exact: true })).toHaveValue(
      date,
    );
  }
  async function reviewedSelfPay(dialog: Locator) {
    await dialog
      .getByRole('combobox', { name: 'Coverage for this visit', exact: true })
      .selectOption('Self-pay');
    await dialog
      .getByRole('combobox', { name: 'Authorization review', exact: true })
      .selectOption('not-required');
  }

  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await pick(
    page.getByRole('combobox', { name: 'Calendar provider', exact: true }),
    /Dr. Nina Patel/,
  );
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await tools
    .getByRole('button', { name: 'Recurring visits', exact: true })
    .click();
  const series = page.getByRole('dialog', {
    name: 'Create recurring visits',
    exact: true,
  });
  await pick(
    series.getByRole('combobox', { name: 'Patient', exact: true }),
    /Olivia Bennett/,
  );
  await expect(
    series
      .getByRole('combobox', { name: 'Account for this visit', exact: true })
      .locator('option:checked'),
  ).toContainText('Private insurance');
  await series
    .getByLabel('Series start date', { exact: true })
    .fill('2030-07-01');
  await series.getByLabel('Visit time', { exact: true }).fill('13:00');
  await pick(
    series.getByRole('combobox', { name: 'Clinician preference', exact: true }),
    /Dr. Nina Patel/,
  );
  await series.getByLabel('Number of visits', { exact: true }).fill('2');
  await series
    .getByRole('combobox', { name: 'Repeat interval', exact: true })
    .selectOption('Weekly');
  await series.getByLabel('Visit reason', { exact: true }).fill(seriesReason);
  await reviewedSelfPay(series);
  await series
    .getByRole('button', { name: 'Create recurring visits', exact: true })
    .click();
  await expect(series).not.toBeVisible();
  await expect(tools).toContainText('Recurring visits saved');

  await showDate('2030-07-01');
  await expect(event()).toHaveCount(1);
  await event().click();
  await expect(detail()).toContainText(seriesReason);
  await detail()
    .getByRole('button', { name: 'Reschedule visit', exact: true })
    .click();
  const reschedule = page.getByRole('dialog', {
    name: 'Reschedule visit',
    exact: true,
  });
  await expect(reschedule).toContainText(
    'Coverage dates, clinician availability',
  );
  await reschedule
    .getByLabel('New visit date', { exact: true })
    .fill('2030-07-02');
  await reschedule.getByLabel('New visit time', { exact: true }).fill('13:00');
  await reschedule
    .getByLabel('Reason for rescheduling', { exact: true })
    .fill(rescheduleReason);
  await reschedule
    .getByRole('button', { name: 'Save rescheduled visit', exact: true })
    .click();
  await expect(reschedule).not.toBeVisible();
  await expect(detail()).not.toBeVisible();
  await expect(event()).toHaveCount(0);
  await showDate('2030-07-02');
  await expect(event()).toHaveCount(1);
  await event().click();
  await expect(detail()).toContainText(seriesReason);
  await expect(detail()).not.toContainText(rescheduleReason);
  await detail()
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await showDate('2030-07-08');
  await expect(event()).toHaveCount(1);
  await event().click();
  await expect(detail()).toContainText(seriesReason);
  await detail()
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();

  // A separate cancelled appointment supplies an earlier slot for the original visit.
  await page
    .getByRole('button', { name: 'New appointment', exact: true })
    .click();
  const appointment = page.getByRole('dialog', {
    name: 'Schedule an appointment',
    exact: true,
  });
  await appointment.getByLabel('Date', { exact: true }).fill('2030-06-25');
  await pick(
    appointment.getByRole('combobox', { name: 'Patient', exact: true }),
    /Olivia Bennett/,
  );
  await appointment.getByLabel('Time', { exact: true }).fill('13:00');
  await pick(
    appointment.getByRole('combobox', {
      name: /^Provider/,
      exact: false,
    }),
    /Dr. Nina Patel/,
  );
  await appointment
    .getByLabel('Reason for visit', { exact: true })
    .fill('Synthetic cancelled visit for waitlist demonstration');
  await reviewedSelfPay(appointment);
  await appointment
    .getByRole('button', { name: 'Schedule appointment', exact: true })
    .click();
  await expect(appointment).not.toBeVisible();
  await expect(page.getByLabel('Schedule date', { exact: true })).toHaveValue(
    '2030-06-25',
  );
  await expect(event()).toHaveCount(1);
  await event().click();
  page.once('dialog', (dialog) => void dialog.accept());
  await detail()
    .getByRole('button', { name: 'Cancel appointment', exact: true })
    .click();
  await expect(detail()).not.toBeVisible();
  await expect(event()).toContainText('Cancelled');

  await tools
    .getByRole('button', { name: 'Refresh waitlist', exact: true })
    .click();
  await tools
    .getByRole('button', { name: 'Add to waitlist', exact: true })
    .click();
  const waitlist = page.getByRole('dialog', {
    name: 'Add patient to cancellation waitlist',
    exact: true,
  });
  await pick(
    waitlist.getByRole('combobox', { name: 'Patient', exact: true }),
    /Olivia Bennett/,
  );
  await pick(
    waitlist.getByRole('combobox', {
      name: 'Visit to move (optional)',
      exact: true,
    }),
    /Jul 2, 2030/,
  );
  await expect(
    waitlist.getByRole('textbox', { name: /^Visit reason/ }),
  ).toHaveValue(seriesReason);
  await expect(
    waitlist.getByRole('textbox', { name: /^Visit reason/ }),
  ).toBeDisabled();
  await waitlist
    .getByLabel('Waitlist earliest date', { exact: true })
    .fill('2030-06-25');
  await waitlist
    .getByLabel('Waitlist latest date', { exact: true })
    .fill('2030-06-25');
  await waitlist
    .getByLabel('Earliest start time', { exact: true })
    .fill('12:00');
  await waitlist
    .getByLabel('Latest finish time', { exact: true })
    .fill('14:00');
  await waitlist
    .getByRole('combobox', { name: 'Waitlist priority', exact: true })
    .selectOption('High');
  await expect(waitlist).toContainText(
    'The original appointment keeps its visit account',
  );
  await waitlist
    .getByRole('button', { name: 'Add waitlist request', exact: true })
    .click();
  await expect(waitlist).not.toBeVisible();
  await tools.locator('summary').click();
  await expect(tools).toContainText(
    'No SMS, email or other delivery occurs in demo mode.',
  );
  const slot = tools.locator('article.finance-card').filter({
    has: page.getByRole('heading', {
      name: 'Jun 25, 2030 · 1:00 PM',
      exact: true,
    }),
  });
  await expect(slot).toContainText('Dr. Nina Patel');
  await expect(slot).toContainText('Follow-up needed');
  await expect(slot).toContainText('Pre-visit intake not submitted');
  await slot
    .getByRole('button', { name: 'Record manual offer', exact: true })
    .click();
  await expect(tools).toContainText('No message was sent.');
  const request = tools.locator('article.finance-card').filter({
    has: page.getByRole('heading', { name: patient, exact: true }),
  });
  await expect(request).toContainText('Offered');
  await request
    .getByRole('button', { name: 'Confirm patient accepted', exact: true })
    .click();
  const confirm = page.getByRole('dialog', {
    name: 'Confirm cancellation booking',
    exact: true,
  });
  await confirm
    .getByLabel('I reviewed these outstanding readiness items', {
      exact: false,
    })
    .check();
  await confirm
    .getByLabel('Patient acceptance has been confirmed by staff.', {
      exact: true,
    })
    .check();
  await confirm
    .getByRole('button', { name: 'Book accepted slot', exact: true })
    .click();
  await expect(confirm).not.toBeVisible();
  await expect(tools).toContainText(
    'Cancellation slot booked after staff confirmed patient acceptance.',
  );
  await expect(tools.locator('summary')).toContainText(
    '0 active waitlist requests',
  );
  await expect(event().filter({ hasText: 'Scheduled' })).toHaveCount(1);
  await event().filter({ hasText: 'Scheduled' }).click();
  await expect(detail()).toContainText(seriesReason);
  await expect(detail()).toContainText('Dr. Nina Patel');
  await detail()
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await showDate('2030-07-02');
  await expect(event()).toHaveCount(0);
  await showDate('2030-07-08');
  await expect(event()).toHaveCount(1);
}
