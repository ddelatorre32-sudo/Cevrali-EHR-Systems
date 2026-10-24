import { expect, type Page } from '@playwright/test';

export async function exerciseAccounts(page: Page) {
  const suffix = Date.now().toString();
  const email = `owner-${suffix}@example.test`;
  const clinicianEmail = `clinician-${suffix}@example.test`;
  const password = 'SyntheticBrowser2026!';
  async function signIn(address: string, pw = password) {
    await page.getByLabel('Email address', { exact: true }).fill(address);
    await page.getByLabel('Password', { exact: true }).fill(pw);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  async function create(address: string, name: string) {
    await page
      .getByRole('button', { name: 'Create practice account', exact: true })
      .click();
    const d = page.getByRole('dialog', {
      name: 'Create practice account',
      exact: true,
    });
    await d
      .getByLabel('Your full name', { exact: true })
      .fill('Synthetic Owner');
    await d.getByLabel('Your work email', { exact: true }).fill(address);
    await d
      .getByLabel('Password (12 or more characters)', { exact: true })
      .fill(password);
    await d.getByLabel('Confirm password', { exact: true }).fill(password);
    await d
      .getByRole('button', { name: 'Continue to practice details' })
      .click();
    await d.getByLabel('Practice name', { exact: true }).fill(name);
    await d.getByLabel('Practice phone', { exact: true }).fill('555-0100');
    await d
      .getByLabel('Practice address', { exact: true })
      .fill('Synthetic practice address');
    await d.getByRole('button', { name: 'Create practice workspace' }).click();
    await expect(d).not.toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Account setup.' }),
    ).toBeVisible();
  }
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signout.or(page.getByRole('button',{name:'Create practice account',exact:true}))).toBeVisible();
  if (await signout.isVisible()) await signout.click();
  await create(email, 'Summit Care');
  await expect(page.locator('.practice-selector')).toContainText('Summit Care');
  await expect(
    page.getByRole('button', { name: 'Encounters', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.account-summary')).toContainText(
    '0 registered patients',
  );
  await page
    .getByRole('button', { name: 'Finish practice setup', exact: true })
    .click();
  await expect(
    page.getByText('Practice setup complete', { exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await page.getByLabel('Staff email', { exact: true }).fill(clinicianEmail);
  await page
    .getByRole('combobox', { name: 'Staff role', exact: true })
    .selectOption('clinician');
  await page
    .getByRole('button', { name: 'Create invitation link', exact: true })
    .click();
  await expect(
    page.getByLabel('Invitation link', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Invitation created. Share the link directly; no email was sent.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/cevrali-practice-team.png',
    fullPage: true,
  });
  const invite = await page
    .getByLabel('Invitation link', { exact: true })
    .inputValue();
  await page.evaluate(
    (hash) => {
      location.hash = hash;
    },
    invite.slice(invite.indexOf('#')),
  );
  await expect(
    page.getByRole('heading', { name: 'Join your practice', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Summit Care', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Your full name', { exact: true })
    .fill('Synthetic Clinician');
  await page
    .getByLabel('Password (12 or more characters)', { exact: true })
    .fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Accept invitation', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Account setup.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Team', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Encounters', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New patient', exact: true }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('First name', { exact: true }).fill('Synthetic');
  await d.getByLabel('Last name', { exact: true }).fill('SummitPatient');
  await d.getByLabel('Date of birth', { exact: true }).fill('1990-01-01');
  await d.getByLabel('Phone number', { exact: true }).fill('555-0123');
  await d
    .getByRole('button', { name: 'Register patient', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Patient chart', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page
    .getByRole('button', { name: 'New appointment', exact: true })
    .click();
  const appointment = page.getByRole('dialog', {
    name: 'Schedule an appointment',
    exact: true,
  });
  await appointment
    .getByRole('combobox', { name: 'Patient', exact: true })
    .selectOption({ index: 1 });
  await expect(
    appointment.getByRole('combobox', { name: /Provider/ }).getByRole('option'),
  ).toHaveText(['Synthetic Clinician']);
  await appointment
    .getByLabel('Reason for visit', { exact: true })
    .fill('Synthetic new-practice visit');
  await appointment
    .getByRole('button', { name: 'Schedule appointment', exact: true })
    .click();
  await expect(appointment).not.toBeVisible();
  await signout.click();
  await signIn(email);
  await page
    .getByRole('button', { name: 'Account setup', exact: true })
    .click();
  await expect(page.locator('.account-summary')).toContainText(
    '1 registered patient',
  );
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  const member = page
    .locator('.account-member')
    .filter({ hasText: clinicianEmail });
  await expect(member).toBeVisible();
  await member.getByLabel('Active', { exact: true }).uncheck();
  await member
    .getByRole('button', { name: 'Save access', exact: true })
    .click();
  await expect(
    page.getByText('Staff access updated', { exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(password);
  await page
    .getByLabel('Password (12 or more characters)', { exact: true })
    .fill('ChangedSynthetic2026!');
  await page
    .getByLabel('Confirm password', { exact: true })
    .fill('ChangedSynthetic2026!');
  await page
    .getByRole('button', { name: 'Change password', exact: true })
    .click();
  await expect(
    page.getByText('Password changed. Other sessions have been signed out.', {
      exact: true,
    }),
  ).toBeVisible();
  await signout.click();
  await create(`other-${suffix}@example.test`, 'Separate Practice');
  await expect(page.locator('.account-summary')).toContainText(
    '0 registered patients',
  );
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await expect(page.locator('.account-member')).toHaveCount(1);
  await signout.click();
  await signIn(email, 'ChangedSynthetic2026!');
  await page
    .getByRole('button', { name: 'Account setup', exact: true })
    .click();
  await expect(page.locator('.account-summary')).toContainText(
    '1 registered patient',
  );
  await expect(page.locator('.practice-selector')).toContainText('Summit Care');
  await page.screenshot({
    path: '/tmp/cevrali-practice-account.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator('.sidebar')
        .evaluate((el) => Math.round(el.getBoundingClientRect().right)),
    )
    .toBeLessThanOrEqual(1);
  await expect(page.getByLabel('Practice name', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/cevrali-practice-mobile.png',
    fullPage: true,
  });
}
