import { expect, type Locator, type Page } from "@playwright/test";

/** The same UI journey runs against persisted SQLite and the offline demo. */
export async function exerciseNoShow(page: Page) {
  page.setDefaultTimeout(12000);
  const date = "2020-01-16";
  const reason = "Missed visit calendar consistency regression";
  async function choose(select: Locator, name: RegExp) {
    const option = select.locator("option").filter({ hasText: name });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute("value"))!);
  }
  async function calendar() {
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await page.getByLabel("Schedule date", { exact: true }).fill(date);
    await page.getByRole("button", { name: "Day", exact: true }).click();
  }
  const event = () =>
    page.locator(".calendar-event").filter({ hasText: "Olivia Bennett" });
  const detail = () =>
    page.getByRole("dialog", { name: "Appointment details", exact: true });
  await calendar();
  await page
    .getByRole("button", { name: "New appointment", exact: true })
    .click();
  const booking = page.getByRole("dialog", {
    name: "Schedule an appointment",
    exact: true,
  });
  await choose(
    booking.getByRole("combobox", { name: "Patient", exact: true }),
    /Olivia Bennett/,
  );
  await choose(
    booking.getByRole("combobox", { name: /^Provider/ }),
    /Dr. Nina Patel/,
  );
  await booking.getByLabel("Time", { exact: true }).fill("09:00");
  await booking.getByLabel("Reason for visit", { exact: true }).fill(reason);
  await booking
    .getByRole("combobox", { name: "Coverage for this visit", exact: true })
    .selectOption("Self-pay");
  await booking
    .getByRole("combobox", { name: "Authorization review", exact: true })
    .selectOption("not-required");
  await booking
    .getByRole("button", { name: "Schedule appointment", exact: true })
    .click();
  await expect(booking).not.toBeVisible();

  await page
    .getByRole("button", { name: "Patient queue", exact: true })
    .click();
  await page.getByLabel("Queue date", { exact: true }).fill(date);
  const card = page.locator(".queue-card").filter({ hasText: reason });
  await card.getByRole("button", { name: "Mark no-show", exact: true }).click();
  const missedColumn = page
    .locator(".queue-column")
    .filter({
      has: page.getByRole("heading", { name: "No-show", exact: true }),
    });
  await expect(
    missedColumn.locator(".queue-card").filter({ hasText: reason }),
  ).toHaveCount(1);
  await expect(
    card.getByRole("button", { name: "Check in", exact: true }),
  ).toHaveCount(0);

  await calendar();
  await expect(event()).toContainText("No-show");
  await event().click();
  await expect(detail()).toContainText(reason);
  await expect(detail().getByText("No-show", { exact: true })).toBeVisible();
  for (const label of [
    "Check in patient",
    "Start visit",
    "Continue visit",
    "Complete visit",
    "Cancel appointment",
    "Reschedule",
  ])
    await expect(
      detail().getByRole("button", { name: label, exact: true }),
    ).toHaveCount(0);
  await detail()
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const row = () =>
    page
      .locator(".appointment-table tbody tr")
      .filter({ hasText: "Olivia Bennett" });
  await expect(row()).toContainText("No-show");
  await expect(
    page.locator(".appointment-actions").getByRole("button"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Upcoming", exact: true }).click();
  await expect(event()).toHaveCount(0);
  await expect(row()).toHaveCount(0);
  await page.getByRole("button", { name: "No-shows", exact: true }).click();
  await expect(event()).toHaveCount(1);
  await expect(row()).toHaveCount(1);
  await choose(
    page.getByRole("combobox", { name: "Calendar provider", exact: true }),
    /Dr. Alex Morgan/,
  );
  await expect(event()).toHaveCount(0);
  await expect(row()).toHaveCount(0);
  await choose(
    page.getByRole("combobox", { name: "Calendar provider", exact: true }),
    /Dr. Nina Patel/,
  );
  await expect(event()).toHaveCount(1);
  await expect(row()).toHaveCount(1);

  // Standalone state deliberately resets on reload; persisted mode must retain the no-show.
  if (/^https?:/.test(page.url())) {
    await page.reload();
    await calendar();
    await expect(event()).toContainText("No-show");
    await expect(row()).toContainText("No-show");
  }
}
