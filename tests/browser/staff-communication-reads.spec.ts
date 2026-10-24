import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const staffBase = "/api/workflow/staff";
const generalId = "staff-general";
const messagesPath = staffBase + "/conversations/" + generalId + "/messages";
const readPath = staffBase + "/conversations/" + generalId + "/read";

async function preparePractice(owner: BrowserContext, peer: BrowserContext) {
  const suffix = randomUUID();
  const created = await owner.request.post("/api/accounts/signup", {
    data: {
      owner_name: "Synthetic Read Administrator",
      email: "staff-reads-owner-" + suffix + "@example.test",
      password: "SyntheticReadChecks2026!",
      clinical_access: false,
      practice: { name: "Synthetic Staff Read Checks" },
    },
  });
  expect(created.status()).toBe(201);
  const invitation = await owner.request.post("/api/account/invitations", {
    data: {
      email: "staff-reads-peer-" + suffix + "@example.test",
      role: "receptionist",
      is_admin: false,
    },
  });
  expect(invitation.status()).toBe(200);
  const { token } = await invitation.json();
  const accepted = await peer.request.post("/api/accounts/invitations/" + token + "/accept", {
    data: { name: "Synthetic Read Peer", password: "SyntheticReadChecks2026!" },
  });
  expect(accepted.status()).toBe(201);
}

async function peerMessage(peer: BrowserContext, text: string) {
  const response = await peer.request.post(messagesPath, {
    data: { text, client_id: randomUUID() },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

async function unreadGeneral(owner: BrowserContext) {
  const response = await owner.request.get(staffBase);
  expect(response.status()).toBe(200);
  const workspace = await response.json();
  return workspace.conversations.find((conversation: any) => conversation.id === generalId).unread_count;
}

async function refreshMessages(page: Page) {
  await page.evaluate((conversationId) => {
    window.dispatchEvent(new CustomEvent("cevrali:staff-updated", {
      detail: { conversationId, refreshMessages: true },
    }));
  }, generalId);
}

test("a failed read update retries the same visible message after a refresh", async ({ page, context, browser, baseURL }) => {
  const peer = await browser.newContext({ baseURL });
  try {
    await preparePractice(context, peer);
    const sent = await peerMessage(peer, "Synthetic message whose first read acknowledgement fails.");
    const readPositions: number[] = [];
    let unavailable = true;
    await page.route("**" + readPath, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      readPositions.push(route.request().postDataJSON().sequence);
      if (unavailable)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic temporary read update failure" }),
        });
      return route.continue();
    });
    const failedRead = page.waitForResponse((response) =>
      new URL(response.url()).pathname === readPath &&
      response.request().method() === "PATCH" && response.status() === 503);
    await page.goto("/#staff");
    await expect(page.getByRole("region", { name: "Conversation: General", exact: true })
      .getByText(sent.text, { exact: true })).toBeVisible();
    await failedRead;
    expect(await unreadGeneral(context)).toBe(1);

    unavailable = false;
    await refreshMessages(page);
    await expect.poll(async () => unreadGeneral(context)).toBe(0);
    expect(readPositions.length).toBeGreaterThanOrEqual(2);
    expect(readPositions[0]).toBe(sent.sequence);
    expect(readPositions[1]).toBe(sent.sequence);
    await expect(page.locator("html")).not.toHaveAttribute("data-cevrali-session-checking", "");
  } finally {
    await peer.close();
  }
});

test("reading older messages keeps a new arrival unread until jumping to the latest messages", async ({ page, context, browser, baseURL }) => {
  const peer = await browser.newContext({ baseURL });
  try {
    await preparePractice(context, peer);
    for (let index = 1; index <= 60; index++)
      await peerMessage(peer, "Synthetic shift handover " + index + ". " +
        "This longer staff update makes the message history scroll. ".repeat(8));
    await page.goto("/#staff");
    const conversation = page.getByRole("region", { name: "Conversation: General", exact: true });
    const history = conversation.locator(".staff-message-history");
    await expect(history.locator('[data-message-sequence="60"]')).toHaveCount(1);
    await expect.poll(async () => unreadGeneral(context)).toBe(0);
    expect(await history.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
    await history.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    const next = await peerMessage(peer, "Synthetic new arrival while the administrator reads older handovers.");
    await refreshMessages(page);
    await expect(history.locator('[data-message-sequence="' + next.sequence + '"]')).toHaveCount(1);
    const jump = conversation.getByRole("button", { name: "Jump to latest messages", exact: true });
    await expect(jump).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await history.evaluate((element) => element.scrollTop)).toBeLessThan(100);
    expect(await unreadGeneral(context)).toBe(1);

    await jump.click();
    await expect.poll(async () => unreadGeneral(context)).toBe(0);
    await expect.poll(async () => history.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(80);
    await expect(page.locator("html")).not.toHaveAttribute("data-cevrali-session-checking", "");
  } finally {
    await peer.close();
  }
});
