import { test, expect } from '@playwright/test';
import { exerciseSettings } from '../settings-browser';

test('settings persist per staff account and provider templates apply without rewriting saved notes', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await exerciseSettings(page);
  expect(errors).toEqual([]);
});

test('saved start pages survive reload while explicit page links keep their destination', async ({ page, context }) => {
  const signup = await context.request.post('/api/accounts/signup', {
    data: {
      owner_name: 'Settings Browser Owner',
      email: `settings-start-${Date.now()}@example.test`,
      password: 'SyntheticSettings2026!',
      clinical_access: true,
      practice: { name: 'Settings Browser Practice' },
    },
  });
  expect(signup.status()).toBe(201);
  const saved = await context.request.patch('/api/workflow/user-settings', {
    data: { start_page: 'queue', calendar_view: 'day', density: 'compact' },
  });
  expect(saved.status()).toBe(200);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await page.goto('/#patients');
  await expect(nav.getByRole('button', { name: 'Patients', exact: true })).toHaveClass(/active/);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-density', 'compact');
  await page.goto('/');
  await expect(nav.getByRole('button', { name: 'Patient queue', exact: true })).toHaveClass(/active/);
  await page.reload();
  await expect(nav.getByRole('button', { name: 'Patient queue', exact: true })).toHaveClass(/active/);
  await nav.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Calendar view' })
    .getByRole('button', { name: 'Day', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
