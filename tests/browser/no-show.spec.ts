import { test, expect } from "@playwright/test";
import { exerciseNoShow } from "../no-show-browser";

test("no-shows stay consistent across queue, calendar, filters, terminal actions and reload", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open clinician demo", exact: true })
    .click();
  await exerciseNoShow(page);
  expect(errors).toEqual([]);
});
