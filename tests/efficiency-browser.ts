import { expect, type Page } from '@playwright/test';

export async function exerciseEfficiency(page: Page) {
  await page
    .getByRole('button', { name: 'Patient queue', exact: true })
    .click();
  const emma = page.locator('.queue-card').filter({ hasText: 'Emma Thompson' });
  await emma.getByRole('button', { name: 'Create intake link' }).click();
  await page
    .getByRole('dialog', { name: 'Patient intake link' })
    .getByRole('button', { name: 'Open patient view' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Hello, Emma.' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Confirm appointment', exact: true })
    .click();
  await expect(
    page.getByText('Appointment confirmed', { exact: true }).last(),
  ).toBeVisible();
  await page.getByLabel('Main concern').fill('Review preventive care goals');
  await page
    .getByLabel('Symptoms or updates')
    .fill('Synthetic patient-reported update.');
  await page.getByLabel('Allergies you want the team to review').fill('Latex');
  await page
    .getByLabel('Medications you are taking')
    .fill('Example medicine | 10 mg | Daily');
  await page
    .getByLabel('I agree to appointment and follow-up reminders.')
    .check();
  await page.getByLabel('I have reviewed this information').check();
  await page.getByRole('button', { name: 'Submit intake' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Thank you. Your form is with the care team.',
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    location.hash = 'intake';
  });
  await expect(
    page.getByRole('heading', { name: 'Pre-visit intake review' }),
  ).toBeVisible();
  const submitted = page
    .locator('.intake-card')
    .filter({ hasText: 'Emma Thompson' });
  page.once('dialog', (dialog) => dialog.accept());
  await submitted
    .getByRole('button', { name: 'Review & reconcile chart' })
    .click();
  await expect(submitted.getByText('Reviewed', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Patient queue', exact: true })
    .click();
  await emma.getByRole('button', { name: 'Check in', exact: true }).click();
  await emma
    .getByRole('textbox', { name: 'Room for Emma Thompson' })
    .fill('Room 3');
  await emma.getByRole('textbox', { name: 'Room for Emma Thompson' }).blur();
  await emma.getByRole('button', { name: 'Room patient' }).click();
  await emma.getByRole('button', { name: 'Ready for clinician' }).click();
  await emma.getByRole('button', { name: 'Open visit' }).click();
  const note = page.getByRole('dialog', { name: 'Document encounter' });
  await expect(
    note.getByText('Example medicine', { exact: true }),
  ).toBeVisible();
  await note
    .getByRole('combobox', { name: 'Visit template' })
    .selectOption('template-preventive');
  await note.getByRole('button', { name: 'Apply template' }).click();
  await expect(note.getByLabel('Assessment', { exact: false })).toHaveValue(
    /\[\[/,
  );
  await note
    .getByLabel('Subjective')
    .fill('Reviewed patient concerns and preventive care goals.');
  await note
    .getByLabel('Objective')
    .fill('Documented the examination performed for this synthetic visit.');
  await note
    .getByLabel('Assessment', { exact: false })
    .fill('Preventive care review.');
  await note
    .getByLabel('Plan', { exact: false })
    .fill('Agreed follow-up and screening plan.');
  await note
    .getByRole('combobox', { name: 'Smart phrase', exact: true })
    .selectOption('phrase-followup');
  await note.getByRole('button', { name: 'Insert phrase' }).click();
  await expect(note.getByLabel('Plan', { exact: false })).toHaveValue(
    /Reasons to return sooner/,
  );
  await note
    .getByLabel('Plan', { exact: false })
    .fill('Agreed follow-up in two weeks and reasons to return sooner.');
  await note.getByRole('button', { name: 'Save as template' }).click();
  await note
    .getByRole('textbox', { name: 'New template name' })
    .fill('Preventive visit team template');
  await note
    .getByRole('button', { name: 'Save template', exact: true })
    .click();
  await expect(note.getByText('Template saved', { exact: true })).toBeVisible();
  await note.getByRole('button', { name: 'Follow-up', exact: true }).click();
  await note
    .getByLabel('Follow-up task', { exact: true })
    .fill('Review preventive care follow-up');
  await note
    .getByRole('button', { name: 'Create follow-up', exact: true })
    .click();
  await expect(
    note.getByText('Follow-up task and reminder created.'),
  ).toBeVisible();
  await note.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(note.getByText('All changes saved')).toBeVisible();
  await note.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page
    .getByRole('button', { name: 'Orders & referrals', exact: true })
    .click();
  await page.getByRole('button', { name: 'New order' }).click();
  const composer = page.locator('.order-composer');
  await composer
    .getByRole('combobox', { name: 'Patient', exact: true })
    .selectOption('pat-005');
  await composer.getByLabel('Test name').fill('Complete blood count');
  await composer
    .getByLabel('Clinical question and instructions')
    .fill('Synthetic workflow test, clinician-reviewed order.');
  await composer.getByRole('button', { name: 'Create draft order' }).click();
  const order = page
    .locator('.order-card')
    .filter({ hasText: 'Complete blood count' });
  await order.getByRole('button', { name: 'Mark reviewed & prepared' }).click();
  await order.getByRole('button', { name: 'Record received result' }).click();
  const result = page.getByRole('dialog', { name: 'Record a received result' });
  await result.getByLabel('Result', { exact: true }).fill('13.4');
  await result.getByLabel('Units', { exact: true }).fill('g/dL');
  await result.getByLabel('Reference range').fill('12.0–15.5');
  await result
    .getByRole('combobox', { name: 'Flag', exact: true })
    .selectOption('Normal');
  await result.getByLabel('External result ID').fill('demo-browser-cbc');
  await result
    .getByRole('button', { name: 'Save result & create review task' })
    .click();
  await expect(result).not.toBeVisible();
  await expect(
    order.getByText('Result received', { exact: true }),
  ).toBeVisible();
  await order.getByRole('button', { name: 'Acknowledge result' }).click();
  await expect(
    order.getByText('Reviewed', { exact: true }).first(),
  ).toBeVisible();

  await page
    .getByRole('button', { name: /^Care inbox/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const task = page.getByRole('dialog', { name: 'Create a care task' });
  await task.getByLabel('Task title').fill('Coordinate patient follow-up');
  await task
    .getByRole('combobox', { name: 'Patient', exact: true })
    .selectOption('pat-005');
  await task
    .getByRole('combobox', { name: 'Owner', exact: true })
    .selectOption('usr-colleague');
  await task.getByLabel('Due date', { exact: true }).fill('2020-01-01');
  await task
    .getByRole('combobox', { name: 'Priority', exact: true })
    .selectOption('High');
  await task.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(task).not.toBeVisible();
  const assigned = page
    .locator('.assigned-task')
    .filter({ hasText: 'Coordinate patient follow-up' });
  await expect(assigned.getByText('Overdue', { exact: true })).toBeVisible();
  await expect(
    assigned.getByLabel('Owner for Coordinate patient follow-up'),
  ).toHaveValue('usr-colleague');

  await page.getByRole('button', { name: 'Reminders', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Reminder outbox' }),
  ).toBeVisible();
  await expect(
    page.getByText(/Messages are never sent automatically/),
  ).toBeVisible();
  await expect(
    page.locator('.reminder-card').filter({ hasText: 'Emma Thompson' }).first(),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Practice metrics', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Practice operations' }),
  ).toBeVisible();
  await expect(
    page.getByText('Average check-in wait', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  await expect(page.getByText('Live connection: not connected')).toHaveCount(3);
  await page.getByLabel('Lab provider name').fill('Demo lab');
  await page.getByRole('button', { name: 'Save demo preferences' }).click();
  await expect(
    page.getByText(
      'Demo integration preferences saved. Live delivery remains disconnected.',
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Open command palette' }).click();
  const palette = page.getByRole('dialog', { name: 'Find your next step' });
  await palette
    .getByRole('textbox', { name: 'Command search' })
    .fill('Emma Thompson');
  await palette
    .getByRole('button', { name: 'Star Emma Thompson', exact: true })
    .click();
  await expect(
    palette.getByRole('button', { name: 'Unstar Emma Thompson', exact: true }),
  ).toBeVisible();
  await palette.getByRole('button', { name: /Emma Thompson.*CV-/ }).click();
  await expect(
    page.getByRole('dialog', { name: 'Patient chart' }),
  ).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Patient chart' })
    .getByRole('button', { name: 'Close dialog' })
    .click();
  await page.getByRole('button', { name: 'Patients', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Filter patient directory' })
    .fill('Emma');
  await page
    .getByRole('textbox', { name: 'Saved view name' })
    .fill('Emma follow-up');
  await page.getByRole('button', { name: 'Save current view' }).click();
  await expect(
    page.getByRole('button', { name: /^Emma follow-up/ }),
  ).toBeVisible();
}
