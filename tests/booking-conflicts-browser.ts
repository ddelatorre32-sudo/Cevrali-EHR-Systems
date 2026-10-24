import { expect, type Locator, type Page } from "@playwright/test";

/** Exercise the ordinary booking form in both the connected app and offline preview. */
export async function exerciseBookingConflicts(page: Page) {
  page.setDefaultTimeout(12000);
  const date = "2034-10-05";
  const booking = () =>
    page.getByRole("dialog", { name: "Schedule an appointment", exact: true });
  async function choose(select: Locator, name: RegExp) {
    const option = select.locator("option").filter({ hasText: name });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute("value"))!);
  }
  async function reviewSelfPay(dialog: Locator) {
    await expect(
      dialog.getByRole("combobox", {
        name: "Account for this visit",
        exact: true,
      }),
    ).not.toHaveValue("");
    await dialog
      .getByRole("combobox", { name: "Coverage for this visit", exact: true })
      .selectOption("Self-pay");
    await dialog
      .getByRole("combobox", { name: "Authorization review", exact: true })
      .selectOption("not-required");
  }
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await page.getByLabel("Schedule date", { exact: true }).fill(date);
  await page
    .getByRole("combobox", { name: "Calendar provider", exact: true })
    .selectOption("all");
  await page.getByRole("button", { name: "Day", exact: true }).click();
  await page
    .getByRole("button", { name: "New appointment", exact: true })
    .click();
  let dialog = booking();
  await choose(
    dialog.getByRole("combobox", { name: "Patient", exact: true }),
    /Olivia Bennett/,
  );
  await choose(
    dialog.getByRole("combobox", { name: /^Provider/ }),
    /Dr. Alex Morgan/,
  );
  await dialog.getByLabel("Date", { exact: true }).fill(date);
  await dialog.getByLabel("Time", { exact: true }).fill("09:00");
  await dialog
    .getByRole("textbox", { name: "Reason for visit", exact: true })
    .fill("Ordinary patient overlap original booking");
  await reviewSelfPay(dialog);
  await dialog
    .getByRole("button", { name: "Schedule appointment", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();

  await page
    .getByRole("button", { name: "New appointment", exact: true })
    .click();
  dialog = booking();
  await choose(
    dialog.getByRole("combobox", { name: "Patient", exact: true }),
    /Olivia Bennett/,
  );
  await choose(
    dialog.getByRole("combobox", { name: /^Provider/ }),
    /Dr. Nina Patel/,
  );
  await dialog.getByLabel("Date", { exact: true }).fill(date);
  await dialog.getByLabel("Time", { exact: true }).fill("09:15");
  await dialog
    .getByRole("textbox", { name: "Reason for visit", exact: true })
    .fill("Ordinary patient overlap retry booking");
  await reviewSelfPay(dialog);
  await dialog
    .getByRole("button", { name: "Schedule appointment", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "overlaps another appointment",
  );
  await expect(
    dialog.getByRole("combobox", { name: "Patient", exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByLabel("Time", { exact: true })).toBeEnabled();
  await expect(
    page.locator(".calendar-event").filter({ hasText: "Olivia Bennett" }),
  ).toHaveCount(1);

  await choose(
    dialog.getByRole("combobox", { name: "Patient", exact: true }),
    /James Wilson/,
  );
  await reviewSelfPay(dialog);
  await dialog
    .getByRole("button", { name: "Schedule appointment", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("Schedule date", { exact: true })).toHaveValue(
    date,
  );
  await expect(
    page.locator(".calendar-event").filter({ hasText: "Olivia Bennett" }),
  ).toHaveCount(1);
  await expect(
    page.locator(".calendar-event").filter({ hasText: "James Wilson" }),
  ).toHaveCount(1);
  const table = page.locator(".appointment-table");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(
    table.locator("tbody tr").filter({ hasText: "Olivia Bennett" }),
  ).toHaveCount(1);
  await expect(
    table.locator("tbody tr").filter({ hasText: "James Wilson" }),
  ).toHaveCount(1);
}
