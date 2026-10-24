import { test, expect } from "@playwright/test";
import { exerciseNoteResultIntegrity } from "../note-result-integrity-browser";

test("excluded corrected fax reports require explicit relinking and fresh provider review before signature", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open clinician demo", exact: true })
    .click();
  await exerciseNoteResultIntegrity(page);
  expect(errors).toEqual([]);
});
