import { expect, type Page } from "@playwright/test";

/** Shared connected/offline flow; creates its own patient and uses UI only. */
export async function exerciseNoteResultIntegrity(page: Page) {
  page.setDefaultTimeout(10000);
  const name = "ResultIntegrityBrowser Patient";
  const complaint = "First corrected-report review";
  await page.getByRole("button", { name: "New patient", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Register a patient",
    exact: true,
  });
  for (const [label, value] of [
    ["First name", "ResultIntegrityBrowser"],
    ["Last name", "Patient"],
    ["Date of birth", "1991-07-08"],
    ["Phone number", "555-0194"],
  ])
    await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog
    .getByRole("button", { name: "Register patient", exact: true })
    .click();
  const chart = page.getByRole("dialog", {
    name: "Patient chart",
    exact: true,
  });
  await chart
    .getByRole("button", { name: "New encounter", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Start an encounter",
    exact: true,
  });
  await dialog.getByLabel("Chief complaint", { exact: true }).fill(complaint);
  await dialog
    .getByRole("button", { name: "Create encounter", exact: true })
    .click();
  let note = page.getByRole("dialog", {
    name: "Document encounter",
    exact: true,
  });
  for (const [label, value] of [
    ["Assessment", "Independent assessment remains unchanged."],
    ["Plan", "Independent follow-up plan remains unchanged."],
  ])
    await note
      .locator(".soap-label")
      .filter({ hasText: label })
      .locator("textarea")
      .fill(value);
  await note.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    note.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  await note.getByRole("button", { name: "Close dialog", exact: true }).click();

  await page.getByRole("button", { name: "Fax inbox", exact: true }).click();
  await page
    .getByRole("button", { name: "Receive demo fax", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Receive a demo fax",
    exact: true,
  });
  const example = dialog.getByRole("combobox", {
    name: "Example patient",
    exact: true,
  });
  await example.selectOption({ label: name });
  const patientId = await example.inputValue();
  const original = [
    `Patient Name: ${name}`,
    "DOB: 1991-07-08",
    "Document Type: Lab report",
    "Synthetic potassium: 9.0 mmol/L",
  ].join("\n");
  const corrected = original.replace("9.0", "4.0");
  await dialog
    .getByLabel("Sending facility", { exact: true })
    .fill("Synthetic Integrity Laboratory");
  await dialog
    .getByLabel("Facility fax reference", { exact: true })
    .fill("BROWSER-RESULT-INTEGRITY");
  await dialog
    .getByLabel("Received document text", { exact: true })
    .fill(original);
  await dialog
    .getByRole("button", { name: "Process demo fax", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();

  await page.getByRole("button", { name: "Encounters", exact: true }).click();
  await page
    .getByRole("button", { name: "New encounter", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Start an encounter",
    exact: true,
  });
  await dialog
    .getByRole("combobox", { name: "Patient", exact: true })
    .selectOption(patientId);
  await dialog
    .getByLabel("Chief complaint", { exact: true })
    .fill("Second open integrity draft");
  await dialog
    .getByRole("button", { name: "Create encounter", exact: true })
    .click();
  note = page.getByRole("dialog", { name: "Document encounter", exact: true });
  await note.getByRole("button", { name: "Close dialog", exact: true }).click();

  await page.getByRole("button", { name: "Fax inbox", exact: true }).click();
  const fax = page
    .locator(".finance-card")
    .filter({ hasText: "BROWSER-RESULT-INTEGRITY" });
  await fax
    .getByRole("button", { name: "Review received fax", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Received fax document",
    exact: true,
  });
  await dialog
    .getByText("Correct document type / verify extracted text", { exact: true })
    .click();
  const transcription = dialog.getByRole("textbox", {
    name: "Verified extracted text / manual transcription",
    exact: true,
  });
  await expect(transcription).toHaveValue(original);
  await transcription.fill(corrected);
  await dialog
    .getByLabel("Review / correction reason", { exact: true })
    .fill("Compared original patient identifiers, decimal value and units.");
  await dialog
    .getByLabel("I reviewed the original and verified patient identifiers.", {
      exact: true,
    })
    .check();
  await dialog
    .getByLabel(
      "I compared every original page and verified all text, values, units and document type.",
      { exact: true },
    )
    .check();
  await dialog
    .getByRole("button", {
      name: "Save verified classification and text",
      exact: true,
    })
    .click();
  await expect(
    dialog
      .locator(".inline-success")
      .filter({ hasText: /^Extraction verified by/ }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();

  await page.getByRole("button", { name: "Encounters", exact: true }).click();
  const originalRow = page.getByRole("row").filter({ hasText: complaint });
  await originalRow
    .getByRole("button", { name: "Continue note", exact: true })
    .click();
  note = page.getByRole("dialog", { name: "Document encounter", exact: true });
  const results = note.locator(".received-note-results");
  await expect(
    results.getByText("Source changed", { exact: true }),
  ).toBeVisible();
  const include = results.getByRole("button", {
    name: "Review and include report",
    exact: true,
  });
  await expect(include).toBeDisabled();
  await results
    .getByRole("button", { name: "Exclude from this note", exact: true })
    .click();
  await expect(results.getByText("Excluded", { exact: true })).toBeVisible();
  await expect(include).toBeDisabled();
  await results
    .getByRole("button", { name: "Relink verified report", exact: true })
    .click();
  await expect(
    results.getByText("Pending review", { exact: true }),
  ).toBeVisible();
  await expect(results).toContainText("4.0 mmol/L");
  await expect(results).not.toContainText("9.0 mmol/L");
  await expect(include).toBeEnabled();
  await include.click();
  await expect(results.getByText("Included", { exact: true })).toBeVisible();
  await expect(
    note
      .locator(".soap-label")
      .filter({ hasText: "Assessment" })
      .locator("textarea"),
  ).toHaveValue("Independent assessment remains unchanged.");
  await note.getByRole("button", { name: "Sign note", exact: true }).click();
  await note
    .getByRole("button", { name: "Confirm signature", exact: true })
    .click();
  await expect(note).not.toBeVisible();
  await originalRow
    .getByRole("button", { name: "View note", exact: true })
    .click();
  note = page.getByRole("dialog", { name: "Signed encounter", exact: true });
  await expect(note.locator(".received-note-results")).toContainText(
    "4.0 mmol/L",
  );
  await expect(note.locator(".received-note-results")).not.toContainText(
    "9.0 mmol/L",
  );
  await note.getByRole("button", { name: "Close dialog", exact: true }).click();
}
