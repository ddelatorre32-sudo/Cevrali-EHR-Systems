import { expect, type Page } from '@playwright/test';

/** UI-only journey shared with the network-blocked, in-memory preview. */
export async function exerciseStaffCommunication(page: Page) {
  page.setDefaultTimeout(12000);
  const suffix = `${Date.now()}`;
  const channelName = `Morning huddle ${suffix}`;
  const messageText = `Please review the synthetic morning huddle checklist ${suffix}.`;
  const directMessage = `Synthetic private handoff to Dr. Morgan ${suffix}.`;
  const announcementTitle = `Practice briefing ${suffix}`;
  const announcementBody = 'Please acknowledge that you have reviewed the updated opening checklist.';
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signout.or(page.getByRole('button', {
    name: 'Open clinician demo', exact: true,
  }))).toBeVisible();
  if (!(await signout.isVisible()))
    await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();

  const open = async () => page.getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Staff communication', exact: true }).click();
  const tab = (name: string) => page.getByRole('tablist', { name: 'Staff communication', exact: true })
    .getByRole('tab', { name, exact: true });
  const conversations = page.getByRole('navigation', { name: 'Staff conversations', exact: true });
  const conversation = (name: string) => page.getByRole('region', {
    name: `Conversation: ${name}`, exact: true,
  });

  await open();
  await tab('Messages').click();
  await conversations.getByRole('button', { name: 'General', exact: true }).click();
  await expect(conversation('General').getByRole('textbox', { name: 'Message', exact: true }))
    .toBeEditable();
  await page.getByRole('button', { name: 'New channel', exact: true }).click();
  const channelDialog = page.getByRole('dialog', { name: 'Create a channel', exact: true });
  await channelDialog.getByRole('textbox', { name: 'Channel name', exact: true }).fill(channelName);
  await channelDialog.getByRole('textbox', { name: 'Channel description', exact: true })
    .fill('Coordinate the synthetic practice opening checklist.');
  await channelDialog.getByRole('button', { name: 'Create channel', exact: true }).click();
  await expect(channelDialog).not.toBeVisible();
  await conversations.getByRole('button', { name: channelName, exact: true }).click();
  const channel = conversation(channelName);
  await channel.getByRole('textbox', { name: 'Message', exact: true }).fill(messageText);
  await channel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(channel.getByText(messageText, { exact: true })).toBeVisible();
  await expect(channel.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await channel.getByRole('searchbox', { name: 'Search this conversation', exact: true }).fill(suffix);
  await channel.getByRole('button', { name: 'Search messages', exact: true }).click();
  await expect(channel.getByText(messageText, { exact: true })).toBeVisible();
  await channel.getByRole('button', { name: 'Clear search', exact: true }).click();

  await tab('Announcements').click();
  await page.getByRole('button', { name: 'New announcement', exact: true }).click();
  const announcementDialog = page.getByRole('dialog', { name: 'Post an announcement', exact: true });
  await announcementDialog.getByRole('textbox', { name: 'Announcement title', exact: true })
    .fill(announcementTitle);
  await announcementDialog.getByRole('textbox', { name: 'Announcement message', exact: true })
    .fill(announcementBody);
  await announcementDialog.getByRole('combobox', { name: 'Announcement priority', exact: true })
    .selectOption('Urgent');
  await announcementDialog.getByRole('checkbox', { name: 'Require staff acknowledgement', exact: true })
    .check();
  await announcementDialog.getByRole('button', { name: 'Post announcement', exact: true }).click();
  await expect(announcementDialog).not.toBeVisible();
  const announcement = page.getByRole('article', { name: `Announcement: ${announcementTitle}`, exact: true });
  await expect(announcement).toContainText(announcementBody);
  await expect(announcement).toContainText('Urgent');

  await signout.click();
  await page.getByRole('button', { name: 'Explore the front desk demo', exact: true }).click();
  await open();
  await tab('Announcements').click();
  await expect(page.getByRole('button', { name: 'New announcement', exact: true })).toHaveCount(0);
  await announcement.getByRole('button', { name: 'Acknowledge announcement', exact: true }).click();
  await expect(announcement).toContainText('Acknowledged');
  await expect(announcement.getByRole('button', { name: 'Acknowledge announcement', exact: true }))
    .toHaveCount(0);

  await tab('Messages').click();
  await conversations.getByRole('button', { name: channelName, exact: true }).click();
  await expect(channel.getByText(messageText, { exact: true })).toBeVisible();
  const reply = `Front desk has reviewed the opening checklist ${suffix}.`;
  await channel.getByRole('textbox', { name: 'Message', exact: true }).fill(reply);
  await channel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(channel.getByText(reply, { exact: true })).toBeVisible();

  await tab('Staff directory').click();
  const doctor = page.getByRole('article', { name: 'Staff member: Dr. Alex Morgan', exact: true });
  await doctor.getByRole('button', { name: 'Message staff member', exact: true }).click();
  const privateConversation = conversation('Dr. Alex Morgan');
  await privateConversation.getByRole('textbox', { name: 'Message', exact: true }).fill(directMessage);
  await privateConversation.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(privateConversation.getByText(directMessage, { exact: true })).toBeVisible();

  await signout.click();
  await page.getByRole('button', { name: 'Open clinician demo', exact: true }).click();
  await open();
  await tab('Announcements').click();
  await announcement.getByText('View acknowledgements', { exact: true }).click();
  await expect(announcement).toContainText('Jamie Parker');
  await expect(announcement).toContainText('Acknowledged');
  await tab('Messages').click();
  await conversations.getByRole('button', { name: 'Jamie Parker', exact: true }).click();
  await expect(conversation('Jamie Parker').getByText(directMessage, { exact: true })).toBeVisible();
  return { announcementTitle, channelName, messageText, directMessage };
}
