import { expect, test } from "@playwright/test";
import { exerciseBookingConflicts } from "../booking-conflicts-browser";

test("ordinary booking prevents patient overlap across providers and permits independent simultaneous care", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open clinician demo", exact: true })
    .click();
  await exerciseBookingConflicts(page);
  expect(errors).toEqual([]);
});
