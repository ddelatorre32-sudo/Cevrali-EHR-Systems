import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { exerciseMyWork } from '../my-work-browser';
import { clinicDate } from '../../src/clinic-dates';
import type { StaffTaskView } from '../../server/staff-task-model';

const taskBase = '/api/workflow/staff-tasks';

async function prepareTaskSource(context: BrowserContext, prefix: string) {
  const created = await context.request.post('/api/accounts/signup', { data: {
    owner_name: 'Synthetic My Work Owner',
    email: `my-work-${prefix}-${randomUUID()}@example.test`,
    password: 'SyntheticMyWork2026!',
    clinical_access: false,
    practice: { name: `Synthetic ${prefix} Task Practice` },
  } });
  expect(created.status()).toBe(201);
  const owner = await created.json();
  const message = await context.request.post('/api/workflow/staff/conversations/staff-general/messages', {
    data: { text: `Synthetic ${prefix} staff handoff needing follow-up.`, client_id: randomUUID() },
  });
  expect(message.status()).toBe(200);
  return { owner, message: await message.json() };
}

async function openCreate(page: Page, sourceText: string) {
  await page.goto('/#staff');
  const source = page.getByRole('region', { name: 'Conversation: General', exact: true })
    .getByRole('article').filter({ hasText: sourceText });
  await source.getByRole('button', { name: 'Create task', exact: true }).click();
  return page.getByRole('dialog', { name: 'Create task from message', exact: true });
}

async function createTask(context: BrowserContext, prefix: string, title = `Synthetic ${prefix} task`) {
  const source = await prepareTaskSource(context, prefix);
  const created = await context.request.post(taskBase, { data: {
    conversation_id: 'staff-general', message_id: source.message.id,
    title, owner_id: source.owner.id, due_date: clinicDate(),
    priority: 'Normal', client_id: randomUUID(),
  } });
  expect(created.status()).toBe(200);
  return { ...source, task: await created.json() as StaffTaskView };
}

const card = (page: Page, title: string) => page.getByRole('article', {
  name: `Staff task: ${title}`, exact: true,
});

test('a staff message becomes an assigned follow-up and completes across both staff roles', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const saved = await exerciseMyWork(page);
  const tasks = await (await page.request.get(`${taskBase}?scope=all&status=all`)).json();
  const task = tasks.find((item: StaffTaskView) => item.title === saved.title);
  expect(task.done).toBe(1);
  expect(task.history.map((entry: { action: string }) => entry.action)).toEqual(['Created', 'Completed']);
  expect(task.source_message.text).toBe(saved.messageText);
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/cevrali-my-work-desktop.png', fullPage: true });
});

test('a lost task-creation response retries the original assignment without duplicating the task', async ({ page, context }) => {
  const { message } = await prepareTaskSource(context, 'LostResponse');
  const create = await openCreate(page, message.text);
  const title = 'Preserve this synthetic task after a lost creation response';
  await create.getByRole('textbox', { name: 'Task title', exact: true }).fill(title);
  const clientIds: string[] = [];
  await page.route('**' + taskBase, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    clientIds.push(route.request().postDataJSON().client_id);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (clientIds.length === 1) return route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic lost assignment response' }),
    });
    return route.fulfill({ response });
  });
  await create.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(create.getByRole('alert')).toContainText('Synthetic lost assignment response');
  await expect(create.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue(title);
  await create.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(create).not.toBeVisible();
  expect(clientIds).toHaveLength(2);
  expect(clientIds[1]).toBe(clientIds[0]);
  const saved = await (await context.request.get(`${taskBase}?scope=all&status=all`)).json();
  const matches = saved.filter((item: StaffTaskView) => item.message_id === message.id);
  expect(matches).toHaveLength(1);
  expect(matches[0].title).toBe(title);
  expect(matches[0].history).toHaveLength(1);
});

