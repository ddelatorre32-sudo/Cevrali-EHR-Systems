import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { exerciseStaffCommunication } from '../staff-communication-browser';
import type { StaffConversationView, StaffMessagePage, StaffMessageView } from '../../server/staff-communication-model';

async function createPractice(context: BrowserContext, prefix: string) {
  const created = await context.request.post('/api/accounts/signup', { data: {
    owner_name: 'Synthetic Staff Administrator',
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    password: 'SyntheticStaff2026!',
    clinical_access: false,
    practice: { name: `Synthetic ${prefix} Communication` },
  } });
  expect(created.status()).toBe(201);
  return created.json();
}

async function createChannel(context: BrowserContext, name: string) {
  const created = await context.request.post('/api/workflow/staff/conversations', { data: {
    kind: 'channel', name, description: 'Synthetic browser regression channel',
    client_id: crypto.randomUUID(),
  } });
  expect(created.status()).toBe(200);
  return await created.json() as StaffConversationView;
}

async function send(context: BrowserContext, conversationId: string, text: string) {
  const sent = await context.request.post(`/api/workflow/staff/conversations/${conversationId}/messages`, {
    data: { text, client_id: crypto.randomUUID() },
  });
  expect(sent.status()).toBe(200);
  return await sent.json() as StaffMessageView;
}

const region = (page: Page, name: string) => page.getByRole('region', {
  name: `Conversation: ${name}`, exact: true,
});

test('staff channels, private handoffs and acknowledged announcements work across both staff roles', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const saved = await exerciseStaffCommunication(page);
  const workspace = await (await page.request.get('/api/workflow/staff')).json();
  const announcement = workspace.announcements.find((item: any) => item.title === saved.announcementTitle);
  expect(announcement.acknowledged_count).toBe(1);
  expect(announcement.recipient_count).toBe(workspace.directory.length - 1);
  expect(errors).toEqual([]);
  expect(await page.locator('.staff-conversations').evaluate(element =>
    element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: '/tmp/cevrali-staff-communication-desktop.png', fullPage: true });
});

test('a delayed old conversation response cannot replace the selected conversation, draft or read cursor', async ({ page, context }) => {
  await createPractice(context, 'Switching');
  const a = await createChannel(context, 'Older response');
  const b = await createChannel(context, 'Current conversation');
  const oldText = 'Synthetic earlier channel text must not appear in the current conversation.';
  const currentText = 'Synthetic current conversation remains visible.';
  await send(context, a.id, oldText);
  await send(context, b.id, currentText);
  await page.goto('/#staff');
  await expect(region(page, 'General').getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();

  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let olderReads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === `/api/workflow/staff/conversations/${a.id}/read`
      && request.method() === 'PATCH') olderReads++;
  });
  await page.route(`**/api/workflow/staff/conversations/${a.id}/messages*`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    started();
    await delayed;
    await route.fulfill({ response });
  });
  const conversations = page.getByRole('navigation', { name: 'Staff conversations', exact: true });
  await conversations.getByRole('button', { name: a.name, exact: true }).click();
  await requestStarted;
  await conversations.getByRole('button', { name: b.name, exact: true }).click();
  const current = region(page, b.name);
  await expect(current.getByText(currentText, { exact: true })).toBeVisible();
  const draft = 'Keep this unsent current-channel draft.';
  await current.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);
  const returned = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/workflow/staff/conversations/${a.id}/messages`);
  release();
  await returned;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(current.getByText(currentText, { exact: true })).toBeVisible();
  await expect(current.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);
  await expect(current).not.toContainText(oldText);
  expect(olderReads).toBe(0);
});

test('staff communication fits a phone and wraps long messages without page overflow', async ({ page, context }) => {
  await createPractice(context, 'Mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#staff');
  const general = region(page, 'General');
  const message = `Synthetic mobile handoff ${'x'.repeat(220)}`;
  await general.getByRole('textbox', { name: 'Message', exact: true }).fill(message);
  await general.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(general.getByText(message, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: '/tmp/cevrali-staff-communication-mobile.png', fullPage: true });
});

test('a saved message survives failed refreshes without repeating the send', async ({ page, context }) => {
  await createPractice(context, 'RefreshRetry');
  await page.goto('/#staff');
  const general = region(page, 'General');
  await expect(general.getByRole('heading', { name: 'Start the conversation', exact: true })).toBeVisible();
  let readsFail = false;
  let posts = 0;
  await page.route('**/api/workflow/staff/conversations/staff-general/messages*', async route => {
    if (route.request().method() === 'POST') {
      posts++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      readsFail = true;
      return route.fulfill({ response });
    }
    if (readsFail) return route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic message refresh interruption' }),
    });
    return route.continue();
  });
  await page.route('**/api/workflow/staff', route => readsFail
    ? route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic workspace refresh interruption' }) })
    : route.continue());
  const text = 'Keep this successfully saved synthetic handoff after a refresh interruption.';
  await general.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await general.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(general.getByText(text, { exact: true })).toBeVisible();
  await expect(general.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await expect(general.getByRole('alert')).toContainText('Synthetic message refresh interruption');
  readsFail = false;
  await page.getByRole('button', { name: 'Refresh communication', exact: true }).click();
  await expect(general.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry loading communication', exact: true })).toHaveCount(0);
  expect(posts).toBe(1);
  const saved = await (await context.request.get('/api/workflow/staff/conversations/staff-general/messages')).json();
  expect(saved.messages.filter((message: StaffMessageView) => message.text === text)).toHaveLength(1);
});

test('retrying after a lost send response reuses the original message request', async ({ page, context }) => {
  await createPractice(context, 'LostResponse');
  await page.goto('/#staff');
  const general = region(page, 'General');
  await expect(general.getByRole('heading', { name: 'Start the conversation', exact: true })).toBeVisible();
  const clientIds: string[] = [];
  await page.route('**/api/workflow/staff/conversations/staff-general/messages*', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    clientIds.push(route.request().postDataJSON().client_id);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (clientIds.length === 1) return route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic lost send response' }),
    });
    return route.fulfill({ response });
  });
  const text = 'This synthetic staff message must be saved once even if the response is lost.';
  await general.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await general.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(general.getByRole('alert')).toContainText('Synthetic lost send response');
  await expect(general.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(text);
  await general.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(general.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await expect(general.getByText(text, { exact: true })).toHaveCount(1);
  expect(clientIds).toHaveLength(2);
  expect(clientIds[1]).toBe(clientIds[0]);
  const saved = await (await context.request.get('/api/workflow/staff/conversations/staff-general/messages')).json();
  expect(saved.messages.filter((message: StaffMessageView) => message.text === text)).toHaveLength(1);
});
