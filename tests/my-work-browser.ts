import { expect, type Page } from '@playwright/test';
import { clinicDate } from '../src/clinic-dates';

/** One UI-only staff handoff, shared with the network-blocked preview. */
export async function exerciseMyWork(page: Page) {
  page.setDefaultTimeout(12000);
  const suffix = String(Date.now());
  const channelName = `Task handoff ${suffix}`;
  const messageText = `Please confirm the synthetic morning handoff checklist ${suffix}.`;
  const title = `Confirm morning handoff ${suffix}`;
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signout.or(page.getByRole('button', {
    name: 'Open clinician demo', exact: true,
  }))).toBeVisible();
  if (!(await signout.isVisible()))
    await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  const navigate = (name: string) => page.getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true }).click();
  const taskFilter = (name: string) => page.getByRole('tablist', { name: 'Staff task filters', exact: true })
    .getByRole('tab', { name, exact: true });
  const taskCard = () => page.getByRole('article', { name: `Staff task: ${title}`, exact: true });

  await navigate('Staff communication');
  await page.getByRole('button', { name: 'New channel', exact: true }).click();
  const channelDialog = page.getByRole('dialog', { name: 'Create a channel', exact: true });
  await channelDialog.getByRole('textbox', { name: 'Channel name', exact: true }).fill(channelName);
  await channelDialog.getByRole('textbox', { name: 'Channel description', exact: true })
    .fill('Synthetic staff follow-up workflow.');
  await channelDialog.getByRole('button', { name: 'Create channel', exact: true }).click();
  await expect(channelDialog).not.toBeVisible();
  const conversation = page.getByRole('region', { name: `Conversation: ${channelName}`, exact: true });
  await conversation.getByRole('textbox', { name: 'Message', exact: true }).fill(messageText);
  await conversation.getByRole('button', { name: 'Send message', exact: true }).click();
  const sourceMessage = conversation.getByRole('article').filter({ hasText: messageText });
  await expect(sourceMessage).toHaveCount(1);
  await sourceMessage.getByRole('button', { name: 'Create task', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create task from message', exact: true });
  await expect(create.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue(messageText);
  await create.getByRole('textbox', { name: 'Task title', exact: true }).fill(title);
  const owner = create.getByRole('combobox', { name: 'Assigned to', exact: true });
  const deskId = await owner.getByRole('option', { name: /Jamie Parker/ }).getAttribute('value');
  expect(deskId).toBeTruthy();
  await owner.selectOption(deskId!);
  await create.getByLabel('Due date', { exact: true }).fill(clinicDate());
  await create.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('High');
  await create.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(create).not.toBeVisible();
  await expect(sourceMessage.getByRole('button', { name: 'View task', exact: true })).toBeVisible();

  await navigate('My work');
  await taskFilter('Assigned by me').click();
  await expect(taskCard()).toContainText('Jamie Parker');
  await taskCard().getByRole('button', { name: 'View task', exact: true }).click();
  let details = page.getByRole('dialog', { name: 'Staff task', exact: true });
  await expect(details).toContainText(messageText);
  const history = details.locator('summary').filter({ hasText: /^Task history/ });
  await expect(history).toBeVisible();
  await history.click();
  await expect(details).toContainText('Created');
  await details.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await signout.click();
  await page.getByRole('button', { name: 'Explore the front desk demo', exact: true }).click();
  await navigate('My work');
  await taskFilter('Assigned to me').click();
  await taskCard().getByRole('button', { name: 'View task', exact: true }).click();
  details = page.getByRole('dialog', { name: 'Staff task', exact: true });
  await details.getByRole('button', { name: 'Complete task', exact: true }).click();
  await expect(details).toContainText('Completed');
  await expect(details.getByRole('button', { name: 'Reopen task', exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await taskFilter('Completed').click();
  await expect(taskCard()).toBeVisible();

  await signout.click();
  await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  await navigate('My work');
  await taskFilter('Completed').click();
  await taskCard().getByRole('button', { name: 'View task', exact: true }).click();
  details = page.getByRole('dialog', { name: 'Staff task', exact: true });
  await details.locator('summary').filter({ hasText: /^Task history/ }).click();
  await expect(details).toContainText('Jamie Parker');
  await expect(details).toContainText('Completed');
  await details.getByRole('button', { name: 'Open source conversation', exact: true }).click();
  await expect(details).not.toBeVisible();
  await expect(conversation.getByText(messageText, { exact: true })).toBeVisible();
  await expect(sourceMessage.getByRole('button', { name: 'View task', exact: true })).toBeVisible();
  return { title, channelName, messageText };
}