test('a stale task edit keeps the unsaved draft and cannot overwrite another staff update', async ({ page, context }) => {
  const { task } = await createTask(context, 'StaleRevision');
  await page.goto('/#my-work');
  await card(page, task.title).getByRole('button', { name: 'View task', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Staff task', exact: true });
  const draftTitle = 'Retain this unsaved first-tab staff task title';
  await details.getByRole('textbox', { name: 'Task title', exact: true }).fill(draftTitle);
  const committedTitle = 'Synthetic task title saved by another staff tab';
  const changed = await context.request.patch(`${taskBase}/${task.id}`, { data: {
    revision: task.revision, title: committedTitle,
  } });
  expect(changed.status()).toBe(200);
  const rejected = page.waitForResponse(response =>
    new URL(response.url()).pathname === `${taskBase}/${task.id}` &&
    response.request().method() === 'PATCH' && response.status() === 409);
  await details.getByRole('button', { name: 'Save task changes', exact: true }).click();
  await rejected;
  await expect(details.getByRole('alert')).toBeVisible();
  await expect(details.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue(draftTitle);
  const latest = await (await context.request.get(`${taskBase}/${task.id}`)).json();
  expect(latest.title).toBe(committedTitle);
  expect(latest.history).toHaveLength(2);
  expect(latest.history.at(-1).after.title).toBe(committedTitle);
});

test('My work and task details fit a phone with long task titles and source messages', async ({ page, context }) => {
  const title = 'Synthetic mobile follow-up ' + 'x'.repeat(170);
  const { task } = await createTask(context, 'Mobile', title);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#my-work');
  await expect(card(page, task.title)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: '/tmp/cevrali-my-work-mobile.png', fullPage: true });
  await card(page, task.title).getByRole('button', { name: 'View task', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Staff task', exact: true });
  await expect(details.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue(task.title);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('opening an older source message preserves newer unread history until an explicit jump', async ({ page, context }) => {
  const { message } = await createTask(context, 'OlderSource');
  const path = '/api/workflow/staff/conversations/staff-general/messages';
  let latestText = '';
  for (let index = 1; index <= 60; index++) {
    latestText = `Synthetic newer handover ${index} after the original task source.`;
    const sent = await context.request.post(path, { data: { text: latestText, client_id: randomUUID() } });
    expect(sent.status()).toBe(200);
  }
  let reads = 0;
  page.on('request', request => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname
      === '/api/workflow/staff/conversations/staff-general/read') reads++;
  });
  await page.goto(`/#staff?conversation=staff-general&message=${encodeURIComponent(message.id)}`);
  const conversation = page.getByRole('region', { name: 'Conversation: General', exact: true });
  await expect(conversation.getByText(message.text, { exact: true })).toBeVisible();
  await expect(conversation.getByText(latestText, { exact: true })).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(reads).toBe(0);
  await conversation.getByRole('button', { name: 'Jump to latest messages', exact: true }).click();
  await expect(conversation.getByText(latestText, { exact: true })).toBeVisible();
});

test('My work opens the exact lab result without acknowledging it automatically', async ({ page, context }) => {
  const login = await context.request.post('/api/auth/login', { data: {
    email: 'alex@cevrali.demo', password: 'CevraliDemo2026!',
  } });
  expect(login.status()).toBe(200);
  const suffix = randomUUID();
  const name = `Synthetic My work source ${suffix}`;
  const order = await context.request.post('/api/workflow/orders', { data: {
    patient_id: 'pat-002', encounter_id: null, kind: 'Lab', name,
    details: 'Synthetic source-navigation regression',
  } });
  expect(order.status()).toBe(200);
  const { id: orderId } = await order.json();
  expect((await context.request.patch(`/api/workflow/orders/${orderId}`, { data: { status: 'Prepared' } })).status()).toBe(200);
  const imported = await context.request.post('/api/workflow/results', { data: {
    order_id: orderId, patient_reference: 'Patient/pat-002', name,
    value: '7.1', unit: '%', reference_range: '4.0–5.6', flag: 'High', external_id: suffix,
  } });
  expect(imported.status()).toBe(200);
  const result = await imported.json();
  await page.goto('/#my-work');
  await page.getByRole('article', { name: `Review: Review result: ${name}`, exact: true })
    .getByRole('button', { name: 'Review source', exact: true }).click();
  const source = page.locator(`[id="work-result-${result.id}"]`);
  await expect(source).toBeFocused();
  await expect(source).toContainText(name);
  await expect(source.getByRole('button', { name: 'Acknowledge result', exact: true })).toBeVisible();
  const outstanding = await (await context.request.get('/api/workflow/my-work')).json();
  expect(outstanding.reviews.some((item: { id: string }) => item.id === result.id)).toBe(true);
});

test('a confirmed care-task completion stays completed through a failed dashboard refresh', async ({ page, context }) => {
  const login = await context.request.post('/api/auth/login', { data: {
    email: 'alex@cevrali.demo', password: 'CevraliDemo2026!',
  } });
  expect(login.status()).toBe(200);
  const viewer = await login.json();
  const title = `Synthetic dashboard completion ${randomUUID()}`;
  const created = await context.request.post('/api/workflow/tasks', { data: {
    patient_id: null, title, category: 'Other', priority: 'Normal',
    owner_id: viewer.id, due_date: clinicDate(),
  } });
  expect(created.status()).toBe(200);
  const task = await created.json();
  await page.goto('/#my-work');
  const taskCard = page.getByRole('article', { name: `Care task: ${title}`, exact: true });
  await expect(taskCard).toBeVisible();
  let failedReads = false;
  let writes = 0;
  await page.route(`**/api/workflow/tasks/${task.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    writes++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    failedReads = true;
    return route.fulfill({ response });
  });
  await page.route('**/api/workflow/my-work', route => failedReads
    ? route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic dashboard refresh interruption' }) })
    : route.continue());
  await taskCard.getByRole('button', { name: 'Complete care task', exact: true }).click();
  await expect(taskCard).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Synthetic dashboard refresh interruption');
  failedReads = false;
  await page.getByRole('button', { name: 'Refresh my work', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(writes).toBe(1);
  const saved = await (await context.request.get('/api/workflow/tasks')).json();
  expect(saved.find((item: { id: string }) => item.id === task.id).done).toBe(1);
});
