import { test, expect } from "@playwright/test";
import { exerciseScheduleManagement } from "../schedule-management-browser";
test("recurring bookings, rescheduling and explicit cancellation waitlist booking", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open clinician demo", exact: true })
    .click();
  await exerciseScheduleManagement(page);
  expect(errors).toEqual([]);
});
